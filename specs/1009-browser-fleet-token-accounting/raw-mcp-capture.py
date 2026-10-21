#!/usr/bin/env python3
"""Capture the FULL raw MCP JSON-RPC payloads from the live browser-fleet server.
Read-only tools only (browser_identities, browser_status). Everything the server returns
is persisted verbatim to raw-payload.jsonl (the 'full raw payload record on disk').
"""
import json, os, select, subprocess, sys, time

BIN = "/nix/store/qifanqhl62pyg1y0ixdaa52vkl2wjwm7-browser-fleet-mcp/bin/browser-fleet-mcp"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw-payload.jsonl")
env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "XDG_RUNTIME_DIR")}

proc = subprocess.Popen([BIN, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, env=env, text=True, bufsize=1)
raw_lines = []
def send(msg):
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
def read_until(pred, timeout=25):
    deadline = time.time() + timeout
    out = []
    while time.time() < deadline:
        r, _, _ = select.select([proc.stdout], [], [], max(0.05, deadline - time.time()))
        if not r:
            continue
        line = proc.stdout.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        raw_lines.append(line)
        try:
            msg = json.loads(line)
        except Exception:
            continue
        out.append(msg)
        if pred(msg):
            return msg, out
    raise TimeoutError("no matching message; got %d lines" % len(raw_lines))

send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
      "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                 "clientInfo": {"name": "ms-qa-measure", "version": "1.0"}}})
init, _ = read_until(lambda m: m.get("id") == 1)
send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
tools, _ = read_until(lambda m: m.get("id") == 2)
send({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
      "params": {"name": "browser_identities", "arguments": {}}})
idents, _ = read_until(lambda m: m.get("id") == 3)

with open(OUT, "w") as fh:
    for line in raw_lines:
        fh.write(line + "\n")

proc.stdin.close()
try:
    proc.wait(timeout=5)
except Exception:
    proc.kill()

tool_rows = tools.get("result", {}).get("tools", [])
summary = {
  "server": "browser-fleet",
  "initialize_result_bytes": len(json.dumps(init.get("result", {}))),
  "tools_list_count": len(tool_rows),
  "tools": [{"name": t["name"],
             "description_bytes": len(json.dumps(t.get("description", ""))),
             "inputSchema_bytes": len(json.dumps(t.get("inputSchema", {})))} for t in tool_rows],
  "sum_inputSchema_bytes": sum(len(json.dumps(t.get("inputSchema", {}))) for t in tool_rows),
  "sum_description_bytes": sum(len(json.dumps(t.get("description", ""))) for t in tool_rows),
  "browser_identities_result_bytes": len(json.dumps(idents.get("result", {}))),
  "browser_identities_keys": sorted(idents.get("result", {}).keys()),
  "raw_payload_file": OUT,
  "raw_payload_bytes": os.path.getsize(OUT),
  "raw_line_count": len(raw_lines),
}
print(json.dumps(summary, indent=2))
