"""Offline actual Bash->scanner shell->JVM fd qualification, fake credentials only."""
import base64
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

OWN = Path(__file__).resolve().parent
out = Path(sys.argv[1]).resolve()
assert out.is_relative_to(OWN / 'evidence')
out.mkdir(parents=True, exist_ok=False)
helper = runpy.run_path(str(OWN / 'scanner-fd.py'))
secret = b'FAKE_ONLY_msqa_project_0123456789XYZ'
checks = []
for pattern in (secret, base64.b64encode(secret + b':')):
    for split in range(len(pattern) + 1):
        redactor = helper['Redactor'](secret)
        actual = redactor.feed(b'prefix ' + pattern[:split]) + redactor.feed(pattern[split:] + b' suffix', final=True)
        assert actual == b'prefix [REDACTED] suffix', (len(pattern), split)
checks.append('all raw/base64 token chunk boundaries redact before log persistence')
for pattern in (secret, base64.b64encode(secret + b':')):
    for end in range(1, len(pattern)):
        redactor = helper['Redactor'](secret)
        assert redactor.feed(b'prefix ' + pattern[:end], final=True) == b'prefix [REDACTED]'
checks.append('truncated token prefixes at EOF redact')
# Known malformed settings fail before child/descriptor leakage.
try:
    helper['run_scanner'](secret, b'sonar.token=other', out / 'bad.log', arguments=('-h',))
    raise AssertionError('Duplicate credential accepted')
except ValueError:
    assert not (out / 'bad.log').exists()
checks.append('duplicate credential rejected before launch')
before_fds = set(os.listdir('/proc/self/fd'))
try:
    helper['run_scanner'](secret, b'sonar.projectKey=fake', out / 'absent-directory/log', arguments=('-h',))
    raise AssertionError('Expected log-open failure')
except OSError:
    assert set(os.listdir('/proc/self/fd')) == before_fds
checks.append('log-open failure closes fd without child launch')
jdk = Path('/nix/store/ij5q131fzyqw8wh76y9nrj5jl45zviqw-openjdk-21.0.12+8/bin')
classes = out / 'classes'
classes.mkdir()
manifest = out / 'MANIFEST.MF'
manifest.write_text('Premain-Class: FdProbe\n\n')
commands = [[str(jdk / 'javac'), '-J-Xmx64m', '-J-XX:ActiveProcessorCount=1', '-d', str(classes), str(OWN / 'FdProbe.java')],
            [str(jdk / 'jar'), '-J-Xmx64m', '-J-XX:ActiveProcessorCount=1', 'cfm', str(out / 'probe.jar'), str(manifest), '-C', str(classes), '.']]
for index, argv in enumerate(commands):
    with (out / ('compile-' + str(index) + '.log')).open('wb') as log:
        result = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT, timeout=25)
    assert result.returncode == 0
settings = b'sonar.projectKey=phsb5321_pi-memory-sound-qa\n'
expected = hashlib.sha256(settings + b'\nsonar.token=' + secret + b'\n').hexdigest()
results = []
for mode in ('pass', 'fail', 'timeout'):
    record = helper['run_scanner'](secret, settings, out / (mode + '.log'), arguments=('-h',),
                                 vm_options='-javaagent:' + str(out / 'probe.jar') + '={fd},' + mode,
                                 timeout=3 if mode == 'timeout' else 15)
    log = (out / (mode + '.log')).read_bytes()
    assert ('FD_OK_SHA256=' + expected).encode() in log
    assert secret not in log and base64.b64encode(secret + b':') not in log and b'[REDACTED]' in log
    assert record['fdClosed'] and record['childReaped']
    assert (record['exit'] == 0) if mode == 'pass' else (record['exit'] != 0)
    assert record['timedOut'] == (mode == 'timeout')
    results.append({'mode': mode, **record})
    checks.append('actual launcher/JVM fd inheritance + redaction + cleanup: ' + mode)
report = {'status': 'FAKE_TOKEN_LAUNCHER_QUALIFICATION_PASS', 'checks': checks, 'runs': results,
          'compileCommands': commands, 'realTokensFetched': 0, 'remoteAnalyses': 0, 'scannerMode': 'help-only',
          'productCompilerEvents': 0, 'cgroup': Path('/proc/self/cgroup').read_text()}
(out / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
