"""Producer-declared compiled artifact gate. No compiler/source fallback; blocked=78.
The preserved T5-only entry is artifact-entry-t5.py. Producer schema/paths are data.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

OWN = Path(__file__).resolve().parent
ROLES = ('msqa/ai', 'msqa/auth', 'msqa/models', 'msqa/host')


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
        level = [bytes.fromhex(digest(b'node\0' + level[i] + level[i + 1])) for i in range(0, len(level), 2)]
    return level[0].hex()


def contained(root, relative):
    path = Path(relative)
    assert not path.is_absolute() and '..' not in path.parts and str(path) != '.', 'Escaping producer path'
    return root / path


def bound_file(record):
    path = Path(record['path'])
    assert path.is_absolute() and digest(path.read_bytes()) == record['sha256'], 'Bound manifest/hash mismatch'
    return json.loads(path.read_text())


def verify_receipt(receipt_path):
    receipt_path = Path(receipt_path).resolve()
    receipt = json.loads(receipt_path.read_text())
    assert receipt['schema'] == 'memory-sound-qa-artifact/1', 'Producer declaration has no complete qualified compiled layout/runtime receipt'
    root, source = Path(receipt['root']).resolve(), Path(receipt['sourceRoot']).resolve()
    assert root.is_dir() and source.is_dir()
    rows = bound_file(receipt['sourceManifest'])
    assert rows and len({row['path'] for row in rows}) == len(rows)
    for row in rows:
        file = contained(source, row['path'])
        mode = file.lstat().st_mode
        payload = os.readlink(file).encode() if stat.S_ISLNK(mode) else file.read_bytes()
        actual_mode = '120000' if stat.S_ISLNK(mode) else '100755' if mode & 0o111 else '100644'
        assert actual_mode == row['mode'], 'Source mode mismatch'
        assert hashlib.sha1(f'blob {len(payload)}\0'.encode() + payload).hexdigest() == row['blob'], 'Source blob mismatch'
        if 'sha256' in row:
            assert digest(payload) == row['sha256'], 'Source content mismatch'
    inputs = bound_file(receipt['inputManifest'])
    assert inputs.get('source_manifest_sha256', inputs.get('selected_manifest_sha256')) == receipt['sourceManifest']['sha256']
    links = inputs.get('aliases_and_dependencies', inputs.get('symlinks', []))
    assert len({row['path'] for row in links}) == len(links)
    for row in links:
        file = contained(source, row['path'])
        assert file.is_symlink() and os.readlink(file) == row['target'] and file.exists(), 'Input link mismatch'
    catalogues = inputs.get('catalogue_files_sha256', inputs.get('overlay_data_files', {}))
    for name, sha in catalogues.items():
        file = contained(source / 'packages/ai/src/providers/data', name)
        assert file.is_file() and not file.is_symlink() and digest(file.read_bytes()) == sha, 'Catalogue mismatch'
    for name, metadata in inputs.get('installed_package_metadata', {}).items():
        assert digest(contained(source, name).read_bytes()) == metadata['package_json_sha256'], 'Installed package metadata drift'
    for package in inputs.get('critical_sdk_contents', {}).values():
        folder = Path(package['resolved'])
        metadata = json.loads((folder / 'package.json').read_text())
        assert metadata['version'] == package['version'], 'Critical SDK version drift'
        content = []
        for directory, dirs, files in os.walk(folder, followlinks=False):
            dirs[:] = sorted(name for name in dirs if name != 'node_modules')
            for name in sorted(files):
                file = Path(directory) / name
                payload = os.readlink(file).encode() if file.is_symlink() else file.read_bytes()
                content.append({'path': str(file.relative_to(folder)), 'sha256': digest(payload)})
        assert digest(encode(content)) == package['content_sha256'], 'Critical SDK content drift'
    for name in ('check', 'build'):
        stage = receipt[name]
        assert stage['exit'] == 0 and stage['complete'] is True, 'Incomplete/red producer stage'
        assert digest(Path(stage['log']).read_bytes()) == stage['logSha256'], 'Check/build log mismatch'
    dist = bound_file(receipt['distManifest'])
    assert dist and len({row['path'] for row in dist}) == len(dist)
    assert dist == sorted(dist, key=lambda row: row['path']), 'Dist inventory must be sorted'
    roots = receipt['distRoots']
    assert roots and len(set(roots)) == len(roots)
    physical = []
    for relative in roots:
        folder = contained(root, relative)
        assert folder.is_dir() and not folder.is_symlink(), 'Missing/nonphysical dist root'
        for directory, dirs, files in os.walk(folder, followlinks=False):
            for name in files + [name for name in dirs if (Path(directory) / name).is_symlink()]:
                file = Path(directory) / name
                payload = os.readlink(file).encode() if file.is_symlink() else file.read_bytes()
                physical.append({'path': str(file.relative_to(root)), 'sha256': digest(payload),
                                 'mode': oct(file.lstat().st_mode & 0o777),
                                 'kind': 'symlink' if file.is_symlink() else 'file', 'bytes': len(payload)})
    physical.sort(key=lambda row: row['path'])
    assert physical == dist, 'Extra/missing/drifted output inventory'
    assert digest(encode(dist)) == receipt['distManifest']['sha256'], 'Dist canonical SHA mismatch'
    assert merkle(dist) == receipt['distManifest']['merkleSha256'], 'Dist Merkle mismatch'
    runtime = receipt['runtimeFiles']
    assert runtime, 'Empty runtime closure'
    if receipt.get('runtimeManifest'):
        declared = bound_file(receipt['runtimeManifest'])
        assert declared == runtime, 'Runtime closure manifest mismatch'
    for path, sha in runtime.items():
        file = Path(path)
        assert file.is_absolute() and file.resolve() == file, 'Runtime paths must be resolved absolute paths'
        assert digest(file.read_bytes()) == sha, 'Runtime hash mismatch'
    dist_by_path = {str((root / row['path']).resolve()): row for row in dist}
    additional_hashes = []
    for output in receipt.get('additionalOutputs', []):
        output_root = Path(output['root']).resolve()
        extra = bound_file(output['manifest'])
        actual = []
        for relative in output['distRoots']:
            folder = contained(output_root, relative)
            assert folder.is_dir() and not folder.is_symlink()
            for directory, dirs, files in os.walk(folder, followlinks=False):
                for name in files + [name for name in dirs if (Path(directory) / name).is_symlink()]:
                    file = Path(directory) / name
                    payload = os.readlink(file).encode() if file.is_symlink() else file.read_bytes()
                    actual.append({'path': str(file.relative_to(output_root)), 'sha256': digest(payload),
                                   'mode': oct(file.lstat().st_mode & 0o777), 'kind': 'symlink' if file.is_symlink() else 'file', 'bytes': len(payload)})
        actual.sort(key=lambda row: row['path'])
        assert actual == extra and merkle(extra) == output['manifest']['merkleSha256'], 'Additional compiled output drift'
        dist_by_path.update({str((output_root / row['path']).resolve()): row for row in extra})
        additional_hashes.append(output['manifest']['sha256'])
    for role in ROLES:
        path = receipt['modules'][role]
        file = Path(path) if Path(path).is_absolute() else contained(root, path)
        assert file.is_file() and not file.is_symlink(), 'Missing/nonphysical compiled host/module'
        assert file.suffix in ('.js', '.mjs', '.cjs') and 'source-resolver' not in file.name, 'Product source/resolver forbidden'
        assert str(file.resolve()) in dist_by_path and runtime.get(str(file.resolve())) == digest(file.read_bytes()), 'Module omitted from output/closure'
    for path in receipt.get('dependencyModules', {}).values():
        file = Path(path)
        assert file.is_absolute() and str(file.resolve()) in runtime, 'Omitted declared dependency'
    assert 'proper-lockfile' in receipt.get('dependencyModules', {}), 'Native writer dependency undeclared'
    attachment = contained(root, receipt['nativeAttachment'])
    assert attachment.is_file() and not attachment.is_symlink() and attachment.suffix == '.sh'
    assert runtime.get(str(attachment.resolve())) == digest(attachment.read_bytes()), 'Native PTY attachment omitted/unbound'
    for path, expected in receipt.get('producerBindings', {}).items():
        assert digest(Path(path).read_bytes()) == expected, 'Producer original declaration drift'
    identity = {'sourceRoot': str(source), 'root': str(root), 'sourceSha256': receipt['sourceManifest']['sha256'],
                'inputSha256': receipt['inputManifest']['sha256'], 'sourceEntries': len(rows), 'declaredLinks': len(links),
                'catalogues': len(catalogues), 'distSha256': receipt['distManifest']['sha256'],
                'distMerkleSha256': merkle(dist), 'distEntries': len(dist),
                'runtimeClosureSha256': digest(encode(runtime)), 'runtimeFiles': len(runtime), 'additionalDistSha256': additional_hashes,
                'producerReceiptSha256': digest(receipt_path.read_bytes()), 'executionMode': 'compiled-native-rich-pty',
                'checkLogSha256': receipt['check']['logSha256'], 'buildLogSha256': receipt['build']['logSha256']}
    return receipt, identity


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifact-receipt', required=True, help='Producer-declared exact complete receipt')
    parser.add_argument('--publication', help='Optional bound producer acceptance JSON; not an old tuple selector')
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    evidence = Path(args.evidence).resolve()
    assert evidence.is_relative_to(OWN / 'evidence')
    evidence.mkdir(parents=True, exist_ok=False)
    report = {'status': 'REJECTED', 'productHostLaunched': False, 'compilerInvocations': 0}
    try:
        original = Path(args.artifact_receipt).resolve()
        declared = json.loads(original.read_text())
        report['producerDeclaration'] = {'path': str(original), 'sha256': digest(original.read_bytes()),
                                        'schema': declared.get('schema'), 'status': declared.get('status'),
                                        'sourceSha256': declared.get('source_sha256'), 'inputSha256': declared.get('input_sha256')}
        receipt, identity = verify_receipt(args.artifact_receipt)
        assert not receipt.get('qaFixture'), 'Gate-control fixture is not a product publication'
        report['identity'] = identity
        if args.publication:
            path = Path(args.publication).resolve()
            report['publication'] = {'path': str(path), 'sha256': digest(path.read_bytes())}
        print(f'PASS exact declared source/input/check/build, {identity["distEntries"]} physical outputs and runtime closure')
        if not args.execute:
            report['status'] = 'IDENTITY_VERIFIED_BEHAVIOR_NOT_EXECUTED'
            return 0
        qualified = {**receipt, 'qaVerifiedIdentity': identity}
        path = evidence / 'qualified-receipt.json'
        path.write_bytes(encode(qualified))
        argv = [sys.executable, str(OWN / 'focused-rich-pty.py'), '--artifact-receipt', str(path),
                '--evidence', str(evidence / 'compiled-run')]
        report['argv'] = argv
        with (evidence / 'compiled-run.log').open('wb') as output:
            child = subprocess.run(argv, stdout=output, stderr=subprocess.STDOUT, timeout=105)
        ready = evidence / 'compiled-run/ready.json'
        report.update(focusedExit=child.returncode, productHostLaunched=ready.exists())
        result_file = evidence / 'compiled-run/result.json'
        result = json.loads(result_file.read_text()) if result_file.exists() else {}
        passed = child.returncode == 0 and ready.exists() and result.get('mode') == 'artifact' and not result.get('failures')
        report.update(status='COMPILED_FOCUSED_QA_PASS' if passed else 'COMPILED_FOCUSED_QA_RED',
                      exercisedGates=result.get('checks', []), acceptedScopes=['compiled-native-rich-pty-focused'] if passed else [],
                      notAccepted=['ACED', 'CI/live', 'full-fleet/RAM100x', 'complete rich-command/image/accessibility parity'])
        return 0 if passed else 3
    except (KeyError, AssertionError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        report['error'] = str(error)
        print('REJECTED before acceptance: ' + str(error))
        return 78
    finally:
        (evidence / 'result.json').write_bytes(encode(report))


if __name__ == '__main__':
    raise SystemExit(main())
