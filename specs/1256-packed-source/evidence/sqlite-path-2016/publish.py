#!/usr/bin/env python3
"""One ordinary signed commit/SSH push for scoped2016; stop on real normal gate."""
import datetime as dt
import hashlib
import json
from pathlib import Path
import subprocess
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
NOTE = Path('/home/notroot/Documents/Notes-20261005-disk-attribution/1. Projects/Desktop Job Containment/evidence/2026-10-06-pi-sqlite-path-2016')
PREFIX = 'specs/1256-packed-source/evidence/sqlite-path-2016/'
CODE = ['test/packed-isolation-306.ts', 'test/packed-sqlite-path-regression-2016.ts']
start = time.monotonic()
result = {'authority':'ROOT-PROGRESS-2016-PI', 'started_brt':dt.datetime.now(dt.timezone(dt.timedelta(hours=-3))).isoformat(),
          'outcome':'STARTED', 'commit_calls':0, 'push_calls':0,
          'native_body_counts':{'new_source_inspection':1,'native_contract_archive':1,'offline_path_check':1,'normal_publication':1,'newPI_total':4,'prior1641_total':5,'separate2016DISK_capture':1},
          'compiler_SDK_full306_countertest_model_network_fetch_heavy_calls':0,'p1_cued':False,
          'normal_hooks_signing_prepush_unchanged':True,'protected_base_raw_whitespace_trustfile_manual_gates':0}
argv_file = HERE/'publication-argv.txt'
argv_file.write_text('')
phase = 'publication-start'

def save(name, value):
    (HERE/name).write_text(json.dumps(value,indent=2)+'\n')

def run(name, args, seconds=8, fatal=True):
    global phase
    phase = name
    left = 108-(time.monotonic()-start)
    if left <= 0:
        raise TimeoutError('Total publication bound; no retry')
    with argv_file.open('a') as f:
        f.write(json.dumps({'at':dt.datetime.now(dt.timezone(dt.timedelta(hours=-3))).isoformat(),'phase':name,'argv':args,'timeout_s':min(seconds,left)})+'\n')
    child = subprocess.run(args,cwd=ROOT,capture_output=True,timeout=min(seconds,left),check=False)
    (HERE/(name+'.stdout.txt')).write_bytes(child.stdout)
    (HERE/(name+'.stderr.txt')).write_bytes(child.stderr)
    with (HERE/'publication-exits.txt').open('a') as f:
        f.write(json.dumps({'phase':name,'exit':child.returncode})+'\n')
    if fatal and child.returncode:
        raise subprocess.CalledProcessError(child.returncode,args)
    return child

try:
    result['before_HEAD'] = run('before-head',['git','rev-parse','HEAD']).stdout.decode().strip()
    run('before-status',['git','status','--porcelain=v1','-uall'])
    existing = run('preexisting-staged',['git','diff','--cached','--name-only']).stdout.decode().splitlines()
    if existing:
        raise RuntimeError('Actual unexpected pre-existing staged paths; preserve, do not unstage')
    paths = CODE + [str(p.relative_to(ROOT)) for p in sorted(HERE.iterdir()) if p.is_file() and p.suffix != '.log']
    (HERE/'explicit-stage-paths.txt').write_text('\n'.join(paths)+'\n')
    run('normal-explicit-stage',['git','add','--',*paths])
    staged = run('actual-staged-paths',['git','diff','--cached','--name-only']).stdout.decode().splitlines()
    if not all(p in CODE or p.startswith(PREFIX) for p in staged):
        raise RuntimeError('Actual staged authorization scope mismatch; preserve index')
    result['commit_calls'] = 1
    run('normal-commit',['git','commit','-m','fix: retain native packed session store paths','-m','Park drops open handles, not the SDK directory. Require all eight native\nstore files and preserve source-only path regression evidence.'],62)
    result['normal_commit_succeeded'] = True
    head = run('actual-head',['git','rev-parse','HEAD']).stdout.decode().strip()
    result['actual_HEAD'] = head
    result['actual_tree'] = run('actual-tree',['git','rev-parse','HEAD^{tree}']).stdout.decode().strip()
    run('actual-signed-commit-object',['git','cat-file','commit',head])
    result['push_calls'] = 1
    run('normal-SSH-push',['git','push','git@github.com:phsb5321/pi.git','HEAD:refs/heads/1256-packed-source'],20)
    result['SSH_push_acknowledged'] = True
    remote = run('SSH-exact-remote-readback',['git','ls-remote','--exit-code','git@github.com:phsb5321/pi.git','refs/heads/1256-packed-source'],8).stdout.decode().split()
    if remote != [head,'refs/heads/1256-packed-source']:
        raise RuntimeError('Actual remote HEAD readback mismatch')
    result['SSH_remote_exact_HEAD_verified'] = True
    pr = json.loads(run('PR12-exact-readback',['gh','pr','view','12','--repo','phsb5321/pi','--json','number,url,state,headRefOid,baseRefName,assignees,mergeStateStatus'],8).stdout)
    result['PR'] = pr
    if pr['headRefOid'] != head or pr['baseRefName'] != 'memory-sound' or pr['state'] != 'OPEN' or not any(p['login']=='phsb5321' for p in pr['assignees']):
        raise RuntimeError('Actual PR12 head/base/OPEN/assignee mismatch')
    result['PR_exact_HEAD_base_OPEN_assignee_verified'] = True
    result['outcome'] = 'SOURCE_PATH_HEAD_SSH_PUBLISHED_EXISTING_PR12_OPEN_NOT_INSTALLED'
    # Historical CI metadata is evidence only, never a new source/approval gate.
    job = run('historical-billing-job',['gh','api','repos/phsb5321/pi/actions/jobs/112496714128'],6,fatal=False)
    if job.returncode == 0:
        info = json.loads(job.stdout)
        result['historical_billing_job'] = {k:info.get(k) for k in ['id','run_id','head_sha','status','conclusion','steps','check_run_url']}
        check_url = info.get('check_run_url','')
        if check_url.startswith('https://api.github.com/repos/phsb5321/pi/check-runs/'):
            annotations = run('historical-billing-annotations',['gh','api',check_url+'/annotations'],6,fatal=False)
            result['historical_annotations_exit'] = annotations.returncode
            if annotations.returncode == 0:
                result['historical_annotations'] = json.loads(annotations.stdout)
    else:
        result['historical_billing_job_read_gap'] = {'exit':job.returncode,'Root_exact_annotation_retained_in':'root-ci-context.json'}
    # Observe signature after actual normal signing/publication; no trust-file repair/gate.
    sig = run('signature-observation',['git','verify-commit',head],3,fatal=False)
    result['signature_observation'] = {'exit':sig.returncode,'cryptographically_Good':b'Good "git" signature' in sig.stderr,
                                       'local_principal_authorization':'UNQUALIFIED' if sig.returncode else 'VERIFIED',
                                       'normal_signing_creation_succeeded':True,'trust_config_changed':False}
    result['published_source_SHA256'] = {p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in CODE}
except Exception as exc:
    result['outcome'] = 'ACTUAL_NORMAL_GATE_OR_BOUNDED_FAILURE'
    result['failure'] = {'type':type(exc).__name__,'message':str(exc),'exit':getattr(exc,'returncode',None)}
finally:
    result['last_phase'] = phase
    result['finished_brt'] = dt.datetime.now(dt.timezone(dt.timedelta(hours=-3))).isoformat()
    result['elapsed_seconds'] = time.monotonic()-start
    # Verify only the five previously named WIP bytes offline, without changing them.
    protected = []
    for line in (HERE/'protected-existing-WIP.sha256').read_text().splitlines():
        expected,path = line.split('  ',1)
        observed = hashlib.sha256((ROOT/path).read_bytes()).hexdigest()
        protected.append({'path':path,'before_SHA256':expected,'after_SHA256':observed,'unchanged':expected==observed})
    result['protected_existing_five_WIP'] = protected
    result['source_vs_installed'] = 'SOURCE plumbing only; actual SDK/nativeSQLite/full306/Rootroute/compiler/RAM/N1/100x adoption NOT claimed; p1 UNCued'
    result['MC_pointer_not_written_sibling'] = '/home/notroot/Documents/Notes-2330-comparator-scope/1. Projects/Herdr Fleet Coordination/evidence/portfolio-pi-sqlite-path-2016-2026-10-06'
    save('publication-result.json',result)
    NOTE.mkdir(parents=True,exist_ok=True)
    for p in HERE.iterdir():
        if p.is_file(): (NOTE/p.name).write_bytes(p.read_bytes())
    print(json.dumps(result,indent=2))
raise SystemExit(0 if result['outcome']=='SOURCE_PATH_HEAD_SSH_PUBLISHED_EXISTING_PR12_OPEN_NOT_INSTALLED' else 1)
