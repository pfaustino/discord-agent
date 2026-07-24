"""Cooldown manager: global / channel / user / topic scopes, persisted."""
from __future__ import annotations

from .config import EngineConfig
from .store import SqliteStore


class CooldownManager:
    def __init__(self, store: SqliteStore, config: EngineConfig):
        self.store = store
        self.config = config

    def active(self, now: float, channel_id: str, user_id: str, topic: str) -> list[str]:
        """Return the scopes currently holding Max silent (empty = clear)."""
        cds = self.store.get_cooldowns()
        held = []
        for scope in ("global", f"channel:{channel_id}", f"user:{user_id}", f"topic:{topic}"):
            if scope.endswith(":"):  # empty id — scope not applicable
                continue
            if cds.get(scope, 0) > now:
                held.append(scope)
        return held

    def start_all(self, now: float, channel_id: str, user_id: str, topic: str) -> None:
        c = self.config
        self.store.set_cooldown("global", now + c.cooldown_global)
        if channel_id:
            self.store.set_cooldown(f"channel:{channel_id}", now + c.cooldown_channel)
        if user_id:
            self.store.set_cooldown(f"user:{user_id}", now + c.cooldown_user)
        if topic:
            self.store.set_cooldown(f"topic:{topic}", now + c.cooldown_topic)
