"""Sequential exact-artifact quality work; normal heavy only after compiled PASS.
--manifest routes to real quality-execution.py after compiled/API/map/SCM gates.
Historical --compiled-pass local collector remains below; it never submits scans.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import sys
import tarfile

OWN = Path(__file__).resolve().parent
REPO = OWN.parent.parent
ENGINE = Path('/nix/store/rvc5bdlips64617figwb7zdgvv47c5x7-code-slop-gate-0.1.0/libexec/code-slop-gate')
GATE = runpy.run_path(str(OWN / 'artifact-entry.py'), run_name='quality_identity')
CODE = re.compile(r'\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php)$')


def main():
    if '--manifest' in sys.argv:
        return runpy.run_path(str(OWN / 'quality-execution.py'), run_name='real_quality_execution')['main']()
    parser = argparse.ArgumentParser()
    parser.add_argument('--compiled-pass', required=True)
    parser.add_argument('--artifact-receipt', required=True)
    parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    out = Path(args.evidence).resolve()
    assert out.is_relative_to(OWN / 'evidence')
    out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'BLOCKED', 'scansSubmitted': 0, 'compilerInvocations': 0, 'baselineUpdated': False}
    try:
        quality = json.loads((OWN / 'QUALITY-CONTRACT.json').read_text())
        proof = quality['accessProof']
        proof_path = Path(proof['path'])
        assert hashlib.sha256(proof_path.read_bytes()).hexdigest() == proof['sha256'], 'Sonar access-proof drift'
        access = json.loads(proof_path.read_text())
        assert access['project']['key'] == quality['projectKey'] and access['project']['visibility'] == 'private'
        assert access['tokenMetadata']['type'] == 'PROJECT_ANALYSIS_TOKEN'
        assert access['tokenMetadata']['projectKey'] == quality['projectKey'] and access['rbwEntryPresent']
        assert access['storedAnalysisTokenAuthenticationVerified'] is True
        report['SonarAccess'] = {'status': 'VERIFIED_PROJECT_TOKEN_ACCESS_CLOSED', 'proofSha256': proof['sha256'],
                                'projectKey': quality['projectKey'], 'baselineAnalysisIdAtSetup': access['baselineAnalysisId']}
        previous = json.loads(Path(args.compiled_pass).read_text())
        assert previous['status'] == 'COMPILED_FOCUSED_QA_PASS', 'Compiled behavior must pass first'
        receipt, identity = GATE['verify_receipt'](args.artifact_receipt)
        for key in ('sourceSha256', 'inputSha256', 'distSha256', 'runtimeClosureSha256'):
            assert previous['identity'][key] == identity[key], 'Exact-head quality identity drift'
        report['identity'] = identity
        baseline_sha = quality['cloneRatchet']['originalGitBaseline']
        assert baseline_sha == '4e494929998d6bc4fccf75e0a233f727db4b70ee', 'Original clone ratchet cannot be reset'
        assert subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', baseline_sha + '^{commit}'], text=True).strip() == baseline_sha
        report['baseline'] = {'policy': 'original pinned Git origin/main; independent of Sonar v1.0.4 baseline', 'sha': baseline_sha}
        env = {key: value for key, value in os.environ.items() if key in ('PATH', 'HOME', 'LANG', 'XDG_RUNTIME_DIR')}
        env.update(UV_THREADPOOL_SIZE='1', OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', GOMAXPROCS='1', PYTHONDONTWRITEBYTECODE='1')
        report['cgroup'] = Path('/proc/self/cgroup').read_text()

        def run(name, argv, timeout=110, extra=None):
            with (out / (name + '.log')).open('wb') as log:
                child = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT, env={**env, **(extra or {})}, timeout=timeout)
            report[name] = {'argv': argv, 'exit': child.returncode}
            return child.returncode

        # Real bounded coverage over ONE existing compiled battery; no generic suite.
        coverage = out / 'v8'
        coverage.mkdir()
        run('coverage', ['node', '--v8-pool-size=1', '--max-old-space-size=512', '--enable-source-maps', '--test',
                        '--experimental-test-coverage', '--test-reporter=lcov', '--test-reporter-destination=' + str(out / 'lcov.info'),
                        str(OWN / 'compiled-coverage.test.mjs')], extra={
                            'NODE_V8_COVERAGE': str(coverage), 'MSQA_COMPILED_PASS': str(Path(args.compiled_pass).resolve()),
                            'MSQA_PRODUCER_RECEIPT': str(Path(args.artifact_receipt).resolve()),
                            'MSQA_COVERAGE_EVIDENCE': str(out / 'coverage-compiled'),
                        })
        baseline, candidate = out / 'baseline', out / 'candidate'
        baseline.mkdir(); candidate.mkdir()
        archive = out / 'baseline.tar'
        with archive.open('wb') as stream:
            subprocess.run(['git', '-C', str(REPO), 'archive', baseline_sha], stdout=stream, check=True, env=env, timeout=15)
        with tarfile.open(archive) as stream:
            stream.extractall(baseline, filter='data')
        source_rows = json.loads(Path(receipt['sourceManifest']['path']).read_text())
        for row in source_rows:
            src = Path(receipt['sourceRoot']) / row['path']
            dst = candidate / row['path']
            dst.parent.mkdir(parents=True, exist_ok=True)
            if src.is_symlink():
                dst.symlink_to(os.readlink(src))
            else:
                shutil.copy2(src, dst)
        old = subprocess.check_output(['git', '-C', str(REPO), 'ls-tree', '-r', '-z', baseline_sha])
        baseline_rows = {row.split(b'\t', 1)[1].decode(): row.split(b'\t', 1)[0].split()[2].decode()
                         for row in old.split(b'\0') if row}
        current_rows = {row['path']: row['blob'] for row in source_rows}
        changes = bytearray()
        for name in sorted(set(baseline_rows) | set(current_rows)):
            if baseline_rows.get(name) == current_rows.get(name):
                continue
            status = 'A' if name not in baseline_rows else 'D' if name not in current_rows else 'M'
            changes.extend(status.encode() + b'\0' + name.encode() + b'\0')
        (out / 'changes.z').write_bytes(changes)
        new_code = [name for name in current_rows if CODE.search(name) and current_rows[name] != baseline_rows.get(name)]
        report['changedCodePaths'] = new_code
        ais = str((ENGINE / 'node_modules/.bin/aislop').resolve())
        run('aislop', ['node', '--v8-pool-size=1', '--max-old-space-size=1024', ais, 'scan', str(candidate), '--json'])
        raw = json.loads((out / 'aislop.log').read_text())
        report['aislopErrors'] = raw['summary']['errors']
        report['aislopScore'] = raw.get('score')
        # Exact installed snapshot collection/ratchet flags, baseline never changed.
        jscpd = str((ENGINE / 'node_modules/.bin/jscpd').resolve())
        for label, directory in (('baseline', baseline), ('candidate', candidate)):
            files = [str(file) for file in sorted(directory.rglob('*')) if file.is_file() and CODE.search(str(file))]
            target = out / (label + '-jscpd')
            target.mkdir()
            run(label + '-jscpd', ['node', '--v8-pool-size=1', '--max-old-space-size=1024', jscpd,
                                 '--reporters', 'json', '--silent', '--absolute', '--no-gitignore', '--min-tokens', '50',
                                 '--threshold', '100', '--output', str(target), *files])
        run('clone-ratchet', ['node', '--v8-pool-size=1', str(ENGINE / 'jscpd-snapshot-compare.js'),
                            '--baseline-report', str(out / 'baseline-jscpd/jscpd-report.json'),
                            '--candidate-report', str(out / 'candidate-jscpd/jscpd-report.json'),
                            '--baseline-root', str(baseline), '--candidate-root', str(candidate),
                            '--changes', str(out / 'changes.z')])
        report['cloneRatchet'] = json.loads((out / 'clone-ratchet.log').read_text())
        if (out / 'lcov.info').exists():
            lcov = (out / 'lcov.info').read_text()
            report['lcovSourceFiles'] = [line[3:] for line in lcov.splitlines() if line.startswith('SF:')]
            report['lcovSha256'] = hashlib.sha256(lcov.encode()).hexdigest()
        report['ACEDMissing'] = ['Actual successful exact v1.0.4 analysis and returned project-only SPECIFIC_ANALYSIS baseline ID',
                                 'Actual exact-candidate Sonar analysis and verified source-map/changed-source/condition accounting; generated-JS LCOV alone is not >=80% acceptance']
        report['status'] = 'QUALITY_CHECKS_EXECUTED_ACED_NOT_ACCEPTED'
        return 0
    except (AssertionError, KeyError, OSError, ValueError, subprocess.SubprocessError) as error:
        report['error'] = str(error)
        return 78
    finally:
        (out / 'result.json').write_bytes(GATE['encode'](report))
        print(json.dumps({key: report.get(key) for key in ('status', 'aislopErrors', 'ACEDMissing', 'error')}))


if __name__ == '__main__':
    raise SystemExit(main())
