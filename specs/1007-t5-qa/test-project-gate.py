"""Small receipt/schema fixture only; never compiler/scanner/product/ACED scores."""
import copy
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys

OWN = Path(__file__).resolve().parent
GATE = runpy.run_path(str(OWN / 'project-gate.py'))
out = Path(sys.argv[1]).resolve()
assert out.is_relative_to(OWN / 'evidence')
out.mkdir(parents=True, exist_ok=False)


def file(name, value):
    path = out / name
    raw = value if isinstance(value, bytes) else (json.dumps(value, sort_keys=True) + '\n').encode()
    path.write_bytes(raw)
    return {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest()}


source = file('source.json', [{'path': 'a.ts', 'sha256': 'a' * 64}, {'path': 'b.ts', 'sha256': 'b' * 64}])
inputs = file('inputs.json', {'fixture': True})
identity = {'tuple': 'PROJECT_GATE_FIXTURE_NOT_PRODUCT', 'sourceSha256': source['sha256'], 'inputSha256': inputs['sha256'],
            'distSha256': 'c' * 64, 'runtimeClosureSha256': 'd' * 64}
tool = file('fake-tool', b'fixture metadata, not executable analysis\n')
metadata = file('tool.json', {'version': 'fixture-1'})
log = file('fixture-command.log', b'fixture receipt only; no product command executed\n')
map_file = file('fixture-only.map', {'version': 3, 'mappings': 'AAAA', 'sources': ['a.ts', 'b.ts'],
                                   'sourcesContent': ['fixture only a', 'fixture only b']})
manifest = {'schema': 'memory-sound-project-gate/1', 'fixture': True, 'policy': GATE['POLICY'],
            'identity': identity, 'identityFiles': {'source': source, 'input': inputs},
            'projectKey': 'phsb5321_pi-memory-sound-qa', 'candidateRevision': 'fixture-not-scm-proof',
            'tools': {'fixture': {'binary': tool, 'metadata': metadata, 'version': 'fixture-1', 'packageMetadata': True}},
            'eligibleSources': [{'path': 'a.ts', 'sha256': 'a' * 64}, {'path': 'b.ts', 'sha256': 'b' * 64}],
            'expectedNewSources': ['a.ts', 'b.ts'], 'stages': {}}
results, receipts = {}, {}
for stage in GATE['STAGES']:
    result = {'identity': identity, 'fixture': True}
    if stage == 'compiled':
        result.update(status='COMPILED_FOCUSED_QA_PASS', executionMode='compiled-native-rich-pty')
    elif stage == 'api-history':
        result.update(acceptedScopes=['six-export-api', 'native-history850', 'same-A-B-history', 'richPTY', 'native-bridge', 'source-free-package', 'normal-teardown'], historyEntries=850)
    elif stage in ('biome', 'types'):
        result.update(errors=0, warnings=0, infos=0, producerCheckReuse=True)
    elif stage == 'coverage':
        result.update(kind='source-mapped-TS-V8', sourceMapped=True, observedV8=True, rawFiles=[source], mapFiles=[map_file],
                      mapsBoundToArtifact=True, completeChangedSourceConditionAccounting=True, newCoverage=80,
                      files={name: {'sourceSha256': digest, 'lines': {'total': 3, 'covered': 3}, 'conditions': {'total': 2, 'covered': 1}}
                             for name, digest in [('a.ts', 'a' * 64), ('b.ts', 'b' * 64)]},
                      newCodeSources={name: {'lines': {'total': 3, 'covered': 3}, 'conditions': {'total': 2, 'covered': 1}}
                                      for name in ('a.ts', 'b.ts')})
    elif stage == 'aislop': result.update(errors=0)
    elif stage == 'jscpd': result.update(baseline=GATE['POLICY']['cloneBaseline'], minTokens=50, newCloneGrowth=0)
    elif stage == 'baseline':
        result.update(projectKey=manifest['projectKey'], ceStatus='SUCCESS', analysisId='fixture-baseline-id',
                      revision='7c10bd4337495ee613f2224843ecdf349b80d1df', tree='de4e0ad2e4ca4d3bf80a6e89d1bec453edbc85a0',
                      version='1.0.4', newCodeType='SPECIFIC_ANALYSIS', newCodeValue='fixture-baseline-id', rawFiles=[source])
    elif stage == 'sonar':
        result.update(scanExecuted=True, ceStatus='SUCCESS', analysisId='fixture-candidate-id', projectKey=manifest['projectKey'],
                      baselineAnalysisId='fixture-baseline-id', candidateIdentity=identity, qualityGate='OK', unreviewedHotspots=0,
                      allPagesRead=True, revision=manifest['candidateRevision'], rawFiles=[source],
                      metrics={name: threshold for name, (_, threshold) in GATE['METRICS'].items()})
    results[stage] = result
    receipt = {'status': 'EXECUTED', 'executed': True, 'fixture': True, 'identity': identity,
               'command': ['FIXTURE_ONLY', stage], 'tool': 'fixture', 'toolVersion': 'fixture-1',
               'invocationID': os.environ.get('INVOCATION_ID', 'fixture-explicit-no-product-invocation'),
               'cgroup': Path('/proc/self/cgroup').read_text(), 'log': log, 'exit': 0,
               'result': file(stage + '-result.json', result)}
    receipts[stage] = receipt
    manifest['stages'][stage] = {'command': receipt['command'], 'receipt': file(stage + '-receipt.json', receipt)}
checks = []


def check(name, modified, expected, substring=None, fixture=True):
    binding = file(name + '-manifest.json', modified)
    report = GATE['evaluate'](binding['path'], fixture)
    assert report['status'] == expected, (name, report)
    assert report['ACED'] is False and report['commandsLaunched'] == 0
    if substring: assert substring in report.get('blocker', ''), (name, report)
    file(name + '-gate-result.json', report)
    checks.append({'name': name, 'actualStatus': report['status'], 'actualExit': report['exit']})


def changed_result(stage, mutate):
    candidate = copy.deepcopy(manifest)
    data = copy.deepcopy(results[stage]); mutate(data)
    label = str(len(checks)) + '-' + stage
    receipt = copy.deepcopy(receipts[stage]); receipt['result'] = file('control-' + label + '-result.json', data)
    candidate['stages'][stage]['receipt'] = file('control-' + label + '-receipt.json', receipt)
    return candidate


check('accepting-fixture-never-ACED', manifest, 'FIXTURE_GATE_PASS')
bad = copy.deepcopy(manifest); bad['tools']['fixture']['binary']['path'] = str(out / 'missing-tool')
check('missing-tool', bad, 'BLOCKED', 'Unavailable file/tool')
bad = copy.deepcopy(manifest); bad['identity']['sourceSha256'] = '0' * 64
check('wrong-source', bad, 'FAIL', 'Wrong source/input')
check('wrong-tuple', changed_result('compiled', lambda r: r['identity'].update(tuple='wrong')), 'FAIL', 'Wrong result identity')
check('unmapped-source', changed_result('coverage', lambda r: r['files'].pop('b.ts')), 'FAIL', 'Unmapped/skipped')
check('unavailable-map', changed_result('coverage', lambda r: r.update(mapFiles=[])), 'BLOCKED', 'Unavailable emitted source maps')
check('fake-coverage', changed_result('coverage', lambda r: r.update(kind='generated-js-fixture-score', observedV8=False)), 'FAIL', 'Fake/generated-JS')
check('fake-coverage-score', changed_result('coverage', lambda r: r.update(newCoverage=100)), 'FAIL', 'Fake coverage score')
check('red-quality', changed_result('sonar', lambda r: r['metrics'].update(new_coverage=79)), 'FAIL', 'Red quality metric')
check('wrong-clonebaseline', changed_result('jscpd', lambda r: r.update(baseline='7c10bd4337495ee613f2224843ecdf349b80d1df')), 'FAIL', 'Wrong clone baseline')
check('unexecuted-scan', changed_result('sonar', lambda r: r.update(scanExecuted=False)), 'BLOCKED', 'Unexecuted scan')
check('missing-condition', changed_result('coverage', lambda r: r['files']['b.ts'].pop('conditions')), 'BLOCKED', 'Incomplete')
check('red-command', changed_result('aislop', lambda r: r.update(errors=1)), 'FAIL', 'Red aislop')
check('wrong-baseline-ID', changed_result('baseline', lambda r: r.update(newCodeValue='v1.0.4')), 'FAIL', 'Wrong actual baseline pin')
check('fixture-refused-as-product', manifest, 'FAIL', 'Fixture manifest cannot', fixture=False)
bad = copy.deepcopy(manifest); bad['identity']['distSha256'] = None
check('unavailable-artifact', bad, 'BLOCKED', 'Unbound source/artifact')
report = {'status': 'PROJECT_GATE_SCHEMA_FIXTURES_PASS', 'checks': checks, 'count': len(checks),
          'ACED': False, 'scans': 0, 'rootTypecheckerOrBuildRuns': 0, 'productHosts': 0}
file('result.json', report)
print(json.dumps(report, indent=2))
