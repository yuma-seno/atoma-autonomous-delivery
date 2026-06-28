#!/usr/bin/env python3
import json, os, subprocess, sys

tests = []
passed = 0
failed = 0

def t(name):
    def dec(fn):
        tests.append((name, fn))
        return fn
    return dec

@t("match_trigger.py syntax")
def test1():
    r = subprocess.run(["python3", "-c", "import py_compile; py_compile.compile('.github/atoma/tools/scripts/match_trigger.py')"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr

@t("launch_sub_agent.sh executable")
def test2():
    p = ".github/atoma/tools/scripts/launch_sub_agent.sh"
    assert os.access(p, os.X_OK), f"{p} not executable"

@t("match_trigger: PR opened -> reviewer")
def test3():
    r = subprocess.run(["python3", ".github/atoma/tools/scripts/match_trigger.py"], capture_output=True, text=True, env={**os.environ, "EVENT_TYPE": "pull_request.opened"})
    assert r.stdout.strip() == "reviewer", f"Got: {r.stdout.strip()}"

@t("match_trigger: changes_requested -> engineer")
def test4():
    r = subprocess.run(["python3", ".github/atoma/tools/scripts/match_trigger.py"], capture_output=True, text=True, env={**os.environ, "EVENT_TYPE": "pull_request_review.submitted", "REVIEW_STATE": "changes_requested"})
    assert r.stdout.strip() == "engineer", f"Got: {r.stdout.strip()}"

@t("match_trigger: approved -> no match")
def test5():
    r = subprocess.run(["python3", ".github/atoma/tools/scripts/match_trigger.py"], capture_output=True, text=True, env={**os.environ, "EVENT_TYPE": "pull_request_review.submitted", "REVIEW_STATE": "approved"})
    assert r.stdout.strip() == "", f"Got: {r.stdout.strip()}"

@t("config.json valid")
def test6():
    with open(".github/atoma/config.json") as f:
        c = json.load(f)
    assert c["version"] == 2
    assert c["agents"]["orchestrator"]["max_iterations"] == 50

@t("atoma_github MCP initialize")
def test7():
    p = subprocess.Popen(["python3", ".github/atoma/tools/scripts/atoma_github_mcp_server.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = p.communicate(input=json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}})+"\n", timeout=5)
    r = json.loads(out.strip())
    assert r["result"]["serverInfo"]["name"] == "atoma-github-mcp"

@t("atoma_github MCP tools/list")
def test8():
    p = subprocess.Popen(["python3", ".github/atoma/tools/scripts/atoma_github_mcp_server.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = p.communicate(input=json.dumps({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})+"\n", timeout=5)
    r = json.loads(out.strip())
    names = [t["name"] for t in r["result"]["tools"]]
    for tool in ["create_issue", "create_pr", "get_issue", "search_code", "get_pr_diff"]:
        assert tool in names, f"Missing: {tool}"

@t("atoma MCP initialize")
def test9():
    p = subprocess.Popen(["python3", ".github/atoma/tools/scripts/atoma_mcp_server.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = p.communicate(input=json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}})+"\n", timeout=5)
    r = json.loads(out.strip())
    assert r["result"]["serverInfo"]["name"] == "atoma-mcp-server"

@t("atoma MCP launch_sub_agent schema")
def test10():
    p = subprocess.Popen(["python3", ".github/atoma/tools/scripts/atoma_mcp_server.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = p.communicate(input=json.dumps({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})+"\n", timeout=5)
    r = json.loads(out.strip())
    t = r["result"]["tools"][0]
    assert t["name"] == "launch_sub_agent"
    assert t["inputSchema"]["required"] == ["tasks"]
    item = t["inputSchema"]["properties"]["tasks"]["items"]
    assert "issue" in item["properties"] and "agent" in item["properties"]

@t("launch_sub_agent validates empty tasks")
def test11():
    p = subprocess.Popen(["python3", ".github/atoma/tools/scripts/atoma_mcp_server.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = p.communicate(input=json.dumps({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"launch_sub_agent","arguments":{"tasks":[]}}})+"\n", timeout=5)
    r = json.loads(out.strip())
    assert r["error"]["code"] == -32602

@t("shell_guard blocks dangerous commands")
def test12():
    r = subprocess.run(["python3", ".github/atoma/tools/scripts/shell_guard.py"], input=json.dumps({"arguments":{"command":"git push origin main"}}), capture_output=True, text=True)
    assert '"allow": false' in r.stdout

@t("shell_guard allows safe commands")
def test13():
    r = subprocess.run(["python3", ".github/atoma/tools/scripts/shell_guard.py"], input=json.dumps({"arguments":{"command":"ls -la"}}), capture_output=True, text=True)
    assert '"allow": true' in r.stdout

@t("inject_sub_results.py syntax")
def test14():
    r = subprocess.run(["python3", "-c", "import py_compile; py_compile.compile('.github/atoma/tools/scripts/inject_sub_results.py')"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr

for name, fn in tests:
    try:
        fn()
        passed += 1
        print(f"OK {name}")
    except Exception as e:
        failed += 1
        print(f"FAIL {name}: {e}")

print(f"\nResults: {passed}/{passed+failed} passed, {failed} failed")
sys.exit(1 if failed else 0)
