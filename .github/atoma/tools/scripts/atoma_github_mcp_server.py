#!/usr/bin/env python3
"""
atoma_github_mcp_server.py — Unified GitHub MCP server for Atoma.

Protocol: JSON-RPC 2.0 over stdio.
Dependencies: Python stdlib + `gh` CLI.

Every mutation is logged to $ATOMA_OPS_LOG for dispatch-next to consume.
"""

from __future__ import annotations

import json, os, re, subprocess, sys
from datetime import datetime, timezone
from typing import Any

from atoma_config import get_label, get_merge_policy, get_trigger_agent

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
    {"name":"merge_pr","description":"Merge a PR if config.json's merge_policy is 'auto'. No-op (returns merged:false) when the policy is 'manual' or anything else — call this after posting your LGTM comment and it will decide for you.","inputSchema":{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}},
]

def _notify_tag_prefix() -> str:
    """<!-- atoma:notify=LOGIN --> prefix propagating ISSUE_NOTIFY (the human to
    notify, set by run/action.yml from the workflow's `notify` input) into any
    issue/PR body this run creates. Empty when ISSUE_NOTIFY is unset (e.g. no
    human is associated with this run, or notify propagation isn't relevant)."""
    login = os.environ.get("ISSUE_NOTIFY", "").strip()
    return f"<!-- atoma:notify={login} -->\n" if login else ""

def _create_issue(a):
    t, b, ls, sub = a["title"], a.get("body",""), a.get("labels",[]), a.get("sub_issue", True)
    parent_num = os.environ.get("ISSUE_NUMBER", "").strip()
    cmd = ["issue","create","--repo",REPO,"--title",t]
    # Propagate the original requester's login forward so downstream dispatches
    # (this issue's own future runs, PRs closing it, etc.) know who to notify
    # without needing to walk back up the issue tree.
    b = _notify_tag_prefix() + b
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
    # Refuse to close issues opened by humans.
    # NOTE: `gh issue view --json author` (the gh CLI's GraphQL-based command)
    # returns {id, is_bot, login, name} -- there is NO `.type` field. (`.type`
    # only exists on the REST `gh api repos/OWNER/REPO/issues/N` endpoint, as
    # `.user.type`.) Confirmed live: using `.author.type` here silently always
    # evaluated to "", so this guard never actually refused anything until
    # this fix -- use the reliable `.author.is_bot` boolean instead.
    d = gh_json("issue", "view", str(num), "--repo", REPO, "--json", "author")
    is_bot = bool((d or {}).get("author", {}).get("is_bot"))
    log(f"_close_issue: author.is_bot={is_bot!r}")
    if not is_bot:
        raise RuntimeError(f"Refusing to close issue #{num}: opened by a human, not a bot")
    rc, out, err = gh("issue", "close", str(num), "--repo", REPO)
    if rc: raise RuntimeError(err or out)
    ops_log("close_issue", {"number": num})
    # Whether this is a sub-issue closed via the normal merge_pr path or via
    # an origin-agent re-invocation confirming its own work (see
    # _dispatch_post_merge_agent), phase-gating/aggregation must be checked
    # here so it fires regardless of which path closed the issue.
    # _dispatch_orchestrator_if_ready no-ops harmlessly if #num has no
    # atoma:parent tag (e.g. closing an unrelated issue).
    try:
        _dispatch_orchestrator_if_ready(num)
    except Exception as e:
        log(f"_close_issue: _dispatch_orchestrator_if_ready failed for #{num}: {e}")
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
    """Inject <!-- atoma:parent-issue=N -->, <!-- atoma:origin-agent=AGENT -->,
    <!-- atoma:notify=LOGIN -->, and Closes #N markers into PR body."""
    parent = os.environ.get("ISSUE_NUMBER", "").strip()
    if "<!-- atoma:notify=" in body:
        raise RuntimeError("PR body already contains a notify tag; refusing to add another")
    body = _notify_tag_prefix() + body
    if not parent:
        return body
    if "<!-- atoma:parent-issue=" in body:
        raise RuntimeError(
            f"PR body already contains a parent-issue tag; refusing to add another"
        )
    # Inject parent-issue metadata always, but only add "Closes #N" if the body
    # doesn't already reference it -- agents sometimes write their own closing
    # keyword, and a duplicate "Closes #N" line makes downstream parsing (which
    # greps for the pattern) match twice, corrupting $GITHUB_OUTPUT.
    closes_line = ""
    if not re.search(rf"\bcloses\s+#{re.escape(parent)}\b", body, re.IGNORECASE):
        closes_line = f"Closes #{parent}\n"
    origin_agent = os.environ.get("AGENT", "").strip()
    origin_line = f"<!-- atoma:origin-agent={origin_agent} -->\n" if origin_agent else ""
    return f"<!-- atoma:parent-issue={parent} -->\n{origin_line}{closes_line}{body}"


def _dispatch_post_pr_agent(pr_number: int):
    """Directly dispatch whichever agent config.json's auto_triggers designates for
    a newly opened PR ("pull_request.opened", normally "reviewer" -- but read from
    config, never hardcoded, so retargeting the review role only requires editing
    config.json).

    GitHub suppresses further workflow-triggering events (e.g. pull_request_target)
    for actions performed with the default GITHUB_TOKEN, so a bot-created PR does NOT
    reliably cause atoma-auto-trigger.yml to fire. workflow_dispatch is exempt from
    that restriction, so dispatch directly here, the same way launch_sub_agent.sh does
    for orchestrator -> sub-agent handoffs. Best-effort: a dispatch failure does not
    fail PR creation itself.
    """
    agent = get_trigger_agent("pull_request.opened", default="reviewer")
    dispatch_workflow = os.environ.get("ATOMA_DISPATCH_WORKFLOW", "atoma-runner.yml")
    rc, out, err = gh(
        "workflow", "run", dispatch_workflow,
        "--field", f"agent={agent}",
        "--field", f"number={pr_number}",
        "--field", "type=pr",
        "--field", f"notify={os.environ.get('ISSUE_NOTIFY', '').strip()}",
    )
    if rc:
        log(f"_dispatch_post_pr_agent: WARN failed to dispatch {agent} for PR #{pr_number}: {err or out}")
    else:
        log(f"_dispatch_post_pr_agent: dispatched {agent} for PR #{pr_number}")


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
    _dispatch_post_pr_agent(num)
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
    event = a["event"]
    if event == "APPROVE":
        # GitHub always rejects self-approval since all Atoma agents share the
        # same bot identity ("Can not approve your own pull request"). Rewrite
        # to COMMENT instead of letting the gh call fail — don't rely on the
        # LLM always following the "never use APPROVE" instruction.
        log(f"_submit_pr_review: rewriting event APPROVE -> COMMENT for PR #{a['number']} (self-approval is never possible)")
        event = "COMMENT"
    cmd = ["pr", "review", str(a["number"]), "--repo", REPO, "--" + event.lower()]
    if a.get("body"): cmd += ["--body", a["body"]]
    rc, out, err = gh(*cmd)
    if rc: raise RuntimeError(err or out)
    ops_log("submit_pr_review", {"number": a["number"], "event": event})
    return json.dumps({"ok": True})

def _dispatch_orchestrator_if_ready(sub_issue_num) -> None:
    """Thin wrapper around the standalone dispatch_orchestrator_if_ready.py
    script. Extracted out so request_close_issue.sh (used by the orchestrator's
    atoma__request_close_issue tool) can trigger the exact same phase-gating
    logic as this module's own _close_issue, without duplicating it."""
    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    subprocess.run(
        ["python3", os.path.join(scripts_dir, "dispatch_orchestrator_if_ready.py"),
         "--repo", REPO, "--issue", str(sub_issue_num)],
    )

def _dispatch_post_merge_agent(sub_issue_num: int, agent: str) -> bool:
    """After a PR merges, re-invoke the agent that originally created it (tagged
    via <!-- atoma:origin-agent=... --> in the PR body, see _inject_parent_issue)
    on the linked sub-issue, instead of silently closing the sub-issue ourselves.

    This lets the sub-issue's own thread get a natural wrap-up from the agent
    that actually did the work (it posts a brief confirmation and calls
    github__close_issue itself), rather than being closed with no comment on
    that thread at all. _close_issue (called by the re-invoked agent) already
    triggers _dispatch_orchestrator_if_ready, so aggregation still works the
    same way as before -- it just happens one hop later, from the agent's own
    close_issue call instead of from here directly.

    Returns True if the dispatch was sent (best-effort; a failure here should
    not fail merge_pr itself -- caller falls back to closing directly).
    """
    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    notify_out = subprocess.run(
        ["python3", os.path.join(scripts_dir, "resolve_notify.py"),
         "--repo", REPO, "--number", str(sub_issue_num)],
        capture_output=True, text=True,
    )
    notify = (notify_out.stdout or "").strip()
    rc, out, err = gh(
        "issue", "comment", str(sub_issue_num), "--repo", REPO,
        "--body", "Atoma: Your PR was merged. Please confirm completion and close this sub-task.",
    )
    if rc:
        log(f"_dispatch_post_merge_agent: could not post trigger comment on #{sub_issue_num}: {err or out}")
        return False
    rc, out, err = gh(
        "workflow", "run", "atoma-runner.yml",
        "--repo", REPO,
        "--field", f"agent={agent}",
        "--field", f"number={sub_issue_num}",
        "--field", "type=issue",
        "--field", f"notify={notify}",
    )
    if rc:
        log(f"_dispatch_post_merge_agent: gh workflow run failed for #{sub_issue_num} (rc={rc}): {err or out}")
        return False
    log(f"_dispatch_post_merge_agent: re-invoked {agent} on #{sub_issue_num} to confirm and close")
    return True

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
    # GitHub's native "Closes #N" auto-close does not reliably fire when the
    # merge is performed via the Actions GITHUB_TOKEN (as opposed to a human
    # merging through the UI) -- confirmed empirically: linked issues stayed
    # open after bot-driven squash-merges. Prefer re-invoking the PR's origin
    # agent to close the sub-issue itself (see _dispatch_post_merge_agent);
    # only fall back to closing it directly here if there's no origin-agent
    # tag to dispatch (e.g. a PR created before this feature existed).
    closed_issue = None
    d = gh_json("pr", "view", str(num), "--repo", REPO, "--json", "body")
    body = (d or {}).get("body") or ""
    m = re.search(r"<!--\s*atoma:parent-issue=(\d+)\s*-->", body)
    if m:
        parent_num = int(m.group(1))
        origin_match = re.search(r"<!--\s*atoma:origin-agent=([a-z][a-z0-9-]*)\s*-->", body)
        if origin_match and _dispatch_post_merge_agent(parent_num, origin_match.group(1)):
            return json.dumps({"merged": True, "closed_issue": None, "reinvoked_agent": origin_match.group(1)})
        try:
            # _close_issue now triggers _dispatch_orchestrator_if_ready itself
            # (so the origin-agent re-invocation path gets the same gating
            # behavior when the re-invoked agent calls close_issue on its own).
            _close_issue({"number": parent_num})
            closed_issue = parent_num
        except RuntimeError as e:
            log(f"_merge_pr: could not close parent issue #{parent_num}: {e}")
    return json.dumps({"merged": True, "closed_issue": closed_issue})


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
