"""One fail-closed project evidence gate; no implicit compiler/scanner/admission.
Consume exact existing command receipts. Fixture acceptance is never ACED.
"""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path
import runpy
import subprocess
import sys

OWN = Path(__file__).resolve().parent
STAGES = ('compiled', 'api-history', 'biome', 'types', 'coverage', 'aislop', 'jscpd', 'baseline', 'sonar')
POLICY = {'cloneBaseline': '4e494929998d6bc4fccf75e0a233f727db4b70ee', 'minTokens': 50, 'newCloneMaximum': 0,
          'aislopErrorsMaximum': 0, 'newCoverageMinimum': 80, 'newDuplicationMaximum': 3}
TOOL_VERSIONS = {'biome': '2.3.5', 'types': '7.0.2', 'aislop': '0.12.0', 'jscpd': '5.0.10', 'sonar': '8.1.0.6389'}
METRICS = runpy.run_path(str(OWN.parent / '1006-composed-qa/sonar-readback.py'))['METRICS']


class Stop(Exception):
    def __init__(self, status, reason):
        self.status, self.reason = status, reason
        super().__init__(reason)


def need(ok, reason, status='FAIL'):
    if not ok:
        raise Stop(status, reason)


def bound(binding):
    need(isinstance(binding, dict) and binding.get('path') and binding.get('sha256'), 'Missing bound file', 'BLOCKED')
    path = Path(binding['path'])
    need(path.is_file(), 'Unavailable file/tool: ' + str(path), 'BLOCKED')
    raw = path.read_bytes()
    need(hashlib.sha256(raw).hexdigest() == binding['sha256'], 'File identity mismatch: ' + str(path))
    return raw


def number(value):
    need(not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value), 'Unavailable/non-numeric metric', 'BLOCKED')
    return value


def evaluate(manifest_path, fixture=False):
    report = {'status': 'BLOCKED', 'ACED': False, 'commandsLaunched': 0,
              'stages': {name: {'status': 'NOT_EXECUTED'} for name in STAGES}}
    current = None
    try:
        manifest_bytes = Path(manifest_path).read_bytes()
        manifest = json.loads(manifest_bytes)
        report['manifestSha256'] = hashlib.sha256(manifest_bytes).hexdigest()
        need(manifest['schema'] == 'memory-sound-project-gate/1', 'Wrong gate schema')
        need(manifest['fixture'] is fixture, 'Fixture manifest cannot enter product gate')
        need(manifest['policy'] == POLICY, 'Wrong clone baseline/ratchet or relaxed policy')
        identity = manifest['identity']
        need(all(identity.get(key) for key in ('tuple', 'sourceSha256', 'inputSha256', 'distSha256', 'runtimeClosureSha256')), 'Unbound source/artifact tuple', 'BLOCKED')
        for label, binding in manifest['identityFiles'].items():
            raw = bound(binding)
            if label in ('source', 'input'):
                need(binding['sha256'] == identity[label + 'Sha256'], 'Wrong source/input identity')
        expected_new_sources = set(manifest['expectedNewSources'])
        artifact = None
        if not fixture:
            need(manifest['projectKey'] == 'phsb5321_pi-memory-sound-qa', 'Unapproved project scope')
            source_rows = json.loads(bound(manifest['identityFiles']['source']))
            eligible = {row['path']: row['sha256'] for row in source_rows
                        if re.search(r'\.(ts|tsx|js|jsx|mjs|cjs)$', row['path'])
                        and not row['path'].endswith('.d.ts')
                        and not re.search(r'(^|/)(test|tests)/|\.(test|spec)\.', row['path'])}
            need(eligible == {row['path']: row['sha256'] for row in manifest['eligibleSources']},
                 'Skipped source scope/coverage carveout')
            tree = subprocess.check_output(['git', '-C', str(OWN.parent.parent), 'ls-tree', '-r', '-z',
                                            '7c10bd4337495ee613f2224843ecdf349b80d1df'], timeout=15)
            baseline_blobs = {row.split(b'\t', 1)[1].decode(): row.split(b'\t', 1)[0].split()[2].decode()
                              for row in tree.split(b'\0') if row}
            actual_new_sources = {row['path'] for row in source_rows if row['path'] in eligible
                                  and row['blob'] != baseline_blobs.get(row['path'])}
            need(actual_new_sources == expected_new_sources, 'Skipped changed source relative to exact release baseline')
            need(all(name in manifest['tools'] and manifest['tools'][name]['version'] == version
                     for name, version in TOOL_VERSIONS.items()), 'Missing/wrong installed project tool version', 'BLOCKED')
            gate = runpy.run_path(str(OWN / 'artifact-entry.py'), run_name='project_gate_artifact')
            artifact, actual = gate['verify_receipt'](manifest['artifactReceipt']['path'])
            bound(manifest['artifactReceipt'])
            publication_binding = manifest['identityFiles']['publication']
            publication = json.loads(bound(publication_binding))
            need(publication['tuple'] == identity['tuple'] and
                 publication['source_sha256'] == identity['sourceSha256'] and
                 publication['input_sha256'] == identity['inputSha256'], 'Wrong original producer tuple/source')
            need(artifact['producerBindings'].get(publication_binding['path']) == publication_binding['sha256'],
                 'Original publication omitted from artifact provenance')
            for key in ('sourceSha256', 'inputSha256', 'distSha256', 'runtimeClosureSha256'):
                need(actual[key] == identity[key], 'Artifact/source identity mismatch: ' + key)
        report['identity'] = identity
        # Missing tools never disappear behind a completed command label.
        for name, tool in manifest['tools'].items():
            bound(tool['binary'])
            metadata = bound(tool['metadata'])
            need(tool.get('version'), 'Missing tool version: ' + name, 'BLOCKED')
            if tool.get('packageMetadata'):
                need(json.loads(metadata)['version'] == tool['version'], 'Wrong installed tool version: ' + name)
        for current in STAGES:
            declaration = manifest['stages'][current]
            need(declaration.get('receipt'), 'Missing/unexecuted stage: ' + current, 'BLOCKED')
            receipt_bytes = bound(declaration['receipt'])
            receipt = json.loads(receipt_bytes)
            need(receipt['status'] == 'EXECUTED' and receipt.get('executed') is True, 'Unexecuted stage: ' + current, 'BLOCKED')
            need(receipt['fixture'] is fixture and receipt['identity'] == identity, 'Wrong source/tuple or fixture provenance: ' + current)
            need(receipt['command'] == declaration['command'] and receipt['command'], 'Wrong actual command: ' + current)
            need(receipt.get('tool') in manifest['tools'], 'Missing stage tool: ' + current, 'BLOCKED')
            need(receipt['toolVersion'] == manifest['tools'][receipt['tool']]['version'], 'Wrong stage tool version: ' + current)
            need(receipt.get('invocationID') and receipt.get('cgroup'), 'Missing actual execution identity: ' + current, 'BLOCKED')
            bound(receipt['log'])
            need(receipt['exit'] == 0, 'Red command: ' + current)
            raw_result = bound(receipt['result'])
            result = json.loads(raw_result)
            need(result['identity'] == identity and result['fixture'] is fixture, 'Wrong result identity/provenance: ' + current)
            if current == 'compiled':
                need(result['status'] == 'COMPILED_FOCUSED_QA_PASS' and result['executionMode'] == 'compiled-native-rich-pty', 'Compiled behavior prerequisite not accepted')
            elif current == 'api-history':
                required = {'six-export-api', 'native-history850', 'same-A-B-history', 'richPTY', 'native-bridge', 'source-free-package', 'normal-teardown'}
                need(required <= set(result['acceptedScopes']) and result['historyEntries'] == 850, 'Missing compiled API/history/PTY/package scope')
            elif current in ('biome', 'types'):
                need(result['errors'] == 0 and result.get('warnings', 0) == 0 and result.get('infos', 0) == 0, 'Red Biome/type diagnostics')
                need(result['producerCheckReuse'] is True, 'Root check duplication forbidden')
            elif current == 'coverage':
                need(result['kind'] == 'source-mapped-TS-V8' and result['sourceMapped'] is True and result['observedV8'] is True, 'Fake/generated-JS coverage')
                for file in result['rawFiles']:
                    bound(file)
                need(result['mapFiles'], 'Unavailable emitted source maps', 'BLOCKED')
                for binding in result['mapFiles']:
                    source_map = json.loads(bound(binding))
                    need(source_map['version'] == 3 and source_map['mappings'] and source_map['sources']
                         and len(source_map['sourcesContent']) == len(source_map['sources']), 'Unmapped emitted source map')
                    if artifact is not None:
                        need(artifact['runtimeFiles'].get(str(Path(binding['path']).resolve())) == binding['sha256'],
                             'Map omitted from exact artifact/runtime inventory')
                eligible = {row['path']: row['sha256'] for row in manifest['eligibleSources']}
                covered = result['files']
                need(eligible and set(covered) == set(eligible), 'Unmapped/skipped eligible source')
                for path, digest in eligible.items():
                    need(covered[path]['sourceSha256'] == digest, 'Coverage source identity mismatch')
                    for field in ('lines', 'conditions'):
                        counts = covered[path][field]
                        need(0 <= number(counts['covered']) <= number(counts['total']), 'Invalid source/condition denominator')
                need(result['mapsBoundToArtifact'] and result['completeChangedSourceConditionAccounting'], 'Unbound maps/source conditions')
                totals, hits = 0, 0
                need(result['newCodeSources'] and set(result['newCodeSources']) == expected_new_sources,
                     'Missing/skipped actual new-source/condition partition', 'BLOCKED')
                for path, fields in result['newCodeSources'].items():
                    need(path in covered, 'Unmapped new-code source')
                    for field in ('lines', 'conditions'):
                        counts = fields[field]
                        need(0 <= number(counts['covered']) <= covered[path][field]['covered'] and
                             counts['covered'] <= number(counts['total']) <= covered[path][field]['total'],
                             'Invalid new-source/condition denominator')
                        totals += counts['total']; hits += counts['covered']
                need(totals > 0 and abs(number(result['newCoverage']) - 100 * hits / totals) < 0.01, 'Fake coverage score/denominator')
                need(number(result['newCoverage']) >= 80, 'Red new-source coverage')
            elif current == 'aislop':
                need(number(result['errors']) == 0, 'Red aislop')
            elif current == 'jscpd':
                need(result['baseline'] == POLICY['cloneBaseline'] and result['minTokens'] == 50, 'Wrong clone baseline/minTokens')
                need(number(result['newCloneGrowth']) == 0, 'New clone growth')
            elif current == 'baseline':
                need(result['projectKey'] == manifest['projectKey'] and result['ceStatus'] == 'SUCCESS' and result['analysisId'], 'Baseline CE not successful', 'BLOCKED')
                need(result['revision'] == '7c10bd4337495ee613f2224843ecdf349b80d1df' and result['tree'] == 'de4e0ad2e4ca4d3bf80a6e89d1bec453edbc85a0' and result['version'] == '1.0.4', 'Wrong release baseline')
                for file in result['rawFiles']:
                    bound(file)
                need(result['newCodeType'] == 'SPECIFIC_ANALYSIS' and result['newCodeValue'] == result['analysisId'], 'Wrong actual baseline pin')
                report['baselineAnalysisId'] = result['analysisId']
            elif current == 'sonar':
                need(result['scanExecuted'] is True and result['ceStatus'] == 'SUCCESS' and result['analysisId'], 'Unexecuted scan', 'BLOCKED')
                need(result['projectKey'] == manifest['projectKey'] and result['baselineAnalysisId'] == report['baselineAnalysisId'] and result['candidateIdentity'] == identity, 'Wrong Sonar candidate/project/baseline identity')
                for file in result['rawFiles']:
                    bound(file)
                need(result['revision'] == manifest['candidateRevision'], 'Wrong actual Sonar revision')
                need(result['qualityGate'] == 'OK' and result['unreviewedHotspots'] == 0 and result['allPagesRead'], 'Red/unbound quality readback')
                for key, (comparison, threshold) in METRICS.items():
                    value = number(result['metrics'].get(key))
                    need(value >= 0, 'Invalid negative quality metric: ' + key)
                    if 'rating' in key:
                        need(1 <= value <= 5, 'Invalid A-E rating: ' + key)
                    need(value >= threshold if comparison == 'min' else value <= threshold, 'Red quality metric: ' + key)
            report['stages'][current] = {'status': 'PASS', 'receiptSha256': declaration['receipt']['sha256'],
                                         'command': receipt['command'], 'tool': receipt['tool'], 'toolVersion': receipt['toolVersion'],
                                         'invocationID': receipt['invocationID'], 'exit': receipt['exit'],
                                         'logSha256': receipt['log']['sha256'], 'resultSha256': receipt['result']['sha256']}
        report.update(status='FIXTURE_GATE_PASS' if fixture else 'PROJECT_ACED_PASS', ACED=not fixture)
    except Stop as error:
        report.update(status=error.status, blocker=error.reason)
        if current:
            report['stages'][current] = {'status': error.status, 'reason': error.reason}
    except (KeyError, ValueError, OSError, TypeError, AssertionError, subprocess.SubprocessError) as error:
        report.update(status='BLOCKED', blocker='Incomplete/unqualified evidence: ' + str(error))
        if current:
            report['stages'][current] = {'status': 'BLOCKED', 'reason': report['blocker']}
    report['exit'] = 0 if report['status'] in ('FIXTURE_GATE_PASS', 'PROJECT_ACED_PASS') else 78 if report['status'] == 'BLOCKED' else 3
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--fixture', action='store_true')
    args = parser.parse_args()
    out = args.evidence.resolve()
    need(out.is_relative_to(OWN / 'evidence'), 'Output outside owned evidence')
    out.mkdir(parents=True, exist_ok=False)
    report = evaluate(args.manifest, args.fixture)
    (out / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    return report['exit']


if __name__ == '__main__':
    sys.exit(main())
