#!/usr/bin/env python3
"""Check a complete fleet artifact, not a nested package or a version string."""
import argparse
import json
import os
import pathlib
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifact', type=pathlib.Path)
    parser.add_argument('--require-queue', action='store_true', help='Required before queue-fix activation, not on the packaging-only base')
    args = parser.parse_args()
    root = args.artifact.resolve(strict=True)
    package = json.loads((root / 'package.json').read_text())
    assert package['name'] == '@earendil-works/pi-coding-agent'
    assert package['version'] == '1.4.0'
    assert package['exports']['.']['import'] == './dist/index.js'
    assert package['exports']['./rpc-entry']['import'] == './dist/bundle/rpc-entry.js'
    assert (root / 'install-lock/package-lock.json').is_file()
    cohort = ['pi-agent-core', 'pi-ai', 'pi-codemode', 'pi-mcp', 'pi-tui']
    for name in cohort:
        dependency = '@earendil-works/' + name
        assert package['dependencies'][dependency] == package['version'], dependency
        path = (root / 'node_modules' / dependency / 'package.json').resolve(strict=True)
        assert path.is_relative_to(root), f'{dependency} escapes the standalone artifact'
        actual = json.loads(path.read_text())
        assert actual['name'] == dependency and actual['version'] == package['version'], dependency
    env = {**os.environ, 'PI_OFFLINE': '1', 'HOME': '/nonexistent', 'PI_CODING_AGENT_DIR': '/nonexistent'}
    version = subprocess.check_output(['node', str(root / 'dist/cli.js'), '--version'], env=env, text=True, timeout=30).strip()
    assert version == package['version'], version
    # Static ESM imports exercise actual transitive dependency resolution from
    # the relocated artifact. No model request, provider credential or prompt.
    assert (root / 'dist/bundle/rpc-entry.js').is_file()
    # rpc-entry is an executable: importing it would start an RPC session.
    entries = [root / 'dist/index.js',
               root / 'node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js']
    program = '\n'.join('import ' + json.dumps(p.as_uri()) + ';' for p in entries)
    subprocess.run(['node', '--input-type=module', '-e', program], env=env, check=True, timeout=30)
    native_program = '''
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[1];
const folder = path.join(root, 'node_modules/@earendil-works/pi-tui/native', process.platform,
  'prebuilds', process.platform + '-' + process.arch);
if (fs.existsSync(folder)) {
  for (const file of fs.readdirSync(folder)) if (file.endsWith('.node')) require(path.join(folder, file));
}
const {createRequire} = require('node:module');
createRequire(path.join(root, 'package.json'))('@silvia-odwyer/photon-node');
'''
    subprocess.run(['node', '-e', native_program, str(root)], env=env, check=True, timeout=30)
    if args.require_queue:
        consumer = root / 'dist/extensions/gateway-queue/index.js'
        assert consumer.is_file(), 'combined published source lacks compiled gateway consumer'
        text = consumer.read_text()
        for marker in ['throttler_queue', 'throttler-gateway', 'gateway-queue']:
            assert marker in text, marker
        assert 'gateway-queue' in (root / 'dist/extensions/index.js').read_text(), 'consumer is not built-in'
    print(json.dumps({'artifact': str(root), 'version': version, 'cohort': cohort,
                      'queue_required': args.require_queue, 'result': 'PASS'}))


if __name__ == '__main__':
    main()
