"""Offline read-back oracle controls only; these are NOT Sonar acceptance."""
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

MODULE = runpy.run_path(str(Path(__file__).with_name("sonar-readback.py")), run_name="msqa_oracle")
MAIN = MODULE["main"]
METRICS = MODULE["METRICS"]


class ReadbackControls(unittest.TestCase):
    def check_readback(self, defect):
        reads = []
        measures = [{"metric": name, "value": str(limit)} for name, (_, limit) in METRICS.items()]
        analysis = {"key": "own-analysis", "revision": "own-revision"}
        if defect == "missing-coverage":
            measures = [measure for measure in measures if measure["metric"] != "new_coverage"]
        if defect == "wrong-revision":
            analysis["revision"] = "historical"

        def fake_json(path, params, authorization):
            reads.append(path)
            if path == "/api/ce/task":
                return {"task": {"componentKey": "own-project", "status": "PENDING" if defect == "pending" else "SUCCESS",
                                 "analysisId": "own-analysis"}}
            if path == "/api/project_analyses/search":
                result = dict(analysis)
                if defect == "concurrent" and reads.count(path) == 2:
                    result["key"] = "another-analysis"
                return {"analyses": [result]}
            if path == "/api/qualitygates/project_status":
                return {"projectStatus": {"status": "OK"}}
            if path == "/api/measures/component":
                return {"component": {"measures": measures}}
            if path == "/api/hotspots/search":
                return {"paging": {"total": 1 if defect == "hotspot" else 0}}
            raise AssertionError("Unexpected API request")

        with tempfile.TemporaryDirectory(prefix="msqa-sonar-oracle-") as directory:
            output = Path(directory) / "result.json"
            argv = ["sonar-readback.py", "--project", "own-project", "--task-id", "own-task",
                    "--revision", "own-revision", "--output", str(output)]
            with patch("sys.argv", argv), patch("subprocess.run"), patch("subprocess.check_output", return_value=b"fake-secret"), \
                    patch.dict(MAIN.__globals__, {"get_json": fake_json}):
                code = MAIN()
            evidence = json.loads(output.read_text())
            self.assertNotIn("fake-secret", output.read_text())
            self.assertNotIn("Authorization", output.read_text())
        return code, evidence, reads

    def test_complete_metrics_are_not_full_aced(self):
        code, evidence, _ = self.check_readback(None)
        self.assertEqual(code, 0)
        self.assertEqual(evidence["result"], "SONAR_ACED_METRICS_PASS_NOT_FULL_ACED")

    def test_pending_ce_has_no_poll_or_historical_substitution(self):
        code, evidence, reads = self.check_readback("pending")
        self.assertEqual(code, 3)
        self.assertEqual(evidence["result"], "BLOCKED")
        self.assertEqual(reads, ["/api/ce/task"])

    def test_wrong_revision_or_concurrent_analysis_are_blocked(self):
        for defect in ("wrong-revision", "concurrent"):
            with self.subTest(defect=defect):
                code, evidence, _ = self.check_readback(defect)
                self.assertEqual(code, 3)
                self.assertEqual(evidence["result"], "BLOCKED")

    def test_missing_metric_and_unreviewed_hotspot_fail(self):
        for defect in ("missing-coverage", "hotspot"):
            with self.subTest(defect=defect):
                code, evidence, _ = self.check_readback(defect)
                self.assertEqual(code, 3)
                self.assertEqual(evidence["result"], "FAIL")


if __name__ == "__main__":
    unittest.main()
