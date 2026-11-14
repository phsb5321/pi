#!/usr/bin/env python3
"""The complete launcher pin identifies an immutable fleet installation."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class PinIdentity(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fleet-pin-identity-")
        self.addCleanup(self.cleanup)
        self.work = Path(self.temporary.name)
        self.installer = self.work / "fleet-install.sh"
        shutil.copyfile(Path(__file__).with_name("fleet-install.sh"), self.installer)
        self.source = self.work / "bundle"
        (self.source / "dist").mkdir(parents=True)
        (self.source / "install-lock").mkdir()
        (self.source / "package.json").write_text('{"version": "0.0.0"}\n')
        (self.source / "dist/cli.js").write_text("// inert, never executed\n")
        (self.source / "install-lock/package.json").write_text("{}\n")
        self.pin = json.loads(self.run_installer("compute"))
        self.pin_file = self.work / "fleet-pin.json"
        self.root = self.work / "install"
        self.install()
        self.original = (self.root / "current").resolve()
        self.original_pin = (self.original / ".fleet-pin.json").read_bytes()

    def cleanup(self):
        for directory, _, _ in os.walk(self.temporary.name):
            Path(directory).chmod(0o700)
        self.temporary.cleanup()

    def run_installer(self, command):
        return subprocess.check_output(
            ["bash", str(self.installer), command, "--source", str(self.source),
             *(["--root", str(self.root)] if command == "install" else [])],
            text=True,
        )

    def install(self):
        self.pin_file.write_text(json.dumps(self.pin, indent=2) + "\n")
        self.run_installer("install")
        return (self.root / "current").resolve()

    def assert_new_immutable_install(self):
        current = self.install()
        self.assertNotEqual(current, self.original)
        self.assertEqual(json.loads((current / ".fleet-pin.json").read_text()), self.pin)
        self.assertEqual((self.original / ".fleet-pin.json").read_bytes(), self.original_pin)
        self.assertEqual((current / ".fleet-pin.json").stat().st_mode & 0o222, 0)

    def test_flags_only_without_revision_bump(self):
        self.pin["node_flags"] = "--optimize-for-size"
        self.assert_new_immutable_install()

    def test_revision_only(self):
        self.pin["wrapper_rev"] += 1
        self.assert_new_immutable_install()

    def test_flags_and_revision(self):
        self.pin.update(node_flags="--optimize-for-size", wrapper_rev=2)
        self.assert_new_immutable_install()

    def test_compute_keeps_launcher_policy(self):
        self.pin.update(node_flags="--optimize-for-size", wrapper_rev=2)
        self.pin_file.write_text(json.dumps(self.pin, indent=2) + "\n")
        self.assertEqual(json.loads(self.run_installer("compute")), self.pin)

    def test_identical_pin_is_not_rewritten(self):
        before = (self.original / ".fleet-pin.json").stat()
        self.assertEqual(self.install(), self.original)
        after = (self.original / ".fleet-pin.json").stat()
        self.assertEqual((before.st_ino, before.st_mtime_ns), (after.st_ino, after.st_mtime_ns))


if __name__ == "__main__":
    unittest.main()
