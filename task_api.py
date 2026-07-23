"""External task-management API integration.

Expects a REST API with these endpoints (Bearer auth optional):

  POST {TASK_API_URL}/tasks
  GET  {TASK_API_URL}/tasks?status=open&limit=10
  GET  {TASK_API_URL}/tasks/{id}

Request body for create (JSON):
  title, description, priority, due_date, project_id,
  source ("discord-agent"), metadata { guild_id, channel_id, requester_id, ... }

Responses may use id/task_id, title/name, status, url/link/web_url fields.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx

import config
import db

log = logging.getLogger("task_api")

TOOL_NAMES = frozenset({"create_task", "list_tasks", "get_task"})
TIMEOUT = 20
RESULT_MAX = 6000

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "create_task",
            "description": (
                "Create a task in the external task manager from something the user "
                "asked to track, remember, or follow up on. Turn vague requests into "
                "a clear title and a useful description with context."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short, actionable task title",
                    },
                    "description": {
                        "type": "string",
                        "description": "Details, context, and acceptance criteria",
                    },
                    "priority": {
                        "type": "string",
                        "enum": ["low", "medium", "high"],
                        "description": "Task priority (default medium)",
                    },
                    "due_date": {
                        "type": "string",
                        "description": "Optional due date (ISO 8601, e.g. 2026-07-25)",
                    },
                    "project_id": {
                        "type": "string",
                        "description": "Optional project/list/board override",
                    },
                },
                "required": ["title", "description"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_tasks",
            "description": (
                "List open tasks from the external task manager. Use when someone "
                "asks what's on the list, pending work, or their todos."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "description": "Filter by status (default open)",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max tasks to return (default 10, max 25)",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_task",
            "description": "Look up a single task by its ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The task ID returned when it was created",
                    },
                },
                "required": ["task_id"],
            },
        },
    },
]


@dataclass
class TaskContext:
    guild_id: int
    guild_name: str
    channel_id: int
    channel_name: str
    requester_id: int | None
    requester_name: str
    message_url: str | None = None

    @classmethod
    def from_message(cls, message) -> TaskContext:
        guild = message.guild
        channel = message.channel
        url = None
        if hasattr(message, "jump_url"):
            url = message.jump_url
        return cls(
            guild_id=guild.id,
            guild_name=guild.name,
            channel_id=channel.id,
            channel_name=getattr(channel, "name", "unknown"),
            requester_id=message.author.id,
            requester_name=message.author.display_name,
            message_url=url,
        )

    @classmethod
    def from_voice(cls, guild, channel, speaker_name: str) -> TaskContext:
        return cls(
            guild_id=guild.id,
            guild_name=guild.name,
            channel_id=channel.id,
            channel_name=getattr(channel, "name", "unknown"),
            requester_id=None,
            requester_name=speaker_name,
            message_url=None,
        )


def is_configured() -> bool:
    return bool(config.TASK_API_URL.strip())


async def is_enabled(guild_id: int) -> bool:
    if not is_configured():
        return False
    return bool(await db.get_setting(guild_id, "tasks_enabled"))


async def schemas_for_guild(guild_id: int) -> list[dict]:
    if not await is_enabled(guild_id):
        return []
    return list(TOOL_SCHEMAS)


def _headers() -> dict[str, str]:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if config.TASK_API_KEY:
        headers["Authorization"] = f"Bearer {config.TASK_API_KEY}"
    return headers


def _base_url() -> str:
    return config.TASK_API_URL.rstrip("/")


def _task_id(task: dict) -> str:
    return str(task.get("id") or task.get("task_id") or "?")


def _task_title(task: dict) -> str:
    return str(task.get("title") or task.get("name") or "(untitled)")


def _format_task(task: dict, *, heading: str = "Task") -> str:
    lines = [
        f"{heading}: {_task_title(task)}",
        f"ID: {_task_id(task)}",
        f"Status: {task.get('status', 'unknown')}",
    ]
    if task.get("priority"):
        lines.append(f"Priority: {task['priority']}")
    if task.get("due_date"):
        lines.append(f"Due: {task['due_date']}")
    url = task.get("url") or task.get("link") or task.get("web_url")
    if url:
        lines.append(f"Link: {url}")
    if task.get("description"):
        lines.append(f"Description: {task['description']}")
    return "\n".join(lines)


def _extract_tasks(payload: Any) -> list[dict]:
    if isinstance(payload, list):
        return [t for t in payload if isinstance(t, dict)]
    if isinstance(payload, dict):
        for key in ("tasks", "items", "data", "results"):
            value = payload.get(key)
            if isinstance(value, list):
                return [t for t in value if isinstance(t, dict)]
        if payload.get("id") or payload.get("task_id"):
            return [payload]
    return []


async def _request(method: str, path: str, **kwargs) -> httpx.Response:
    url = f"{_base_url()}{path}"
    async with httpx.AsyncClient(timeout=TIMEOUT, headers=_headers()) as client:
        return await client.request(method, url, **kwargs)


async def test_connection() -> dict:
    if not is_configured():
        return {"ok": False, "error": "Task API URL is not configured"}
    try:
        resp = await _request("GET", "/tasks", params={"limit": 1})
    except httpx.HTTPError as exc:
        return {"ok": False, "error": f"Could not reach API: {exc}"}
    if resp.status_code in (200, 404):
        return {"ok": True, "status": resp.status_code}
    return {
        "ok": False,
        "error": f"HTTP {resp.status_code}",
        "detail": resp.text[:300],
    }


async def create_task(ctx: TaskContext, arguments: dict) -> str:
    title = str(arguments.get("title", "")).strip()
    description = str(arguments.get("description", "")).strip()
    if not title:
        return "Task title is required."
    if not description:
        return "Task description is required."

    project_id = str(arguments.get("project_id") or "").strip()
    if not project_id:
        project_id = await db.get_setting(ctx.guild_id, "tasks_default_project") or ""

    priority = str(arguments.get("priority") or "medium").lower()
    if priority not in ("low", "medium", "high"):
        priority = "medium"

    body: dict[str, Any] = {
        "title": title,
        "description": description,
        "priority": priority,
        "source": "discord-agent",
        "metadata": {
            "guild_id": str(ctx.guild_id),
            "guild_name": ctx.guild_name,
            "channel_id": str(ctx.channel_id),
            "channel_name": ctx.channel_name,
            "requester_id": str(ctx.requester_id) if ctx.requester_id else None,
            "requester_name": ctx.requester_name,
            "message_url": ctx.message_url,
        },
    }
    due_date = str(arguments.get("due_date") or "").strip()
    if due_date:
        body["due_date"] = due_date
    if project_id:
        body["project_id"] = project_id

    try:
        resp = await _request("POST", "/tasks", json=body)
    except httpx.HTTPError as exc:
        return f"Task API unreachable: {exc}"

    if resp.status_code not in (200, 201):
        return f"Task API error (HTTP {resp.status_code}): {resp.text[:400]}"

    try:
        data = resp.json()
    except ValueError:
        return f"Task created (HTTP {resp.status_code}) but response was not JSON."

    task = data if isinstance(data, dict) else {}
    nested = _extract_tasks(data)
    if nested:
        task = nested[0]
    return _format_task(task, heading="Task created")[:RESULT_MAX]


async def list_tasks(ctx: TaskContext, arguments: dict) -> str:
    status = str(arguments.get("status") or "open").strip() or "open"
    try:
        limit = int(arguments.get("limit") or 10)
    except (TypeError, ValueError):
        limit = 10
    limit = max(1, min(limit, 25))

    params: dict[str, Any] = {"limit": limit}
    if status:
        params["status"] = status

    try:
        resp = await _request("GET", "/tasks", params=params)
    except httpx.HTTPError as exc:
        return f"Task API unreachable: {exc}"

    if resp.status_code != 200:
        return f"Task API error (HTTP {resp.status_code}): {resp.text[:400]}"

    try:
        data = resp.json()
    except ValueError:
        return "Task API returned non-JSON response."

    tasks = _extract_tasks(data)
    if not tasks:
        return f"No tasks found (status={status})."

    lines = [f"Tasks ({len(tasks)} shown, status={status}):"]
    for i, task in enumerate(tasks, 1):
        url = task.get("url") or task.get("link") or task.get("web_url")
        extra = f" — {url}" if url else ""
        lines.append(
            f"{i}. [{_task_id(task)}] {_task_title(task)} "
            f"({task.get('status', '?')}, {task.get('priority', '?')}){extra}"
        )
    return "\n".join(lines)[:RESULT_MAX]


async def get_task(ctx: TaskContext, arguments: dict) -> str:
    task_id = str(arguments.get("task_id", "")).strip()
    if not task_id:
        return "task_id is required."

    try:
        resp = await _request("GET", f"/tasks/{task_id}")
    except httpx.HTTPError as exc:
        return f"Task API unreachable: {exc}"

    if resp.status_code == 404:
        return f"Task {task_id} not found."
    if resp.status_code != 200:
        return f"Task API error (HTTP {resp.status_code}): {resp.text[:400]}"

    try:
        data = resp.json()
    except ValueError:
        return "Task API returned non-JSON response."

    task = data if isinstance(data, dict) else {}
    nested = _extract_tasks(data)
    if nested:
        task = nested[0]
    return _format_task(task, heading="Task details")[:RESULT_MAX]


async def run_tool(ctx: TaskContext, name: str, arguments: dict) -> str:
    if not await is_enabled(ctx.guild_id):
        return "Task management is disabled on this server (enable it in the dashboard)."
    if not is_configured():
        return "Task API is not configured — add URL and key in dashboard Settings → Tasks."

    try:
        if name == "create_task":
            return await create_task(ctx, arguments)
        if name == "list_tasks":
            return await list_tasks(ctx, arguments)
        if name == "get_task":
            return await get_task(ctx, arguments)
        return f"Unknown task tool: {name}"
    except Exception as exc:
        log.warning("Task tool %s failed: %s", name, exc)
        return f"Task tool {name} failed: {exc}"
