"""Bounded read-only final metadata/syntax/custody checks; no product or scanner work."""
import ast
import hashlib
import json
from pathlib import Path

OWN = Path(__file__).resolve().parent
for script in OWN.glob('*.py'):
    ast.parse(script.read_text(), filename=str(script))
source = json.loads((OWN / 'evidence/source-a3-selector-api-fix/result.json').read_text())
assert len(source['checks']) == 33 and all(row['passed'] for row in source['checks']) and not source['failures']
old = json.loads((OWN / 'evidence/artifact-boundary-a1/result.json').read_text())
assert old['distEntries'] == 2791 and old['status'] == 'BLOCKED_COMPILED_RICH_HOST_NOT_EMITTED'
assert not old['productHostLaunched']
wip = OWN.parent.parent / 'packages/server/test/shared-isolation-recovery.test.ts'
assert hashlib.sha256(wip.read_bytes()).hexdigest() == '7a34c5eeac6eb6a4fe017241c98d5523cd3a34c07cae77a287a425863be5145c'
controls = json.loads((OWN / 'evidence/ready-wave-1337/gate-controls-a4-final/result.json').read_text())
assert all(row['passed'] for row in controls['checks']) and len(controls['checks']) == 18
assert controls['compilerInvocations'] == controls['productHostsLaunched'] == 0
negative = json.loads((OWN / 'evidence/ready-wave-1337/t6-source-only-publication-rejected/result.json').read_text())
assert negative['status'] == 'REJECTED' and not negative['productHostLaunched']
grants = json.loads((OWN / 'evidence/ready-wave-1337/sonar-preflight-standard.json').read_text())
assert grants['piProjectCandidates'] == [] and grants['scans'] == 0
print('PASS current Python syntax,18 rejecting gate controls, T5 immutable evidence/WIP, T6 blocked before launch and exact Sonar grant evidence')
