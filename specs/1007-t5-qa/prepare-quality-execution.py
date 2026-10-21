"""Prepare real executor wiring with missing artifact/map/SCM left NULL. No payload/network/secrets."""
import hashlib
import json
from pathlib import Path
import shutil
import sys

OWN = Path(__file__).resolve().parent
ENGINE = Path('/nix/store/rvc5bdlips64617figwb7zdgvv47c5x7-code-slop-gate-0.1.0/libexec/code-slop-gate')


def binding(path):
    path = Path(path).resolve()
    return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def write(path, value):
    assert not path.exists(), 'Preserve previous preparation'
    path.write_text(json.dumps(value, indent=2) + '\n')


def main():
    original = OWN / 'PROJECT-GATE.T15.API-HISTORY.json'
    manifest = json.loads(original.read_text())
    api = json.loads((OWN / 'API-HISTORY.json').read_text())
    api['instrumentFiles'][str(OWN / 'api-history.py')] = binding(OWN / 'api-history.py')['sha256']
    api['supportsOwnedV8Capture'] = True
    api['qualityDelta'] = 'Owned NODE_V8_COVERAGE forwarded to every real native adapter child; native helpers unchanged; compiled path unverified'
    api_path = OWN / 'API-HISTORY.QUALITY.json'
    write(api_path, api)
    manifest['stages']['api-history']['executorContract'] = binding(api_path)
    manifest['stages']['api-history']['executorBinding'] = binding(OWN / 'api-history.py')
    quality = json.loads((OWN / 'QUALITY-CONTRACT.json').read_text())
    scanner_meta = OWN / 'quality-scanner-metadata.json'
    write(scanner_meta, {'version': quality['scanner']['version'], 'binary': binding(quality['scanner']['binary']),
                         'qualification': binding(OWN / 'evidence/instrumentation-1858/scanner-a2-final/result.json')})
    manifest['tools']['sonar'].update(binary=binding(quality['scanner']['binary']), metadata=binding(scanner_meta))
    for name in ('aislop', 'jscpd'):
        manifest['tools'][name]['binary'] = binding(ENGINE / 'node_modules/.bin' / name)
    helpers = [OWN / name for name in ('quality-entry.py', 'quality-execution.py', 'quality-sonar.py', 'quality-coverage.mjs',
               'scanner-fd.py', 'source-map-coverage.mjs', 'source-denominator.mjs', 'incremental-source-binding.mjs',
               'artifact-entry.py', 'project-gate.py', 'api-history.py', 'focused-rich-pty.py', 'rich-host.mjs')]
    helpers += [OWN.parent / '1006-composed-qa/sonar-readback.py', OWN / 'api-history-reuse/matched-memory-allocation.py',
                ENGINE / 'jscpd-snapshot-compare.js']
    plan = {'schema': 'memory-sound-real-quality-execution/1', 'originalPreparation': binding(original),
            'sourceIdentity': {key: manifest['identity'][key] for key in ('tuple', 'sourceSha256', 'inputSha256')},
            'node': binding(shutil.which('node')), 'mapInventory': None, 'candidateScm': None, 'coverageCapture': None,
            'instrumentFiles': {item['path']: item['sha256'] for item in map(binding, helpers)},
            'secretEntry': 'sonar-pi-memory-sound-qa', 'project': quality['projectKey'],
            'sourceConditionScopeChanged': False, 'captureCampaign': 'reuse one actual accepting focused+API campaign V8, all native Node PIDs required; no product rerun',
            'scannerSubmitted': False, 'realExecutionVerified': False}
    manifest['qualityExecution'] = plan
    target = OWN / 'PROJECT-GATE.T15.QUALITY.json'
    command = [str(Path(sys.executable).resolve()), '-B', str(OWN / 'quality-entry.py'), '--manifest', str(target),
               '--evidence', str(OWN / 'evidence/quality-product'), '--execute']
    for name in ('coverage', 'aislop', 'jscpd', 'baseline', 'sonar'):
        manifest['stages'][name].update(command=command, executor=str(OWN / 'quality-entry.py'),
            executorBinding=binding(OWN / 'quality-execution.py'))
    write(target, manifest)
    write(OWN / 'QUALITY-EXECUTION.json', plan)
    old = json.loads(original.read_text())
    assert manifest['identity'] == old['identity'] and manifest['artifactReceipt'] is None
    for key in ('eligibleSources', 'expectedNewSources', 'sourceConditionGraph', 'releaseRelativePartition', 'policy', 'identityFiles'):
        assert manifest[key] == old[key]
    assert len(manifest['eligibleSources']) == 929
    for path, expected in api['instrumentFiles'].items():
        assert binding(path)['sha256'] == expected
    print(json.dumps({'status': 'REAL_EXECUTOR_PREPARATION_NOT_EXECUTED', 'manifest': binding(target),
                      'artifact': None, 'mapInventory': None, 'candidateScm': None, 'coverageCapture': None, 'eligibleSources': 929,
                      'command': command}, indent=2))


if __name__ == '__main__':
    main()
