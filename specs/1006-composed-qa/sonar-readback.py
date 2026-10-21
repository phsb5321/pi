"""Bounded read-back only: no scanner launch, project/token creation or CE polling."""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import urllib.error
import urllib.parse
import urllib.request

HOST = "https://sonarqube.home301server.com.br"
METRICS = {
    "sqale_rating": ("max", 1),
    "reliability_rating": ("max", 1),
    "security_rating": ("max", 1),
    "new_maintainability_rating": ("max", 1),
    "new_reliability_rating": ("max", 1),
    "new_security_rating": ("max", 1),
    "new_coverage": ("min", 80),
    "new_violations": ("max", 0),
    "new_security_hotspots_reviewed": ("min", 100),
    "new_duplicated_lines_density": ("max", 3),
}


def get_json(path, params, authorization):
    url = HOST + path + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"Authorization": authorization})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        raise ValueError("Refuse overwrite of existing analysis evidence")
    subprocess.run(["rbw", "unlocked"], check=True, stdout=subprocess.DEVNULL)
    # Secret stays in this process; never argv, exported env, file or output.
    password = subprocess.check_output(["rbw", "get", "sonarqube.home301server.com.br"]).decode().strip()
    authorization = "Basic " + base64.b64encode(("admin:" + password).encode()).decode()
    evidence = {"project": args.project, "expectedRevision": args.revision, "taskId": args.task_id,
                "result": "BLOCKED", "reads": {}}
    try:
        task = get_json("/api/ce/task", {"id": args.task_id}, authorization)["task"]
        evidence["reads"]["task"] = task
        if task.get("componentKey") != args.project or task.get("status") != "SUCCESS" or not task.get("analysisId"):
            raise ValueError("Task not successful/exact; no polling or historical substitution")
        analysis_id = task["analysisId"]
        latest = get_json("/api/project_analyses/search", {"project": args.project, "ps": 1}, authorization)
        evidence["reads"]["latestBefore"] = latest
        analysis = latest.get("analyses", [{}])[0]
        if analysis.get("key") != analysis_id or analysis.get("revision") != args.revision:
            raise ValueError("Latest analysis does not bind exact task/revision")
        gate = get_json("/api/qualitygates/project_status", {"analysisId": analysis_id}, authorization)
        evidence["reads"]["gate"] = gate
        measures = get_json("/api/measures/component", {"component": args.project, "metricKeys": ",".join(METRICS)}, authorization)
        evidence["reads"]["measures"] = measures
        hotspots = get_json("/api/hotspots/search", {"projectKey": args.project, "status": "TO_REVIEW", "ps": 1}, authorization)
        evidence["reads"]["hotspots"] = hotspots
        latest_after = get_json("/api/project_analyses/search", {"project": args.project, "ps": 1}, authorization)
        evidence["reads"]["latestAfter"] = latest_after
        if latest_after.get("analyses", [{}])[0].get("key") != analysis_id:
            raise ValueError("Concurrent analysis changed project while metrics were read")
        values = {}
        for measure in measures["component"]["measures"]:
            raw = measure.get("value", measure.get("period", {}).get("value"))
            if raw is not None:
                values[measure["metric"]] = float(raw)
        failures = []
        for metric, (direction, limit) in METRICS.items():
            actual = values.get(metric)
            if actual is None or not 0 <= actual < float("inf"):
                failures.append(metric + ": missing/invalid")
            elif (direction == "max" and actual > limit) or (direction == "min" and actual < limit):
                failures.append(f"{metric}: {actual}")
        if gate["projectStatus"].get("status") != "OK":
            failures.append("live quality gate not OK")
        if hotspots.get("paging", {}).get("total") != 0:
            failures.append("unreviewed hotspot list nonempty/unavailable")
        evidence["thresholdFailures"] = failures
        evidence["result"] = "FAIL" if failures else "SONAR_ACED_METRICS_PASS_NOT_FULL_ACED"
    except (ValueError, KeyError, urllib.error.URLError) as error:
        evidence["blocker"] = str(error)
    finally:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(evidence["result"])
    return 0 if evidence["result"] == "SONAR_ACED_METRICS_PASS_NOT_FULL_ACED" else 3


if __name__ == "__main__":
    raise SystemExit(main())
