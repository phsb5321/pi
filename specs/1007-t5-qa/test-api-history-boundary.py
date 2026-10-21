"""ONE bounded admission-boundary check: missing artifact + stale identity, no positive product fixture."""
import ast
from datetime import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys

OWN = Path(__file__).resolve().parent
OUT = OWN / 'evidence/api-history-1008-1458'
assert not OUT.exists(), 'Preserve previous failures/results'
OUT.mkdir()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


(OUT / 'clock.txt').write_text(datetime.now().astimezone().strftime('%d/%m/%Y %H:%M:%S %z') + '\n')
for file in (OWN / 'api-history.py', OWN / 'prepare-api-history.py', Path(__file__).resolve()):
    ast.parse(file.read_text(), filename=str(file))
with (OUT / 'preparation.log').open('wb') as log:
    prepared = subprocess.run([sys.executable, '-B', str(OWN / 'prepare-api-history.py')], stdout=log, stderr=subprocess.STDOUT, timeout=8)
(OUT / 'preparation.exit').write_text(str(prepared.returncode) + '\n')
assert prepared.returncode == 0, 'See full preparation.log'
manifest_path = OWN / 'PROJECT-GATE.T15.API-HISTORY.json'
manifest = json.loads(manifest_path.read_text())
assert manifest['artifactReceipt'] is None and manifest['identity']['distSha256'] is None
stale = json.loads(manifest_path.read_text())
stale['identity']['tuple'] = 'T14-stale-negative-control'
(OUT / 'stale-negative-manifest.json').write_text(json.dumps(stale, indent=2) + '\n')
checks = []
for name, path, expected_exit, reason in (
        ('missing-artifact', manifest_path, 78, 'Missing qualified compiled artifact'),
        ('stale-identity', OUT / 'stale-negative-manifest.json', 3, 'Stale source identity: tuple')):
    argv = [sys.executable, '-B', str(OWN / 'api-history.py'), '--manifest', str(path), '--evidence', str(OUT / name), '--execute']
    with (OUT / (name + '.log')).open('wb') as log:
        child = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT, timeout=8)
    (OUT / (name + '.exit')).write_text(str(child.returncode) + '\n')
    result_path = OUT / name / 'result.json'
    result = json.loads(result_path.read_text())
    assert child.returncode == result['exit'] == expected_exit and result['blocker'] == reason, result
    assert result['commandsLaunched'] == 0 and result['compilerInvocations'] == 0 and result['productHostLaunched'] is False
    assert result['ACED'] is False and not result['acceptedScopes'] and result['historyEntries'] is None
    checks.append({'name': name, 'argv': argv, 'exit': child.returncode, 'reason': reason,
                   'logSha256': sha(OUT / (name + '.log')), 'rawResultSha256': sha(result_path)})
for path in (OWN / 'api-history-probe.mjs', OWN / 'api-history-network.mjs'):
    with (OUT / (path.stem + '-syntax.log')).open('wb') as log:
        child = subprocess.run(['node', '--check', str(path)], stdout=log, stderr=subprocess.STDOUT, timeout=3)
    assert child.returncode == 0
summary = {'status': 'ADMISSION_BOUNDARY_CHECK_PASS_NOT_PRODUCT', 'checks': checks,
           'productCohorts': 0, 'compilerInvocations': 0, 'ACED': False, 'behaviorExecuted': False,
           'manifestSha256': sha(manifest_path), 'fixturePositive': False}
(OUT / 'boundary-result.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
