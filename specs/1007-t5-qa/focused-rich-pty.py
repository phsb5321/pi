"""Focused actual T5 rich SDK/PTY source battery; one worker, no paid provider."""
import argparse
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import runpy
import select
import signal
import socket
import sqlite3
import struct
import subprocess
import termios
import time
import uuid
OWN = Path(__file__).resolve().parent
identity_module = runpy.run_path(str(OWN / 'verify-t5.py'), run_name='qa_identity')
ROOT = identity_module['ROOT']
verify = identity_module['verify']
parser = argparse.ArgumentParser()
parser.add_argument('--evidence', required=True)
parser.add_argument('--force-control-fail', action='store_true')
parser.add_argument('--artifact-receipt')
args = parser.parse_args()
EVIDENCE = Path(args.evidence).resolve()
assert EVIDENCE.is_relative_to(OWN / 'evidence'), 'Evidence must be owned durable QA work product'
EVIDENCE.mkdir(parents=True, exist_ok=False)
artifact = None
if args.artifact_receipt:
    receipt_path = Path(args.artifact_receipt).resolve()
    gate = runpy.run_path(str(OWN / 'artifact-entry.py'), run_name='qa_artifact_gate')
    artifact, identity = gate['verify_receipt'](receipt_path)
    ROOT = Path(artifact['sourceRoot'])
else:
    identity = verify()
(EVIDENCE / 'identity.json').write_text(json.dumps(identity, indent=2) + '\n')
if args.force_control_fail:
    (EVIDENCE / 'negative-control.json').write_text(json.dumps({'result': 'REJECTED_INTENTIONAL_FALSE_CONTROL', 'productHostLaunched': False}) + '\n')
    raise SystemExit(3)
# Native sockets alone are disposable runtime bytes. Evidence stays in OWN repo.
SOCKETS = Path(os.environ.get('XDG_RUNTIME_DIR', '/tmp')) / ('qa-t5-' + uuid.uuid4().hex[:10])
SOCKETS.mkdir(mode=0o700)
ENV = {key: value for key, value in os.environ.items() if key in ('PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'NODE_OPTIONS', 'NODE_V8_COVERAGE')}
ENV.update(MSQA_SOURCE=str(ROOT), MSQA_DATA=str(EVIDENCE), MSQA_SOCKET_ROOT=str(SOCKETS),
           UV_THREADPOOL_SIZE='1', OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1')
ARGV = ['node', '--v8-pool-size=1', '--max-old-space-size=192', '--experimental-strip-types', '--import', str(OWN / 'qa-loader.mjs')]
if args.artifact_receipt:
    assert not any(flag in ENV.get('NODE_OPTIONS', '') for flag in ('--import', '--require', '--loader', '-r ')), 'Unqualified NODE_OPTIONS module preload'
    ENV['MSQA_ARTIFACT_RECEIPT'] = str(receipt_path)
    ENV['MSQA_RECEIPT_SHA256'] = hashlib.sha256(receipt_path.read_bytes()).hexdigest()
else:
    ARGV += ['--import', str(ROOT / 'packages/coding-agent/src/experimental/source-resolver.ts')]
ARGV += [str(OWN / ('rich-host.mjs' if artifact else 'rich-host-source-support.mjs'))]
(EVIDENCE / 'invocation.json').write_text(json.dumps({'argv': ARGV, 'mode': 'artifact' if args.artifact_receipt else 'source',
    'cgroup': Path('/proc/self/cgroup').read_text(), 'workerPid': os.getpid(), 'started': time.time(),
    'threadLimits': {'UV_THREADPOOL_SIZE': 1, 'OMP_NUM_THREADS': 1, 'v8Pool': 1}, 'deadlineSeconds': 90}, indent=2) + '\n')
log = (EVIDENCE / 'host.log').open('wb')
host = subprocess.Popen(ARGV, cwd=Path(artifact['root']) if artifact else ROOT, env=ENV, stdout=log, stderr=subprocess.STDOUT)
panes = []
checks = []
failures = []


def check(label, condition):
    checks.append({'check': label, 'passed': bool(condition)})
    print(('PASS ' if condition else 'FAIL ') + label, flush=True)
    if not condition:
        failures.append(label)


def pump():
    for pane in panes:
        if pane.get('closed_fds'):
            continue
        while select.select([pane['master']], [], [], 0)[0]:
            try:
                chunk = os.read(pane['master'], 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            pane['bytes'].extend(chunk)
            assert len(pane['bytes']) <= 4 * 1024 * 1024, 'Unexpected unbounded raw PTY capture'


def wait_for(label, predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        pump()
        if predicate():
            return
        assert host.poll() is None, f'Host exited {host.returncode}: {(EVIDENCE / "host.log").read_text()}'
        time.sleep(0.01)  # bounded sampling of owned subprocess/PTY, not resource admission wait
    raise AssertionError('TIMEOUT ' + label)


def records(name):
    file = EVIDENCE / (name + '.jsonl')
    return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []


def text(pane):
    return pane['bytes'].decode('utf8', errors='replace')


def command(action, **extra):
    with socket.socket(socket.AF_UNIX) as channel:
        channel.settimeout(5)
        channel.connect(str(SOCKETS / 'qa.sock'))
        channel.sendall((json.dumps({'action': action, **extra}) + '\n').encode())
        value = bytearray()
        while not value.endswith(b'\n'):
            chunk = channel.recv(65536)
            if not chunk:
                break
            value.extend(chunk)
        result = json.loads(value)
        assert result['ok'], result
        return result


def launch(session, columns, rows, kitty=False):
    master, slave = pty.openpty()
    before = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
    script = ROOT / 'scripts/shared-tty-attach.sh'
    if args.artifact_receipt:
        artifact = json.loads(Path(args.artifact_receipt).read_text())
        script = Path(artifact['root']) / artifact['nativeAttachment']
        expected = artifact['runtimeFiles'][str(script.resolve())]
        assert hashlib.sha256(script.read_bytes()).hexdigest() == expected, 'Native attachment artifact changed'
    process = subprocess.Popen(['bash', str(script), str(SOCKETS / 'tty.sock'), session], cwd=ROOT,
        env={**ENV, 'TERM': 'xterm-256color', 'TERM_PROGRAM': '', 'COLORTERM': 'truecolor' if kitty else ''},
        stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    pane = {'master': master, 'slave': slave, 'before': before, 'process': process, 'session': session,
            'bytes': bytearray(), 'tty': os.ttyname(slave), 'kitty': kitty}
    panes.append(pane)
    return pane


def type_input(pane, data):
    os.write(pane['master'], data)


def snapshot():
    return command('snapshot')['views']


def idle(session):
    view = snapshot().get(session)
    if not view or 'conversation' not in view:
        return False
    live = view['conversation']['docs'].get('pi.live')
    return live is not None and 'run' not in live and not live.get('compactions')


def new_request(session, token):
    return any(row['id'] == session and token in row['text'] for row in records('requests'))


def census():
    # Only the product children of THIS driver. No unrelated live cohort.
    all_rows = {}
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            value = path.read_text()
            fields = value[value.rfind(')') + 2:].split()
            pid = int(path.parent.name)
            all_rows[pid] = {'pid': pid, 'ppid': int(fields[1]), 'startTicks': fields[19],
                'argv': (path.parent / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace'),
                'exe': str((path.parent / 'exe').resolve())}
        except (OSError, ValueError, IndexError):
            continue
    owned = {os.getpid()}
    while True:
        more = {pid for pid, row in all_rows.items() if row['ppid'] in owned}
        if more <= owned:
            break
        owned |= more
    rows = [all_rows[pid] for pid in sorted(owned) if pid in all_rows]
    (EVIDENCE / 'actual-owned-census.json').write_text(json.dumps(rows, indent=2) + '\n')
    return rows


def stop_pane(pane):
    if pane['process'].poll() is None:
        pane['process'].send_signal(signal.SIGTERM)
        pane['process'].wait(timeout=5)
    pump()
    check('exact termios restored ' + pane['session'], termios.tcgetattr(pane['slave']) == pane['before'])
    check('paste/cursor/alt-screen restoration bytes ' + pane['session'], all(token in pane['bytes'] for token in
          [b'\x1b[?2004l', b'\x1b[?25h', b'\x1b[?1049l']))


def expired(_signal, _frame):
    raise TimeoutError('Owned focused source battery deadline reached')

signal.signal(signal.SIGALRM, expired)
signal.signal(signal.SIGTERM, expired)
signal.setitimer(signal.ITIMER_REAL, 80)

try:
    wait_for('native source host ready', lambda: (EVIDENCE / 'ready.json').exists())
    one = launch('pane-one', 90, 26, True)
    two = launch('pane-two', 110, 31)
    # Replies are fragmented on pane A; B is a heterogeneous legacy terminal.
    wait_for('per-pane Kitty query', lambda: b'\x1b[?u' in one['bytes'] and b'\x1b[?u' in two['bytes'])
    type_input(one, b'\x1b[?7'); type_input(one, b'u\x1b[?1;2c')
    type_input(two, b'\x1b[?1;2c')
    wait_for('two rich surfaces ready', lambda: len([row for row in records('events') if row['type'] == 'ready']) == 2)
    check('two actual distinct native rich PTYs', one['tty'] != two['tty'])
    if artifact:
        # ProcessTerminal enables modifyOtherKeys on a legacy DA response;
        # Kitty A consumes the fragmented flags reply BEFORE its DA sentinel.
        # This observes the actual host, not a separately imported TUI singleton.
        wait_for('actual legacy B fallback after DA', lambda: b'\x1b[>4;2m' in two['bytes'])
        terminal_state = {'ok': True, 'oracle': 'native-PTY-negotiation-wire', 'terminals': [
            {'sessionId': 'pane-one', 'kitty': b'\x1b[>4;2m' not in one['bytes']},
            {'sessionId': 'pane-two', 'kitty': b'\x1b[>4;2m' not in two['bytes']} ]}
    else:
        wait_for('actual Kitty A / legacy B state negotiation', lambda: {row['sessionId']: row['kitty'] for row in command('terminals')['terminals']} == {'pane-one': True, 'pane-two': False})
        terminal_state = command('terminals')
    (EVIDENCE / 'actual-terminal-negotiation.json').write_text(json.dumps(terminal_state, indent=2) + '\n')
    check('actual terminal negotiation is pane-local', {row['sessionId']: row['kitty'] for row in terminal_state['terminals']} == {'pane-one': True, 'pane-two': False})
    check('raw mode applied to both owned PTYs', not (termios.tcgetattr(one['slave'])[3] & termios.ICANON) and not (termios.tcgetattr(two['slave'])[3] & termios.ICANON))
    check('rich alt-screen startup, not thin text surface', b'\x1b[?1049h' in one['bytes'] and b'\x1b[?1049h' in two['bytes'])
    check('writer held and second writer actually refused', command('writer')['ok'])
    check('attached park refused', command('park', id='pane-one')['outcome'] == 'refused-not-quiescent')
    rows = census()
    check('one actual JS host, native bash/nc attachment legs', sum('node' in Path(row['exe']).name for row in rows) == 1 and
          len([row for row in rows if Path(row['exe']).name == 'nc']) == 2)
    # Duplicate TTY lease through actual host: separate control channel, same FD.
    with socket.socket(socket.AF_UNIX) as duplicate:
        duplicate.settimeout(3); duplicate.connect(str(SOCKETS / 'tty.sock'))
        duplicate.sendall(f'MS-TTY-1\npane-one\n{one["tty"]}\nxterm-256color\n\n\n\n'.encode())
        check('actual duplicate terminal renderer refused', b'already has a renderer' in duplicate.recv(4096))
    # Literal bracketed paste is one exact native user input, not a text projection.
    pasted = 'QAA history-proof\n' + 'long-unchanged-' * 330 + ' PASTE_END'
    type_input(one, b'\x1b[200~' + pasted.encode()[:17]); type_input(one, pasted.encode()[17:] + b'\x1b[201~')
    time.sleep(0.05); pump()
    check('bracketed paste is not prematurely submitted', not new_request('pane-one', 'history-proof'))
    type_input(one, b'\r')
    wait_for('actual rich streaming before final', lambda: b'STREAM_START' in one['bytes'])
    check('intermediate rich frame precedes STREAM_END', b'STREAM_END' not in one['bytes'])
    wait_for('A stream completed', lambda: b'STREAM_END' in one['bytes'])
    wait_for('A native idle', lambda: idle('pane-one'))
    request = next(row for row in records('requests') if row['id'] == 'pane-one')
    check('native actual request retains >4096-char multiline paste', request['text'] == pasted and len(request['text']) > 4096)
    type_input(two, b'QAB peer-proof\r')
    wait_for('B own answer', lambda: b'QAB STREAM_START' in two['bytes'] and b'STREAM_END' in two['bytes'])
    wait_for('B native idle', lambda: idle('pane-two'))
    check('no cross-session rich frames', b'QAB' not in one['bytes'] and b'QAA' not in two['bytes'])
    type_input(one, b'QAA tool-proof\r')
    wait_for('native registered tool and consumed actual result', lambda: any(row['id'] == 'pane-one' and
        any(message['role'] == 'toolResult' for message in row['messages']) for row in records('requests')))
    wait_for('tool native idle', lambda: idle('pane-one'))
    check('one real tool effect in A cwd only', (EVIDENCE / 'sessions/pane-one/tool-proof.txt').read_text() == 'one-effect\n' and
        not (EVIDENCE / 'sessions/pane-two/tool-proof.txt').exists())
    # Rich selector commands must not become paid/model prompts.
    prior_requests = len(records('requests'))
    type_input(one, b'/model\r')
    wait_for('rich model selector', lambda: b'Select model:' in one['bytes'])
    type_input(one, b'\x1b'); time.sleep(0.05); pump()
    check('model selector command not sent to faux model', len(records('requests')) == prior_requests)
    type_input(one, b'/agents\r')
    wait_for('rich conversation selector', lambda: b'Switch to:' in one['bytes'])
    type_input(one, b'\x1b'); time.sleep(0.05); pump()
    check('rich conversation selector not sent to faux model', len(records('requests')) == prior_requests)
    # Actual running stream cancellation from rich terminal input while peer works.
    type_input(one, b'QAA cancel-proof\r')
    wait_for('native in-flight cancellation target', lambda: new_request('pane-one', 'cancel-proof'))
    # Native rich view deliberately commits partials on a >=100ms throttle.
    # Abort after an actual committed partial, not merely a scheduled run:
    # an earlier abort correctly leaves no assistant entry to display.
    wait_for('actual committed streaming partial before cancellation', lambda: bool(snapshot()['pane-one']['conversation']['docs'].get('pi.live', {}).get('generation', {}).get('message')))
    cancel_run = snapshot()['pane-one']['conversation']['docs']['pi.live']['run']
    (EVIDENCE / 'cancel-live-run.json').write_text(json.dumps(cancel_run) + '\n')
    type_input(two, b'QAB cancel-peer\r')
    type_input(one, b'\x1b')
    wait_for('native provider signal actually aborted', lambda: any(row['check'] == 'native-provider-abort-signal' for row in records('checks')))
    wait_for('cancelled A actual idle', lambda: idle('pane-one'))
    wait_for('B completes despite A cancel', lambda: new_request('pane-two', 'cancel-peer') and idle('pane-two'))
    resident = json.loads((EVIDENCE / 'sessions/pane-one.resident.json').read_text())
    with sqlite3.connect(f'file:{Path(resident["directory"]) / "session.sqlite"}?mode=ro', uri=True) as db:
        task = json.loads(db.execute('SELECT record FROM tasks WHERE id = ?', (cancel_run['taskId'],)).fetchone()[0])
        settlements = [json.loads(db.execute('SELECT record FROM submissions WHERE id = ?', (identity,)).fetchone()[0]) for identity in cancel_run['inputs']]
    (EVIDENCE / 'actual-cancel-receipts.json').write_text(json.dumps({'task': task, 'submissions': settlements}, indent=2) + '\n')
    check('actual cancelled native task receipt, not a transient view flag', task['state']['outcome']['status'] == 'aborted')
    check('actual cancelled user submission settlement', all(record['status'] == 'unanswered' and record['reason'] == 'aborted' for record in settlements))
    check('peer was not aborted', 'aborted' not in json.dumps(snapshot()['pane-two']))
    # Resize just A through real bridge signalling; only own terminal geometry changes.
    fcntl.ioctl(one['slave'], termios.TIOCSWINSZ, struct.pack('HHHH', 35, 73, 0, 0))
    one['process'].send_signal(signal.SIGWINCH)
    wait_for('actual A resize', lambda: any(row['type'] == 'resized' and row['sessionId'] == 'pane-one' and row['columns'] == 73 and row['rows'] == 35 for row in records('events')))
    check('B unaffected by A resize', not any(row['type'] == 'resized' and row['sessionId'] == 'pane-two' and row['columns'] == 73 for row in records('events')))
    before_id = snapshot()['pane-one']['session']
    (EVIDENCE / 'before-reattach-session.json').write_text(json.dumps(before_id) + '\n')
    peer_detach_offset = len(two['bytes'])
    stop_pane(one)
    wait_for('actual A detach event', lambda: any(row['type'] == 'closed' and row['sessionId'] == 'pane-one' for row in records('events')))
    check('quiescent native A actually parks', command('park', id='pane-one')['outcome'] == 'parked')
    check('native A residency dropped', any(row['id'] == 'pane-one' and not row['live'] and not row['openedRetained'] for row in records('residency')))
    peer_legacy = (two['process'].poll() is None and b'\x1b[>4;0m' not in two['bytes'][peer_detach_offset:]) if artifact else command('terminals')['terminals'][0]['kitty'] is False
    check('legacy peer negotiation survives Kitty surface detach', peer_legacy)
    fresh = launch('pane-one', 80, 24)
    wait_for('reattach ready', lambda: len([row for row in records('events') if row['type'] == 'ready' and row['sessionId'] == 'pane-one']) == 2)
    type_input(fresh, b'\x1b[?1;2c')
    after_id = snapshot()['pane-one']['session']
    check('reattach same native id/store/cwd', before_id == after_id)
    type_input(fresh, b'QAA recall-proof\r')
    wait_for('actual resumed model context', lambda: new_request('pane-one', 'recall-proof'))
    wait_for('resumed native idle', lambda: idle('pane-one'))
    recall = next(row for row in reversed(records('requests')) if row['id'] == 'pane-one')
    check('actual model context recalls full persisted history/tools', pasted in json.dumps(recall['messages'], ensure_ascii=False).replace('\\n', '\n') and
          any(message['role'] == 'toolResult' for message in recall['messages']) and 'QAB' not in json.dumps(recall))
    # Save real native store/session state before abrupt host loss, then kill ONLY
    # this owned child. The native attachment must restore its own PTY and exit.
    (EVIDENCE / 'final-rich-views.json').write_text(json.dumps(snapshot(), indent=2) + '\n')
    if ENV.get('NODE_V8_COVERAGE'):
        assert Path(ENV['NODE_V8_COVERAGE']).resolve().is_relative_to(OWN / 'evidence'), 'Coverage bytes must be owned durable evidence'
        command('coverage')
    pump()
    loss_offsets = {pane['tty']: len(pane['bytes']) for pane in (fresh, two)}
    host.kill(); host.wait(timeout=5)
    for pane in (fresh, two):
        pane['process'].wait(timeout=5); pump()
        check('host-loss exact termios restore ' + pane['session'], termios.tcgetattr(pane['slave']) == pane['before'])
        restored = pane['bytes'][loss_offsets[pane['tty']]:]
        check('host-loss protocol restoration ' + pane['session'], all(token in restored for token in (b'\x1b[?2004l', b'\x1b[?25h', b'\x1b[?1049l')))
    for record_file in (EVIDENCE / 'sessions').glob('*.resident.json'):
        resident = json.loads(record_file.read_text())
        database = Path(resident['directory']) / 'session.sqlite'
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
            integrity = db.execute('PRAGMA integrity_check').fetchone()[0]
        check('actual SQLite integrity after host loss ' + resident['sessionId'], integrity == 'ok')
    check('preserved failing host-count control rejects 2 instead of1', 2 != sum('node' in Path(row['exe']).name for row in rows))
    if artifact:
        loaded = records('loaded-runtime')
        actual = {row['path'] for row in loaded}
        required = {str((Path(artifact['root']) / artifact['modules'][role]).resolve()) for role in gate['ROLES']}
        check('all required actual compiled native/rich modules loaded and qualified', required <= actual and bool(loaded))
        check('no product TypeScript/source-resolver actually loaded', all(not row['path'].endswith(('.ts', '.mts', '.cts')) and 'source-resolver' not in row['path'] for row in loaded))
except Exception as error:
    failures.append(str(error))
    print('FAIL ' + str(error), flush=True)
finally:
    signal.setitimer(signal.ITIMER_REAL, 0)
    for pane in panes:
        if pane['process'].poll() is None:
            try:
                pane['process'].send_signal(signal.SIGTERM); pane['process'].wait(timeout=3)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pane['process'].kill(); pane['process'].wait(timeout=3)
        pump()
        (EVIDENCE / f'pty-{panes.index(pane)}-{pane["session"]}.raw').write_bytes(pane['bytes'])
        (EVIDENCE / f'termios-{panes.index(pane)}.json').write_text(json.dumps({'before': repr(pane['before']), 'after': repr(termios.tcgetattr(pane['slave']))}) + '\n')
        os.close(pane['master']); os.close(pane['slave']); pane['closed_fds'] = True
    if host.poll() is None:
        host.terminate()
        try: host.wait(timeout=5)
        except subprocess.TimeoutExpired: host.kill(); host.wait(timeout=3)
    log.close()
    result = {'result': 'FAIL' if failures else 'FOCUSED_RICH_PTY_PASS', 'mode': 'artifact' if args.artifact_receipt else 'source-only',
        'identity': identity, 'checks': checks, 'failures': failures, 'hostExit': host.returncode,
        'notProven': ['compiled acceptance' if not args.artifact_receipt else 'CI/live', 'full-fleet/RAM100x', 'all rich commands/images/accessibility parity', 'ACED'],
        'realProviderRequests': 0, 'rootCheckBuildRuns': 0, 'workerCount': 1}
    (EVIDENCE / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(result['result'], flush=True)
raise SystemExit(3 if failures else 0)
