"""Single-file T15 release attribution and null-output source gate; no scan/build."""
import hashlib
import json
from pathlib import Path
import runpy
import subprocess

OWN = Path(__file__).resolve().parent
OUT = OWN / 'evidence/t15-delta-1008-1253'
PRODUCER = Path('/home/notroot/Documents/Code/pi-upstream-1006-collapse-compose/specs/1008-native-nested-type-repair')
REVISION = '7c10bd4337495ee613f2224843ecdf349b80d1df'
TREE = 'de4e0ad2e4ca4d3bf80a6e89d1bec453edbc85a0'


def binding(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return {'path': str(path), 'sha256': digest.hexdigest()}


helper = runpy.run_path(str(OWN / 'bind-release-lines.py'))
base_path = OWN / 'evidence/t14-incremental-1008-1214/release-relative-partition.json'
assert binding(base_path)['sha256'] == 'df5c83ec3479b86a4590afc00fbcf2cae54be75737f7c52efabde1c2fad90043'
base = json.loads(base_path.read_bytes())
graph_path = OUT / 'source-a1/incremental-source-condition-graph.json'
graph = json.loads(graph_path.read_bytes())
result = json.loads((graph_path.parent / 'result.json').read_bytes())
assert binding(graph_path)['sha256'] == result['graphSha256']
assert len(graph['recensusedPaths']) == 1
assert base['identity'] == graph['baseIdentity']
assert base['baseline']['revision'] == REVISION and base['baseline']['tree'] == TREE
target = graph['recensusedPaths'][0]
file = graph['deltaFiles'][target]
assert file['baselineBlob'] is None, 'Target unexpectedly existed in release; use existing blob-binding path instead'
command = ['git', '-C', str(OWN.parent.parent), 'ls-tree', '-r', '-z', REVISION, '--', target]
released = subprocess.run(command, capture_output=True, timeout=15, check=True)
assert released.stdout == b'' and released.stderr == b'', 'Released file absence not proved'
(OUT / 'release-target-ls-tree.stdout').write_bytes(released.stdout)
tree_command = ['git', '-C', str(OWN.parent.parent), 'rev-parse', REVISION + '^{tree}']
tree = subprocess.run(tree_command, capture_output=True, timeout=15, check=True)
assert tree.stdout.decode().strip() == TREE and not tree.stderr
(OUT / 'release-tree.stdout').write_bytes(tree.stdout)
source_path = PRODUCER / 'evidence/repair-source-manifest.json'
input_path = PRODUCER / 'evidence/repair-input-manifest.json'
assert binding(source_path)['sha256'] == graph['identity']['sourceSha256']
assert binding(input_path)['sha256'] == graph['identity']['inputSha256']
rows = {row['path']: row for row in json.loads(source_path.read_bytes())}
current = (Path(graph['root']) / target).read_bytes()
assert hashlib.sha256(current).hexdigest() == file['sha256'] == rows[target]['sha256']
lines = helper['changed_lines']('', current.decode())
line_set = set(lines)
conditions = {}
for branch_id, branch in file['branchMap'].items():
    assert len(branch['locations']) == len(file['zeroConditions'][branch_id])
    affected = [index for index, location in enumerate(branch['locations'])
                if helper['overlaps'](location, branch.get('loc'), line_set)]
    if helper['overlaps'](branch['loc'], branch['loc'], line_set):
        affected = list(range(len(branch['locations'])))
    conditions[branch_id] = {'locations': branch['locations'], 'potentialNewArmIndices': affected,
                             'observedCounts': None, 'staticZeroCounts': file['zeroConditions'][branch_id]}
files = dict(base['files'])
files[target] = {'sourceSha256': file['sha256'], 'baselineBlob': None, 'baselineContentSha256': None,
                 'changedLines': lines, 'conditions': conditions, 'observedCoverage': False}
assert set(files) == set(graph['changedPaths'])
retained = {}
for path in files:
    assert files[path]['sourceSha256'] == rows[path]['sha256']
    if path != target:
        assert files[path] == base['files'][path]
        retained[path] = hashlib.sha256(json.dumps(files[path], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
partition = {**base, 'identity': graph['identity'], 'sourceGraphSha256': result['graphSha256'],
             'inheritedPartition': binding(base_path), 'inheritedReleaseFiles': retained, 'files': files,
             'eligiblePaths': graph['eligiblePaths'], 'changedSourceCount': len(files),
             'changedLines': sum(len(row['changedLines']) for row in files.values()),
             'potentialNewConditionSlots': sum(len(branch['potentialNewArmIndices']) for row in files.values() for branch in row['conditions'].values()),
             'currentReleaseProof': {'revision': REVISION, 'tree': TREE, 'target': target,
                                    'command': command, 'exit': released.returncode, 'stdout': binding(OUT / 'release-target-ls-tree.stdout'),
                                    'treeCommand': tree_command, 'treeExit': tree.returncode, 'treeStdout': binding(OUT / 'release-tree.stdout'),
                                    'releasedTargetAbsent': True, 'baselineBlobsFetched': 0},
             'observedCoverage': False, 'ACED': False}
partition_path = OUT / 'release-relative-partition.json'
assert not partition_path.exists()
partition_path.write_text(json.dumps(partition, indent=2) + '\n')
manifest = json.loads((OWN / 'PROJECT-GATE.T14.json').read_bytes())
manifest['identity'].update(graph['identity'])
manifest['identityFiles']['source'] = binding(source_path)
manifest['identityFiles']['input'] = binding(input_path)
assert manifest['identity']['distSha256'] is None and manifest['identity']['runtimeClosureSha256'] is None
assert manifest['identityFiles']['publication'] is None and manifest['artifactReceipt'] is None
manifest['eligibleSources'] = [{'path': path, 'sha256': rows[path]['sha256']} for path in graph['eligiblePaths']]
manifest['expectedNewSources'] = graph['changedPaths']
manifest['sourceConditionGraph'] = binding(graph_path)
manifest['releaseRelativePartition'] = binding(partition_path)
manifest['bindingState'] = 'EXACT_T15_SOURCE_ONLY_ONE_FILE_DELTA_OUTPUT_RUNTIME_PUBLICATION_NULL_COMPILER_BUDGET_EXHAUSTED'
manifest['notes'] = '928zero scopes retained; only extension-composition recensused. T14 actual rootcheck1; shipping1/1 and total3 immutable. No compiler/product/scanner authority or acceptance from this repair.'
manifest_path = OWN / 'PROJECT-GATE.T15.json'
assert not manifest_path.exists()
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
summary = {'status': 'T15_SOURCE_ONLY_RELEASE_ATTRIBUTION_AND_GATE_BOUND', 'identity': graph['identity'],
           'eligible': result['eligible'], 'recensused': result['recensused'], 'retained': result['retained'],
           'conditions': result['conditions'], 'changedRelativeToRelease': len(files),
           'changedLines': partition['changedLines'], 'potentialNewConditionSlots': partition['potentialNewConditionSlots'],
           'retainedReleaseFilePartitions': len(retained), 'releasedTargetAbsentVerified': True,
           'graph': binding(graph_path), 'partition': binding(partition_path), 'manifest': binding(manifest_path),
           'output': None, 'runtime': None, 'observedCoverage': False, 'ACED': False}
(OUT / 'preparation-result.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
