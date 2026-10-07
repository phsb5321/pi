#!/usr/bin/env python3
"""One admitted offline SDK/store check. No retries, installs, compiler or provider operation."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

here = Path(__file__).resolve().parent
source = here / 'prepared-source-2144'
prior = os.environ.get('NODE_OPTIONS', '')
options = re.sub(r'(?<!\S)--v8-pool-size(?:=|\s+)\d+', '', prior).strip()
env = os.environ.copy()
env.update(UV_THREADPOOL_SIZE='1', OMP_NUM_THREADS='1', NODE_OPTIONS=(options + ' --v8-pool-size=1').strip(), PI_OFFLINE='1', NO_UPDATE_NOTIFIER='1')
node = shutil.which('node')
argv = [node, '--import', str(source/'packages/coding-agent/src/experimental/source-resolver.ts'), '--experimental-strip-types', str(here/'native-store-check.mjs')]
record = {'started_brt': datetime.datetime.now().astimezone().isoformat(), 'argv': argv, 'native_checks_launched': 1, 'child_deadline_seconds': 90, 'prior_NODE_OPTIONS': prior, 'thread_env': {k: env[k] for k in ['UV_THREADPOOL_SIZE','OMP_NUM_THREADS','NODE_OPTIONS']}, 'scope':'Actual source SDK/faux/SQLite/retained-history lifecycle, no SDK/storage mocks, not compiler/RAM/full306', 'cgroup':Path('/proc/self/cgroup').read_text(), 'pid_namespace_self_pid':os.getpid()}
start = time.monotonic()
try:
    child = subprocess.run(argv, cwd=source, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90, check=False)
    stdout, stderr, code = child.stdout, child.stderr, child.returncode
except subprocess.TimeoutExpired as error:
    stdout, stderr, code = error.stdout or b'', error.stderr or b'', 124
    record['actual_child_timeout'] = True
(here/'native.stdout.txt').write_bytes(stdout)
(here/'native.stderr.txt').write_bytes(stderr)
record.update(exit=code, elapsed_seconds=time.monotonic()-start, finished_brt=datetime.datetime.now().astimezone().isoformat(), stdout_sha256=hashlib.sha256(stdout).hexdigest(), stderr_sha256=hashlib.sha256(stderr).hexdigest(), result='ACTUAL_NATIVE_CHECK_EXIT0' if code==0 else 'ACTUAL_NATIVE_CHECK_FAILED_NOT_NATIVE_PASS')
(here/'native-invocation.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record,indent=2))
print(stdout.decode(errors='replace'))
print(stderr.decode(errors='replace'))
raise SystemExit(code)
