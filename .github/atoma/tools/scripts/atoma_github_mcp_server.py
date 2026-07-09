#!/usr/bin/env python3
"""
atoma_github_mcp_server.py — Unified GitHub MCP server for Atoma.

Protocol: JSON-RPC 2.0 over stdio.
Dependencies: Python stdlib + `gh` CLI.

Every mutation is logged to $ATOMA_OPS_LOG for dispatch-next to consume.
"""

from __future__ import annotations

import json, os, subprocess, sys
from datetime import datetime, timezone
from typing import Any

from atoma_config import get_label, get_merge_policy

def rungit(*args):
    """Run git command, returns (rc, stdout, stderr)."""
    r = subprocess.run(["git", *args], capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()

REPO = os.environ.get("GITHUB_REPOSITORY", "")
# Fallback: derive REPO from git remote if env var is not set
if not REPO:
    try:
        rc, out, _ = rungit("remote", "get-url", "origin")
        if rc == 0 and out:
            # Handle both https://github.com/owner/repo and git@github.com:owner/repo
            url = out.strip()
            for prefix in ["https://github.com/", "git@github.com:"]:
                if url.startswith(prefix):
                    suffix = url[len(prefix):]
                    REPO = suffix.removesuffix(".git")
                    break
    except Exception:
        pass
OPS_LOG = os.environ.get("ATOMA_OPS_LOG", "/tmp/atoma_ops.log")

def log(msg): print(f"[atoma-github] {msg}", file=sys.stderr, flush=True)

def ops_log(op, payload):
    entry = {"ts": datetime.now(timezone.utc).isoformat(), "op": op, **payload}
    try:
        with open(OPS_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError as e:
        log(f"WARN: ops_log failed: {e}")

def send_response(rid, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}) + "\n")
    sys.stdout.flush()

def send_error(rid, code, msg):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": msg}}) + "\n")
    sys.stdout.flush()

def gh(*args):
    """Run gh CLI. Inherits GH_TOKEN from parent environment."""
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()

def gh_json(*args):
    rc, out, err = gh(*args)
    if rc: raise RuntimeError(f"gh {' '.join(args)}: {err or out}")
    return json.loads(out) if out else None

def gh_graphql(query, **variables):
    """Run a GraphQL query via gh api graphql."""
    args = ["api", "graphql", "-f", f"query={query}"]
    for k, v in variables.items():
        args += ["-F", f"{k}={v}"]
    rc, out, err = gh(*args)
    if rc:
        raise RuntimeError(f"GraphQL query failed: {err or out[:200]}")
    result = json.loads(out)
    if "errors" in result:
        raise RuntimeError(f"GraphQL errors: {result['errors']}")
    return result["data"]

def resolve_issue_id(number: int) -> str:
    """Resolve an issue number to its global GraphQL node ID."""
    owner, repo = REPO.split("/", 1)
    d = gh_graphql(
        "query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){id}}}",
        owner=owner, repo=repo, num=number,
    )
    return d["repository"]["issue"]["id"]

TOOLS = [
    {"name":"create_issue","description":"Create a new GitHub issue. Set sub_issue=true to automatically link it to the current issue as a child task.","inputSchema":{"type":"object","properties":{"title":{"type":"string"},"body":{"type":"string"},"labels":{"type":"array","items":{"type":"string"}},"sub_issue":{"type":"boolean","description":"Set sub_issue=true to automatically link it to the current issue as a child task. Defaults to true."}},"required":["title"]}},
    {"name":"get_issue","description":"Get an issue by number.","inputSchema":{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}},
    {"name":"list_issues","description":"List issues.","inputSchema":{"type":"object","properties":{"state":{"type":"string","enum":["open","closed","all"]},"labels":{"type":"array","items":{"type":"string"}},"limit":{"type":"integer"}}}},
    {"name":"get_issue_comments","description":"Get issue comments.","inputSchema":{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}},
    {"name":"close_issue","description":"Close an issue. Refuses to close issues opened by humans.","inputSchema":{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}},
    {"name":"create_pr","description":"Create a pull request from the current branch.","inputSchema":{"type":"object","properties":{"title":{"type":"string"},"body":{"type":"string"},"base":{"type":"string"}},"required":["title"]}},
    {"name":"get_pr","description":"Get a PR by number.","inputSchema":{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}},
    {"name":"get_pr_diff","description":"Get PR diff.","inputSchema":{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}},
    {"name":"list_prs","description":"List PRs.","inputSchema":{"type":"object","properties":{"state":{"type":"string","enum":["open","closed","merged","all"]},"limit":{"type":"integer"}}}},
    {"name":"search_code","description":"Search code.","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}},
    {"name":"get_branch","description":"Get branch info.","inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}},
    {"name":"get_check_runs","description":"Get check runs for a ref.","inputSchema":{"type":"object","properties":{"ref":{"type":"string"}},"required":["ref"]}},
    {"name":"get_pr_reviews","description":"Get PR reviews.","inputSchema":{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}},
    {"name":"list_pr_review_comments","description":"List PR review comments.","inputSchema":{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}},
    {"name":"submit_pr_review","description":"Submit a PR review (comment or request changes). Note: APPROVE is not usable — Atoma agents share a single bot identity, and GitHub refuses to let an account approve its own pull request.","inputSchema":{"type":"object","properties":{"number":{"type":"integer"},"event":{"type":"string","enum":["COMMENT","REQUEST_CHANGES"]},"body":{"type":"string"}},"required":["number","event"]}},
    {"name":"commit_and_push","description":"Stage all changes, commit with a message, and push to the current branch.","inputSchema":{"type":"object","properties":{"message":{"type":"string","description":"Commit message."}},"required":["message"]}},
    {"name":"merge_pr","description":"Merge a PR if agents.reviewer.merge_policy in config.json is 'auto'. No-op (returns merged:false) when the policy is 'manual' or anything else — call this after posting your LGTM comment and it will decide for you.","inputSchema":{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}},
]

def _create_issue(a):
    t, b, ls, sub = a["title"], a.get("body",""), a.get("labels",[]), a.get("sub_issue", True)
    parent_num = os.environ.get("ISSUE_NUMBER", "").strip()
    cmd = ["issue","create","--repo",REPO,"--title",t]
    if sub:
        # Inject HTML comment for workflow backward compatibility
        if parent_num:
            b = f"<!-- atoma:parent=#{parent_num} -->\n{b}"
        # Add the sub-issue tracking label (from config.json, falls back to a default)
        sub_issue_label = get_label("sub_issue", "atoma/sub-issue")
        if sub_issue_label not in ls:
            ls = list(ls) + [sub_issue_label]
    if b: cmd += ["--body",b]
    for l in ls: cmd += ["--label",l]
    rc, out, err = gh(*cmd)
    if rc: raise RuntimeError(err or out)
    num = int(out.strip().split("/")[-1])
    # Link via official GitHub sub-issues API (GraphQL addSubIssue)
    if sub and parent_num:
        try:
            pid = resolve_issue_id(int(parent_num))
            sid = resolve_issue_id(num)
            gh_graphql(
                "mutation($parent:ID!,$sub:ID!){addSubIssue(input:{issueId:$parent,subIssueId:$sub,replaceParent:true}){issue{number}}}",
                parent=pid, sub=sid,
            )
            log(f"Linked sub-issue #{num} to parent #{parent_num} via official sub-issues API")
        except RuntimeError as e:
            log(f"WARN: Failed to link sub-issue #{num} to parent #{parent_num}: {e}")
    ops_log("create_issue",{"number":num,"title":t,"sub_issue":sub})
    return json.dumps({"number":num,"url":out.strip()})
def _get_issue(a): return json.dumps(gh_json("issue","view",str(a["number"]),"--repo",REPO,"--json","number,title,body,state,labels,createdAt,closedAt,comments"))
def _list_issues(a):
    s, lim, ls = a.get("state","open"), a.get("limit",30), a.get("labels",[])
    cmd = ["issue","list","--repo",REPO,"--state",s,"--limit",str(lim),"--json","number,title,state,labels"]
    for l in ls: cmd += ["--label",l]
    return json.dumps(gh_json(*cmd) or [])
def _get_issue_comments(a):
    d = gh_json("issue","view",str(a["number"]),"--repo",REPO,"--json","comments")
    return json.dumps(d.get("comments",[]) if d else [])

def _close_issue(a):
    num = a["number"]
    log(f"_close_issue: #{num}")
    # Refuse to close issues opened by humans
    d = gh_json("issue", "view", str(num), "--repo", REPO, "--json", "author")
    author_type = d.get("author", {}).get("type") or ""
    log(f"_close_issue: author.type={author_type!r}")
    if author_type.upper() == "USER":
        raise RuntimeError(f"Refusing to close issue #{num}: opened by a human, not a bot")
    rc, out, err = gh("issue", "close", str(num), "--repo", REPO)
    if rc: raise RuntimeError(err or out)
    ops_log("close_issue", {"number": num})
    return json.dumps({"ok":True})
def _resolve_branch():
    """Resolve current branch, preferring BRANCH env var (set by atoma-runner.yml)."""
    br = os.environ.get("BRANCH", "").strip()
    if br and br != "HEAD":
        return br
    rc, out, _ = rungit("rev-parse", "--abbrev-ref", "HEAD")
    if rc == 0 and out.strip() and out.strip() != "HEAD":
        return out.strip()
    rc, out, _ = rungit("branch", "--format=%(refname:short)", "--points-at=HEAD")
    if rc == 0 and out.strip():
        return out.strip().split('\n')[0]
    raise RuntimeError("Cannot determine branch name; set BRANCH env")

def _inject_parent_issue(body: str) -> str:
    """Inject <!-- atoma:parent-issue=N --> and Closes #N markers into PR body."""
    parent = os.environ.get("ISSUE_NUMBER", "").strip()
    if not parent:
        return body
    if "<!-- atoma:parent-issue=" in body:
        raise RuntimeError(
            f"PR body already contains a parent-issue tag; refusing to add another"
        )
    # Inject both parent-issue metadata and Closes #N for auto-close on merge
    return f"<!-- atoma:parent-issue={parent} -->\nCloses #{parent}\n{body}"


def _dispatch_reviewer(pr_number: int):
    """Directly dispatch the reviewer agent on a newly created PR.

    GitHub suppresses further workflow-triggering events (e.g. pull_request_target)
    for actions performed with the default GITHUB_TOKEN, so a bot-created PR does NOT
    reliably cause atoma-auto-trigger.yml to fire. workflow_dispatch is exempt from
    that restriction, so dispatch directly here, the same way launch_sub_agent.sh does
    for orchestrator -> sub-agent handoffs. Best-effort: a dispatch failure does not
    fail PR creation itself.
    """
    dispatch_workflow = os.environ.get("ATOMA_DISPATCH_WORKFLOW", "atoma-runner.yml")
    rc, out, err = gh(
        "workflow", "run", dispatch_workflow,
        "--field", "agent=reviewer",
        "--field", f"number={pr_number}",
        "--field", "type=pr",
        "--field", "notify=",
    )
    if rc:
        log(f"_dispatch_reviewer: WARN failed to dispatch reviewer for PR #{pr_number}: {err or out}")
    else:
        log(f"_dispatch_reviewer: dispatched reviewer for PR #{pr_number}")


def _create_pr(a):
    t, b, base = a["title"], a.get("body",""), a.get("base")
    b = _inject_parent_issue(b)
    log(f"_create_pr: title={t!r}, base={base!r}, REPO={REPO!r}")
    try:
        branch = _resolve_branch()
        log(f"_create_pr: resolved branch={branch!r}")
    except RuntimeError as e:
        log(f"_create_pr: branch resolution failed: {e}")
        raise RuntimeError(f"Cannot resolve branch: {e}")
    rc, out, err = rungit("push", "-u", "origin", branch)
    log(f"_create_pr: git push rc={rc}, err={err!r}")
    if rc:
        raise RuntimeError(f"git push failed (rc={rc}): {err or out}")
    cmd = ["pr","create","--repo",REPO,"--title",t, "--head", branch]
    if b: cmd += ["--body",b]
    if base: cmd += ["--base",base]
    log(f"_create_pr: running gh {' '.join(cmd)}")
    rc, out, err = gh(*cmd)
    log(f"_create_pr: gh pr create rc={rc}, out={out!r}, err={err!r}")
    if rc:
        raise RuntimeError(f"gh pr create failed (rc={rc}): {err or out}")
    try:
        num = int(out.strip().split("/")[-1])
    except (ValueError, IndexError):
        raise RuntimeError(f"gh pr create: unexpected output: {out[:300]}")
    ops_log("create_pr",{"number":num,"title":t})
    _dispatch_reviewer(num)
    return json.dumps({"number":num,"url":out.strip()})

def _commit_and_push(a):
    msg = a["message"]
    rc, out, err = rungit("add", "-A")
    if rc: raise RuntimeError(err or out)
    rc, out, err = rungit("commit", "-m", msg)
    if rc: raise RuntimeError(err or out)
    branch = _resolve_branch()
    rc, out, err = rungit("push", "-u", "origin", branch)
    if rc: raise RuntimeError(err or out)
    ops_log("commit_and_push", {})
    return json.dumps({"ok": True})
def _get_pr(a): return json.dumps(gh_json("pr","view",str(a["number"]),"--repo",REPO,"--json","number,title,body,state,baseRefName,headRefName,createdAt"))
def _get_pr_diff(a):
    rc, out, err = gh("pr","diff",str(a["number"]),"--repo",REPO)
    if rc: raise RuntimeError(err or out)
    return out[:50000]
def _list_prs(a):
    s, lim = a.get("state","open"), a.get("limit",30)
    return json.dumps(gh_json("pr","list","--repo",REPO,"--state",s,"--limit",str(lim),"--json","number,title,state,headRefName,baseRefName") or [])
def _search_code(a):
    rc, out, err = gh("search","code",a["query"],"--repo",REPO,"--limit","30")
    if rc: raise RuntimeError(err or out)
    return out[:50000]
def _get_branch(a): return json.dumps(gh_json("api",f"repos/{REPO}/branches/{a['name']}"))
def _get_check_runs(a):
    d = gh_json("api",f"repos/{REPO}/commits/{a['ref']}/check-runs")
    return json.dumps(d.get("check_runs",[]) if d else [])
def _get_pr_reviews(a):
    d = gh_json("pr","view",str(a["number"]),"--repo",REPO,"--json","reviews")
    return json.dumps(d.get("reviews",[]) if d else [])
def _list_pr_review_comments(a): return json.dumps(gh_json("api",f"repos/{REPO}/pulls/{a['number']}/comments") or [])

def _submit_pr_review(a):
    cmd = ["pr", "review", str(a["number"]), "--repo", REPO, "--" + a["event"].lower()]
    if a.get("body"): cmd += ["--body", a["body"]]
    rc, out, err = gh(*cmd)
    if rc: raise RuntimeError(err or out)
    ops_log("submit_pr_review", {"number": a["number"], "event": a["event"]})
    return json.dumps({"ok": True})

def _merge_pr(a):
    num = a["number"]
    policy = get_merge_policy()
    if policy != "auto":
        log(f"_merge_pr: merge_policy={policy!r}, not 'auto' — skipping merge for PR #{num}")
        return json.dumps({"merged": False, "reason": f"merge_policy is '{policy}', not 'auto'"})
    rc, out, err = gh("pr", "merge", str(num), "--repo", REPO, "--squash")
    log(f"_merge_pr: gh pr merge rc={rc}, out={out!r}, err={err!r}")
    if rc:
        raise RuntimeError(f"gh pr merge failed (rc={rc}): {err or out}")
    ops_log("merge_pr", {"number": num})
    return json.dumps({"merged": True})

TOOL_HANDLERS = {
    "create_issue":_create_issue,"get_issue":_get_issue,"list_issues":_list_issues,
    "get_issue_comments":_get_issue_comments,
    "close_issue":_close_issue,"create_pr":_create_pr,"get_pr":_get_pr,
    "get_pr_diff":_get_pr_diff,"list_prs":_list_prs,"search_code":_search_code,
    "get_branch":_get_branch,"get_check_runs":_get_check_runs,
    "get_pr_reviews":_get_pr_reviews,"list_pr_review_comments":_list_pr_review_comments,
    "submit_pr_review":_submit_pr_review,"commit_and_push":_commit_and_push,
    "merge_pr":_merge_pr,
}

def hi(params, rid):
    send_response(rid,{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"atoma-github-mcp","version":"1.0.0"}})
def htl(_, rid): send_response(rid,{"tools":TOOLS})
def htc(params, rid):
    name, args = params.get("name",""), params.get("arguments",{})
    fn = TOOL_HANDLERS.get(name)
    if not fn: return send_error(rid,-32601,f"Unknown: {name}")
    try:
        r = fn(args)
        send_response(rid,{"content":[{"type":"text","text":r}],"isError":False})
    except Exception as e:
        log(f"Tool error: {e}")
        send_response(rid,{"content":[{"type":"text","text":f"Error: {e}"}],"isError":True})

METHODS = {"initialize":hi,"tools/list":htl,"tools/call":htc,"notifications/initialized":lambda p,r:None}

def main():
    log(f"Starting for {REPO}")
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try: msg = json.loads(line)
        except: continue
        m, rid, params = msg.get("method",""), msg.get("id"), msg.get("params",{})
        log(f"<- {m}")
        fn = METHODS.get(m)
        if not fn:
            if rid is not None: send_error(rid,-32601,f"Not found: {m}")
            continue
        try: fn(params, rid)
        except Exception as e:
            log(f"Handler crash: {e}")
            if rid is not None: send_error(rid,-32603,str(e))

if __name__ == "__main__":
    main()
