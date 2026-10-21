#!/usr/bin/env python3
"""A/B driver: measure per-turn declared-tool tokens with/without the browser-fleet MCP
server, and with counterfactual direct exposure. pi --mode rpc lets us wait for the
background MCP connect before the first prompt. Usage = input + cacheRead + cacheWrite
(the provider's per-request input-side token count).
"""
import json, os, subprocess, sys, time, select

arm, cwd = sys.argv[1], sys.argv[2]
extra = sys.argv[3:]
connect_sleep = int(os.environ.get("AB_CONNECT_SLEEP", "0"))
out_dir = os.path.dirname(os.path.abspath(__file__))
cmd = [os.environ.get("PI_BIN", "pi"), "--mode", "rpc", "--no-session", "--no-context-files", "--no-extensions",
       "--no-skills", "--no-prompt-templates", "--model", "deepseek/deepseek-v4-pro", *extra]
proc = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, text=True, bufsize=1)
events = []
def read_until(pred, timeout=240):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r, _, _ = select.select([proc.stdout], [], [], 0.2)
        if not r:
            continue
        line = proc.stdout.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        events.append(rec)
        if pred(rec):
            return rec
    raise TimeoutError("timeout waiting; %d events" % len(events))

def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()

time.sleep(connect_sleep)
send({"id": "p1", "type": "prompt", "message": "Reply with exactly OK"})
read_until(lambda r: r.get("type") == "agent_settled", timeout=240)
try:
    proc.stdin.close()
except Exception:
    pass
try:
    proc.wait(timeout=10)
except Exception:
    proc.kill()
err = proc.stderr.read() if proc.stderr else ""

with open(os.path.join(out_dir, "arm-%s-rpc.jsonl" % arm), "w") as fh:
    for rec in events:
        fh.write(json.dumps(rec) + "\n")
with open(os.path.join(out_dir, "arm-%s-stderr.txt" % arm), "w") as fh:
    fh.write(err)

summary = {"arm": arm, "connectSleep": connect_sleep, "eventCount": len(events),
           "systemToolsAddedNames": [], "systemSectionKeys": [], "mcpServersSection": None,
           "usage": None, "stderrTail": err[-300:]}
for rec in events:
    m = rec.get("message", {}) or {}
    if rec.get("type") == "message_start" and m.get("role") == "system":
        summary["systemToolsAddedNames"] = [t.get("name") for t in (m.get("toolsAdded") or [])]
        summary["systemSectionKeys"] = sorted((m.get("sections") or {}).keys())
        summary["mcpServersSection"] = (m.get("sections") or {}).get("mcp_servers")
    if rec.get("type") == "message_end" and m.get("role") == "assistant":
        u = m.get("usage") or {}
        summary["usage"] = {"input": u.get("input"), "cacheRead": u.get("cacheRead"),
                            "cacheWrite": u.get("cacheWrite"),
                            "inputSideTotal": (u.get("input") or 0) + (u.get("cacheRead") or 0) + (u.get("cacheWrite") or 0)}
print(json.dumps(summary, indent=2))
