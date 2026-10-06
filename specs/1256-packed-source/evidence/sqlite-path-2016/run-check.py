#!/usr/bin/env python3
"""Exactly one bounded offline2016 path check; raw stdio/argv/exit retained."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
NODE = '/nix/store/2gd4h12irmnanhg33md2rpjygrsj5ypb-nodejs-slim-22.23.2/bin/node'
argv = [NODE, '--experimental-strip-types', str(ROOT/'test/packed-sqlite-path-regression-2016.ts')]
env = os.environ.copy()
env['UV_THREADPOOL_SIZE'] = '1'
env['OMP_NUM_THREADS'] = '1'
old_options = env.get('NODE_OPTIONS', '')
env['NODE_OPTIONS'] = (old_options + ' --v8-pool-size=1').strip()
start = time.monotonic()
result = {'started_brt': dt.datetime.now(dt.timezone(dt.timedelta(hours=-3))).isoformat(), 'argv': argv,
          'thread_limits': {k:env[k] for k in ['UV_THREADPOOL_SIZE','OMP_NUM_THREADS','NODE_OPTIONS']},
          'prior_NODE_OPTIONS_preserved': old_options, 'node_checks_launched': 1, 'watchdog_seconds': 45,
          'scope': 'Offline actual SOURCE path slices/real filesystem with injectedSDK/adapter, notSQLite/full306/compiler/model'}
try:
    child = subprocess.run(argv, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=45, check=False)
    (HERE/'check.stdout.txt').write_bytes(child.stdout)
    (HERE/'check.stderr.txt').write_bytes(child.stderr)
    result.update(exit_code=child.returncode, stdout_bytes=len(child.stdout), stderr_bytes=len(child.stderr),
                  stdout_sha256=hashlib.sha256(child.stdout).hexdigest(), stderr_sha256=hashlib.sha256(child.stderr).hexdigest())
except (OSError, subprocess.TimeoutExpired) as exc:
    result.update(exit_code=None, failure_type=type(exc).__name__, failure=str(exc))
    (HERE/'check.stdout.txt').write_bytes(getattr(exc,'stdout',None) or b'')
    (HERE/'check.stderr.txt').write_bytes(getattr(exc,'stderr',None) or b'')
result['elapsed_seconds'] = time.monotonic()-start
result['finished_brt'] = dt.datetime.now(dt.timezone(dt.timedelta(hours=-3))).isoformat()
result['result'] = 'NODE_CHECK_EXIT0' if result.get('exit_code') == 0 else 'ACTUAL_CHECK_FAILURE_NOT_RED_GREEN'
(HERE/'check-invocation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
raise SystemExit(0 if result.get('exit_code') == 0 else 1)
