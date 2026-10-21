"""Sequential rejecting controls for the owned gate/loader; fixtures are NOT product QA."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess

OWN = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--evidence', type=Path, default=OWN / 'evidence/ready-wave-1337/gate-controls')
OUT = parser.parse_args().evidence.resolve()
assert OUT.is_relative_to(OWN / 'evidence')
OUT.mkdir(parents=True, exist_ok=False)
GATE = runpy.run_path(str(OWN / 'artifact-entry.py'), run_name='gate_under_test')
sha, encode = GATE['digest'], GATE['encode']
root = OUT / 'fixture'
(root / 'emitted').mkdir(parents=True)
(root / 'source').mkdir()
(root / 'deps').mkdir()
(root / 'external/dist').mkdir(parents=True)
external_ai = root / 'external/dist/ai.mjs'
external_ai.write_text('export const externalCompiledFixture = true;\n')
extra_manifest = root / 'external-dist.json'
extra_rows = [{'path': 'dist/ai.mjs', 'sha256': hashlib.sha256(external_ai.read_bytes()).hexdigest(),
               'mode': oct(external_ai.stat().st_mode & 0o777), 'kind': 'file', 'bytes': external_ai.stat().st_size}]
extra_manifest.write_bytes(encode(extra_rows))
source = root / 'source/source.ts'
source.write_text('export const notAProduct = true;\n')
data = source.read_bytes()
rows = [{'path': 'source.ts', 'mode': '100644', 'blob': hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest(), 'sha256': sha(data)}]
source_manifest = root / 'source-manifest.json'
source_manifest.write_bytes(encode(rows))
inputs = {'aliases_and_dependencies': [], 'catalogue_files_sha256': {}, 'source_manifest_sha256': sha(source_manifest.read_bytes())}
input_manifest = root / 'input-manifest.json'
input_manifest.write_bytes(encode(inputs))
for role in GATE['ROLES']:
    (root / 'emitted' / (role.split('/')[1] + '.mjs')).write_text('export const identityFixtureOnly = true;\n')
(root / 'emitted/host.mjs').write_text('import "./dep.mjs"; export const identityFixtureOnly = true;\n')
(root / 'emitted/dep.mjs').write_text('export const dependency = true;\n')
lock = root / 'deps/lock.mjs'
lock.write_text('export default {};\n')
attachment = root / 'native-attach.sh'
attachment.write_text('#!/bin/sh\nexit 0\n')
for stage in ('check', 'build'):
    (root / (stage + '.log')).write_text('Fixture metadata, not a compiler invocation\n')
dist_path = root / 'dist.json'
runtime_path = root / 'runtime.json'


def refresh(receipt):
    dist = [{'path': str(file.relative_to(root)), 'sha256': sha(file.read_bytes()), 'mode': oct(file.stat().st_mode & 0o777),
             'kind': 'file', 'bytes': file.stat().st_size} for file in sorted((root / 'emitted').iterdir())]
    dist_path.write_bytes(encode(dist))
    receipt['distManifest'] = {'path': str(dist_path), 'sha256': sha(dist_path.read_bytes()), 'merkleSha256': GATE['merkle'](dist)}
    runtime_path.write_bytes(encode(receipt['runtimeFiles']))
    receipt['runtimeManifest'] = {'path': str(runtime_path), 'sha256': sha(runtime_path.read_bytes())}
    (root / 'receipt.json').write_bytes(encode(receipt))


receipt = {'schema': 'memory-sound-qa-artifact/1', 'qaFixture': True, 'root': str(root), 'sourceRoot': str(root / 'source'),
           'sourceManifest': {'path': str(source_manifest), 'sha256': sha(source_manifest.read_bytes())},
           'inputManifest': {'path': str(input_manifest), 'sha256': sha(input_manifest.read_bytes())},
           'distRoots': ['emitted'], 'modules': {role: 'emitted/' + role.split('/')[1] + '.mjs' for role in GATE['ROLES']},
           'runtimeFiles': {str(file): sha(file.read_bytes()) for file in list((root / 'emitted').iterdir()) + [lock, attachment]},
           'dependencyModules': {'proper-lockfile': str(lock)}, 'nativeAttachment': 'native-attach.sh'}
for stage in ('check', 'build'):
    receipt[stage] = {'exit': 0, 'complete': True, 'log': str(root / (stage + '.log')), 'logSha256': sha((root / (stage + '.log')).read_bytes())}
receipt['modules']['msqa/ai'] = str(external_ai)
receipt['runtimeFiles'][str(external_ai)] = sha(external_ai.read_bytes())
receipt['additionalOutputs'] = [{'root': str(root / 'external'), 'distRoots': ['dist'],
                                 'manifest': {'path': str(extra_manifest), 'sha256': sha(extra_manifest.read_bytes()),
                                              'merkleSha256': GATE['merkle'](extra_rows)}}]
refresh(receipt)
GATE['verify_receipt'](root / 'receipt.json')
results = [{'control': 'positive-identity-fixture-not-product', 'passed': True}]


def reject(name, change):
    changed = copy.deepcopy(receipt)
    change(changed)
    (root / 'receipt.json').write_bytes(encode(changed))
    try:
        GATE['verify_receipt'](root / 'receipt.json')
    except (AssertionError, KeyError, OSError, ValueError) as error:
        results.append({'control': name, 'passed': True, 'rejection': str(error)})
    else:
        raise AssertionError('False acceptance: ' + name)
    refresh(receipt)


for name in ('sourceManifest', 'inputManifest'):
    reject('wrong-' + name + '-hash', lambda r, n=name: r[n].update(sha256='0' * 64))
for name in ('check', 'build'):
    reject('wrong-' + name + '-log-hash', lambda r, n=name: r[n].update(logSha256='0' * 64))
    reject('red-' + name, lambda r, n=name: r[n].update(exit=1))
reject('wrong-dist-hash', lambda r: r['distManifest'].update(sha256='0' * 64))
reject('wrong-dist-merkle', lambda r: r['distManifest'].update(merkleSha256='0' * 64))
reject('wrong-additional-compiled-output-hash', lambda r: r['additionalOutputs'][0]['manifest'].update(sha256='0' * 64))
reject('omitted-additional-compiled-output-inventory', lambda r: r.pop('additionalOutputs'))
reject('wrong-runtime-hash', lambda r: r['runtimeFiles'].update({str(lock): '0' * 64}))
reject('absent-host-layout', lambda r: r['modules'].update({'msqa/host': 'emitted/absent.mjs'}))
reject('omitted-writer-dependency', lambda r: r['runtimeFiles'].pop(str(lock)))
reject('unbound-native-pty-attachment', lambda r: r['runtimeFiles'].pop(str(attachment)))
# Validate actual imported closure, not just testing dictionary membership.
base_env = {key: value for key, value in os.environ.items() if key in ('PATH', 'HOME', 'LANG')}
for name, code, omitted in (
    ('omitted-transitive-loaded-dependency', 'import "./dep.mjs";', str(root / 'emitted/dep.mjs')),
    ('loaded-product-typescript', 'import "../source/source.ts";', None),
    ('loaded-source-resolver', 'import "./source-resolver.mjs";', None),
):
    changed = copy.deepcopy(receipt)
    (root / 'emitted/host.mjs').write_text(code)
    changed['runtimeFiles'][str(root / 'emitted/host.mjs')] = sha((root / 'emitted/host.mjs').read_bytes())
    if name == 'loaded-source-resolver':
        (root / 'emitted/source-resolver.mjs').write_text('export const resolver = true;\n')
        changed['runtimeFiles'][str(root / 'emitted/source-resolver.mjs')] = sha((root / 'emitted/source-resolver.mjs').read_bytes())
    if name == 'loaded-product-typescript':
        changed['runtimeFiles'][str(source)] = sha(source.read_bytes())
    if omitted:
        changed['runtimeFiles'].pop(omitted)
    refresh(changed)
    GATE['verify_receipt'](root / 'receipt.json')
    env = {**base_env, 'MSQA_SOURCE': str(root / 'source'), 'MSQA_DATA': str(OUT), 'MSQA_SOCKET_ROOT': str(root / 'sockets'),
           'MSQA_ARTIFACT_RECEIPT': str(root / 'receipt.json'), 'MSQA_RECEIPT_SHA256': sha((root / 'receipt.json').read_bytes()), 'UV_THREADPOOL_SIZE': '1'}
    child = subprocess.run(['node', '--v8-pool-size=1', '--max-old-space-size=192', '--experimental-strip-types', '--import',
                            str(OWN / 'qa-loader.mjs'), '--input-type=module', '--eval', 'import "msqa/host";'],
                           env=env, capture_output=True, timeout=10)
    (OUT / (name + '.log')).write_bytes(child.stdout + child.stderr)
    assert child.returncode != 0 and (b'Omitted loaded runtime dependency' in child.stderr or b'Product source/resolver fallback' in child.stderr), name
    results.append({'control': name, 'passed': True, 'exit': child.returncode, 'actualRuntimeGuard': True})
(OUT / 'result.json').write_bytes(encode({'result': 'GATE_REJECTING_CONTROLS_PASS_NOT_PRODUCT_ACCEPTANCE', 'checks': results,
                                         'productHostsLaunched': 0, 'compilerInvocations': 0}))
print(f'PASS {len(results)} gate/loaded-closure controls; fixture-only, no product acceptance')
