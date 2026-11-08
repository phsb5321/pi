#!/usr/bin/env python3
"""Offline regressions for the retained fleet verifier and isolated install roots."""
import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest

INSTALLER = pathlib.Path(__file__).with_name('fleet-install.sh')


class FleetInstall(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        self.tool = self.base / 'tool'
        self.tool.mkdir()
        shutil.copy2(INSTALLER, self.tool / INSTALLER.name)
        self.source = self.base / 'source'
        (self.source / 'dist').mkdir(parents=True)
        (self.source / 'install-lock').mkdir()
        (self.source / 'package.json').write_text('{"version":"1.4.0"}\n')
        (self.source / 'dist/cli.js').write_text('console.log("fixture one");\n')
        (self.source / 'dist/other.js').write_text('export const fixture = 1;\n')
        (self.source / 'install-lock/package-lock.json').write_text('{"lockfileVersion":3}\n')
        self.root = self.base / 'isolated-root'
        self.pin = self.compute()
        self.set_pin(self.pin)

    def run_tool(self, action, source=None, extra=(), expected=0):
        result = subprocess.run(['bash', str(self.tool / INSTALLER.name), action,
                                 '--source', str(source or self.source), *extra],
                                text=True, capture_output=True, timeout=15)
        if expected == 0:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def compute(self):
        return json.loads(self.run_tool('compute').stdout)

    def set_pin(self, pin):
        (self.tool / 'fleet-pin.json').write_text(json.dumps(pin, indent=2) + '\n')

    def test_pin_schema_and_verified_install(self):
        self.assertEqual(self.pin['schema'], 1)
        self.assertEqual(self.pin['package'], '@earendil-works/pi-coding-agent')
        for key in ['bundle_manifest_sha512', 'package_json_sha512',
                    'install_lock_sha512', 'dist_cli_sha512']:
            self.assertRegex(self.pin[key], r'^[0-9a-f]{128}$')
        self.assertEqual(self.pin['bundle_manifest_short'], self.pin['bundle_manifest_sha512'][:8])
        self.run_tool('verify')
        self.run_tool('install', extra=['--root', str(self.root)])
        installed = (self.root / 'current').resolve()
        self.assertEqual(json.loads((installed / '.fleet-pin.json').read_text()), self.pin)
        self.assertEqual((installed / 'dist/cli.js').read_bytes(), (self.source / 'dist/cli.js').read_bytes())
        self.assertEqual(installed.stat().st_mode & 0o222, 0)

    def test_wrong_pin_rejected_before_install(self):
        self.set_pin({**self.pin, 'bundle_manifest_sha512': '0' * 128})
        self.run_tool('install', extra=['--root', str(self.root)], expected=1)
        self.assertFalse(self.root.exists())

    def test_version_lock_cli_and_manifest_rejection(self):
        mutations = {'package.json': '{"version":"0.84.3"}\n',
                     'install-lock/package-lock.json': '{"changed":true}\n',
                     'dist/cli.js': 'console.log("changed");\n',
                     'dist/other.js': 'export const changed = 2;\n'}
        for name, changed in mutations.items():
            with self.subTest(name=name):
                path = self.source / name
                original = path.read_bytes()
                path.write_text(changed)
                try:
                    self.run_tool('install', extra=['--root', str(self.root)], expected=1)
                    self.assertFalse(self.root.exists())
                finally:
                    path.write_bytes(original)

    def test_old_root_is_retained_and_rollback_is_verified(self):
        self.run_tool('install', extra=['--root', str(self.root)])
        old = (self.root / 'current').resolve()
        old_bytes = (old / 'dist/cli.js').read_bytes()
        old_source = self.base / 'old-source'
        shutil.copytree(self.source, old_source)
        (self.source / 'dist/cli.js').write_text('console.log("fixture two");\n')
        self.set_pin(self.compute())
        self.run_tool('install', extra=['--root', str(self.root)])
        self.assertNotEqual((self.root / 'current').resolve(), old)
        self.assertEqual((old / 'dist/cli.js').read_bytes(), old_bytes)
        self.set_pin(self.pin)
        self.run_tool('install', source=old_source, extra=['--root', str(self.root)])
        self.assertEqual((self.root / 'current').resolve(), old)


    def test_flags_only_pin_change_reaches_current_pin(self):
        """pram-06: a node_flags/wrapper_rev flip must land in current/.fleet-pin.json."""
        self.run_tool('install', extra=['--root', str(self.root)])
        first = (self.root / 'current').resolve()
        flagged = {**self.pin, 'node_flags': '--optimize-for-size'}
        for name, pin in {'same wrapper_rev': flagged,
                          'wrapper_rev bump': {**flagged, 'wrapper_rev': 2}}.items():
            with self.subTest(name=name):
                self.set_pin(pin)
                self.run_tool('install', extra=['--root', str(self.root)])
                current = (self.root / 'current').resolve()
                self.assertEqual(json.loads((current / '.fleet-pin.json').read_text()), pin)
                self.assertEqual(current.stat().st_mode & 0o222, 0)
                self.assertEqual((current / 'dist/cli.js').read_bytes(), (self.source / 'dist/cli.js').read_bytes())
        # compute must not reset a flipped pin; a repeat install of the same pin writes nothing.
        self.assertEqual(self.compute()['node_flags'], '--optimize-for-size')
        marker = (self.root / 'current/.fleet-pin.json').stat().st_mtime_ns
        self.run_tool('install', extra=['--root', str(self.root)])
        self.assertEqual((self.root / 'current/.fleet-pin.json').stat().st_mtime_ns, marker)
        self.assertTrue((first / 'dist/cli.js').exists())  # rollback target retained


if __name__ == '__main__':
    unittest.main(verbosity=2)
