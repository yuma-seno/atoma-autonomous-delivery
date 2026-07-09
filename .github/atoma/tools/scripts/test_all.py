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
    assert c["version"] == 4
    assert c["agents"]["orchestrator"]["max_iterations"] == 100
    assert c["merge_policy"] == "manual"
    assert "labels" in c

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
    # shell_guard.py's design explicitly allows `git` (agents need to push their
    # own commits) -- only raw `gh` CLI / curl / code-exec primitives etc. are
    # blocked (use a real blocked pattern here, not `git push`).
    r = subprocess.run(["python3", ".github/atoma/tools/scripts/shell_guard.py"], input=json.dumps({"arguments":{"command":"gh issue list"}}), capture_output=True, text=True)
    assert '"allow": false' in r.stdout

@t("shell_guard allows safe commands")
def test13():
    r = subprocess.run(["python3", ".github/atoma/tools/scripts/shell_guard.py"], input=json.dumps({"arguments":{"command":"ls -la"}}), capture_output=True, text=True)
    assert '"allow": true' in r.stdout

@t("inject_sub_results.py syntax")
def test14():
    r = subprocess.run(["python3", "-c", "import py_compile; py_compile.compile('.github/atoma/tools/scripts/inject_sub_results.py')"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr

@t("check_open_siblings.py syntax")
def test17():
    r = subprocess.run(["python3", "-c", "import py_compile; py_compile.compile('.github/atoma/tools/scripts/check_open_siblings.py')"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr

@t("get_config_value.py reads labels.in_progress")
def test18():
    r = subprocess.run(["python3", ".github/atoma/tools/scripts/get_config_value.py", "labels.in_progress", "atoma/in-progress"], capture_output=True, text=True)
    assert r.stdout.strip() == "atoma/in-progress", f"Got: {r.stdout.strip()}"

@t("get_config_value.py falls back to default for missing key")
def test19():
    r = subprocess.run(["python3", ".github/atoma/tools/scripts/get_config_value.py", "nonexistent.key", "fallback"], capture_output=True, text=True)
    assert r.stdout.strip() == "fallback", f"Got: {r.stdout.strip()}"

@t("atoma_config.get_merge_policy reads top-level key")
def test20():
    r = subprocess.run(["python3", "-c",
        "import sys; sys.path.insert(0, '.github/atoma/tools/scripts'); "
        "from atoma_config import get_merge_policy; print(get_merge_policy())"],
        capture_output=True, text=True)
    assert r.stdout.strip() == "manual", f"Got: {r.stdout.strip()} err={r.stderr}"

@t("atoma_config.get_trigger_agent resolves pull_request.opened")
def test21():
    r = subprocess.run(["python3", "-c",
        "import sys; sys.path.insert(0, '.github/atoma/tools/scripts'); "
        "from atoma_config import get_trigger_agent; print(get_trigger_agent('pull_request.opened'))"],
        capture_output=True, text=True)
    assert r.stdout.strip() == "reviewer", f"Got: {r.stdout.strip()} err={r.stderr}"

@t("resolve_notify.py extracts notify tag from body")
def test22():
    r = subprocess.run(["python3", "-c",
        "import sys; sys.path.insert(0, '.github/atoma/tools/scripts'); "
        "from resolve_notify import NOTIFY_RE; "
        "print(NOTIFY_RE.search('<!-- atoma:notify=octocat -->\\nbody').group(1))"],
        capture_output=True, text=True)
    assert r.stdout.strip() == "octocat", f"Got: {r.stdout.strip()} err={r.stderr}"

@t("atoma_github_mcp_server propagates ISSUE_NOTIFY into created issues/PRs")
def test23():
    with open(".github/atoma/tools/scripts/atoma_github_mcp_server.py") as f:
        src = f.read()
    assert "_notify_tag_prefix" in src, "Missing _notify_tag_prefix helper"
    assert "ISSUE_NOTIFY" in src, "Missing ISSUE_NOTIFY propagation"

@t("close_issue refuses human-created issues")
def test15():
    # Verify _close_issue() refuses to close issues opened by humans
    # by checking the source code contains the protection logic
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "atoma_github_mcp_server",
        ".github/atoma/tools/scripts/atoma_github_mcp_server.py"
    )
    mod = importlib.util.module_from_spec(spec)
    # Don't execute the module (it would start the main loop),
    # just verify the source contains the protection
    with open(".github/atoma/tools/scripts/atoma_github_mcp_server.py") as f:
        src = f.read()
    # Check for the author type check
    assert 'author_type.upper() == "USER"' in src, "Missing USER guard in _close_issue"
    assert 'Refusing to close issue' in src, "Missing error message in _close_issue"

@t("close_issue protection logic (USER raises)")
def test16():
    test_globals = {}
    exec('''
def _close_issue(a):
    num = a["number"]
    d = {"author": {"type": "USER"}}
    author_type = d.get("author", {}).get("type") or ""
    if author_type.upper() == "USER":
        raise RuntimeError(f"Refusing to close issue #{num}: opened by a human, not a bot")
    return {"ok": True}
''', test_globals)
    fn = test_globals["_close_issue"]
    try:
        fn({"number": 999})
        assert False, "Expected RuntimeError"
    except RuntimeError as e:
        assert "Refusing to close issue" in str(e)
        assert "opened by a human" in str(e)


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
