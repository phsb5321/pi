"""Prepare executable T15 stage wiring; retain original graph/conditions and null artifact.
Copies only an owned derivative manifest; never reads producer publication or launches product.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sys

OWN = Path(__file__).resolve().parent
MEMORY = Path('/home/notroot/Documents/Code/pi-upstream-1006-memory-proof')
RUNTIME = Path('/home/notroot/Documents/Notes-2356-runtime-memory-research/1. Projects/Herdr Fleet Coordination/evidence/runtime-alchemy-2026-10-07/semantic-acceptance')


def binding(path):
    path = Path(path).resolve()
    return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def write(path, value):
    assert not path.exists(), 'Preserve original prepared bytes: ' + str(path)
    path.write_text(json.dumps(value, indent=2) + '\n')


def main():
    original = OWN / 'PROJECT-GATE.T15.json'
    manifest = json.loads(original.read_text())
    paths = [OWN / 'api-history.py', OWN / 'api-history-probe.mjs', OWN / 'api-history-network.mjs',
             OWN / 'prepare-api-history.py', OWN / 'artifact-entry.py', OWN / 'project-gate.py',
             *sorted((OWN / 'api-history-reuse').glob('*'))]
    paths = [path for path in paths if path.is_file()]
    template = MEMORY / 'specs/1006-memory-proof/current-t15-20261008-1308/N1.job.template.json'
    target = OWN / 'api-history-reuse/N1.job.template.json'
    assert not target.exists()
    shutil.copyfile(template, target)
    native = json.loads(target.read_text())
    assert native['N'] == 1 and len(native['history']) == 850
    for name in ('matched-memory-driver.py', 'matched-native-adapter.mjs', 'matched-native-loader.mjs'):
        expected = native['instrument_files'][str(MEMORY / 'tools' / name)]
        assert binding(OWN / 'api-history-reuse' / name)['sha256'] == expected
    metadata_path = OWN / 'api-history-python.json'
    metadata = {'version': sys.version.split()[0], 'binary': binding(sys.executable), 'implementation': sys.implementation.name}
    write(metadata_path, metadata)
    node = binding(shutil.which('node'))
    contract = {'schema': 'memory-sound-api-history-executor/1',
                'sourceIdentity': {key: manifest['identity'][key] for key in ('tuple', 'sourceSha256', 'inputSha256')},
                'originalPreparation': binding(original), 'nativeJobTemplate': binding(target),
                'originalNativeJobTemplate': binding(template), 'node': node, 'python': binding(sys.executable),
                'pythonVersion': sys.version.split()[0], 'instrumentFiles': {item['path']: item['sha256'] for item in map(binding, paths)},
                'runtimeNormalizedReferences': [binding(RUNTIME / name) for name in ('README.md', 'loader.mjs', 'host.mjs', 'run.py')],
                'scope': 'compiled native history850/full paged readback/closed clones/paired rich PTYs/normal teardown, not memory idle or ratio'}
    write(OWN / 'API-HISTORY.json', contract)
    manifest['tools']['python'] = {'version': metadata['version'], 'binary': metadata['binary'],
                                 'metadata': binding(metadata_path), 'packageMetadata': False}
    command = [str(Path(sys.executable).resolve()), '-B', str(OWN / 'api-history.py'), '--manifest',
               str(OWN / 'PROJECT-GATE.T15.API-HISTORY.json'), '--evidence', str(OWN / 'evidence/api-history-product'), '--execute']
    manifest['stages']['api-history'] = {'receipt': None, 'command': command,
            'executor': str(OWN / 'api-history.py'), 'executorBinding': binding(OWN / 'api-history.py'),
            'executorContract': binding(OWN / 'API-HISTORY.json')}
    manifest['apiHistoryPreparation'] = {'original': binding(original), 'behaviorExecuted': False,
                                        'sourceDenominatorChanged': False, 'compilerInvocations': 0}
    write(OWN / 'PROJECT-GATE.T15.API-HISTORY.json', manifest)
    # Structural equality retains every source/condition/SCM partition, including unused arms.
    original_manifest = json.loads(original.read_text())
    assert {key: value for key, value in manifest.items() if key not in ('tools', 'stages', 'apiHistoryPreparation')} == {
        key: value for key, value in original_manifest.items() if key not in ('tools', 'stages')}
    assert {key: value for key, value in manifest['stages'].items() if key != 'api-history'} == {
        key: value for key, value in original_manifest['stages'].items() if key != 'api-history'}
    print(json.dumps({'status': 'EXECUTABLE_PREPARATION_NOT_PRODUCT', 'manifest': binding(OWN / 'PROJECT-GATE.T15.API-HISTORY.json'),
                     'originalUnchanged': binding(original), 'retainedEligibleSources': len(manifest['eligibleSources']),
                     'artifactReceipt': manifest['artifactReceipt'], 'command': command}, indent=2))


if __name__ == '__main__':
    main()
