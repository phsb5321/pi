"""Compiled-only api-history executor. No compiler/admission/polling or memory claim.
Reuse the native adapter and Driver seed/clone/launch/close methods byte-identically.
--execute runs inside an existing normal heavy job, after exact compiled QA PASS.
Without a qualified manifest artifact, return BLOCKED/78 before any product child.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import runpy
import selectors
import shutil
import subprocess
import sys
import tempfile
import time

OWN = Path(__file__).resolve().parent
REUSE = OWN / 'api-history-reuse'
GATE = runpy.run_path(str(OWN / 'project-gate.py'), run_name='api_history_gate')
need, bound = GATE['need'], GATE['bound']
ARTIFACT = runpy.run_path(str(OWN / 'artifact-entry.py'), run_name='api_history_artifact')
MEMORY = runpy.run_path(str(REUSE / 'matched-memory-driver.py'), run_name='api_history_native_helpers')
sha, canonical = MEMORY['sha'], MEMORY['canonical']
EXPORTS = {'createSharedTtyHost', 'main', 'AuthStorage', 'ModelRuntime', 'openDurable', 'runDurableTui'}
ABI = MEMORY['ABI']


def binding(path):
    path = Path(path).resolve()
    return {'path': str(path), 'sha256': sha(path)}


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n')


def preflight(manifest_path):
    manifest = json.loads(Path(manifest_path).read_text())
    contract_binding = manifest['stages']['api-history'].get('executorContract')
    contract = json.loads(bound(contract_binding)) if contract_binding else json.loads((OWN / 'API-HISTORY.json').read_text())
    for name, expected in contract['instrumentFiles'].items():
        need(sha(name) == expected, 'Changed API/history instrument: ' + name)
    need(manifest['schema'] == 'memory-sound-project-gate/1' and manifest['fixture'] is False, 'Product manifest required')
    identity = manifest['identity']
    for key, expected in contract['sourceIdentity'].items():
        need(identity.get(key) == expected, 'Stale source identity: ' + key)
    for label in ('source', 'input'):
        bound(manifest['identityFiles'][label])
        need(manifest['identityFiles'][label]['sha256'] == identity[label + 'Sha256'], 'Manifest source/input mismatch')
    need(manifest.get('artifactReceipt'), 'Missing qualified compiled artifact', 'BLOCKED')
    bound(manifest['artifactReceipt'])
    receipt, actual = ARTIFACT['verify_receipt'](manifest['artifactReceipt']['path'])
    need(not receipt.get('qaFixture'), 'Fixture is not compiled product')
    for key in ('sourceSha256', 'inputSha256', 'distSha256', 'runtimeClosureSha256'):
        need(actual[key] == identity[key], 'Stale compiled artifact identity: ' + key)
    publication_binding = manifest['identityFiles']['publication']
    publication = json.loads(bound(publication_binding))
    need(receipt['producerBindings'].get(publication_binding['path']) == publication_binding['sha256'], 'Publication not artifact-bound')
    need(publication['tuple'] == identity['tuple'] and publication['source_sha256'] == identity['sourceSha256'] and
         publication['input_sha256'] == identity['inputSha256'] and
         publication['status'] == 'accepted-local-optin-compiled-native-rich-host', 'No exact completed producer PASS')
    need(EXPORTS <= set(receipt.get('actualCompiledExports', [])), 'Missing emitted six-export ABI')
    package_root = Path(receipt['root'])
    need(not (package_root / 'src').exists(), 'Source-free package required')
    package_path = package_root / 'package.json'
    need(receipt['runtimeFiles'].get(str(package_path)) == sha(package_path), 'Unbound package metadata')
    package = json.loads(package_path.read_text())
    entry = (package_root / package['exports']['./shared-tty-host']['import']).resolve()
    need(all((package_root / receipt['modules'][role]).resolve() == entry for role in ('msqa/host', 'msqa/auth', 'msqa/models')), 'Second public bundle graph')
    compiled = json.loads(bound(manifest['stages']['compiled']['receipt']))
    need(compiled['executed'] is True and compiled['status'] == 'EXECUTED' and compiled['fixture'] is False and
         compiled['identity'] == identity and compiled['exit'] == 0, 'Exact compiled battery must pass first', 'BLOCKED')
    bound(compiled['log'])
    result = json.loads(bound(compiled['result']))
    need(result['status'] == 'COMPILED_FOCUSED_QA_PASS' and result['identity'] == identity and result['fixture'] is False,
         'Shared source/fixture is not compiled acceptance')
    native_modules = {'memory-proof/shared-tty': {'path': str(entry), 'sha256': sha(entry)}}
    inputs = json.loads(bound(manifest['identityFiles']['input']))
    # Read the producer's physical public package export map, never source/private API guesses.
    for name, package_name, export in (
            ('@earendil-works/pi-ai', '@earendil-works/pi-ai', '.'),
            ('@earendil-works/pi-durable', '@earendil-works/pi-durable', '.'),
            ('@earendil-works/chord/context', '@earendil-works/chord', './context'),
            ('@earendil-works/pi-durable/storage/sqlite/node', '@earendil-works/pi-durable', './storage/sqlite/node')):
        links = [row for row in inputs['aliases_and_dependencies'] if row['path'] == 'node_modules/' + package_name]
        need(len(links) == 1, 'Missing declared native package input: ' + name)
        root = (Path(receipt['sourceRoot']) / links[0]['path']).resolve()
        metadata = json.loads((root / 'package.json').read_text())
        path = (root / metadata['exports'][export]['import']).resolve()
        need(path.suffix in ('.js', '.mjs', '.cjs') and receipt['runtimeFiles'].get(str(path)) == sha(path), 'Native module outside compiled closure: ' + name)
        native_modules[name] = binding(path)
        # Preserve the package's other public import subpaths for real transitive imports.
        for subpath, declaration in metadata['exports'].items():
            if not isinstance(declaration, dict) or not declaration.get('import'):
                continue
            candidate = (root / declaration['import']).resolve()
            if receipt['runtimeFiles'].get(str(candidate)):
                alias = package_name + ('' if subpath == '.' else subpath[1:])
                native_modules[alias] = binding(candidate)
    template = json.loads(bound(contract['nativeJobTemplate']))
    need(template['artifact']['tuple'] == identity['tuple'] and len(template['history']) == 850 and
         canonical(template['history']) == template['history_sha256'] and canonical(template['workload']) == template['workload_sha256'], 'History/workload identity drift')
    job = {**template, 'node': contract['node']['path'], 'bridge': str(package_root / receipt['nativeAttachment']),
           'deadline_s': 150, 'idle_s': 0, 'instrument_files': contract['instrumentFiles'],
           'artifact': {'execution_mode': 'compiled-native', 'modules': native_modules,
                        'files': {**receipt['runtimeFiles'], contract['node']['path']: contract['node']['sha256']}}}
    bound(contract['node'])
    need(ABI <= set(native_modules) and job['N'] == 1 and job['order'] == ['A', 'B'], 'Exact paired native N1 scope required')
    return manifest, contract, job


class ApiDriver(MEMORY['Driver']):
    """Reuse PTY lifecycle, not memory admission, idle, ratio or whole-machine sampling."""
    def __init__(self, job, out):
        self.job, self.out, self.qualification = job, out, False
        self.cgroup, self.cg = MEMORY['cgroup_path']()
        need('desktop-job-slot.service' in self.cgroup, 'Product execution requires normal heavy admission', 'BLOCKED')
        self.resources = runpy.run_path(str(REUSE / 'matched-memory-allocation.py'), run_name='api_history_allocation')
        # The admitted env -i launcher strips INVOCATION_ID: use the retained live unit reader.
        self.allocation = self.resources['read_invocation']()
        self.resources['validate_normal_n1'](self.allocation, job['deadline_s'])
        out.mkdir()
        self.start = time.monotonic()
        self.end = self.start + job['deadline_s']
        self.children, self.panes, self.samples, self.launches = [], [], [], []
        self.selector = selectors.DefaultSelector()
        self.events_path, self.loads = out / 'events.jsonl', out / 'loaded-modules.jsonl'
        self.contract_path = out / 'contract.json'
        write(self.contract_path, job)
        self.runtime_dir = Path(tempfile.mkdtemp(prefix='api-history-', dir=os.environ['XDG_RUNTIME_DIR']))
        self.env = {key: value for key, value in os.environ.items() if key in ('PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR')}
        self.env.update(MP_CONTRACT=str(self.contract_path), MP_ROOT=str(out), MP_EVENTS=str(self.events_path),
                        MP_LOAD_LOG=str(self.loads), MP_SOCKET_ROOT=str(self.runtime_dir),
                        MP_CONTROL=str(self.runtime_dir / 'c.sock'), MP_SESSION=str(self.runtime_dir / 's.sock'),
                        PI_OFFLINE='1', UV_THREADPOOL_SIZE='1', OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1',
                        TERM='xterm-256color', TERM_PROGRAM='', TMUX='')
        if os.environ.get('NODE_V8_COVERAGE'):
            capture = Path(os.environ['NODE_V8_COVERAGE']).resolve()
            need(capture.is_relative_to(OWN / 'evidence') and capture.is_dir(), 'API V8 capture outside owned durable evidence')
            self.env['NODE_V8_COVERAGE'] = str(capture)
        need(sha(MEMORY['PROBE']) == MEMORY['PROBE_SHA'], 'Changed retained process-stat helper')
        self.probe = runpy.run_path(str(MEMORY['PROBE']), run_name='api_history_stat')
        self.initial_scope = self.scope()
        write(out / 'allocation-actual.json', {**self.allocation, 'deadline_s': job['deadline_s'], 'memoryProof': False})

    def command(self, mode, id=''):
        return [self.job['node'], '--v8-pool-size=1', '--max-old-space-size=256', '--import',
                str(REUSE / 'matched-native-loader.mjs'), '--import', str(OWN / 'api-history-network.mjs'),
                str(REUSE / 'matched-native-adapter.mjs'), mode, id]

    def snapshot(self, phase, **unused):
        # ponytail: only owned launch roots and the admitted PID census; memory proof remains a later stage.
        resources = self.resources['read_resources'](self.cg)
        self.resources['check_headroom'](resources)
        row = {'phase': phase, 'scope': self.scope(), 'launches': list(self.launches), 'at': time.time(), 'resources': resources}
        self.samples.append(row)
        with (self.out / 'census.jsonl').open('a') as stream:
            stream.write(json.dumps(row) + '\n')
        return row

    def turn(self, phase):
        panes = [p for p in self.panes if p['process'].poll() is None]
        for pane in panes:
            os.write(pane['master'], f"MP:{pane['id']}:{phase}\r".encode())
        token = 'MP-WARM-' if phase == 'warm' else 'MP-ANSWER-'
        self.wait(lambda: all((token + p['id']).encode() in p['bytes'] for p in panes), 'paired native ' + phase, 60)
        self.snapshot(phase + '-settled')

    def execute(self):
        files = {**self.job['artifact']['files'], **self.job['instrument_files']}
        self.job['instrument_files'] = files
        write(self.contract_path, self.job)
        command = [*self.command('seed')[:-3], str(OWN / 'api-history-probe.mjs')]
        with (self.out / 'six-export-api.log').open('wb') as log:
            child = subprocess.run(command, cwd=self.out, env=self.env, stdout=log, stderr=subprocess.STDOUT, timeout=20)
        write(self.out / 'six-export-invocation.json', {'argv': command, 'exit': child.returncode})
        need(child.returncode == 0, 'Emitted six-export probe failed')
        try:
            self.prepare_seed()
            seed = json.loads((self.out / 'seed-readback-seat-0.json').read_text())
            need(seed['entries'] == 850 and len(seed['readback']) == 850 and seed['store_closed'] is True, 'Native paged history850/closed writer missing')
            self.verify_clones(['A', 'B'])
            write(self.out / 'closed-clones.json', {'verified': True, 'beforeLaunch': True, 'seedBySession': self.seed_inventory})
            self.launch(['A', 'B'])
            need(sum(mode == 'A' and p.poll() is None for mode, _, p, _ in self.children) == 1 and
                 sum(mode == 'B' and id == '' and p.poll() is None for mode, id, p, _ in self.children) == 1, 'Native host census mismatch')
            self.turn('warm')
            self.turn('measure')
            events = self.events()
            for phase in ('warm', 'measure'):
                requests = [next(e for e in events if e['arm'] == arm and e['id'] == 'seat-0' and e['event'] == 'request' and e['phase'] == phase) for arm in ('A', 'B')]
                need(requests[0]['history_sha256'] == requests[1]['history_sha256'] and all(e['messages'] >= 850 for e in requests), 'Actual A/B native model-history differs')
            need(all(self.event('seat-0', 'tool-result', arm) for arm in ('A', 'B')), 'Real tool-result missing')
            self.close_owned()
            need(self.event('seat-0', 'closed', 'A') and self.event('host', 'closed', 'B'), 'Missing normal native close events')
            loaded = [json.loads(line) for line in self.loads.read_text().splitlines()]
            product_files = self.job['artifact']['files']
            for record in loaded:
                need(files.get(record['path']) == record['sha256'], 'Unbound loaded ledger entry')
                need(Path(record['path']).suffix not in ('.ts', '.mts', '.cts') and 'source-resolver' not in record['path'], 'Loaded source fallback')
            for mode, _, child, _ in self.children:
                required = {self.job['artifact']['modules'][name]['path'] for name in ABI}
                need(required <= {row['path'] for row in loaded if row['pid'] == child.pid}, 'Native graph not actually loaded: ' + mode)
            need(all(sha(path) == digest for path, digest in product_files.items()), 'Runtime changed during execution')
            self.runtime_dir.rmdir()
            return {'acceptedScopes': ['six-export-api', 'native-history850', 'same-A-B-history', 'richPTY', 'native-bridge', 'source-free-package', 'normal-teardown'],
                    'historyEntries': 850, 'loadedLedger': binding(self.loads), 'workloadSha256': self.job['workload_sha256'],
                    'historySha256': self.job['history_sha256'], 'memoryProof': False, 'ACED': False,
                    'notAccepted': ['full-fleet', 'RAM100x', 'all ordinary extension/image parity', 'observed coverage', 'Sonar quality']}
        finally:
            if any(child.poll() is None for _, _, child, _ in self.children):
                self.close_owned()  # Normal close only; admitted deadline owns forced cleanup on a defect.
            for _, _, _, stream in self.children:
                stream.close()
            self.selector.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    out = args.evidence.resolve()
    need(out.is_relative_to(OWN / 'evidence'), 'Output outside owned durable evidence')
    out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'BLOCKED', 'exit': 78, 'fixture': False, 'ACED': False, 'productHostLaunched': False,
              'compilerInvocations': 0, 'commandsLaunched': 0, 'acceptedScopes': [], 'historyEntries': None,
              'clock_brt': datetime.now().astimezone().strftime('%d/%m/%Y %H:%M:%S %z')}
    command = [sys.executable, '-B', str(Path(__file__).resolve()), *sys.argv[1:]]
    with (out / 'executor.log').open('w') as log:
        try:
            manifest, contract, job = preflight(args.manifest)
            report['identity'] = manifest['identity']
            report['manifest'] = binding(args.manifest)
            if args.execute:
                driver = ApiDriver(job, out / 'native-run')
                report.update(productHostLaunched=True, commandsLaunched=1)
                report.update(driver.execute(), status='COMPILED_API_HISTORY_PASS', exit=0,
                              commandsLaunched=len(driver.children) + 1)
                receipt = {'status': 'EXECUTED', 'executed': True, 'fixture': False, 'identity': report['identity'],
                           'command': command, 'tool': 'python', 'toolVersion': contract['pythonVersion'],
                           'invocationID': driver.allocation['InvocationID'], 'cgroup': driver.cgroup, 'exit': 0}
            else:
                report.update(status='IDENTITY_VERIFIED_BEHAVIOR_NOT_EXECUTED', exit=78)
        except GATE['Stop'] as error:
            report.update(status=error.status, blocker=error.reason, exit=78 if error.status == 'BLOCKED' else 3)
        except Exception as error:
            report.update(status='FAIL' if report['productHostLaunched'] else 'BLOCKED', blocker=str(error),
                          exit=3 if report['productHostLaunched'] else 78)
        log.write(json.dumps(report, indent=2) + '\n')
    report['rawFiles'] = [binding(path) for path in sorted((out / 'native-run').rglob('*')) if path.is_file()] if (out / 'native-run').exists() else []
    if os.environ.get('NODE_V8_COVERAGE') and report['exit'] == 0:
        report['v8Files'] = [binding(path) for path in sorted(Path(os.environ['NODE_V8_COVERAGE']).glob('coverage-*.json'))]
        report['v8CapturePresent'] = bool(report['v8Files'])
        report['rawFiles'].extend(report['v8Files'])
    write(out / 'result.json', report)
    if report['exit'] == 0:
        receipt.update(log=binding(out / 'executor.log'), result=binding(out / 'result.json'))
        write(out / 'receipt.json', receipt)
    print(json.dumps(report, indent=2))
    return report['exit']


if __name__ == '__main__':
    raise SystemExit(main())
