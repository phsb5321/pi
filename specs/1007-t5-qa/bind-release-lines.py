"""Bind static changed-line/condition locations to real released Git blob bytes.
Not observed V8 coverage or Sonar SCM/new-code acceptance; no compiler/source import.
"""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import subprocess

OWN = Path(__file__).resolve().parent
REVISION = '7c10bd4337495ee613f2224843ecdf349b80d1df'
TREE = 'de4e0ad2e4ca4d3bf80a6e89d1bec453edbc85a0'


def changed_lines(before, after):
    # ponytail: exact deterministic line diff; quadratic ceiling on repetitive huge
    # files. This bounded frozen graph is small; use git diff if that ceiling grows.
    lines = set()
    for tag, _, _, start, end in difflib.SequenceMatcher(None, before.splitlines(), after.splitlines(), autojunk=False).get_opcodes():
        if tag in ('replace', 'insert'):
            lines.update(range(start + 1, end + 1))
    return sorted(lines)


def overlaps(location, enclosing, lines):
    # Istanbul's implicit else arm has empty endpoints; its condition is the
    # enclosing branch expression, not a missing condition to drop.
    if 'line' not in location['start'] or 'line' not in location['end']:
        location = enclosing
    assert location and 'line' in location['start'] and 'line' in location['end'], 'Unattributable condition retained: source graph cannot close'
    return any(line in lines for line in range(location['start']['line'], location['end']['line'] + 1))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--graph', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    out = args.evidence.resolve()
    assert out.is_relative_to(OWN / 'evidence')
    out.mkdir(exist_ok=False)
    graph_bytes = args.graph.read_bytes()
    graph = json.loads(graph_bytes)
    assert graph['baseline']['revision'] == REVISION and graph['baseline']['tree'] == TREE
    ids = sorted({graph['files'][path]['baselineBlob'] for path in graph['changedPaths'] if graph['files'][path]['baselineBlob']})
    command = ['git', '-C', str(OWN.parent.parent), 'cat-file', '--batch']
    completed = subprocess.run(command, input=('\n'.join(ids) + '\n').encode(), capture_output=True, timeout=40, check=True)
    assert not completed.stderr
    raw = completed.stdout
    (out / 'release-blobs.batch').write_bytes(raw)
    blobs = {}
    offset = 0
    for requested in ids:
        end = raw.index(b'\n', offset)
        oid, kind, size = raw[offset:end].decode().split()
        assert oid == requested and kind == 'blob'
        start, size = end + 1, int(size)
        data = raw[start:start + size]
        assert raw[start + size:start + size + 1] == b'\n'
        assert hashlib.sha1(b'blob ' + str(size).encode() + b'\0' + data).hexdigest() == oid
        blobs[oid] = data
        offset = start + size + 1
    assert offset == len(raw)
    partition = {}
    for path in graph['changedPaths']:
        row = graph['files'][path]
        current = (Path(graph['root']) / path).read_bytes()
        assert hashlib.sha256(current).hexdigest() == row['sha256']
        previous = blobs[row['baselineBlob']] if row['baselineBlob'] else b''
        lines = changed_lines(previous.decode(), current.decode())
        line_set = set(lines)
        branches = {}
        for branch_id, branch in row['branchMap'].items():
            locations = branch['locations']
            assert len(locations) == len(row['zeroConditions'][branch_id])
            enclosing = branch.get('loc')
            affected = [index for index, location in enumerate(locations)
                        if overlaps(location, enclosing, line_set)]
            # Whole expression changes can affect condition arms outside the diff.
            if enclosing and overlaps(enclosing, enclosing, line_set):
                affected = list(range(len(locations)))
            branches[branch_id] = {'locations': locations, 'potentialNewArmIndices': affected,
                                   'observedCounts': None, 'staticZeroCounts': row['zeroConditions'][branch_id]}
        partition[path] = {'sourceSha256': row['sha256'], 'baselineBlob': row['baselineBlob'],
                           'baselineContentSha256': hashlib.sha256(previous).hexdigest() if row['baselineBlob'] else None,
                           'changedLines': lines, 'conditions': branches, 'observedCoverage': False}
    assert changed_lines('a\nb\n', 'a\nc\n') == [2]
    assert changed_lines('', 'a\nb\n') == [1, 2]
    assert changed_lines('a\nb\n', 'a\n') == []
    assert overlaps({'start': {}, 'end': {}}, {'start': {'line': 2}, 'end': {'line': 2}}, {2})
    assert not overlaps({'start': {}, 'end': {}}, {'start': {'line': 2}, 'end': {'line': 2}}, {3})
    try:
        overlaps({'start': {}, 'end': {}}, None, {2})
        raise AssertionError('Unattributable condition accepted')
    except AssertionError as error:
        assert str(error).startswith('Unattributable condition retained:')
    result = {'schema': 'memory-sound-release-relative-source-partition/1',
              'status': 'RELEASE_BLOBS_SOURCE_PARTITION_BOUND_NOT_OBSERVED_COVERAGE',
              'sourceGraphSha256': hashlib.sha256(graph_bytes).hexdigest(), 'identity': graph['identity'],
              'baseline': {'revision': REVISION, 'tree': TREE, 'blobCount': len(blobs), 'command': command,
                           'exit': completed.returncode, 'batchSha256': hashlib.sha256(raw).hexdigest()},
              'files': partition, 'eligiblePaths': graph['eligiblePaths'],
              'changedSourceCount': len(partition), 'changedLines': sum(len(row['changedLines']) for row in partition.values()),
              'potentialNewConditionSlots': sum(len(branch['potentialNewArmIndices']) for row in partition.values() for branch in row['conditions'].values()),
              'conditionAttribution': 'STATIC_LOCATION_CANDIDATES_REQUIRES_ACTUAL_EMITTED_MAP_AND_SONAR_RECONCILIATION',
              'ACED': False, 'observedCoverage': False}
    (out / 'release-relative-partition.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: value for key, value in result.items() if key not in ('files', 'eligiblePaths')}, indent=2))


if __name__ == '__main__':
    main()
