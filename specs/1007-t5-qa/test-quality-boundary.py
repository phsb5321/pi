"""ONE small new prerequisite check. No product fixture, scanner, secret fetch or HTTP."""
import ast
from datetime import datetime
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import sys
import urllib.request

OWN = Path(__file__).resolve().parent
OUT = OWN / 'evidence/quality-execution-1008-1608'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    assert not (OUT / 'boundary-result.json').exists(), 'Preserve the ONE result; do not rerun'
    files = ['quality-entry.py', 'quality-execution.py', 'quality-sonar.py', 'api-history.py', 'prepare-quality-execution.py', 'test-quality-boundary.py']
    for name in files:
        ast.parse((OWN / name).read_text(), filename=name)
    for name in ('quality-coverage.mjs', 'api-history-probe.mjs', 'api-history-network.mjs'):
        argv = ['node', '--v8-pool-size=1', '--max-old-space-size=160', '--check', str(OWN / name)]
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10)
        (OUT / (name + '-syntax.log')).write_bytes(result.stdout)
        assert result.returncode == 0
    # Prepare only: hash existing executables/contracts, retain all source partitions, leave all artifacts NULL.
    with (OUT / 'preparation.log').open('w') as stream:
        original_stdout = sys.stdout
        sys.stdout = stream
        try:
            runpy.run_path(str(OWN / 'prepare-quality-execution.py'), run_name='quality_prepare')['main']()
        finally:
            sys.stdout = original_stdout
    prepared = OWN / 'PROJECT-GATE.T15.QUALITY.json'
    manifest = json.loads(prepared.read_text())
    assert manifest['artifactReceipt'] is None and len(manifest['eligibleSources']) == 929
    inherited = json.loads((OWN / 'PROJECT-GATE.T15.API-HISTORY.json').read_text())
    for key in ('identity', 'policy', 'eligibleSources', 'expectedNewSources', 'sourceConditionGraph', 'releaseRelativePartition', 'identityFiles'):
        assert manifest[key] == inherited[key]
    qualified = {'scanner-fd.py': 'e56990c084b2176adb2a434fb91d8838c7c2ea8feb1531c922e16419fd4bd90b',
                 'source-map-coverage.mjs': 'f2cd72afc683f4b6974ba44cee1538468e6f7c5aab4edf813e421e51f3770f6b',
                 'project-gate.py': '6a077b03c76566f2113a95985f43f3ce5adfb8a25aabf9defae41818051ebd3b'}
    for name, digest in qualified.items():
        assert sha(OWN / name) == digest
    old_api = json.loads((OWN / 'API-HISTORY.json').read_text())
    for path, digest in old_api['instrumentFiles'].items():
        if path != str(OWN / 'api-history.py'):
            assert sha(path) == digest
    attempts = []
    original_popen, original_urlopen = subprocess.Popen, urllib.request.urlopen

    def forbidden(*args, **kwargs):
        attempts.append('forbidden product/scanner/credential/HTTP call')
        raise AssertionError('Boundary reached a side effect')

    subprocess.Popen = forbidden
    urllib.request.urlopen = forbidden
    original_argv = sys.argv
    try:
        entry = runpy.run_path(str(OWN / 'quality-entry.py'), run_name='quality_boundary_entry')
        sys.argv = ['quality-entry.py', '--manifest', str(prepared), '--evidence', str(OUT / 'missing-artifact'), '--execute']
        with (OUT / 'missing-artifact.log').open('w') as stream:
            original_stdout = sys.stdout
            sys.stdout = stream
            try:
                exit_code = entry['main']()
            finally:
                sys.stdout = original_stdout
        assert exit_code == 78 and not attempts
        rejected = json.loads((OUT / 'missing-artifact/result.json').read_text())
        assert rejected['status'] == 'BLOCKED' and rejected['blocker'] == 'Missing qualified compiled artifact'
        assert not rejected['ACED'] and not rejected['productLaunched']
        assert rejected['scansSubmitted'] == rejected['credentialFetches'] == rejected['httpRequests'] == rejected['compilerInvocations'] == 0
        uneligible = json.loads(prepared.read_text())
        uneligible['fixture'] = True
        bad = OUT / 'ineligible-manifest.json'
        bad.write_text(json.dumps(uneligible, indent=2) + '\n')
        sys.argv = ['quality-entry.py', '--manifest', str(bad), '--evidence', str(OUT / 'ineligible'), '--execute']
        with (OUT / 'ineligible.log').open('w') as stream:
            original_stdout = sys.stdout
            sys.stdout = stream
            try:
                bad_exit = entry['main']()
            finally:
                sys.stdout = original_stdout
        assert bad_exit == 3 and not attempts
    finally:
        subprocess.Popen, urllib.request.urlopen, sys.argv = original_popen, original_urlopen, original_argv
    execution = (OWN / 'quality-execution.py').read_text()
    sonar = (OWN / 'quality-sonar.py').read_text()
    coverage = (OWN / 'quality-coverage.mjs').read_text()
    assert "TRANSPORT['run_scanner']" in sonar and "READBACK['get_json']" in sonar
    assert "baseline_id = sonar.completed(task, RELEASE, '1.0.4')" in execution and 'sonar.pin(baseline_id)' in execution
    assert "'SPECIFIC_ANALYSIS'" in sonar and "'value': analysis_id" in sonar
    assert 'self.record(\'sonar\'' in execution and 'self.record(\'coverage\'' in execution
    assert "GATE['evaluate']" in execution and 'convertBoundCoverage' in coverage
    assert 'coverage.merge(converted.coverage)' in coverage and 'API/focused child raw V8 missing' in coverage
    assert "self.env['NODE_V8_COVERAGE'] = str(capture)" in (OWN / 'api-history.py').read_text()
    allocation = runpy.run_path(str(OWN / 'api-history-reuse/matched-memory-allocation.py'), run_name='boundary_allocation')['read_invocation']()
    (OUT / 'boundary-allocation.json').write_text(json.dumps(allocation, indent=2) + '\n')
    result = {'status': 'PREREQUISITE_CHECK_PASS', 'exit': 0, 'clock_brt': datetime.now().astimezone().strftime('%d/%m/%Y %H:%M:%S %z'),
              'missingArtifactExit': exit_code, 'ineligibleExit': bad_exit, 'sideEffectAttempts': attempts,
              'sourceGraphFiles': 929, 'syntax': 'PASS', 'validCodepathInspection': 'STATIC_ONLY',
              'positiveProductExecution': 'UNVERIFIED', 'ACED': False, 'oldControlsRerun': 0,
              'manifest': {'path': str(prepared), 'sha256': sha(prepared)},
              'files': {name: sha(OWN / name) for name in [*files, 'quality-coverage.mjs', 'PROJECT-GATE.T15.QUALITY.json', 'API-HISTORY.QUALITY.json', 'QUALITY-EXECUTION.json']}}
    (OUT / 'boundary-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
