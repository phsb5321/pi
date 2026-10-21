"""ONE bounded REAL quality-execution boundary check. No product fixture/scanner/credential/HTTP.
Proves the executor rejects before product: missing qualified artifact -> 78/BLOCKED,
stale T14/T15 tuple -> 3. Negative controls only; no accepting product/coverage/Sonar/ACED.
"""
import ast
from datetime import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys

OWN = Path(__file__).resolve().parent
OUT = OWN / 'evidence/quality-execution-boundary-1009-1530'
assert not OUT.exists(), 'Preserve previous failures/results'
OUT.mkdir()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


(OUT / 'clock.txt').write_text(datetime.now().astimezone().strftime('%d/%m/%Y %H:%M:%S %z') + '\n')
for file in ('quality-entry.py', 'quality-execution.py', 'quality-sonar.py', 'prepare-quality-execution.py', Path(__file__).resolve()):
    ast.parse(Path(file).read_text() if Path(file).is_absolute() else (OWN / file).read_text(),
              filename=str(file))

# Regenerate the derivative manifests with the current preparer (refuses overwrite; scoped to own regenerable files).
for name in ('API-HISTORY.QUALITY.json', 'quality-scanner-metadata.json', 'PROJECT-GATE.T15.QUALITY.json', 'QUALITY-EXECUTION.json'):
    (OWN / name).unlink(missing_ok=True)
with (OUT / 'preparation.log').open('wb') as log:
    prepared = subprocess.run([sys.executable, '-B', str(OWN / 'prepare-quality-execution.py')],
                              stdout=log, stderr=subprocess.STDOUT, timeout=30)
(OUT / 'preparation.exit').write_text(str(prepared.returncode) + '\n')
assert prepared.returncode == 0, 'See preparation.log'

manifest_path = OWN / 'PROJECT-GATE.T15.QUALITY.json'
manifest = json.loads(manifest_path.read_text())
assert manifest['artifactReceipt'] is None and manifest['identity']['distSha256'] is None
plan = manifest['qualityExecution']
assert plan['sourceIdentity'] == {key: manifest['identity'][key] for key in ('tuple', 'sourceSha256', 'inputSha256')}

stale = json.loads(manifest_path.read_text())
stale['identity']['tuple'] = 'T14-stale-negative-control'
(OUT / 'stale-negative-manifest.json').write_text(json.dumps(stale, indent=2) + '\n')

checks = []
for name, path, expected_exit, reason in (
        ('missing-artifact', manifest_path, 78, 'Missing qualified compiled artifact'),
        ('stale-tuple', OUT / 'stale-negative-manifest.json', 3, 'Stale source identity: tuple')):
    argv = [sys.executable, '-B', str(OWN / 'quality-entry.py'), '--manifest', str(path),
            '--evidence', str(OUT / name), '--execute']
    with (OUT / (name + '.log')).open('wb') as log:
        child = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT, timeout=30)
    (OUT / (name + '.exit')).write_text(str(child.returncode) + '\n')
    result_path = OUT / name / 'result.json'
    result = json.loads(result_path.read_text())
    assert child.returncode == result['exit'] == expected_exit and result['blocker'] == reason, result
    assert result['scansSubmitted'] == 0 and result['credentialFetches'] == 0 and result['httpRequests'] == 0
    assert result['compilerInvocations'] == 0 and result['productLaunched'] is False and result['ACED'] is False
    assert result['commandsLaunched'] == 0, result
    assert not (OUT / name / 'sonar').exists(), 'Scanner/readback side effect in rejection path'
    checks.append({'name': name, 'argv': argv, 'exit': child.returncode, 'reason': reason,
                   'logSha256': sha(OUT / (name + '.log')), 'rawResultSha256': sha(result_path)})

summary = {'status': 'QUALITY_EXECUTION_BOUNDARY_CHECK_PASS_NOT_PRODUCT', 'checks': checks,
           'scansSubmitted': 0, 'credentialFetches': 0, 'httpRequests': 0, 'compilerInvocations': 0,
           'commandsLaunched': 0, 'productLaunched': False, 'ACED': False, 'behaviorExecuted': False, 'fixturePositive': False,
           'manifestSha256': sha(manifest_path), 'clock_brt': datetime.now().astimezone().strftime('%d/%m/%Y %H:%M:%S %z')}
(OUT / 'boundary-result.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
