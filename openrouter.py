"""Minimal async OpenRouter chat-completions client with tool-calling support.

Background calls (classification, memory maintenance, assessments) are
rate-capped per hour as a spend breaker and every call's token usage is
logged under the "llm" logger so cost hot-spots show up in the dashboard.
"""
import json
import logging
import time
from collections import deque

import httpx

import config

API_URL = "https://openrouter.ai/api/v1/chat/completions"

log = logging.getLogger("llm")

_bg_calls: deque = deque()  # timestamps of background calls, last hour


class OpenRouterError(Exception):
    pass


def _bg_budget_check() -> None:
    cap = config.OPENROUTER_BG_HOURLY_CAP
    if cap <= 0:
        return
    now = time.time()
    while _bg_calls and now - _bg_calls[0] > 3600:
        _bg_calls.popleft()
    if len(_bg_calls) >= cap:
        raise OpenRouterError(
            f"background call budget exhausted ({cap}/hour) — skipping")
    _bg_calls.append(now)


async def chat(
    messages: list[dict],
    model: str | None = None,
    max_tokens: int = 1000,
    temperature: float = 0.7,
    tools: list[dict] | None = None,
    tool_handler=None,
    max_tool_rounds: int = 4,
    background: bool = False,
) -> str:
    """Send a chat completion request and return the assistant's reply text.

    If `tools` and `tool_handler` are given, runs an agent loop: when the model
    requests tool calls, each is executed via `await tool_handler(name, args)`
    and the results are fed back, up to `max_tool_rounds` rounds. The last
    round is forced tool-free so the model always produces a final answer.
    """
    if not config.OPENROUTER_API_KEY:
        raise OpenRouterError("OPENROUTER_API_KEY is not set")
    if background:
        _bg_budget_check()
    headers = {
        "Authorization": f"Bearer {config.OPENROUTER_API_KEY}",
        "X-Title": "Discord Agent",
    }
    messages = list(messages)
    use_tools = bool(tools and tool_handler)

    async with httpx.AsyncClient(timeout=90) as client:
        for round_no in range(max_tool_rounds + 1):
            payload = {
                "model": model or config.OPENROUTER_MODEL,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
            }
            if use_tools and round_no < max_tool_rounds:
                payload["tools"] = tools
            resp = await client.post(API_URL, headers=headers, json=payload)
            if resp.status_code != 200:
                raise OpenRouterError(f"OpenRouter returned {resp.status_code}: {resp.text[:300]}")
            data = resp.json()
            try:
                reply = data["choices"][0]["message"]
            except (KeyError, IndexError) as exc:
                raise OpenRouterError(f"Unexpected OpenRouter response: {data}") from exc
            usage = data.get("usage") or {}
            log.info("%s%s in=%s out=%s", payload["model"],
                     " [bg]" if background else "",
                     usage.get("prompt_tokens", "?"), usage.get("completion_tokens", "?"))

            tool_calls = reply.get("tool_calls")
            if not (tool_calls and use_tools):
                return reply.get("content") or ""

            messages.append(reply)
            for call in tool_calls:
                try:
                    args = json.loads(call["function"].get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                result = await tool_handler(call["function"]["name"], args)
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.get("id", ""),
                    "content": result,
                })
    raise OpenRouterError("Tool loop ended without a final answer")
