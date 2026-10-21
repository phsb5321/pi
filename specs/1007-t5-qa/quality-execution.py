"""Real serial quality execution. Prerequisite-only unless --execute is explicit.
No compiler, admission, provider, token creation or artifact/CE polling.
Qualified scanner/V8/readback helpers remain unchanged. Never fabricate missing data.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tarfile
import time

OWN = Path(__file__).resolve().parent
REPO = OWN.parent.parent
GATE = runpy.run_path(str(OWN / 'project-gate.py'), run_name='quality_project_gate')
need, bound = GATE['need'], GATE['bound']
ARTIFACT = runpy.run_path(str(OWN / 'artifact-entry.py'), run_name='quality_artifact')
SONAR = runpy.run_path(str(OWN / 'quality-sonar.py'), run_name='quality_sonar')
RELEASE = '7c10bd4337495ee613f2224843ecdf349b80d1df'
TREE = 'de4e0ad2e4ca4d3bf80a6e89d1bec453edbc85a0'
ENGINE = Path('/nix/store/rvc5bdlips64617figwb7zdgvv47c5x7-code-slop-gate-0.1.0/libexec/code-slop-gate')


def binding(path):
    path = Path(path).resolve()
    return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def write(path, data):
    Path(path).write_text(json.dumps(data, indent=2) + '\n')


def preflight(path):
    manifest = json.loads(Path(path).read_text())
    need(manifest['schema'] == 'memory-sound-project-gate/1' and manifest['fixture'] is False, 'Product quality manifest required')
    identity = manifest['identity']
    plan = manifest['qualityExecution']
    for key, expected in plan['sourceIdentity'].items():
        need(identity.get(key) == expected, 'Stale source identity: ' + key)
    need(manifest.get('artifactReceipt'), 'Missing qualified compiled artifact', 'BLOCKED')
    bound(manifest['artifactReceipt'])
    artifact, actual = ARTIFACT['verify_receipt'](manifest['artifactReceipt']['path'])
    need(not artifact.get('qaFixture') and manifest['policy'] == GATE['POLICY'], 'Fixture or relaxed quality policy')
    need(identity.get('tuple'), 'Actual tuple missing', 'BLOCKED')
    for key in ('sourceSha256', 'inputSha256', 'distSha256', 'runtimeClosureSha256'):
        need(actual[key] == identity.get(key), 'Quality artifact identity mismatch: ' + key)
    publication_binding = manifest['identityFiles']['publication']
    publication = json.loads(bound(publication_binding))
    need(artifact['producerBindings'].get(publication_binding['path']) == publication_binding['sha256'], 'Publication not artifact-bound')
    need(publication['tuple'] == identity['tuple'] and publication['source_sha256'] == identity['sourceSha256'] and
         publication['input_sha256'] == identity['inputSha256'] and publication['status'] == 'accepted-local-optin-compiled-native-rich-host', 'No genuine completed publication')
    for stage in ('compiled', 'api-history'):
        record = json.loads(bound(manifest['stages'][stage]['receipt']))
        need(record['status'] == 'EXECUTED' and record['executed'] is True and record['fixture'] is False and
             record['identity'] == identity and record['exit'] == 0, 'Exact compiled/API PASS prerequisite missing', 'BLOCKED')
        bound(record['log'])
        result = json.loads(bound(record['result']))
        need(result['identity'] == identity and result['fixture'] is False, 'Stale compiled/API result')
        if stage == 'compiled':
            need(result['status'] == 'COMPILED_FOCUSED_QA_PASS', 'Compiled focused behavior not accepted')
        else:
            need(result['status'] == 'COMPILED_API_HISTORY_PASS' and result['historyEntries'] == 850 and
                 {'six-export-api', 'native-history850', 'same-A-B-history', 'richPTY', 'native-bridge', 'source-free-package', 'normal-teardown'} <= set(result['acceptedScopes']), 'Incomplete API/native history prerequisite')
            bound(result['loadedLedger'])
    need(manifest['projectKey'] == SONAR['PROJECT'], 'Wrong private project scope')
    quality = json.loads((OWN / 'QUALITY-CONTRACT.json').read_text())
    need(quality['projectKey'] == SONAR['PROJECT'] and quality['host'] == SONAR['HOST'] and quality['visibility'] == 'private', 'Wrong Sonar contract')
    access = json.loads(bound(quality['accessProof']))
    need(access['project']['key'] == SONAR['PROJECT'] and access['project']['visibility'] == 'private' and
         access['tokenMetadata']['type'] == 'PROJECT_ANALYSIS_TOKEN' and access['tokenMetadata']['projectKey'] == SONAR['PROJECT'] and
         access['storedAnalysisTokenAuthenticationVerified'] is True, 'Verified scoped access proof missing')
    need(quality['token']['rbwEntry'] == 'sonar-pi-memory-sound-qa', 'Wrong credential entry')
    for path, digest in plan['instrumentFiles'].items():
        need(binding(path)['sha256'] == digest, 'Quality helper drift: ' + path)
    for name in ('python', 'sonar', 'aislop', 'jscpd'):
        bound(manifest['tools'][name]['binary'])
        bound(manifest['tools'][name]['metadata'])
    need(binding(sys.executable) == manifest['tools']['python']['binary'], 'Wrong actual Python executor')
    bound(plan['node'])
    need(plan.get('mapInventory'), 'Actual composed-map inventory missing', 'BLOCKED')
    maps = json.loads(bound(plan['mapInventory']))
    need(artifact['producerBindings'].get(plan['mapInventory']['path']) == plan['mapInventory']['sha256'], 'Map inventory not publisher-bound')
    need(maps['root'] == artifact['sourceRoot'], 'Stale map source root')
    need(plan.get('coverageCapture'), 'ONE actual compiled/API-child V8 capture missing', 'BLOCKED')
    capture = json.loads(bound(plan['coverageCapture']))
    need(capture['identity'] == identity and capture['fixture'] is False and
         capture['compiledReceipt'] == manifest['stages']['compiled']['receipt'] and
         capture['apiReceipt'] == manifest['stages']['api-history']['receipt'], 'V8 not from exact accepting compiled/API campaign')
    bound(capture['focusedReady'])
    for file in capture['v8']:
        bound(file)
    for key in ('sourceConditionGraph', 'releaseRelativePartition'): 
        doc = json.loads(bound(manifest[key]))
        need(doc['identity'] == {key: identity[key] for key in ('tuple', 'sourceSha256', 'inputSha256')}, 'Stale denominator/SCM partition')
    need(manifest.get('candidateRevision') and plan.get('candidateScm'), 'Actual candidate SCM provenance missing', 'BLOCKED')
    scm = json.loads(bound(plan['candidateScm']))
    need(artifact['producerBindings'].get(plan['candidateScm']['path']) == plan['candidateScm']['sha256'], 'SCM attestation not original-bound')
    need(scm['revision'] == manifest['candidateRevision'] and scm['identity'] == identity, 'Wrong actual candidate SCM identity')
    need(subprocess.check_output(['git', '-C', scm['repository'], 'rev-parse', scm['revision'] + '^{commit}'], text=True, timeout=10).strip() == scm['revision'], 'Invented SCM revision')
    need(subprocess.check_output(['git', '-C', scm['repository'], 'rev-parse', scm['revision'] + '^{tree}'], text=True, timeout=10).strip() == scm['tree'], 'SCM tree mismatch')
    need(subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', RELEASE + '^{tree}'], text=True, timeout=10).strip() == TREE, 'Released baseline tree mismatch')
    need(quality['cloneRatchet']['originalGitBaseline'] == GATE['POLICY']['cloneBaseline'], 'Clone baseline reset')
    # Do not mutate the native helpers: API V8 forwarding is an explicit glue prerequisite.
    api_contract = json.loads(bound(manifest['stages']['api-history']['executorContract']))
    need(api_contract.get('supportsOwnedV8Capture') is True, 'API child V8 forwarding not prepared', 'BLOCKED')
    return manifest, artifact, plan, scm


class Execution:
    def __init__(self, manifest, artifact, plan, scm, out, command):
        self.manifest, self.artifact, self.plan, self.scm, self.out, self.command = manifest, artifact, plan, scm, out, command
        self.identity = manifest['identity']
        self.reader = runpy.run_path(str(OWN / 'api-history-reuse/matched-memory-allocation.py'), run_name='quality_allocation')
        self.allocation = self.reader['read_invocation']()
        self.reader['validate_normal_n1'](self.allocation, 650)
        self.deadline = min(time.monotonic() + 650, self.allocation['deadline_monotonic'] - 25)
        self.env = {key: value for key, value in os.environ.items() if key in ('PATH', 'HOME', 'LANG', 'USER', 'LOGNAME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS')}
        self.env.update(UV_THREADPOOL_SIZE='1', OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', PYTHONDONTWRITEBYTECODE='1')
        self.receipts, self.commands = {}, []
        self.cg = Path(self.allocation['actual_bounds_and_pressure'][0]['path'])
        self.allocation_file = out / ('allocation-' + self.allocation['InvocationID'] + '.json')
        write(self.allocation_file, self.allocation)

    def run(self, name, argv, *, extra=None, timeout=120):
        self.reader['check_headroom'](self.reader['read_resources'](self.cg))
        remaining = self.deadline - time.monotonic()
        need(remaining > 20, 'Owned quality deadline reached', 'BLOCKED')
        timeout = min(timeout, remaining - 15)
        log = self.out / (name + '.log')
        with log.open('wb') as stream:
            child = subprocess.run(argv, env={**self.env, **(extra or {})}, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
        self.commands.append({'name': name, 'argv': argv, 'exit': child.returncode, 'log': binding(log)})
        write(self.out / 'commands.json', self.commands)
        need(child.returncode == 0, 'Actual command RED: ' + name)
        return log

    def record(self, stage, result, log, tool='python'):
        result.update(identity=self.identity, fixture=False)
        result.setdefault('rawFiles', []).append(binding(self.allocation_file))
        result_path = self.out / (stage + '-result.json')
        write(result_path, result)
        receipt = {'status': 'EXECUTED', 'executed': True, 'identity': self.identity, 'fixture': False,
                   'command': self.command, 'tool': tool, 'toolVersion': self.manifest['tools'][tool]['version'],
                   'invocationID': self.allocation['InvocationID'], 'cgroup': self.allocation['cgroup'], 'exit': 0,
                   'log': binding(log), 'result': binding(result_path)}
        receipt_path = self.out / (stage + '-receipt.json')
        write(receipt_path, receipt)
        self.receipts[stage] = binding(receipt_path)
        write(self.out / 'stage-bindings.json', self.receipts)

    def capture(self, manifest_path):
        # ponytail: reuse the ONE real accepting QA/API campaign's V8, not another product run.
        capture = json.loads(bound(self.plan['coverageCapture']))
        compiled = json.loads(bound(self.manifest['stages']['compiled']['receipt']))
        compiled_result = json.loads(bound(compiled['result']))
        need(capture['focusedReady'] in compiled_result['rawFiles'], 'Focused PID not bound to actual compiled run')
        api_receipt = json.loads(bound(self.manifest['stages']['api-history']['receipt']))
        api = json.loads(bound(api_receipt['result']))
        need(api['identity'] == self.identity and api['status'] == 'COMPILED_API_HISTORY_PASS', 'API capture not exact PASS')
        loaded = [json.loads(line) for line in bound(api['loadedLedger']).decode().splitlines()]
        pids = {row['pid'] for row in loaded}
        pids.add(json.loads(bound(capture['focusedReady']))['hostPid'])
        raw = capture['v8']
        need(raw and len(pids) >= 4, 'Missing native child V8')
        api_raw = api.get('v8Files', [])
        need(api_raw and all(file in raw for file in api_raw), 'Captured API V8 not in complete raw inventory')
        common = os.path.commonpath([self.artifact['sourceRoot'], self.artifact['root']])
        conversion = {'manifest': binding(manifest_path), 'mapInventory': self.plan['mapInventory'],
                      'root': common, 'v8': raw, 'requiredPids': sorted(pids)}
        write(self.out / 'coverage-plan.json', conversion)
        target = self.out / 'mapped'
        target.mkdir()
        log = self.run('mapped-coverage', [self.plan['node']['path'], '--v8-pool-size=1', '--max-old-space-size=1024',
                       str(OWN / 'quality-coverage.mjs'), str(self.out / 'coverage-plan.json'), str(target)])
        coverage = json.loads((target / 'coverage-result.json').read_text())
        coverage['rawFiles'].append(self.plan['coverageCapture'])
        need(coverage['identity'] == self.identity and coverage['newCoverage'] >= 80, 'Actual complete new coverage below80')
        self.record('coverage', coverage, log)
        return coverage, target / 'lcov.info'

    def views(self):
        baseline = self.out / 'pi-upstream-1608-release-view'
        self.run('released-worktree', ['git', '-C', str(REPO), 'worktree', 'add', '--detach', str(baseline), RELEASE], timeout=30)
        need(subprocess.check_output(['git', '-C', str(baseline), 'rev-parse', 'HEAD^{tree}'], text=True).strip() == TREE, 'Release view drift')
        candidate = self.out / 'pi-upstream-1608-candidate-view'
        self.run('candidate-worktree', ['git', '-C', self.scm['repository'], 'worktree', 'add', '--detach', str(candidate), self.scm['revision']], timeout=30)
        rows = json.loads(bound(self.artifact['sourceManifest']))
        for row in rows:
            relative = Path(row['path'])
            need(not relative.is_absolute() and '..' not in relative.parts, 'Analysis view escape')
            source, target = Path(self.artifact['sourceRoot']) / relative, candidate / relative
            need(not target.is_symlink(), 'Existing analysis symlink refused')
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_symlink():
                need(not target.exists(), 'Cannot replace view file with source symlink')
                target.symlink_to(os.readlink(source))
            else:
                shutil.copyfile(source, target)
                target.chmod(0o755 if row['mode'] == '100755' else 0o644)
                need(binding(target)['sha256'] == row['sha256'], 'Candidate view source mismatch')
        write(self.out / 'view-provenance.json', {'releaseCommit': RELEASE, 'releaseTree': TREE,
              'candidateScm': self.plan['candidateScm'], 'frozenSource': self.artifact['sourceManifest'],
              'candidateRevision': self.scm['revision'], 'overlayIdentity': self.identity,
              'revisionIsRealUnderlyingCommitNotInventedFrozenCommit': True})
        return baseline, candidate

    def local(self, candidate):
        baseline = self.out / 'clone-baseline'
        baseline.mkdir()
        archive = self.out / 'clone-baseline.tar'
        with archive.open('wb') as stream:
            subprocess.run(['git', '-C', str(REPO), 'archive', GATE['POLICY']['cloneBaseline']], stdout=stream, check=True, timeout=20)
        with tarfile.open(archive) as stream:
            stream.extractall(baseline, filter='data')
        ais = str((ENGINE / 'node_modules/.bin/aislop').resolve())
        log = self.run('aislop', [self.plan['node']['path'], '--v8-pool-size=1', '--max-old-space-size=1024', ais, 'scan', str(candidate), '--json'])
        actual = json.loads(log.read_text())
        need(actual['summary']['errors'] == 0, 'Actual aislop errors')
        self.record('aislop', {'errors': actual['summary']['errors'], 'rawFiles': [binding(log)]}, log, 'aislop')
        old = subprocess.check_output(['git', '-C', str(REPO), 'ls-tree', '-r', '-z', GATE['POLICY']['cloneBaseline']])
        previous = {row.split(b'\t', 1)[1].decode(): row.split(b'\t', 1)[0].split()[2].decode() for row in old.split(b'\0') if row}
        current = {row['path']: row['blob'] for row in json.loads(bound(self.artifact['sourceManifest']))}
        changes = b''
        for path in sorted(set(previous) | set(current)):
            if previous.get(path) != current.get(path):
                status = 'A' if path not in previous else 'D' if path not in current else 'M'
                changes += status.encode() + b'\0' + path.encode() + b'\0'
        (self.out / 'changes.z').write_bytes(changes)
        jscpd = str((ENGINE / 'node_modules/.bin/jscpd').resolve())
        for label, view in (('clone-baseline', baseline), ('candidate', candidate)):
            target = self.out / (label + '-clones')
            target.mkdir()
            files = [str(file) for file in sorted(view.rglob('*')) if file.is_file() and file.suffix in ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb', '.php') and '.git' not in file.parts]
            self.run(label + '-jscpd', [self.plan['node']['path'], '--v8-pool-size=1', '--max-old-space-size=1024', jscpd,
                '--reporters', 'json', '--silent', '--absolute', '--no-gitignore', '--min-tokens', '50', '--threshold', '100', '--output', str(target), *files])
        log = self.run('clone-ratchet', [self.plan['node']['path'], '--v8-pool-size=1', str(ENGINE / 'jscpd-snapshot-compare.js'),
              '--baseline-report', str(self.out / 'clone-baseline-clones/jscpd-report.json'), '--candidate-report', str(self.out / 'candidate-clones/jscpd-report.json'),
              '--baseline-root', str(baseline), '--candidate-root', str(candidate), '--changes', str(self.out / 'changes.z')])
        actual = json.loads(log.read_text())
        need(actual['summary']['regressions'] == len(actual['regressions']) == 0, 'Actual new clone growth')
        self.record('jscpd', {'baseline': GATE['POLICY']['cloneBaseline'], 'minTokens': 50, 'newCloneGrowth': actual['summary']['regressions'],
                             'rawFiles': [binding(log)]}, log, 'jscpd')

    def execute(self, manifest_path, resume=False):
        if resume:
            saved = json.loads((self.out / 'stage-bindings.json').read_text())
            for stage in ('coverage', 'aislop', 'jscpd'):
                record = json.loads(bound(saved[stage]))
                need(record['identity'] == self.identity and record['exit'] == 0 and record['fixture'] is False, 'Stale resume receipt')
                bound(record['log'])
                result = json.loads(bound(record['result']))
                need(result['identity'] == self.identity, 'Stale resumed result')
                for item in result.get('rawFiles', []):
                    bound(item)
                self.receipts[stage] = saved[stage]
            coverage = json.loads(bound(json.loads(bound(saved['coverage']))['result']))
            lcov = self.out / 'mapped/lcov.info'
            baseline, candidate = self.out / 'pi-upstream-1608-release-view', self.out / 'pi-upstream-1608-candidate-view'
            for row in self.manifest['eligibleSources']:
                need(binding(candidate / row['path'])['sha256'] == row['sha256'], 'Resumed analysis source drift')
            if saved.get('baseline'):
                self.receipts['baseline'] = saved['baseline']
        else:
            coverage, lcov = self.capture(manifest_path)
            baseline, candidate = self.views()
            self.local(candidate)
        # Source-mapped TS path normalization only: candidate bytes must equal the frozen TS.
        normalized = []
        paths = []
        for line in lcov.read_text().splitlines():
            if line.startswith('SF:'):
                source = Path(line[3:])
                relative = source.relative_to(self.artifact['sourceRoot'])
                target = candidate / relative
                need(binding(source)['sha256'] == binding(target)['sha256'], 'LCOV analysis source path/content mismatch')
                paths.append({'source': binding(source), 'analysisSource': binding(target)})
                line = 'SF:' + str(target)
            normalized.append(line)
        candidate_lcov = self.out / 'candidate-lcov.info'
        candidate_lcov.write_text('\n'.join(normalized) + '\n')
        write(self.out / 'lcov-path-provenance.json', {'original': binding(lcov), 'normalized': binding(candidate_lcov), 'paths': paths,
              'generatedJsRelabelled': False})
        sonar_out = self.out / 'sonar'
        sonar_out.mkdir(exist_ok=resume)
        self.reader['check_headroom'](self.reader['read_resources'](self.cg))
        sonar = SONAR['Sonar'](sonar_out, self.deadline)
        release_files = subprocess.check_output(['git', '-C', str(baseline), 'ls-tree', '-r', '--name-only', RELEASE], text=True).splitlines()
        import_re = GATE['re']
        release_sources = [path for path in release_files if import_re.search(r'\.(ts|tsx|js|jsx|mjs|cjs)$', path) and not path.endswith('.d.ts') and not import_re.search(r'(^|/)(test|tests)/|\.(test|spec)\.', path)]
        submission = sonar_out / 'baseline-submission.json'
        if submission.exists():
            saved_submission = json.loads(submission.read_text())
            bound(saved_submission['viewProvenance'])
            task = saved_submission['taskId']
        else:
            report, task = sonar.submit(baseline, '1.0.4', RELEASE, release_sources, sonar_out / 'baseline-scanner.log', sonar_out / 'baseline-task.properties')
            write(submission, {'scanner': report, 'taskId': task, 'viewProvenance': binding(self.out / 'view-provenance.json')})
        if self.receipts.get('baseline'):
            record = json.loads(bound(self.receipts['baseline']))
            actual_baseline = json.loads(bound(record['result']))
            need(record['identity'] == self.identity and actual_baseline['revision'] == RELEASE and actual_baseline['tree'] == TREE, 'Stale actual baseline')
            baseline_id = actual_baseline['analysisId']
        else:
            baseline_id = sonar.completed(task, RELEASE, '1.0.4')
            pin = sonar.pin(baseline_id)
            self.record('baseline', {'projectKey': SONAR['PROJECT'], 'ceStatus': 'SUCCESS', 'analysisId': baseline_id,
                'revision': RELEASE, 'tree': TREE, 'version': '1.0.4', 'newCodeType': pin['type'], 'newCodeValue': pin['value'],
                'rawFiles': [binding(submission), *map(binding, sonar.reads)]}, sonar_out / 'baseline-scanner.log', 'sonar')
        self.reader['check_headroom'](self.reader['read_resources'](self.cg))
        version = self.identity['tuple'] + '-' + self.identity['sourceSha256']
        submission = sonar_out / 'candidate-submission.json'
        if submission.exists():
            saved_submission = json.loads(submission.read_text())
            need(saved_submission['identity'] == self.identity, 'Stale candidate submission')
            task = saved_submission['taskId']
        else:
            report, task = sonar.submit(candidate, version, self.manifest['candidateRevision'],
                 [row['path'] for row in self.manifest['eligibleSources']], sonar_out / 'candidate-scanner.log', sonar_out / 'candidate-task.properties', candidate_lcov)
            write(submission, {'scanner': report, 'taskId': task, 'identity': self.identity})
        analysis_id = sonar.completed(task, self.manifest['candidateRevision'], version)
        result = sonar.candidate(analysis_id, baseline_id, self.manifest, coverage)
        result['rawFiles'] = [binding(sonar_out / 'candidate-submission.json'), *map(binding, sonar.reads)]
        self.record('sonar', result, sonar_out / 'candidate-scanner.log', 'sonar')
        final = json.loads(Path(manifest_path).read_text())
        for stage, record in self.receipts.items():
            final['stages'][stage].update(receipt=record, command=json.loads(bound(record))['command'])
        # Biome/types are real reused producer receipts, never new check/compiler commands.
        for stage in ('biome', 'types'):
            bound(final['stages'][stage]['receipt'])
        write(self.out / 'executed-project-gate.json', final)
        result = GATE['evaluate'](self.out / 'executed-project-gate.json')
        write(self.out / 'project-gate-result.json', result)
        need(result['status'] == 'PROJECT_ACED_PASS' and result['ACED'] is True, 'Actual project gate not ACED')
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--resume', action='store_true', help='Explicit completed-CE boundary only; reuse saved capture/submissions, no polling or rescan')
    args = parser.parse_args()
    out = args.evidence.resolve()
    need(out.is_relative_to(OWN / 'evidence'), 'Evidence outside owned repo')
    # Count every OS command this executor spawns. Popen is the single funnel through which
    # subprocess.run/check_output and the scanner all reach the OS, so wrapping only it counts
    # each command exactly once. The rejection path (preflight stops before its first spawn)
    # must report commandsLaunched=0.
    spawned = [0]
    real_popen = subprocess.Popen
    def counting_popen(*pargs, **pkwargs):
        spawned[0] += 1
        return real_popen(*pargs, **pkwargs)
    subprocess.Popen = counting_popen
    if args.resume:
        need(args.execute and out.is_dir() and (out / 'stage-bindings.json').is_file(), 'No owned resumable stage state')
        previous = out / 'result.json'
        if previous.exists():
            saved_result = out / ('result-before-resume-' + binding(previous)['sha256'] + '.json')
            need(not saved_result.exists(), 'Repeated unchanged resume refused')
            saved_result.write_bytes(previous.read_bytes())
    else:
        out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'BLOCKED', 'exit': 78, 'ACED': False, 'scansSubmitted': 0, 'credentialFetches': 0,
              'httpRequests': 0, 'productLaunched': False, 'compilerInvocations': 0, 'commandsLaunched': 0,
              'clock_brt': datetime.now().astimezone().strftime('%d/%m/%Y %H:%M:%S %z')}
    try:
        manifest, artifact, plan, scm = preflight(args.manifest)
        if args.execute:
            report.update(status='EXECUTING')
            command = [str(Path(sys.executable).resolve()), '-B', str(OWN / 'quality-entry.py'), *sys.argv[1:]]
            execution = Execution(manifest, artifact, plan, scm, out, command)
            report.update(executionStarted=True)
            result = execution.execute(args.manifest, args.resume)
            report.update(status=result['status'], exit=0, ACED=True)
        else:
            report['blocker'] = 'Prerequisites verified; execution not requested'
    except GATE['Stop'] as error:
        report.update(status=error.status, blocker=error.reason, exit=78 if error.status == 'BLOCKED' else 3)
    except SONAR['Pending']:
        report.update(status='BLOCKED', exit=78, blocker='Actual CE pending; explicit later readback only, no polling/rescan')
    except Exception as error:
        # Exception text may come from secret-bearing HTTP/scanner failures: persist only type.
        report.update(status='FAIL' if report.get('executionStarted') else 'BLOCKED', blocker=type(error).__name__,
                      exit=3 if report.get('executionStarted') else 78)
    finally:
        submissions = list(out.glob('sonar/*-submission.json'))
        report['scansSubmitted'] = len(submissions)
        effects = out / 'sonar/effects.jsonl'
        if effects.exists():
            rows = [json.loads(line) for line in effects.read_text().splitlines()]
            report.update(credentialFetches=sum(row['kind'] == 'credential-get' for row in rows),
                          httpRequests=sum(row['kind'] == 'http' for row in rows),
                          scannerLaunchAttempts=sum(row['kind'] == 'scanner-launch' for row in rows))
        report['commandsLaunched'] = spawned[0]
        write(out / 'result.json', report)
        print(json.dumps(report, indent=2))
    return report['exit']


if __name__ == '__main__':
    raise SystemExit(main())
