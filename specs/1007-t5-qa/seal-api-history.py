"""Owned metadata/custody seal only; never reruns boundary/product/compiler/quality tests."""
import ast
from datetime import datetime
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import sys

OWN = Path(__file__).resolve().parent
OUT = OWN / 'evidence/api-history-1008-1458'


def binding(path):
    path = Path(path).resolve()
    return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n')


original = OWN / 'PROJECT-GATE.T15.json'
assert binding(original)['sha256'] == '7692ff4f53022ca65490dcf1755f0ee7a3c2884bb5b08e79450afc5b5c2a333d'
contract_path = OWN / 'API-HISTORY.json'
contract = json.loads(contract_path.read_text())
job = json.loads(Path(contract['nativeJobTemplate']['path']).read_text())
allocation = OWN / 'api-history-reuse/matched-memory-allocation.py'
assert binding(allocation)['sha256'] == job['instrument_files']['/home/notroot/Documents/Code/pi-upstream-1006-memory-proof/tools/matched-memory-allocation.py']
for name, expected in contract['instrumentFiles'].items():
    if name != str(OWN / 'api-history.py'):
        assert binding(name)['sha256'] == expected
before = binding(OUT / 'boundary-tested-api-history.py')
assert before['sha256'] == contract['instrumentFiles'][str(OWN / 'api-history.py')]
contract['instrumentFiles'][str(OWN / 'api-history.py')] = binding(OWN / 'api-history.py')['sha256']
contract['instrumentFiles'][str(allocation)] = binding(allocation)['sha256']
contract['postBoundaryDelta'] = {'testedExecutor': before, 'testedManifest': binding(OUT / 'boundary-tested-manifest.json'),
     'reason': 'Native env -i strips INVOCATION_ID; reuse actual unit reader/normal envelope validator. Capture pressure and exact child-command count.',
     'boundaryReruns': 0, 'compiledPathVerified': False}
write(contract_path, contract)
manifest_path = OWN / 'PROJECT-GATE.T15.API-HISTORY.json'
manifest = json.loads(manifest_path.read_text())
manifest['stages']['api-history']['executorBinding'] = binding(OWN / 'api-history.py')
manifest['stages']['api-history']['executorContract'] = binding(contract_path)
write(manifest_path, manifest)
old = json.loads(original.read_text())
assert {key: value for key, value in manifest.items() if key not in ('tools', 'stages', 'apiHistoryPreparation')} == {
    key: value for key, value in old.items() if key not in ('tools', 'stages')}
assert {key: value for key, value in manifest['stages'].items() if key != 'api-history'} == {
    key: value for key, value in old['stages'].items() if key != 'api-history'}
assert manifest['artifactReceipt'] is None and manifest['identity']['distSha256'] is None
for name in ('api-history.py', 'prepare-api-history.py', 'seal-api-history.py'):
    ast.parse((OWN / name).read_text(), filename=name)
# Scope the retained native journal to this invocation; no sibling payload is a deliverable.
journal_path = OUT / 'boundary-unit-journal.jsonl'
rows = [json.loads(line) for line in journal_path.read_text().splitlines()]
rows = [row for row in rows if row.get('USER_INVOCATION_ID') == '0ce4a9dfe22647489b574b61ec326598']
assert any('test-api-history-boundary.py' in row.get('MESSAGE', '') for row in rows)
assert any('915ms CPU' in row.get('MESSAGE', '') for row in rows)
journal_path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
producer = json.loads((OUT / 'producer-boundary/result.json').read_text())
assert producer['check']['exit'] == producer['build']['exit'] == 0 and producer['optin']['exit'] == 1
assert producer['counts']['new_wave_actual_events'] == 1 and producer['counts']['total_actual_events'] == 4
assert producer['source_before']['input_sha256'] != manifest['identity']['inputSha256']
assert producer['compiled_acceptance'] is None
assert binding(OWN.parent.parent / 'packages/server/test/shared-isolation-recovery.test.ts')['sha256'] == '7a34c5eeac6eb6a4fe017241c98d5523cd3a34c07cae77a287a425863be5145c'
assert subprocess.check_output(['git', 'diff', '--cached', '--name-only'], cwd=OWN, text=True) == ''
reader = runpy.run_path(str(allocation), run_name='api_history_seal_allocation')
actual = reader['read_invocation']()
write(OUT / 'seal-allocation-actual.json', actual)
checkpoint = {'status': 'EXECUTABLE_PREPARATION_PRODUCT_BLOCKED', 'manifest': binding(manifest_path),
    'originalManifest': binding(original), 'contract': binding(contract_path), 'boundaryResult': binding(OUT / 'boundary-result.json'),
    'boundaryExecutor': before, 'currentExecutor': binding(OWN / 'api-history.py'),
    'boundaryPositiveProduct': False, 'currentCompiledPathVerified': False, 'boundaryReruns': 0,
    'producerSnapshot': binding(OUT / 'producer-boundary/publication.json'), 'producerResult': binding(OUT / 'producer-boundary/result.json'),
    'productHostLaunched': False, 'compilerInvocations': 0, 'ACED': False,
    'preservedEligibleSources': len(manifest['eligibleSources']), 'actualProducerEventsTotal': 4,
    'clock_brt': datetime.now().astimezone().strftime('%d/%m/%Y %H:%M:%S %z'),
    'sealInvocationID': actual['InvocationID'], 'sealCgroup': actual['cgroup'],
    'tools': {'python': {'version': sys.version, **binding(sys.executable)},
              'node': {'version': subprocess.check_output([contract['node']['path'], '--version'], text=True).strip(), **contract['node']}}}
write(OUT / 'checkpoint.json', checkpoint)
paths = [path for path in OUT.rglob('*') if path.is_file() and path.name not in ('final-bindings.sha256', 'final-custody.log', 'final-custody.exit')]
paths += [OWN / name for name in ('api-history.py', 'api-history-probe.mjs', 'api-history-network.mjs', 'API-HISTORY.json', 'PROJECT-GATE.T15.API-HISTORY.json')]
(OUT / 'final-bindings.sha256').write_text(''.join(f'{binding(path)["sha256"]}  {path}\n' for path in sorted(paths)))
print(json.dumps(checkpoint, indent=2))
