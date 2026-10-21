"""Private anonymous settings transport and streaming redaction; no credential fetch.
Caller owns eligibility/project/revision and passes secret privately in memory.
"""
import base64
import os
from pathlib import Path
import selectors
import signal
import subprocess
import time

SCANNER = '/nix/store/zd52304wjfbvr63lfs2w7nqywqv7zvz2-sonar-scanner-cli-8.1.0.6389/bin/sonar-scanner'


class Redactor:
    def __init__(self, secret):
        self.patterns = (secret, base64.b64encode(secret + b':'))
        self.buffer = b''

    def feed(self, chunk, final=False):
        self.buffer += chunk
        emitted = bytearray()
        while self.buffer:
            match = next((p for p in self.patterns if self.buffer.startswith(p)), None)
            if match:
                emitted.extend(b'[REDACTED]')
                self.buffer = self.buffer[len(match):]
            elif any(p.startswith(self.buffer) for p in self.patterns):
                if not final:
                    break
                emitted.extend(b'[REDACTED]')
                self.buffer = b''
            else:
                emitted.append(self.buffer[0])
                self.buffer = self.buffer[1:]
        return bytes(emitted)


def run_scanner(secret, settings, log_path, *, arguments=(), vm_options='', timeout=90):
    if not secret or any(c in secret for c in (b'\n', b'\r', b'\\')):
        raise ValueError('Invalid token bytes')
    if b'sonar.token' in settings or b'sonar.login' in settings:
        raise ValueError('Settings must not supply a second credential')
    fd = os.memfd_create('msqa-scanner-settings', os.MFD_CLOEXEC)
    proc = None
    started = time.monotonic()
    redactor = Redactor(secret)
    report = {'scopeEnforcement': 'Caller must enforce compiled PASS and exact isolated project', 'timedOut': False}
    try:
        os.fchmod(fd, 0o600)
        payload = settings + b'\nsonar.token=' + secret + b'\n'
        if os.write(fd, payload) != len(payload):
            raise OSError('Incomplete anonymous settings write')
        os.lseek(fd, 0, os.SEEK_SET)
        argv = [SCANNER, '-Dproject.settings=/proc/self/fd/' + str(fd), *arguments]
        env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG', 'XDG_RUNTIME_DIR')}
        env['SONAR_SCANNER_OPTS'] = '-Xms16m -Xmx96m -XX:ActiveProcessorCount=1 ' + vm_options.format(fd=fd)
        if any(pattern in value.encode() for value in (*argv, *env.values()) for pattern in redactor.patterns):
            raise ValueError('Credential cannot enter argv/environment')
        with Path(log_path).open('wb') as log:
            proc = subprocess.Popen(argv, env=env, pass_fds=(fd,), stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, start_new_session=True)
            # Bound the owned process group; reader consumes only sanitized bytes.
            with selectors.DefaultSelector() as selector:
                selector.register(proc.stdout, selectors.EVENT_READ)
                eof = False
                while not eof:
                    if not report['timedOut'] and time.monotonic() - started >= timeout:
                        report['timedOut'] = True
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait()
                    for key, _ in selector.select(0.05):
                        chunk = os.read(key.fileobj.fileno(), 4096)
                        if not chunk:
                            eof = True
                            break
                        log.write(redactor.feed(chunk))
                log.write(redactor.feed(b'', final=True))
            report['exit'] = proc.wait(timeout=2)
        report['argv'] = argv
        report['seconds'] = time.monotonic() - started
    finally:
        if proc is not None and proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=2)
        if proc is not None and proc.stdout is not None:
            proc.stdout.close()
        os.close(fd)
        report['fdClosed'] = not Path('/proc/self/fd/' + str(fd)).exists()
        report['childReaped'] = proc is None or proc.poll() is not None
    return report
