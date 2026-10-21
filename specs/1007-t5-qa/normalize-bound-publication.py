"""Bind one immutable producer publication to the existing compiled-only normalizer.
No producer edits, compiler, polling, provider calls or source-runtime fallback.
"""
import argparse
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import sys

OWN = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--contract', type=Path, required=True)
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
evidence = args.evidence.resolve()
if not evidence.is_relative_to(OWN / 'evidence'):
    raise ValueError('Evidence must be in OWN durable repository')
evidence.mkdir(parents=True, exist_ok=False)
report = {'status': 'NOT_EXECUTED_PUBLICATION_REJECTED', 'productHostLaunched': False,
          'compilerInvocations': 0, 'normalizerInvocations': 0, 'compiledBatteryInvocations': 0}


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


exit_code = 78
try:
    contract_path = args.contract.resolve()
    contract = json.loads(contract_path.read_text())
    report['contract'] = {'path': str(contract_path), 'sha256': digest(contract_path)}
    require(contract['schema'] == 'memory-sound-qa-publication-binding/1', 'Unknown binding schema')
    for name, expected in contract['reusedControlHashes'].items():
        require(digest(OWN / name) == expected, 'Changed qualified control/receipt: ' + name)
    originals = dict(contract['originalBindings'])
    for key in ('sourceManifest', 'inputManifest'):
        binding = contract[key]
        originals[binding['path']] = binding['sha256']
    for path, expected in originals.items():
        require(digest(path) == expected, 'Frozen original binding drift: ' + path)
    # Exactly one live publication read. Reuse these bytes for every later check.
    publication_path = Path(contract['publication']).resolve()
    raw = publication_path.read_bytes()
    snapshot = evidence / 'producer-publication.json'
    snapshot.write_bytes(raw)
    publication = json.loads(raw)
    publication_hash = hashlib.sha256(raw).hexdigest()
    report['producerPublication'] = {'path': str(publication_path), 'sha256': publication_hash,
                                     'snapshot': str(snapshot), 'status': publication.get('status'),
                                     'tuple': publication.get('tuple'), 'event': publication.get('event')}
    report['sourceSha256'] = publication.get('source_sha256')
    report['inputSha256'] = publication.get('input_sha256')
    require(publication['tuple'] == contract['tuple'], 'Wrong producer tuple; rebind a derivative explicitly')
    for key, binding in (('source_sha256', 'sourceManifest'), ('input_sha256', 'inputManifest')):
        require(publication[key] == contract[binding]['sha256'], 'Wrong exact producer identity: ' + key)
    require(publication['status'] == 'accepted-local-optin-compiled-native-rich-host',
            'No qualified compiled publication: ' + str(publication.get('status')))
    for key in contract['requiredProducerClaims']:
        require(publication['claims'].get(key) is True, 'Missing actual producer claim: ' + key)
    event = (publication_path.parent / 'evidence' / publication['event']).resolve()
    require(event.is_relative_to(publication_path.parent / 'evidence'), 'Event escapes producer evidence')
    result = json.loads((event / 'result.json').read_text())
    for key in contract['requiredProducerPhases']:
        require(result[key]['exit'] == 0, 'Red/incomplete producer phase: ' + key)
    before = result['source_before']
    require(Path(before['source']).resolve() == Path(contract['sourceRoot']).resolve(), 'Wrong source root')
    require(before['source_sha256'] == publication['source_sha256'] and
            before['input_sha256'] == publication['input_sha256'], 'Event/publication identity mismatch')
    require(result['qualification'] is True, 'Compiler isolation qualification not successful')
    require(result['dist_manifest_sha256'] == publication['dist_manifest_sha256'], 'Event/publication output identity mismatch')
    qualification = json.loads((event / 'qualification.json').read_text())
    require(qualification['result'] == 'PASS_ACTUAL_COMPILER_NETNS_HEAVY_CGROUP_REFUSAL' and
            qualification['child']['cgroup'] == qualification['parent']['cgroup'] and
            qualification['child']['netns'] != qualification['parent']['netns'] and
            qualification['parent_listener_reachable'] is False, 'Unqualified compiler allocation/isolation')
    require(json.loads((event / 'namespace-argv.json').read_text())['positive_control'] is True and
            json.loads((event / 'envelope.json').read_text())['namespace_child_exit'] == 0, 'Compiler envelope incomplete/red')
    abi = json.loads((event / 'compiled-abi.json').read_text())
    require(abi['result'] == 'PASS_COMPILED_SELF_EXPORT_SINGLE_RUNTIME_ABI_NATIVE_WASM', 'Missing compiled import ABI proof')
    require(set(contract['requiredCompiledExports']) <= set(abi['exports']), 'Missing actual public compiled exports')
    report['compiledExports'] = abi['exports']
    for row in publication['evidence_manifest']:
        require(digest(row['path']) == row['sha256'], 'Published evidence drift: ' + row['path'])
        originals[row['path']] = row['sha256']
    originals[str(snapshot)] = publication_hash
    originals[str(publication_path)] = publication_hash
    originals[str(contract_path)] = report['contract']['sha256']
    normalized = evidence / 'artifact-receipt.json'
    argv = [sys.executable, str(OWN / 'normalize-t6-publication.py'), '--event', str(event),
            '--source-manifest', contract['sourceManifest']['path'], '--input-manifest', contract['inputManifest']['path'],
            '--output', str(normalized)]
    report['normalizerCommand'] = argv
    report['normalizerInvocations'] = 1
    with (evidence / 'normalizer.log').open('wb') as log:
        completed = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT, timeout=90)
    report['normalizerExit'] = completed.returncode
    require(completed.returncode == 0, 'Existing compiled-only normalization rejected; inspect normalizer.log')
    receipt = json.loads(normalized.read_text())
    require(receipt['additionalOutputs'][0]['manifest']['merkleSha256'] == publication['dist_merkle_sha256'],
            'Event/publication output Merkle mismatch')
    consumer = Path(receipt['root'])
    for row in publication['consumer_manifest']:
        path = consumer / row['path']
        require(path.resolve().is_relative_to(consumer), 'Consumer manifest path escapes package')
        payload = str(path.readlink()).encode() if path.is_symlink() else path.read_bytes()
        require(hashlib.sha256(payload).hexdigest() == row['sha256'] and
                oct(path.lstat().st_mode & 0o777) == row['mode'], 'Published consumer drift: ' + str(path))
    receipt['producerBindings'].update(originals)
    receipt['scopedCallbacksAndControls'] = contract['scopedCallbacksAndControls']
    receipt['actualCompiledExports'] = abi['exports']
    gate = runpy.run_path(str(OWN / 'artifact-entry.py'), run_name='bound_normalization_oracles')
    normalized.write_bytes(gate['encode'](receipt))
    _, report['identity'] = gate['verify_receipt'](normalized)
    report['artifactReceipt'] = {'path': str(normalized), 'sha256': digest(normalized)}
    report['status'] = 'NORMALIZED_COMPILED_IDENTITY_NOT_BEHAVIORAL_ACCEPTANCE'
    exit_code = 0
except (ValueError, AssertionError, KeyError, OSError, TypeError, subprocess.SubprocessError) as error:
    report['blocker'] = str(error)
report['exit'] = exit_code
(evidence / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
sys.exit(exit_code)
