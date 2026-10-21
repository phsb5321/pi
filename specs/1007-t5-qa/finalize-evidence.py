"""Read-only local final checks; write only the owned durable evidence index."""
import ast
import hashlib
import json
from pathlib import Path

OWN = Path(__file__).resolve().parent
REPO = OWN.parent.parent
RECEIPT = Path('/home/notroot/Documents/Notes/1. Projects/Memory-Sound Program/evidence/execution-wave-2026-10-06/qa/RECEIPT.md')
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
for script in OWN.glob('*.py'):
    ast.parse(script.read_text(), filename=str(script))
accepted = json.loads((OWN / 'evidence/source-a3-selector-api-fix/result.json').read_text())
assert accepted['result'] == 'FOCUSED_RICH_PTY_PASS' and accepted['mode'] == 'source-only'
assert len(accepted['checks']) == 33 and all(row['passed'] for row in accepted['checks'])
assert not accepted['failures'] and accepted['realProviderRequests'] == accepted['rootCheckBuildRuns'] == 0
assert accepted['workerCount'] == 1
assert (OWN / 'source-a3-selector-api-fix.exit').read_text().strip() == '0'
artifact = json.loads((OWN / 'evidence/artifact-boundary-a1/result.json').read_text())
assert artifact['status'] == 'BLOCKED_COMPILED_RICH_HOST_NOT_EMITTED'
assert not artifact['productHostLaunched'] and artifact['compilerInvocations'] == 0
assert artifact['distEntries'] == 2791 and artifact['compiledCatalogues'] == 43
assert artifact['missingDistRowRejected']
assert (OWN / 'artifact-boundary-a1.exit').read_text().strip() == '78'
for run in ('source-a1', 'source-a2-oracle-fix'):
    assert json.loads((OWN / 'evidence' / run / 'result.json').read_text())['result'] == 'FAIL'
    assert (OWN / (run + '.exit')).read_text().strip() == '3'
assert json.loads((OWN / 'evidence/negative-a1/negative-control.json').read_text())['productHostLaunched'] is False
wip = REPO / 'packages/server/test/shared-isolation-recovery.test.ts'
assert sha(wip) == '7a34c5eeac6eb6a4fe017241c98d5523cd3a34c07cae77a287a425863be5145c'
assert 'SOURCE_FOCUSED_33_OF_33_PASS' in RECEIPT.read_text()
assert '2791 rows' in (OWN / 'README.md').read_text()
files = {str(file.relative_to(OWN)): sha(file) for file in sorted(OWN.rglob('*'))
         if file.is_file() and file.name != 'evidence-index.json'}
index = {'schema': 'memory-sound-owned-qa-evidence/1', 'root': str(OWN),
         'sourceChecks': 33, 'sourceExit': 0, 'compiledEligibilityExit': 78,
         'compiledHostAcceptance': False, 'ACED': 'pending-no-scan',
         'preservedWipSha256': sha(wip), 'canonicalReceipt': str(RECEIPT),
         'canonicalReceiptSha256': sha(RECEIPT), 'files': files}
(OWN / 'evidence-index.json').write_text(json.dumps(index, indent=2, sort_keys=True) + '\n')
print(f'PASS durable source33/33 exit0; artifact blocked78; preserved red runs/WIP; {len(files)} indexed owned files')
print('PASS README/canonical receipt persisted; all owned Python syntax parsed')
