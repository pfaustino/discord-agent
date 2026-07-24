"""Cursor Cloud Agents API (v1) — cloud-only integration for Sara.

Docs: https://cursor.com/docs/cloud-agent/api/endpoints
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

import config
import db

log = logging.getLogger("cursor_api")

API_BASE = "https://api.cursor.com"
TIMEOUT = 60
RESULT_MAX = 6000

# Terminal run statuses per Cursor API
TERMINAL_STATUSES = frozenset({"FINISHED", "ERROR", "CANCELLED", "EXPIRED"})


def is_configured() -> bool:
    return bool(config.CURSOR_API_KEY.strip())


def _api_key(override: str | None = None) -> str:
    if override is not None:
        return override.strip()
    return config.CURSOR_API_KEY.strip()


async def is_enabled(guild_id: int) -> bool:
    if not is_configured():
        return False
    return bool(await db.get_setting(guild_id, "cursor_enabled"))


def _auth(api_key: str | None = None) -> tuple[str, str]:
    return _api_key(api_key), ""


async def _request(method: str, path: str, *, api_key: str | None = None, **kwargs) -> httpx.Response:
    url = f"{API_BASE}{path}"
    async with httpx.AsyncClient(timeout=TIMEOUT, auth=_auth(api_key)) as client:
        return await client.request(method, url, **kwargs)


async def test_connection(api_key: str | None = None) -> dict:
    key = _api_key(api_key)
    if not key:
        return {"ok": False, "error": "No API key provided — paste your key and try again."}
    try:
        resp = await _request("GET", "/v1/models", api_key=api_key)
    except httpx.HTTPError as exc:
        return {"ok": False, "error": f"Could not reach Cursor API: {exc}"}
    if resp.status_code == 200:
        data = resp.json()
        count = len(data.get("items") or [])
        return {"ok": True, "model_count": count}
    if resp.status_code == 401:
        return {"ok": False, "error": "Invalid API key (HTTP 401)"}
    return {"ok": False, "error": f"HTTP {resp.status_code}", "detail": resp.text[:300]}


async def list_models() -> list[dict]:
    if not is_configured():
        return []
    try:
        resp = await _request("GET", "/v1/models")
        if resp.status_code != 200:
            return []
        return list(resp.json().get("items") or [])
    except httpx.HTTPError:
        return []


def _format_git(git: dict | None) -> str:
    if not git:
        return ""
    lines = []
    for branch in git.get("branches") or []:
        parts = [branch.get("branch") or "(branch)"]
        if branch.get("prUrl"):
            parts.append(f"PR: {branch['prUrl']}")
        elif branch.get("repoUrl"):
            parts.append(branch["repoUrl"])
        lines.append(" · ".join(parts))
    return "\n".join(lines)


def _format_run(run: dict, agent: dict | None = None) -> str:
    lines = [
        f"Run: {run.get('id', '?')}",
        f"Status: {run.get('status', 'unknown')}",
    ]
    if agent:
        lines.insert(0, f"Agent: {agent.get('name') or agent.get('id', '?')}")
        if agent.get("url"):
            lines.append(f"Dashboard: {agent['url']}")
    if run.get("durationMs") is not None:
        lines.append(f"Duration: {run['durationMs']} ms")
    if run.get("result"):
        lines.append(f"Result: {run['result']}")
    git_line = _format_git(run.get("git"))
    if git_line:
        lines.append(f"Git:\n{git_line}")
    return "\n".join(lines)[:RESULT_MAX]


async def _guild_defaults(guild_id: int) -> dict[str, Any]:
    return {
        "model": await db.get_setting(guild_id, "cursor_default_model") or "",
        "repo": await db.get_setting(guild_id, "cursor_default_repo") or "",
        "branch": await db.get_setting(guild_id, "cursor_default_branch") or "main",
        "auto_create_pr": bool(await db.get_setting(guild_id, "cursor_auto_create_pr")),
        "work_on_current_branch": bool(
            await db.get_setting(guild_id, "cursor_work_on_current_branch")
        ),
        "mode": await db.get_setting(guild_id, "cursor_mode") or "agent",
    }


async def launch_agent(guild_id: int, arguments: dict) -> str:
    prompt = str(arguments.get("prompt", "")).strip()
    if not prompt:
        return "A prompt is required — describe the coding task for Cursor."

    defaults = await _guild_defaults(guild_id)
    repo = str(arguments.get("repo") or defaults["repo"]).strip()
    if not repo:
        return (
            "No repository configured. Set cursor_default_repo in dashboard "
            "Settings → Cursor, or pass repo in the tool call."
        )
    branch = str(arguments.get("branch") or defaults["branch"]).strip() or "main"
    model_id = str(arguments.get("model") or defaults["model"]).strip()
    mode = str(arguments.get("mode") or defaults["mode"]).strip() or "agent"
    if mode not in ("agent", "plan"):
        mode = "agent"
    name = str(arguments.get("name") or "").strip()[:100]
    auto_pr = arguments.get("auto_create_pr")
    if auto_pr is None:
        auto_pr = defaults["auto_create_pr"]
    else:
        auto_pr = bool(auto_pr)

    work_on_branch = arguments.get("work_on_current_branch")
    if work_on_branch is None:
        work_on_branch = defaults["work_on_current_branch"]
    else:
        work_on_branch = bool(work_on_branch)

    # Pushing directly to the target branch — no separate cursor/... branch or PR needed.
    if work_on_branch:
        auto_pr = False

    body: dict[str, Any] = {
        "prompt": {"text": prompt},
        "repos": [{"url": repo, "startingRef": branch}],
        "workOnCurrentBranch": work_on_branch,
        "autoCreatePR": auto_pr,
        "mode": mode,
    }
    if name:
        body["name"] = name
    if model_id:
        body["model"] = {"id": model_id}

    try:
        resp = await _request("POST", "/v1/agents", json=body)
    except httpx.HTTPError as exc:
        return f"Cursor API unreachable: {exc}"

    if resp.status_code not in (200, 201):
        return f"Cursor API error (HTTP {resp.status_code}): {resp.text[:500]}"

    try:
        data = resp.json()
    except ValueError:
        return "Cursor accepted the request but returned non-JSON."

    agent = data.get("agent") or {}
    run = data.get("run") or {}
    push_note = (
        f"Changes will push directly to **{branch}** (no separate cursor/ branch)."
        if work_on_branch
        else "Changes will land on a new cursor/… branch — merge or enable "
             "'Push to target branch' in Settings → Cursor."
    )
    lines = [
        "Cursor cloud agent launched.",
        push_note,
        _format_run(run, agent),
        "",
        "The agent is working in the cloud — ask me to check status with cursor_agent_status.",
    ]
    return "\n".join(lines)[:RESULT_MAX]


async def agent_status(guild_id: int, arguments: dict) -> str:
    agent_id = str(arguments.get("agent_id", "")).strip()
    if not agent_id:
        return "agent_id is required."

    run_id = str(arguments.get("run_id") or "").strip()

    try:
        agent_resp = await _request("GET", f"/v1/agents/{agent_id}")
    except httpx.HTTPError as exc:
        return f"Cursor API unreachable: {exc}"

    if agent_resp.status_code == 404:
        return f"Agent {agent_id} not found."
    if agent_resp.status_code != 200:
        return f"Cursor API error (HTTP {agent_resp.status_code}): {agent_resp.text[:400]}"

    try:
        agent = agent_resp.json()
    except ValueError:
        return "Cursor returned non-JSON for agent lookup."

    if not run_id:
        run_id = agent.get("latestRunId") or ""
    if not run_id:
        lines = [f"Agent: {agent.get('name') or agent_id}", f"Status: {agent.get('status', '?')}"]
        if agent.get("url"):
            lines.append(f"Dashboard: {agent['url']}")
        return "\n".join(lines)

    try:
        run_resp = await _request("GET", f"/v1/agents/{agent_id}/runs/{run_id}")
    except httpx.HTTPError as exc:
        return f"Cursor API unreachable: {exc}"

    if run_resp.status_code == 404:
        return f"Run {run_id} not found for agent {agent_id}."
    if run_resp.status_code != 200:
        return f"Cursor API error (HTTP {run_resp.status_code}): {run_resp.text[:400]}"

    try:
        run = run_resp.json()
    except ValueError:
        return "Cursor returned non-JSON for run lookup."

    return _format_run(run, agent)
