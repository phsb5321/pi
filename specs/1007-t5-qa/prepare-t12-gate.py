"""Prepare new T12 metadata only; never overwrite qualified historical gate bytes."""
import hashlib
import json
from pathlib import Path
import re

OWN = Path(__file__).resolve().parent
EVIDENCE = OWN / 'evidence/t12-denominator-2334'
BASE = Path('/home/notroot/Documents/Code/pi-upstream-1006-collapse-compose/specs/1007-optin-source-maps')


def binding(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return {'path': str(path), 'sha256': digest.hexdigest()}


out = OWN / 'PROJECT-GATE.T12.json'
assert not out.exists()
graph_path = EVIDENCE / 'source-graph-a2-method-fix/source-condition-graph.json'
partition_path = EVIDENCE / 'release-lines-a2-implicit-arm/release-relative-partition.json'
graph = json.loads((graph_path.parent / 'result.json').read_bytes())
partition = json.loads(partition_path.read_bytes())
assert partition['sourceGraphSha256'] == binding(graph_path)['sha256'] == graph['graphSha256']
source_rows = json.loads((BASE / 'evidence/source-map-checkpoint-source-manifest.json').read_bytes())
eligible = [row for row in source_rows if re.search(r'\.(?:[cm]?ts|tsx|[cm]?js|jsx)$', row['path'])
            and not re.search(r'\.d\.[cm]?ts$|(^|/)(test|tests)/|\.(test|spec)\.', row['path'])]
assert {row['path'] for row in eligible} == set(partition['eligiblePaths'])
manifest = json.loads((OWN / 'PROJECT-GATE.json').read_bytes())
manifest['identity'].update(graph['identity'])
manifest['identityFiles']['source'] = binding(BASE / 'evidence/source-map-checkpoint-source-manifest.json')
manifest['identityFiles']['input'] = binding(BASE / 'evidence/source-map-checkpoint-input-manifest.json')
manifest['eligibleSources'] = [{'path': row['path'], 'sha256': row['sha256']} for row in eligible]
manifest['expectedNewSources'] = sorted(partition['files'])
manifest['sourceConditionGraph'] = binding(graph_path)
manifest['releaseRelativePartition'] = binding(partition_path)
manifest['producerMapContract'] = {'schema': 'pi-shared-tty-source-map-inventory/1',
                                  'contractSha256': '1006ca2447cde16c745ddee714a46e442d7f7b0e0701d713aa843d1adb0226d8',
                                  'actualEmittedInventory': None, 'completeCoverageDenominatorRequired': True}
manifest['bindingState'] = 'T12_SOURCE_GRAPH_BOUND; PRODUCT_PUBLICATION_SOURCE_ONLY; NO_EMITTED_MAPS_CLOSURE_OR_COMPILER_PASS'
manifest['notes'] = 'Static graph is not V8/SCM/Sonar coverage. Historical 18/7/8/16 controls unchanged; product fixture and source resolver rejected. Sole producer root check supplies Biome/types.'
out.write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'preparedManifest': binding(out), 'eligibleSources': len(eligible),
                  'changedSources': len(partition['files']), 'sourceGraph': binding(graph_path),
                  'releaseRelativePartition': binding(partition_path), 'ACED': False}, indent=2))
