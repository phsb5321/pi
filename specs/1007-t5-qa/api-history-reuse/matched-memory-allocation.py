#!/usr/bin/env python3
"""Read actual owned invocation and fail closed on resource headroom; never admit."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import time

CGROOT = Path('/sys/fs/cgroup')
NAMES = ('cpu.max', 'memory.max', 'memory.high', 'memory.swap.max', 'pids.max',
         'memory.current', 'memory.peak', 'memory.swap.current', 'pids.current',
         'memory.events', 'pids.events', 'memory.pressure', 'cpu.pressure', 'io.pressure')

def require(value, message):
    if not value:
        raise ValueError(message)


def read_invocation():
    raw = Path('/proc/self/cgroup').read_text()
    relative = next(line.split(':', 2)[2] for line in raw.splitlines() if line.startswith('0::/'))
    cg = CGROOT / relative.lstrip('/')
    show = subprocess.check_output(['systemctl', '--user', 'show', cg.name, '-p', 'InvocationID', '-p', 'ActiveState', '-p', 'ControlGroup'], text=True, timeout=3)
    props = dict(line.split('=', 1) for line in show.splitlines() if '=' in line)
    require(props['ActiveState'] == 'active' and props['ControlGroup'] == relative,
            'No actually active matching invocation')
    require(re.fullmatch('[0-9a-f]{32}', props['InvocationID']), 'No actual InvocationID')
    address = subprocess.check_output(['busctl', '--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'GetUnit', 's', cg.name], text=True, timeout=3)
    require(address.startswith('o "'), 'Unparseable own unit address')
    address = json.loads(address[2:])
    values = {}
    for interface, key in (('Service', 'RuntimeMaxUSec'), ('Unit', 'ActiveEnterTimestampMonotonic')):
        value = subprocess.check_output(['busctl', '--user', 'get-property', 'org.freedesktop.systemd1', address, f'org.freedesktop.systemd1.{interface}', key], text=True, timeout=3).strip()
        require(re.fullmatch('t [0-9]+', value), 'Unparseable typed lifetime')
        values[key] = int(value[2:])
    require(0 < values['RuntimeMaxUSec'] <= 900_000_000, 'Unbounded/unapproved lifetime')
    deadline = (values['ActiveEnterTimestampMonotonic'] + values['RuntimeMaxUSec']) / 1_000_000
    require(deadline > time.monotonic(), 'Expired admitted invocation')
    return {'clock_brt': datetime.now().astimezone().strftime('%d/%m/%Y %H:%M:%S %Z'),
            'unit': cg.name, 'InvocationID': props['InvocationID'], 'cgroup': raw,
            'typed_lifetime': values, 'deadline_monotonic': deadline,
            'pid_namespace': os.readlink('/proc/self/ns/pid'),
            'net_namespace': os.readlink('/proc/self/ns/net'),
            'pid1_cgroup': Path('/proc/1/cgroup').read_text(),
            'actual_bounds_and_pressure': read_resources(cg),
            'allocation_created_by_this_reader': False}


def read_resources(cg):
    rows = []
    for path in (cg, *cg.parents):
        if not path.is_relative_to(CGROOT):
            break
        rows.append({'path': str(path), 'fields': {name: (path / name).read_text().strip()
                     for name in NAMES if (path / name).exists()}})
    return rows


def event_counts(rows):
    return {row['path']: {key: row['fields'][key] for key in ('memory.events', 'pids.events') if key in row['fields']}
            for row in rows}


def check_headroom(rows, initial_events=None):
    require(rows, 'No scope resource observations')
    for row in rows:
        fields = row['fields']
        # Limits/headroom apply to ancestors too; another job is never ours to reclaim.
        for resource, used, reserve in (('memory', 'memory.current', 128 * 1024 ** 2), ('pids', 'pids.current', 16)):
            limit = fields.get(f'{resource}.max', 'max')
            if limit != 'max':
                require(int(fields[used]) + reserve < int(limit), f'{row["path"]}: insufficient {resource} headroom')
        high = fields.get('memory.high', 'max')
        if high != 'max':
            require(int(fields['memory.current']) < int(high), f'{row["path"]}: memory.high reached')
        for line in fields.get('memory.pressure', '').splitlines():
            values = dict(part.split('=', 1) for part in line.split()[1:])
            ceiling = 1.0 if line.startswith('some ') else 0.1
            require(float(values['avg10']) <= ceiling, f'{row["path"]}: memory pressure')
    require(initial_events is None or event_counts(rows) == initial_events, 'New leaf/ancestor memory/PID event; row invalid')


def validate_normal_n1(allocation, deadline_s):
    require(allocation['unit'] == 'desktop-job-slot.service', 'Not own normal heavy allocation')
    require(allocation['pid1_cgroup'] == allocation['cgroup'], 'Not wholly in admitted PID namespace')
    leaf = allocation['actual_bounds_and_pressure'][0]['fields']
    expected = {'cpu.max': '400000 100000', 'memory.max': '4294967296',
                'memory.high': '3221225472', 'memory.swap.max': '2147483648', 'pids.max': '256'}
    require(all(leaf.get(key) == value for key, value in expected.items()), 'Not the authorized ordinary4CPU/4GiB/256-task budget')
    require(deadline_s <= 760 and deadline_s + 25 < allocation['deadline_monotonic'] - time.monotonic(),
            'Own workload/export/teardown deadline exceeds actual remaining lease')
    check_headroom(allocation['actual_bounds_and_pressure'])


def control_check(out):
    out.mkdir(parents=True, exist_ok=False)
    allocation = read_invocation()
    (out / 'ALLOCATION.json').write_text(json.dumps(allocation, indent=2) + '\n')
    # Instrument qualification is not a product allocation: retain live RED,
    # but test the guard independently. validate_normal_n1 still fails on RED.
    try:
        check_headroom(allocation['actual_bounds_and_pressure'])
        live_headroom = {'status': 'PASS'}
    except ValueError as error:
        live_headroom = {'status': 'REFUSED', 'error': str(error)}
    tests = []
    fixture = [{'path': 'owned-resource-fixture', 'fields': {
        'memory.max': str(512 * 1024 ** 2), 'memory.current': '1', 'memory.high': 'max',
        'pids.max': '64', 'pids.current': '1', 'memory.pressure': 'some avg10=0.00\nfull avg10=0.00',
        'memory.events': 'oom 0', 'pids.events': 'max 0'}}]
    check_headroom(fixture)
    for key, value in (('memory.current', str(512 * 1024 ** 2)), ('pids.current', '64'),
                       ('memory.pressure', 'some avg10=2.00\nfull avg10=0.00'), ('memory.events', 'oom 1')):
        changed = json.loads(json.dumps(fixture))
        changed[0]['fields'][key] = value
        try:
            check_headroom(changed, event_counts(fixture))
        except ValueError:
            tests.append(key)
        else:
            raise AssertionError(f'Resource negative accepted: {key}')
    receipt = {'status': 'OWN_SMALL_INVOCATION_READER_AND_RESOURCE_GUARD_TESTS_PASS',
               'allocation': allocation, 'resource_negatives': tests,
               'live_small_aggregate_headroom': live_headroom,
               'is_product_allocation': False, 'live_refusal_is_product_permission': False}
    (out / 'CHECK.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(receipt['status'])

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control-check', type=Path, required=True)
    control_check(parser.parse_args().control_check.resolve())
