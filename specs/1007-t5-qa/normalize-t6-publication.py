"""Normalize producer-declared T6 package/runtime layout without inventing acceptance.
Own receipt only; source/consumer/publication never modified. Missing phases reject.
"""
import argparse
import json
import os
from pathlib import Path
import runpy
import subprocess
import tarfile

OWN = Path(__file__).resolve().parent
GATE = runpy.run_path(str(OWN / 'artifact-entry.py'), run_name='normalization_oracles')
sha, encode = GATE['digest'], GATE['encode']
parser = argparse.ArgumentParser()
parser.add_argument('--event', type=Path, required=True, help='Producer complete event directory')
parser.add_argument('--source-manifest', type=Path, required=True)
parser.add_argument('--input-manifest', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
output = args.output.resolve()
assert output.is_relative_to(OWN / 'evidence') and not output.exists()
event = args.event.resolve()
result = json.loads((event / 'result.json').read_text())
package = json.loads((event / 'package-acceptance.json').read_text())
assert package['result'] == 'PASS_OPTIN_PACKAGED_COMPILED_NATIVE_RICH_CLOSURE'
for phase in ('check', 'build', 'optin', 'compiled_acceptance'):
    assert result[phase]['exit'] == 0, 'Producer phase red/incomplete: ' + phase
for key in ('identity_stable', 'source_stable_after_build', 'source_stable_after_optin', 'source_stable_after_acceptance'):
    assert result[key] is True, 'Producer source/input changed: ' + key
before = result['source_before']
source = Path(before['source']).resolve()
source_manifest, input_manifest = args.source_manifest.resolve(), args.input_manifest.resolve()
assert sha(source_manifest.read_bytes()) == before['source_sha256']
assert sha(input_manifest.read_bytes()) == before['input_sha256']
# The producer's packed consumer and emitted entry are authoritative layout data.
root = Path(package['package']).resolve()
assert not (root / 'src').exists(), 'No-source packaged consumer required'
manifest = json.loads((root / 'package.json').read_text())
entry = manifest['exports']['./shared-tty-host']['import'].removeprefix('./')
assert {'createSharedTtyHost', 'AuthStorage', 'ModelRuntime'} <= set(package['closure']['exports'])
modules = {'msqa/host': entry, 'msqa/auth': entry, 'msqa/models': entry}
closure_path = event / 'external-runtime-closure.json'
closure = json.loads(closure_path.read_text())
runtime = {}
for dependency in closure['packages']:
    assert sha(encode(dependency['files'])) == dependency['content_sha256']
    for row in dependency['files']:
        file = Path(row['path'])
        data = str(file.readlink()).encode() if row['kind'] == 'symlink' else file.read_bytes()
        assert sha(data) == row['sha256'], 'Producer external runtime content drift'
        if file.is_file() and not file.is_symlink():
            runtime[str(file.resolve())] = row['sha256']
inputs = json.loads(input_manifest.read_text())
ai_link = [row for row in inputs['aliases_and_dependencies'] if row['path'] == 'node_modules/@earendil-works/pi-ai']
assert len(ai_link) == 1
ai_root = (source / ai_link[0]['path']).resolve()
assert (ai_root / 'package.json').is_file()
modules['msqa/ai'] = str(ai_root / 'dist/index.js')
writer_link = [row for row in inputs['aliases_and_dependencies'] if row['path'] == 'node_modules/proper-lockfile']
assert len(writer_link) == 1, 'Native writer QA dependency not a producer-declared input'
writer_root = (source / writer_link[0]['path']).resolve()
writer_meta = json.loads((writer_root / 'package.json').read_text())
writer_entry = (writer_root / writer_meta.get('main', 'index.js')).resolve()
qa_dependencies = json.loads(subprocess.check_output(['node', '--v8-pool-size=1', str(OWN / 'declared-dependency-closure.mjs'), str(writer_root)], timeout=15))
for dependency in qa_dependencies:
    folder = Path(dependency['root'])
    for directory, dirs, files in os.walk(folder, followlinks=False):
        dirs[:] = [name for name in dirs if name != 'node_modules']
        for name in files:
            file = Path(directory) / name
            if file.is_file() and not file.is_symlink():
                runtime[str(file.resolve())] = sha(file.read_bytes())
bridge = 'dist/bundle/shared-tty-attach.sh'
# Normalize physical consumer outputs, then prove every byte was published in packlist.
archive = Path(package['tarball'])
assert sha(archive.read_bytes()) == package['tarball_sha256']
with tarfile.open(archive) as stream:
    for member in stream.getmembers():
        if member.isfile():
            assert member.name.startswith('package/')
            relative = member.name.removeprefix('package/')
            assert '..' not in Path(relative).parts
            assert stream.extractfile(member).read() == (root / relative).read_bytes(), 'Packed consumer differs from producer tarball'
packlist = json.loads((event / 'npm-pack-dry-run.json').read_text())[0]['files']
pack_names = {row['path'] for row in packlist}
dist = []
for file in sorted((root / 'dist').rglob('*')):
    if not file.is_file():
        continue
    assert not file.is_symlink() and str(file.relative_to(root)) in pack_names
    data = file.read_bytes()
    row = {'path': str(file.relative_to(root)), 'sha256': sha(data), 'mode': oct(file.stat().st_mode & 0o777), 'kind': 'file', 'bytes': len(data)}
    dist.append(row)
    runtime[str(file.resolve())] = row['sha256']
dist.sort(key=lambda row: row['path'])
output.parent.mkdir(parents=True, exist_ok=True)
dist_file = output.with_name(output.stem + '-dist.json')
dist_file.write_bytes(encode(dist))
# Package metadata and native libraries/assets are runtime dependencies, not JS-only.
runtime[str(root / 'package.json')] = sha((root / 'package.json').read_bytes())
native_path = event / 'native-abi.json'
for row in json.loads(native_path.read_text()):
    runtime[row['absolute']] = row['sha256']
    for lib in row['libraries']:
        runtime[lib['path']] = lib['sha256']
published_dist = json.loads((event / 'dist-manifest.json').read_text())
assert published_dist == result['dist'] and sha(encode(published_dist)) == result['dist_manifest_sha256']
for row in published_dist:
    file = source / row['path']
    if row['kind'] == 'file':
        runtime[str(file.resolve())] = row['sha256']
for folder in (ai_root,):
    runtime[str(folder / 'package.json')] = sha((folder / 'package.json').read_bytes())
extra_roots = sorted({row['path'].split('/dist/', 1)[0] + '/dist' for row in published_dist})
extra_dist = {'root': str(source), 'distRoots': extra_roots,
              'manifest': {'path': str(event / 'dist-manifest.json'), 'sha256': result['dist_manifest_sha256'],
                           'merkleSha256': GATE['merkle'](published_dist)}}
runtime_file = output.with_name(output.stem + '-runtime.json')
runtime_file.write_bytes(encode(runtime))
receipt = {'schema': 'memory-sound-qa-artifact/1', 'root': str(root), 'sourceRoot': str(source),
           'sourceManifest': {'path': str(source_manifest), 'sha256': before['source_sha256']},
           'inputManifest': {'path': str(input_manifest), 'sha256': before['input_sha256']},
           'distRoots': ['dist'], 'distManifest': {'path': str(dist_file), 'sha256': sha(dist_file.read_bytes()), 'merkleSha256': GATE['merkle'](dist)},
           'additionalOutputs': [extra_dist], 'qaDeclaredInputDependencies': qa_dependencies,
           'modules': modules, 'dependencyModules': {'proper-lockfile': str(writer_entry)}, 'nativeAttachment': bridge,
           'runtimeFiles': runtime, 'runtimeManifest': {'path': str(runtime_file), 'sha256': sha(runtime_file.read_bytes())},
           'producerBindings': {str(path): sha(path.read_bytes()) for path in
                               (event / 'result.json', event / 'package-acceptance.json', closure_path, native_path, archive)},
           'optinCommand': result['optin']['argv']}
for stage, key in (('check', 'check'), ('build', 'optin')):
    phase = result[key]
    log = Path(phase.get('full_log', event / (key + '.log')))
    receipt[stage] = {'exit': phase['exit'], 'complete': True, 'log': str(log), 'logSha256': sha(log.read_bytes())}
output.write_bytes(encode(receipt))
GATE['verify_receipt'](output)
print('PASS normalized exact producer declaration; original publication/source/consumer unchanged')
