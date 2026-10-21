"""Merge only current delta attribution; retain frozen release/zero-census receipts."""
import hashlib
import json
from pathlib import Path

OWN = Path(__file__).resolve().parent
OUT = OWN / 'evidence/t14-incremental-1008-1214'
PRODUCER = Path('/home/notroot/Documents/Code/pi-upstream-1006-collapse-compose/specs/1008-native-nested-policy')


def binding(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return {'path': str(path), 'sha256': digest.hexdigest()}


base_path = OWN / 'evidence/t12-denominator-2334/release-lines-a2-implicit-arm/release-relative-partition.json'
assert binding(base_path)['sha256'] == '39af0b4b2ce076a16c6a845399af0c1c69b3bb49011cc084e143eb1b4bb7b3ff'
base = json.loads(base_path.read_bytes())
graph_path = OUT / 'source-a1/incremental-source-condition-graph.json'
graph = json.loads(graph_path.read_bytes())
result = json.loads((graph_path.parent / 'result.json').read_bytes())
assert binding(graph_path)['sha256'] == result['graphSha256']
delta_path = OUT / 'delta-release-a1/release-relative-partition.json'
delta = json.loads(delta_path.read_bytes())
assert delta['identity'] == graph['identity']
assert delta['sourceGraphSha256'] == result['deltaGraphSha256']
assert delta['baseline']['revision'] == base['baseline']['revision'] == '7c10bd4337495ee613f2224843ecdf349b80d1df'
assert delta['baseline']['tree'] == base['baseline']['tree'] == 'de4e0ad2e4ca4d3bf80a6e89d1bec453edbc85a0'
source_path = PRODUCER / 'evidence/native-nested-policy-source-manifest.json'
input_path = PRODUCER / 'evidence/native-nested-policy-input-manifest.json'
assert binding(source_path)['sha256'] == graph['identity']['sourceSha256']
assert binding(input_path)['sha256'] == graph['identity']['inputSha256']
rows = {row['path']: row for row in json.loads(source_path.read_bytes())}
files = {}
retained = {}
for path in graph['changedPaths']:
    if path in graph['deltaFiles']:
        files[path] = delta['files'][path]
    else:
        files[path] = base['files'][path]
        retained[path] = hashlib.sha256(json.dumps(files[path], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    assert files[path]['sourceSha256'] == rows[path]['sha256']
assert set(files) == set(graph['changedPaths'])
partition = {**base, 'schema': 'memory-sound-incremental-release-partition/1',
             'identity': graph['identity'], 'sourceGraphSha256': result['graphSha256'],
             'inheritedPartition': binding(base_path), 'deltaPartition': binding(delta_path),
             'inheritedReleaseFiles': retained, 'files': files, 'eligiblePaths': graph['eligiblePaths'],
             'changedSourceCount': len(files), 'changedLines': sum(len(row['changedLines']) for row in files.values()),
             'potentialNewConditionSlots': sum(len(branch['potentialNewArmIndices']) for row in files.values() for branch in row['conditions'].values()),
             'newReleaseBlobExecution': delta['baseline'], 'observedCoverage': False, 'ACED': False}
partition_path = OUT / 'release-relative-partition.json'
assert not partition_path.exists()
partition_path.write_text(json.dumps(partition, indent=2) + '\n')
manifest = json.loads((OWN / 'PROJECT-GATE.json').read_bytes())
manifest['identity'].update(graph['identity'])
manifest['identityFiles']['source'] = binding(source_path)
manifest['identityFiles']['input'] = binding(input_path)
manifest['identityFiles']['publication'] = None
manifest['artifactReceipt'] = None
manifest['eligibleSources'] = [{'path': path, 'sha256': rows[path]['sha256']} for path in graph['eligiblePaths']]
manifest['expectedNewSources'] = graph['changedPaths']
manifest['sourceConditionGraph'] = binding(graph_path)
manifest['releaseRelativePartition'] = binding(partition_path)
manifest['mapRequirement'] = 'SOURCE-DENOMINATOR.md'
manifest['producerMapContract'] = {'schema': 'pi-shared-tty-source-map-inventory/1',
                                  'actualEmittedInventory': None, 'completeCoverageDenominatorRequired': True,
                                  'historicalT9SourcemapFalseExpectation': False}
manifest['bindingState'] = 'EXACT_T14_SOURCE_INCREMENTALLY_BOUND_OUTPUT_RUNTIME_PUBLICATION_NULL_UNTIL_REAL_PRODUCER_PASS'
manifest['notes'] = 'All924unchanged zero files/conditions inherited byte-bound; only5files recensused. Static condition/source partition is not observedV8/Sonar coverage. Reuse sole producer rootcheck for Biome/types.'
manifest_path = OWN / 'PROJECT-GATE.T14.json'
assert not manifest_path.exists()
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
summary = {'status': 'T14_INCREMENTAL_RELEASE_PARTITION_AND_GATE_PREPARED',
           'identity': graph['identity'], 'recensused': result['recensused'], 'retained': result['retained'],
           'eligible': result['eligible'], 'changedRelativeToRelease': len(files),
           'conditions': result['conditions'], 'changedLines': partition['changedLines'],
           'potentialNewConditionSlots': partition['potentialNewConditionSlots'],
           'inheritedReleaseFiles': len(retained), 'newReleaseBlobCount': delta['baseline']['blobCount'],
           'sourceGraph': binding(graph_path), 'partition': binding(partition_path), 'manifest': binding(manifest_path),
           'outputSha256': None, 'runtimeSha256': None, 'publication': None, 'observedCoverage': False, 'ACED': False}
(OUT / 'preparation-result.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
