"""One-shot exact T5 dist verification and compiled-rich-PTY eligibility gate.
No compiler/install/scanner; no source-product fallback. Exit 78 means blocked.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

OWN = Path(__file__).resolve().parent
IDENTITY = runpy.run_path(str(OWN / 'verify-t5.py'), run_name='qa_identity')
BASE, ROOT = IDENTITY['BASE'], IDENTITY['ROOT']
MODULES = {
    'msqa/ai': 'packages/ai/dist/index.js',
    'msqa/tui': 'packages/tui/dist/index.js',
    'msqa/auth': 'packages/coding-agent/dist/core/auth-storage.js',
    'msqa/models': 'packages/coding-agent/dist/core/model-runtime.js',
    'msqa/host': 'packages/coding-agent/dist/experimental/durable/shared-tty-host.js',
    'msqa/theme': 'packages/coding-agent/dist/modes/interactive/theme/theme.js',
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()


def merkle(rows):
    level = [bytes.fromhex(digest(b'leaf\0' + encode(row))) for row in rows]
    if not level:
        return digest(b'empty\0')
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        level = [bytes.fromhex(digest(b'node\0' + level[i] + level[i + 1]))
                 for i in range(0, len(level), 2)]
    return level[0].hex()


def require_dist(rows, accepted):
    assert digest(encode(rows)) == accepted['dist_manifest_sha256'], 'Dist inventory SHA mismatch'
    assert merkle(rows) == accepted['dist_merkle_sha256'], 'Dist Merkle mismatch'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--publication', required=True, help='Exact build-owner acceptance.json')
    parser.add_argument('--evidence', required=True, help='New owned evidence directory')
    parser.add_argument('--artifact-receipt', help='Qualified compiled/runtime-closure receipt, schema memory-sound-qa-artifact/1')
    parser.add_argument('--execute', action='store_true', help='Run one focused compiled battery only after all gates')
    args = parser.parse_args()
    evidence = Path(args.evidence).resolve()
    assert evidence.is_relative_to(OWN / 'evidence'), 'Evidence must stay in owned QA work product'
    evidence.mkdir(parents=True, exist_ok=False)
    report = {'status': 'REJECTED', 'productHostLaunched': False, 'compilerInvocations': 0}
    try:
        identity = IDENTITY['verify']()
        accepted_path = Path(args.publication).resolve()
        accepted = json.loads(accepted_path.read_text())
        assert accepted['source']['source'] == str(ROOT)
        assert accepted['source']['source_sha256'] == identity['sourceSha256']
        assert accepted['source']['input_sha256'] == identity['inputSha256']
        assert accepted['claims']['full_root_check'] and accepted['claims']['offline_build']
        actual_result = json.loads((BASE / 'evidence/attempt-4/result.json').read_text())
        assert actual_result['check']['exit'] == actual_result['build']['exit'] == 0
        assert actual_result['check']['argv'] == ['npm', 'run', 'check']
        assert actual_result['build']['argv'] == ['npm', 'run', 'build:offline']
        assert actual_result['identity_stable'] and actual_result['source_stable_after_build']
        # Physical inventory, not just reading the owner's reported digest.
        rows = []
        for directory, dirs, files in os.walk(ROOT / 'packages', followlinks=False):
            dirs[:] = [name for name in dirs if name != 'node_modules']
            if '/dist/' not in directory + '/':
                continue
            for name in files + [name for name in dirs if (Path(directory) / name).is_symlink()]:
                file = Path(directory) / name
                data = os.readlink(file).encode() if file.is_symlink() else file.read_bytes()
                rows.append({'path': str(file.relative_to(ROOT)), 'sha256': digest(data),
                             'mode': oct(file.lstat().st_mode & 0o777),
                             'kind': 'symlink' if file.is_symlink() else 'file', 'bytes': len(data)})
        rows.sort(key=lambda row: row['path'])
        expected = json.loads((BASE / 'evidence/attempt-4/dist-manifest.json').read_text())
        assert rows == expected == actual_result['dist'], 'Missing/extra/drifted physical dist entries'
        require_dist(rows, accepted)
        assert len(rows) == accepted['dist_entries'] == 2791
        assert sum(row['bytes'] for row in rows) == accepted['dist_bytes'] == 29414213
        inputs = json.loads((BASE / 'evidence/preflight-input-manifest.json').read_text())
        for name, sha in inputs['catalogue_files_sha256'].items():
            file = ROOT / 'packages/ai/dist/providers/data' / name
            assert file.is_file() and not file.is_symlink() and digest(file.read_bytes()) == sha
        try:
            require_dist(rows[:-1], accepted)
        except AssertionError:
            rejected_missing_row = True
        else:
            raise AssertionError('Missing-row negative control was accepted')
        log_hashes = {name: digest(Path(actual_result[name]['full_log']).read_bytes()) for name in ('check', 'build')}
        present = {name: (ROOT / path).is_file() and not (ROOT / path).is_symlink() for name, path in MODULES.items()}
        missing = [path for name, path in MODULES.items() if not present[name]]
        report.update(identity=identity, publication=str(accepted_path), publicationSha256=digest(accepted_path.read_bytes()),
                      invocationID=accepted['InvocationID'], checkExit=0, buildExit=0, logSha256=log_hashes,
                      distEntries=len(rows), distBytes=sum(row['bytes'] for row in rows),
                      distManifestSha256=digest(encode(rows)), distMerkleSha256=merkle(rows),
                      compiledCatalogues=43, missingDistRowRejected=rejected_missing_row,
                      requiredCompiledModules=MODULES, missingCompiledModules=missing)
        print(f'PASS independent physical dist: {len(rows)} rows, 43 compiled catalogues, exact SHA/Merkle; check0/build0')
        if missing:
            report['status'] = 'BLOCKED_COMPILED_RICH_HOST_NOT_EMITTED'
            print('BLOCKED before product launch: ' + ', '.join(missing))
            return 78
        if not args.artifact_receipt:
            report['status'] = 'BLOCKED_QUALIFIED_RUNTIME_CLOSURE_RECEIPT_REQUIRED'
            print('BLOCKED: qualified runtime closure receipt required; no source fallback')
            return 78
        receipt_path = Path(args.artifact_receipt).resolve()
        receipt = json.loads(receipt_path.read_text())
        assert receipt['schema'] == 'memory-sound-qa-artifact/1'
        assert receipt['root'] == receipt['sourceRoot'] == str(ROOT)
        assert receipt['sourceManifest']['sha256'] == identity['sourceSha256']
        assert receipt['inputManifest']['sha256'] == identity['inputSha256']
        assert receipt['build']['exit'] == 0 and receipt['build']['complete'] is True
        assert receipt['build']['log'] == actual_result['build']['full_log']
        assert receipt['build']['logSha256'] == log_hashes['build']
        for name, path in MODULES.items():
            assert receipt['modules'][name] == path
            assert receipt['runtimeFiles'][str(ROOT / path)] == digest((ROOT / path).read_bytes())
        lockfile = Path(receipt['dependencyModules']['proper-lockfile'])
        assert lockfile.is_absolute() and receipt['runtimeFiles'][str(lockfile.resolve())] == digest(lockfile.read_bytes())
        assert receipt['nativeAttachment'] == 'scripts/shared-tty-attach.sh'
        attachment = ROOT / receipt['nativeAttachment']
        assert receipt['runtimeFiles'][str(attachment.resolve())] == digest(attachment.read_bytes())
        report['artifactReceiptSha256'] = digest(receipt_path.read_bytes())
        if not args.execute:
            report['status'] = 'ELIGIBLE_ENTRY_PREPARED_NOT_EXECUTED'
            return 0
        argv = [sys.executable, str(OWN / 'focused-rich-pty.py'), '--evidence', str(evidence / 'compiled-run'),
                '--artifact-receipt', str(receipt_path)]
        report.update(status='COMPILED_BATTERY_LAUNCH_REQUESTED', argv=argv)
        with (evidence / 'compiled-run.log').open('wb') as output:
            child = subprocess.run(argv, stdout=output, stderr=subprocess.STDOUT, timeout=100)
        report.update(status='COMPILED_BATTERY_PASS' if child.returncode == 0 else 'COMPILED_BATTERY_RED',
                      focusedExit=child.returncode, productHostLaunched=(evidence / 'compiled-run/ready.json').is_file())
        return child.returncode
    except Exception as error:
        report['error'] = str(error)
        print('REJECTED artifact identity/eligibility: ' + str(error))
        return 3
    finally:
        (evidence / 'result.json').write_bytes(encode(report))


if __name__ == '__main__':
    raise SystemExit(main())
