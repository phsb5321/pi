#!/usr/bin/env python3
"""Bounded native paired A/B PTY driver. Runs only INSIDE an existing admitted job.

--contract FILE --out NEW_DIRECTORY: exact compiled ABI/QA + actual normal admission required.
--faux-check --out NEW_DIRECTORY: owned Python PTY orchestration checks only.
No admission creation, network/provider calls, builds, signals, or automatic retries.
"""

import argparse
from datetime import datetime
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import runpy
import selectors
import shutil
import struct
import subprocess
import sys
import termios
import tempfile
import time

HERE = Path(__file__).resolve().parent
PROBE = Path('/home/notroot/Documents/Code/pi-upstream/tools/mem-probe')
PROBE_SHA = '5ae757407f0be595ff9b0bf61429c51fd688198b0ee666a084b1cef4c63f90fd'
VERIFIER = Path('/home/notroot/Documents/Code/pi-upstream-ms-mem-verify/tools/mem-verify')
VERIFIER_SHA = '0d2dd3880a67854dced0e305b6e39d2498d82db060502f9f76318e64f3981633'
ABI = {'memory-proof/shared-tty', '@earendil-works/pi-ai', '@earendil-works/pi-durable',
       '@earendil-works/chord/context', '@earendil-works/pi-durable/storage/sqlite/node'}


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def canonical(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def bound_document(item):
    require(sha(item['path']) == item['sha256'], f"Receipt mismatch: {item['path']}")
    return json.loads(Path(item['path']).read_text())


def proc_stat(pid):
    return Path('/proc', str(pid), 'stat').read_text()


def cgroup_path():
    text = Path('/proc/self/cgroup').read_text()
    path = next(line.split(':', 2)[2] for line in text.splitlines() if line.startswith('0::/'))
    return text, Path('/sys/fs/cgroup') / path.lstrip('/')


def preflight(job, qualification):
    require(job['schedule'] in ('paired', 'serial-exploratory'), 'Unknown schedule')
    require(type(job['N']) is int and job['N'] in (1, 8, 32, 306), 'Invalid/full N required')
    require(canonical(job['history']) == job['history_sha256'], 'History mismatch')
    require(canonical(job['workload']) == job['workload_sha256'], 'Workload mismatch')
    require(sha(PROBE) == PROBE_SHA and sha(VERIFIER) == VERIFIER_SHA, 'Accepted instrument changed')
    for path, digest in {**job['artifact']['files'], **job.get('instrument_files', {})}.items():
        require(sha(path) == digest, f'Artifact mismatch: {path}')
    cgroup, cg = cgroup_path()
    if qualification:
        require(job['N'] == 1 and job['idle_s'] == 0 and job['deadline_s'] <= 15,
                'Faux check must remain tiny')
        return cgroup, cg
    require(job['order'] in (['A', 'B'], ['B', 'A']), 'Must retain both full arms and counterbalanced order')
    require(job['history_class'] in ('minimal-native', 'alternating-native850'),
            'Current seed ABI must not relabel tool-heavy/realistic fleet history')
    for name in ('matched-memory-driver.py', 'matched-native-loader.mjs', 'matched-native-adapter.mjs', 'matched-memory-allocation.py'):
        path = str(HERE / name)
        require(job['instrument_files'].get(path) == sha(path), 'Unbound measurement instrument')
    require(job['artifact']['files'].get(job['node']) == sha(job['node']) and
            job['artifact']['files'].get(job['bridge']) == sha(job['bridge']), 'Unbound native binary/bridge')
    source, inputs = job['artifact']['source'], job['artifact']['inputs']
    bound_document(source)
    bound_document(inputs)
    require(ABI <= set(job['artifact']['modules']), 'Native ABI incomplete')
    execution = job['artifact']['execution_mode']
    require(execution == 'compiled-native', 'Current authorized product entry requires compiled native ABI; no source fallback')
    extensions = ('.js', '.mjs', '.cjs') if execution == 'compiled-native' else ('.js', '.mjs', '.cjs', '.ts', '.mts', '.cts')
    for binding in job['artifact']['modules'].values():
        require(Path(binding['path']).suffix in extensions, 'Undeclared source fallback')
        require(job['artifact']['files'].get(binding['path']) == binding['sha256'], 'ABI not artifact-bound')
    if execution == 'frozen-native-source':
        resolver = job['artifact']['source_resolver']
        require(job['artifact']['files'].get(resolver) == sha(resolver), 'Unbound producer source resolver')
    require(job['artifact']['runtime_closure_sha256'] == canonical(job['artifact']['files']), 'Runtime closure mismatch')
    build, qa = (bound_document(job[key]) for key in ('build', 'qa'))
    identity = {key: job['artifact'][key] for key in ('tuple', 'dist_sha256', 'execution_mode', 'runtime_closure_sha256')}
    identity.update(source_sha256=source['sha256'], input_sha256=inputs['sha256'])
    commands = {tuple(c['argv']): c['exit'] for c in build.get('actual_commands', [])}
    require(commands.get(('npm', 'run', 'check')) == 0 and commands.get(('npm', 'run', 'build:offline')) == 0 and
            build.get('source', {}).get('source_sha256') == source['sha256'] and
            build.get('source', {}).get('input_sha256') == inputs['sha256'] and
            build.get('source', {}).get('tuple') == identity['tuple'] and
            build.get('dist_merkle_sha256') == identity['dist_sha256'], 'No exact green composed build')
    require(execution != 'compiled-native' or build.get('claims', {}).get('compiled_shared_tty_host') is True,
            'Normal dist excludes experimental host; cannot call source host compiled')
    require(qa.get('status') == 'PASS' and qa.get('identity') == identity and
            all(qa.get('gates', {}).get(key) is True for key in
                ('native-history', 'stream-tool-cancel', 'rich-pty', 'one-host-census', 'teardown')),
            'No exact executable QA')
    require(job['schedule'] == 'paired' and job['N'] in (1, 8),
            'Normal desktop product wave is paired N1/N8 only; N32/full306 need existing external allocation/frontend entry')
    require(job['idle_s'] >= 300, 'Actual native storage-idle must be >=300s')
    qualified = bound_document(job['qualification'])
    require(qualified['status'] == 'CURRENT_BYTES_FAUX_PTY_QUALIFIED' and
            all(qualified['code_sha256'].get(path) == value for path, value in job['instrument_files'].items()),
            'Current instrument bytes are not qualified')
    resources = runpy.run_path(str(HERE / 'matched-memory-allocation.py'))
    allocation = resources['read_invocation']()
    resources['validate_normal_n1'](allocation, job['deadline_s'])
    require(os.environ.get('MP_PARENT_NETNS') != allocation['net_namespace'] and os.environ.get('MP_PARENT_NETNS'),
            'No actual workload network-namespace boundary')
    allocation['hostname'] = os.uname().nodename
    allocation['owner'] = 'ms-memory'
    allocation['run_id'] = job['run_id']
    allocation['status'] = 'ACTUALLY_NORMALLY_ADMITTED_OWN_INVOCATION'
    job['allocation_actual'] = allocation
    if job['N'] == 8:
        certificate = bound_document(job['N8_resource_certificate'])
        require(certificate['identity'] == identity and certificate['history_sha256'] == job['history_sha256'] and
                certificate['schedule'] == 'paired' and certificate['qualified_N'] == 8 and
                certificate['includes_common_native_bridge_tool_terminal_costs'] is True,
                'N8 needs actual compiled resource justification, not an extrapolated ratio')
        require(certificate['tasks_upper_bound'] + 16 < int((cg / 'pids.max').read_text()) and
                certificate['memory_upper_bound_bytes'] + 128 * 1024 ** 2 < int((cg / 'memory.high').read_text()),
                'N8 resource certificate does not fit current ordinary envelope')
    require(job['display_scope'] == 'native-local-pty' and job['full_fleet_claim'] is False,
            'This entry does not omit real full-fleet frontends to claim complete fleet proof')
    require(job['N'] != 306, 'Full306 needs separately qualified full-display inventory/entry; no downscale')
    return cgroup, cg


class Driver:
    def __init__(self, job, out, qualification=False):
        self.job, self.out, self.qualification = job, out, qualification
        self.cgroup, self.cg = preflight(job, qualification)
        require(not out.exists(), 'Evidence directory already exists; preserve it')
        out.mkdir(parents=True)
        self.start = time.monotonic()
        self.end = self.start + job['deadline_s']
        self.children, self.panes, self.samples, self.launches = [], [], [], []
        self.selector = selectors.DefaultSelector()
        self.events_path = out / 'events.jsonl'
        self.loads = out / 'loaded-modules.jsonl'
        self.contract_path = out / 'contract.json'
        self.contract_path.write_text(json.dumps(job, indent=2))
        self.env = {**os.environ, 'MP_CONTRACT': str(self.contract_path), 'MP_ROOT': str(out),
                    'MP_EVENTS': str(self.events_path), 'MP_LOAD_LOG': str(self.loads),
                    'PI_OFFLINE': '1', 'UV_THREADPOOL_SIZE': '1', 'OMP_NUM_THREADS': '1',
                    'OPENBLAS_NUM_THREADS': '1', 'TERM': 'xterm-256color', 'TERM_PROGRAM': '', 'TMUX': ''}
        self.probe = runpy.run_path(str(PROBE))
        self.verifier = runpy.run_path(str(VERIFIER))
        self.resources = runpy.run_path(str(HERE / 'matched-memory-allocation.py'))
        self.initial_resources = self.resources['read_resources'](self.cg)
        self.initial_ancestor_events = self.resources['event_counts'](self.initial_resources)
        self.initial_events = self.resource_events()
        self.runtime_dir = None if qualification else Path(tempfile.mkdtemp(prefix='mp-', dir=os.environ['XDG_RUNTIME_DIR']))
        if not qualification:
            self.env.update(MP_CONTROL=str(self.runtime_dir / 'c.sock'), MP_SESSION=str(self.runtime_dir / 's.sock'))
            (out / 'allocation-actual.json').write_text(json.dumps(job['allocation_actual'], indent=2))
        self.initial_scope = self.scope()
        own = os.getpid()
        ancestors = {own}
        while own in self.initial_scope:
            own = self.probe['parse_stat'](proc_stat(own))[0]
            if own in ancestors:
                break
            ancestors.add(own)
        require(set(self.initial_scope) <= ancestors, 'Foreign process in initial admitted scope')

    def resource_events(self):
        return {name: (self.cg / name).read_text() for name in ('memory.events', 'pids.events')}

    def scope(self):
        values = [int(value) for value in (self.cg / 'cgroup.procs').read_text().split()]
        require(values and all(value > 0 for value in values), 'Invisible/empty PID census')
        return sorted(set(values))

    def events(self):
        if not self.events_path.exists():
            return []
        return [json.loads(line) for line in self.events_path.read_text().splitlines() if line.strip()]

    def event(self, id, name, arm=None):
        return any(e['id'] == id and e['event'] == name and (arm is None or e.get('arm') == arm)
                   for e in self.events())

    def command(self, mode, id=''):
        if self.qualification:
            return [sys.executable, '-B', str(HERE / 'matched-driver-faux.py'), mode, id]
        flags = []
        if self.job['artifact']['execution_mode'] == 'frozen-native-source':
            flags = ['--experimental-strip-types', '--import', self.job['artifact']['source_resolver']]
        return [self.job['node'], '--v8-pool-size=1', *flags,
                '--import', str(HERE / 'matched-native-loader.mjs'), str(HERE / 'matched-native-adapter.mjs'), mode, id]

    def spawn(self, mode, id='', terminal=False):
        env = {**self.env, 'MP_ARM': mode, 'PI_CODING_AGENT_DIR': str(self.out / f'{mode}-agent')}
        stdout = (self.out / f'{mode}-{id or "host"}.stderr').open('wb')
        master = slave = None
        command = self.command(mode, id)
        if terminal:
            master, slave = os.openpty()
            rows, columns = self.job['workload']['geometry']
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
            command = (['bash', self.job['bridge'], str(self.runtime_dir / 'c.sock'), id]
                       if mode == 'B' and not self.qualification else self.command(mode, id))
            before = termios.tcgetattr(slave)
            process = subprocess.Popen(command, cwd=self.out, env=env, stdin=slave, stdout=slave, stderr=stdout)
            self.selector.register(master, selectors.EVENT_READ)
            pane = {'arm': mode, 'id': id, 'process': process, 'master': master, 'slave': slave,
                    'tty': os.ttyname(slave), 'before': before, 'bytes': bytearray()}
            self.panes.append(pane)
        else:
            process = subprocess.Popen(command, cwd=self.out, env=env, stdin=subprocess.PIPE, stdout=stdout, stderr=stdout)
        self.children.append((mode, id, process, stdout))
        launch = {'arm': mode, 'id': id, 'pid': process.pid, 'argv': command,
                  'starttime_ticks': self.probe['parse_stat'](proc_stat(process.pid))[1],
                  'cgroup': Path('/proc', str(process.pid), 'cgroup').read_text(),
                  'tty': os.ttyname(slave) if terminal else None, 'at': time.time()}
        self.launches.append(launch)
        with (self.out / 'launches.jsonl').open('a') as stream:
            stream.write(json.dumps(launch) + '\n')
        return process

    def pump(self, seconds):
        end = min(time.monotonic() + seconds, self.end)
        while time.monotonic() < end:
            for key, _ in self.selector.select(max(0, min(.02, end - time.monotonic()))):
                try:
                    data = os.read(key.fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b''
                if not data:
                    self.selector.unregister(key.fd)
                    continue
                pane = next(p for p in self.panes if p['master'] == key.fd)
                require(len(pane['bytes']) + len(data) <= 8 * 1024 * 1024, 'PTY output cap exceeded')
                pane['bytes'].extend(data)
        require(time.monotonic() < self.end, 'Admitted deadline exceeded')

    def wait(self, predicate, phase, limit=30, sampled=False):
        deadline = min(time.monotonic() + limit, self.end)
        next_sample = time.monotonic()
        while not predicate():
            require(time.monotonic() < deadline, f'Owned workload phase timeout: {phase}')
            self.pump(.02)
            if sampled and time.monotonic() >= next_sample:
                self.snapshot(f'{phase}-sampled-peak')
                next_sample = time.monotonic() + .5

    def snapshot(self, phase, omit_pid=None, tool_pids=None):
        before = self.scope()
        records = {}
        parents = {}
        for path in Path('/proc').glob('[0-9]*/stat'):
            try:
                parents[int(path.parent.name)] = self.probe['parse_stat'](path.read_text())[0]
            except (FileNotFoundError, ProcessLookupError):
                continue
        owned = {os.getpid()}
        while True:
            more = {pid for pid, parent in parents.items() if parent in owned}
            if more <= owned:
                break
            owned |= more
        require(owned <= set(before), 'Descendant escaped admitted scope')
        roots = {p.pid: arm for arm, id, p, _ in self.children if p.poll() is None and arm in ('A', 'B')}
        for pid in before:
            if pid == omit_pid:
                continue
            proc = Path('/proc', str(pid))
            first = (proc / 'stat').read_text()
            raw = (proc / 'smaps_rollup').read_text()
            second = (proc / 'stat').read_text()
            parent, start, cpu = self.probe['parse_stat'](first)
            require(start == self.probe['parse_stat'](second)[1], 'PID reused during memory capture')
            require((proc / 'cgroup').read_text() == self.cgroup, 'PID escaped scope')
            rss, pss, swap = self.probe['parse_rollup'](raw)
            require('Pss:' in raw and 'SwapPss:' in raw, 'Unreadable/omitted memory field')
            ancestor, seen = pid, set()
            while ancestor not in roots and ancestor in parents and ancestor not in seen:
                seen.add(ancestor)
                ancestor = parents[ancestor]
            group = roots.get(ancestor, 'common')
            require(pid in owned or pid in self.initial_scope, 'Uncounted/reparented process not launch-owned')
            fields = first.rsplit(')', 1)[1].split()
            threads = int(fields[17])
            task_ids = sorted(int(p.name) for p in (proc / 'task').iterdir())
            require(len(task_ids) == threads, 'Thread census changed')
            records[pid] = {'pid': pid, 'ppid': parent, 'starttime_ticks': start, 'cpu_ticks': cpu,
                            'threads': threads, 'task_ids': task_ids, 'group': group,
                            'exe': os.readlink(proc / 'exe'), 'cmdline': (proc / 'cmdline').read_bytes().decode(errors='replace'),
                            'cwd': os.readlink(proc / 'cwd'), 'cgroup': self.cgroup,
                            'stat_before': first, 'stat_after': second, 'smaps_rollup': raw,
                            'rss_kb': rss, 'pss_kb': pss, 'swappss_kb': swap}
        after = self.scope()
        require(before == after and set(records) == set(before), 'PID census omission/churn')
        if not self.qualification:
            node = str(Path(self.job['node']).resolve())
            for arm in ('A', 'B'):
                live = any(p.poll() is None and mode == arm for mode, _, p, _ in self.children)
                expected = (self.job['N'] if arm == 'A' else 1) if live else 0
                require(sum(p['group'] == arm and p['exe'] == node for p in records.values()) == expected,
                        'Repeated/missing JS host or per-pane JS client')
        totals = {}
        for arm in ('A', 'B', 'common'):
            subset = [p for p in records.values() if p['group'] == arm]
            totals[arm] = self.verifier['recompute'](subset) if subset else None
        require(tool_pids is None or set(tool_pids) <= set(records), 'Actual tool omitted at mid frame')
        resource_rows = self.resources['read_resources'](self.cg)
        if not self.qualification:
            self.resources['check_headroom'](resource_rows, self.initial_ancestor_events)
        sample = {'phase': phase, 'at': time.time(), 'tool_pids': tool_pids,
                  'leaf_ancestor_resources': resource_rows,
                  'scope_pids_before': before, 'scope_pids_after': after,
                  'owned_descendant_pids': sorted(owned),
                  'independent_parent_links': {pid: parents[pid] for pid in owned if pid in parents},
                  'actual_root_launches': list(self.launches),
                  'processes': list(records.values()), 'totals': totals,
                  'tasks_total': sum(p['threads'] for p in records.values()),
                  'memory_current_bytes': int((self.cg / 'memory.current').read_text()),
                  'memory_peak_bytes': (self.cg / 'memory.peak').read_text(),
                  'resource_events': self.resource_events()}
        self.samples.append(sample)
        (self.out / 'samples.jsonl').open('a').write(json.dumps(sample) + '\n')
        (self.out / f'{len(self.samples):04d}-{phase}.pids').write_text('\n'.join(map(str, before)) + '\n')
        return sample

    def prepare_seed(self):
        seed = self.spawn('seed')
        self.wait(lambda: seed.poll() is not None, 'native seed closed', 90)
        require(seed.returncode == 0, 'Native seed creation failed')
        records = json.loads((self.out / 'seed-records.json').read_text())
        require(len(records) == self.job['N'], 'Missing native seed session')
        inventory = {}
        for arm in ('A', 'B'):
            for record in records:
                directory = Path(record['directory'])
                require(directory.is_relative_to(self.out / 'seed-agent'), 'Seed escaped owned root')
                target = self.out / f'{arm}-agent' / directory.relative_to(self.out / 'seed-agent')
                shutil.copytree(directory, target)
                for path in directory.rglob('*'):
                    if path.is_file():
                        relative = str(path.relative_to(directory))
                        require(not relative.endswith('.lock'), 'Seed writer lock retained')
                        value = sha(path)
                        require(sha(target / relative) == value, 'Cloned history mismatch')
                        inventory.setdefault(record['id'], {})[relative] = value
                if arm == 'B':
                    root = self.out / 'B-residency'
                    root.mkdir(exist_ok=True)
                    (root / record['id']).symlink_to(record['cwd'], target_is_directory=True)
                    (root / f"{record['id']}.resident.json").write_text(json.dumps({
                        'sessionId': record['id'], 'cwd': record['cwd'],
                        'nativeSessionId': record['nativeSessionId'], 'directory': str(target)}))
        (self.out / 'seed-bytes.json').write_text(json.dumps(inventory, indent=2))
        self.seed_inventory = inventory

    def verify_clones(self, arms):
        records = json.loads((self.out / 'seed-records.json').read_text())
        for arm in arms:
            for record in records:
                target = self.out / f'{arm}-agent' / Path(record['directory']).relative_to(self.out / 'seed-agent')
                actual = {str(p.relative_to(target)): sha(p) for p in target.rglob('*') if p.is_file()}
                require(actual == self.seed_inventory[record['id']], 'Real cloned seed bytes differ before launch')

    def launch(self, arms):
        self.verify_clones(arms)
        ids = [f'seat-{i}' for i in range(self.job['N'])]
        if 'B' in arms and not self.qualification:
            self.spawn('B')
            self.wait(lambda: self.event('host', 'ready'), 'single native shared host', sampled=True)
        for id in ids:
            for arm in arms:
                self.spawn(arm, id, terminal=True)
        self.wait(lambda: all(self.event(p['id'], 'ready' if p['arm'] == 'A' or self.qualification else 'surface-ready',
                                         p['arm'] if self.qualification else None) for p in self.panes),
                  'real presenters attached', sampled=not self.qualification)
        self.snapshot('attached')

    def storage(self):
        return {str(p): (p.stat().st_mtime_ns, p.stat().st_size) for arm in ('A', 'B')
                for p in (self.out / f'{arm}-agent').rglob('session.sqlite*') if p.is_file()}

    def turn(self, phase):
        panes = [p for p in self.panes if p['process'].poll() is None]
        for pane in panes:
            os.write(pane['master'], f"MP:{pane['id']}:{phase}\r".encode())
        expected = lambda pane: (f"MP-WARM-{pane['id']}" if phase == 'warm' else f"MP-ANSWER-{pane['id']}").encode()
        if phase == 'measure':
            if self.qualification:
                self.wait(lambda: all(self.event(p['id'], 'tool-submitted', p['arm']) for p in panes), 'faux executing barrier')
            else:
                self.wait(lambda: all(self.event(p['id'], 'tool-submitted', p['arm']) for p in panes), 'native tool submissions')
            first = self.snapshot('mid' if self.qualification else 'tool-start-sampled-peak')
            if not self.qualification:
                command = self.job['workload']['tool_sleep_argv']
                def all_tools(sample):
                    return all(any(p['group'] == pane['arm'] and p['cwd'] == str(self.out / 'cwds' / pane['id']) and
                                   p['cmdline'].split('\x00')[:-1] == command for p in sample['processes']) for pane in panes)
                activation_deadline = min(time.monotonic() + 10, self.end)
                while not all_tools(first):
                    require(time.monotonic() < activation_deadline, 'Real executing tool/session absent from census')
                    self.pump(.05)
                    first = self.snapshot('tool-start-sampled-peak')
                first['tool_pids'] = [p['pid'] for p in first['processes'] if p['cmdline'].split('\x00')[:-1] == command]
                self.snapshot('mid', tool_pids=first['tool_pids'])
        while not all(expected(p) in p['bytes'] for p in panes):
            require(time.monotonic() < self.end, 'Owned turn output deadline exceeded')
            self.pump(.5 if not self.qualification else .02)
            self.snapshot(f'{phase}-sampled-peak')
        self.snapshot(f'{phase}-settled')

    def close_owned(self):
        for pane in self.panes:
            if pane['process'].poll() is None:
                os.write(pane['master'], b'\x04')
        self.wait(lambda: all(p['process'].poll() is not None for p in self.panes), 'normal rich exit', 12)
        for arm, id, child, stream in self.children:
            if arm == 'B' and id == '' and child.poll() is None:
                child.stdin.write(b'STOP\n')
                child.stdin.flush()
                child.stdin.close()
        self.wait(lambda: all(p.poll() is not None for _, _, p, _ in self.children), 'owned process join', 12)
        require(all(p.returncode == 0 for _, _, p, _ in self.children), 'Owned native child exit failed')
        terminals = []
        for pane in self.panes:
            after = termios.tcgetattr(pane['slave'])
            terminals.append({'arm': pane['arm'], 'id': pane['id'], 'tty': pane['tty'],
                              'before': pane['before'], 'after': after, 'restored': after == pane['before']})
            require(after == pane['before'], 'Terminal not restored')
            (self.out / f"{pane['arm']}-{pane['id']}.ansi").write_bytes(pane['bytes'])
            if pane['master'] in self.selector.get_map():
                self.selector.unregister(pane['master'])
            for fd in (pane['master'], pane['slave']):
                os.close(fd)
        self.panes = []
        after_scope = self.scope()
        teardown = {'terminals': terminals, 'initial_scope': self.initial_scope, 'scope_after': after_scope,
                    'no_survivors': after_scope == self.initial_scope,
                    'normal_exits': [{'arm': arm, 'id': id, 'pid': child.pid, 'exit': child.returncode}
                                     for arm, id, child, _ in self.children]}
        with (self.out / 'teardown.jsonl').open('a') as stream:
            stream.write(json.dumps(teardown, default=lambda value: {'bytes_hex': value.hex()}) + '\n')
        require(after_scope == self.initial_scope, 'Survivor/unaccounted process after teardown')

    def run(self, omit=False, corrupt_seed=False):
        require(self.qualification or not (omit or corrupt_seed), 'Fault injection is faux-check only')
        try:
            self.prepare_seed()
            if corrupt_seed:
                next((self.out / 'A-agent').rglob('session.sqlite')).write_bytes(b'GENUINE-OWNED-CLONE-MISMATCH')
            orders = [self.job['order']] if self.job['schedule'] == 'paired' else [[a] for a in self.job['order']]
            for order in orders:
                self.launch(order)
                if omit:
                    pid = next(p['process'].pid for p in self.panes if p['arm'] == 'B')
                    self.snapshot('omission-negative', omit_pid=pid)
                self.turn('warm')
                before = self.storage()
                require(before, 'No persisted history idle proof')
                start = time.monotonic()
                while time.monotonic() - start < self.job['idle_s']:
                    self.pump(min(.5, self.job['idle_s'] - (time.monotonic() - start)))
                    require(self.storage() == before, 'Native history not storage-idle')
                    if not self.qualification:
                        self.resources['check_headroom'](self.resources['read_resources'](self.cg), self.initial_ancestor_events)
                self.snapshot('idle')
                self.turn('measure')
                self.close_owned()
            require(self.resource_events() == self.initial_events, 'Resource event delta; capture invalid')
            require(self.qualification or self.loads.exists(), 'No independent loaded-artifact audit')
            if not self.qualification:
                events = self.events()
                for id in (f'seat-{i}' for i in range(self.job['N'])):
                    for phase in ('warm', 'measure'):
                        requests = [next(e for e in events if e['arm'] == arm and e['id'] == id and
                                         e['event'] == 'request' and e['phase'] == phase) for arm in ('A', 'B')]
                        require(requests[0]['history_sha256'] == requests[1]['history_sha256'],
                                'Actual native model-history/workload mismatch across arms')
                    require(all(self.event(id, 'tool-result', arm) for arm in ('A', 'B')),
                            'Missing actual native tool-result proof')
            # Shared control cost stays visible in common; never subtracted for a ratio.
            result = {'status': 'FAUX_DRIVER_ONLY' if self.qualification else 'NATIVE_PAIR_CAPTURED_NOT_100X',
                      'N': self.job['N'], 'schedule': self.job['schedule'], 'bookable_100x': False,
                      'artifact': self.job['artifact'], 'history_sha256': self.job['history_sha256'],
                      'workload_sha256': self.job['workload_sha256'],
                      'instrument_files': self.job.get('instrument_files'),
                      'resource_certificate_scope': 'observed exact N only; not extrapolated N8/32/306',
                      'cross_day_accepted': False, 'full_fleet_accepted': False,
                      'terminal_scope': 'owned native local PTYs; external Ghostty/Herdr NOT in this boundary',
                      'samples': len(self.samples), 'deadline_s': self.job['deadline_s'],
                      'wall_s': time.monotonic() - self.start,
                      'observed_threads_peak': max(s['tasks_total'] for s in self.samples),
                      'observed_scope_memory_peak_bytes': max(int(s['memory_peak_bytes']) for s in self.samples),
                      'sampled_peak_PSS_SwapPss_kib': max(sum(p['pss_kb'] + p['swappss_kb'] for p in s['processes']) for s in self.samples),
                      'peak_is_sampled_not_unobserved_peak_proof': True,
                      'per_arm_totals_keep_common_separate': True,
                      'seed_by_session': self.seed_inventory,
                      'serial_is_claim_contract': False,
                      'product_abi_accepted_by_faux_check': False if self.qualification else None,
                      'normal_exits': [{'arm': arm, 'id': id, 'pid': p.pid, 'exit': p.returncode} for arm, id, p, _ in self.children]}
            if self.runtime_dir is not None:
                self.runtime_dir.rmdir()  # Own sockets must already be removed by normal native shutdown.
            (self.out / 'RESULT.json').write_text(json.dumps(result, indent=2))
            return result
        except Exception as error:
            (self.out / 'INVALID.json').write_text(json.dumps({'error': str(error), 'accepted_rows': 0}))
            # Only normal close/join; no manual signals. The admitted unit owns deadline cleanup.
            self.close_owned()
            raise
        finally:
            for _, _, _, stream in self.children:
                stream.close()
            self.selector.close()


def faux_check(out):
    out.mkdir(parents=True, exist_ok=False)
    job = {'N': 1, 'schedule': 'paired', 'order': ['A', 'B'], 'run_id': 'faux-only',
           'idle_s': 0, 'deadline_s': 12, 'history': [{'role': 'user', 'content': 'fixture', 'timestamp': 1}],
           'workload': {'geometry': [24, 80], 'tool_command': 'FAUX', 'tool_timeout_s': 1},
           'artifact': {'files': {str(HERE / 'matched-driver-faux.py'): sha(HERE / 'matched-driver-faux.py')}}}
    job['history_sha256'] = canonical(job['history'])
    job['workload_sha256'] = canonical(job['workload'])
    positive = Driver(job, out / 'positive', True).run()
    require(positive['normal_exits'] and positive['samples'] >= 4, 'Faux positive did not execute')
    serial_job = {**job, 'schedule': 'serial-exploratory', 'order': ['B', 'A']}
    serial = Driver(serial_job, out / 'serial-exploratory', True).run()
    require([e['arm'] for e in serial['normal_exits']] == ['seed', 'B', 'A'] and
            not serial['serial_is_claim_contract'], 'Counterbalanced serial lifecycle failed')
    tests = []
    for name in ('artifact-mismatch', 'history-mismatch', 'workload-mismatch'):
        changed = json.loads(json.dumps(job))
        if name == 'artifact-mismatch':
            changed['artifact']['files'][str(HERE / 'matched-driver-faux.py')] = '0' * 64
        else:
            changed[name.split('-')[0] + '_sha256'] = '0' * 64
        try:
            Driver(changed, out / name, True)
        except ValueError:
            tests.append({'negative': name, 'rejected_before_spawn': True})
        else:
            raise AssertionError(f'Accepted {name}')
    try:
        Driver(job, out / 'real-cloned-history-mismatch', True).run(corrupt_seed=True)
    except ValueError as error:
        require('Real cloned seed bytes differ' in str(error), 'History negative failed for wrong reason')
        tests.append({'negative': 'genuinely modified owned cloned history bytes', 'rejected': True})
    else:
        raise AssertionError('Modified real clone accepted')
    try:
        Driver(job, out / 'real-live-PID-omission', True).run(omit=True)
    except ValueError as error:
        require('PID census omission' in str(error), 'Omission failed for wrong reason')
        tests.append({'negative': 'omit genuinely running owned B PID', 'rejected': True})
    else:
        raise AssertionError('Omitted live PID accepted')
    summary = {'status': 'OWNED_FAUX_PTY_DRIVER_QUALIFIED', 'positive': positive,
               'serial_exploratory_positive': serial,
               'negatives': tests, 'product_cohorts': 0, 'native_artifact_QA': False,
               'clock_brt': datetime.now().astimezone().strftime('%d/%m/%Y %H:%M:%S %Z')}
    (out / 'CHECK.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--contract', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--faux-check', action='store_true')
    args = parser.parse_args()
    if args.faux_check:
        require(args.contract is None, 'No product contract in faux check')
        faux_check(args.out.resolve())
    else:
        require(args.contract, 'Exact accepted contract required')
        print(json.dumps(Driver(json.loads(args.contract.read_text()), args.out.resolve()).run(), indent=2))


if __name__ == '__main__':
    main()
