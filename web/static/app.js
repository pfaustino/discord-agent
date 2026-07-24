/* Discord Agent dashboard */
"use strict";

const state = {
  guilds: [],
  guildId: null,
  tab: "overview",
  memoryPane: "transcription",
  transcriptionSource: "chat",
  settingsSection: "app",
  memberSearch: "",
  memberOffset: 0,
  roles: [],
  channels: [],
};

const $ = (sel) => document.querySelector(sel);
const content = () => $("#content");

/* ---------- API ---------- */

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("Not logged in");
  }
  if (!res.ok) {
    let detail = "Request failed";
    try { detail = (await res.json()).detail || detail; } catch {}
    toast(detail, true);
    throw new Error(detail);
  }
  return res.json();
}

/* ---------- helpers ---------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error-toast", isError);
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 3000);
}

function timeAgo(ts) {
  if (!ts) return "?";
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function openModal(html) {
  $("#modal").innerHTML = html;
  $("#modal-backdrop").classList.remove("hidden");
}
function closeModal() {
  $("#modal-backdrop").classList.add("hidden");
}
$("#modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "modal-backdrop") closeModal();
});

function confirmAction(text, onYes) {
  openModal(`
    <h2>Are you sure?</h2>
    <p class="muted">${esc(text)}</p>
    <div class="btn-row">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn danger" id="confirm-yes">Confirm</button>
    </div>`);
  $("#confirm-yes").onclick = async () => { closeModal(); await onYes(); };
}

/* ---------- login ---------- */

function showLogin() {
  $("#app").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").classList.add("hidden");
  try {
    await api("/login", { method: "POST", body: { password: $("#login-password").value } });
    $("#login-password").value = "";
    init();
  } catch {
    $("#login-error").classList.remove("hidden");
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

/* ---------- boot ---------- */

async function boot() {
  try {
    if (await checkSetupStatus()) return;
  } catch {
    showLogin();
    return;
  }
  try {
    await api("/me");
    init();
  } catch {
    showLogin();
  }
}

async function init() {
  let me;
  try {
    me = await api("/me");
  } catch { return; }
  $("#login-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  if (!me.ready) {
    content().innerHTML = `<div class="card"><h2>Bot is starting…</h2>
      <p class="muted">Refresh in a few seconds.</p></div>`;
    setTimeout(init, 3000);
    return;
  }
  state.me = me;
  state.guilds = await api("/guilds");
  const sel = $("#guild-select");
  sel.innerHTML = state.guilds
    .map((g) => `<option value="${g.id}">${esc(g.name)}</option>`)
    .join("");
  if (!state.guilds.length) {
    content().innerHTML = `<div class="card"><h2>No servers</h2>
      <p class="muted">Invite the bot to a server first, then refresh.</p></div>`;
    return;
  }
  if (!state.guildId || !state.guilds.find((g) => g.id === state.guildId)) {
    state.guildId = state.guilds[0].id;
  }
  sel.value = state.guildId;
  render();
}

$("#guild-select").addEventListener("change", (e) => {
  state.guildId = e.target.value;
  render();
});

document.querySelectorAll("#tabbar button").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.tab = btn.dataset.tab;
    document.querySelectorAll("#tabbar button").forEach((b) =>
      b.classList.toggle("active", b === btn));
    render();
  });
});

function render() {
  clearInterval(state.memoryTimer);
  clearInterval(state.overviewTimer);
  const renderers = {
    overview: renderOverview,
    members: renderMembers,
    server: renderServer,
    memory: renderMemory,
    mod: renderMod,
    settings: renderSettings,
  };
  content().innerHTML = `<div class="card"><p class="muted">Loading…</p></div>`;
  renderers[state.tab]().catch((e) => console.error(e));
}

/* ---------- overview ---------- */

function overviewListeningLabel(voice) {
  if (!voice.enabled) return { badge: "badge", text: "unavailable", detail: "Set a transcription API key in Settings → App." };
  if (voice.listening) {
    const channel = voice.channels.find((c) => c.id === voice.listening);
    const name = channel ? `#${channel.name}` : "voice channel";
    return { badge: "badge ok", text: "listening", detail: `Monitoring ${name}.` };
  }
  if (voice.voice_enabled) {
    return { badge: "badge", text: "idle", detail: "Monitoring enabled — waiting for someone in voice." };
  }
  return { badge: "badge", text: "off", detail: "Not monitoring voice channels." };
}

async function refreshOverviewListening() {
  const badge = $("#overview-listening-badge");
  const detail = $("#overview-listening-detail");
  const toggle = $("#overview-listening-toggle");
  if (!badge || !detail || !toggle) return;
  try {
    const voice = await api(`/guilds/${state.guildId}/transcripts`);
    const status = overviewListeningLabel(voice);
    badge.className = status.badge;
    badge.textContent = status.text;
    detail.textContent = status.detail;
    const active = Boolean(voice.enabled && voice.listening);
    toggle.disabled = !voice.enabled;
    toggle.textContent = active ? "Stop listening" : "Start listening";
    toggle.className = active ? "btn danger" : "btn primary";
    toggle.dataset.listening = active ? "1" : "0";
  } catch (e) {
    detail.textContent = "Could not load voice status.";
    toggle.disabled = true;
  }
}

async function renderOverview() {
  const [g, me] = await Promise.all([api(`/guilds/${state.guildId}`), api("/me")]);
  content().innerHTML = `
    <div class="card" style="display:flex;align-items:center;gap:12px">
      ${g.icon ? `<img class="avatar" src="${g.icon}" style="width:48px;height:48px;border-radius:12px">` : ""}
      <div><div style="font-size:17px;font-weight:700">${esc(g.name)}</div>
      <div class="muted">Owner: ${esc(g.owner ?? "?")}</div></div>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="value">${g.member_count}</div><div class="label">Members</div></div>
      <div class="stat"><div class="value">${g.humans}</div><div class="label">Humans</div></div>
      <div class="stat"><div class="value">${g.bots}</div><div class="label">Bots</div></div>
      <div class="stat"><div class="value">${g.channels}</div><div class="label">Channels</div></div>
      <div class="stat"><div class="value">${g.roles}</div><div class="label">Roles</div></div>
      <div class="stat"><div class="value">${g.boost_level}</div><div class="label">Boost level</div></div>
    </div>
    <div class="section-title">Voice listening</div>
    <div class="card" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div class="grow" style="min-width:180px">
        <div style="font-weight:600">Microphone</div>
        <div class="muted" id="overview-listening-detail">Loading…</div>
      </div>
      <span id="overview-listening-badge" class="badge">…</span>
      <button type="button" id="overview-listening-toggle" class="btn primary" disabled>Start listening</button>
    </div>
    <div class="section-title">Bot</div>
    <div class="card" style="display:flex;align-items:center;gap:12px">
      <img class="avatar" src="${me.avatar}" style="width:40px;height:40px;border-radius:50%">
      <div class="grow"><div style="font-weight:600">${esc(me.name)}</div>
      <div class="muted">${me.guild_count} server(s) · ${me.latency_ms}ms</div></div>
      <span class="badge ok">online</span>
    </div>`;

  clearInterval(state.overviewTimer);
  $("#overview-listening-toggle").onclick = async () => {
    const btn = $("#overview-listening-toggle");
    if (btn.disabled) return;
    const listening = btn.dataset.listening !== "1";
    btn.disabled = true;
    try {
      const result = await api(`/guilds/${state.guildId}/voice/listening`, {
        method: "POST",
        body: { listening },
      });
      toast(listening
        ? `Listening in ${result.channel_name ? "#" + result.channel_name : "voice"}`
        : "Stopped listening");
      await refreshOverviewListening();
    } catch (e) {
      await refreshOverviewListening();
    }
  };
  await refreshOverviewListening();
  state.overviewTimer = setInterval(() => refreshOverviewListening().catch(() => {}), 3000);
}

/* ---------- members ---------- */

async function renderMembers() {
  content().innerHTML = `
    <div class="inline-form">
      <input id="member-search" placeholder="Search members…" value="${esc(state.memberSearch)}">
    </div>
    <div id="member-list" class="list"></div>
    <div class="btn-row">
      <button class="btn sm hidden" id="member-prev">&larr; Prev</button>
      <button class="btn sm hidden" id="member-next">Next &rarr;</button>
    </div>`;
  const input = $("#member-search");
  input.addEventListener("input", () => {
    clearTimeout(input._t);
    input._t = setTimeout(() => {
      state.memberSearch = input.value;
      state.memberOffset = 0;
      loadMembers();
    }, 300);
  });
  await loadMembers();
}

async function loadMembers() {
  const q = new URLSearchParams({
    search: state.memberSearch, offset: state.memberOffset, limit: 50,
  });
  const data = await api(`/guilds/${state.guildId}/members?${q}`);
  const list = $("#member-list");
  if (!list) return;
  list.innerHTML = data.members.map((m) => `
    <div class="row" data-id="${m.id}">
      <img class="avatar" src="${m.avatar}">
      <div class="grow">
        <div class="title">${esc(m.display_name)}
          ${m.bot ? '<span class="badge">bot</span>' : ""}
          ${m.timed_out ? '<span class="badge warn">timed out</span>' : ""}</div>
        <div class="sub">@${esc(m.name)}</div>
      </div>
      <div class="right">${timeAgo(m.joined_at)}</div>
    </div>`).join("") || `<div class="card muted">No members found</div>`;
  list.querySelectorAll(".row").forEach((row) => {
    row.addEventListener("click", () => {
      const m = data.members.find((x) => x.id === row.dataset.id);
      memberSheet(m);
    });
  });
  const prev = $("#member-prev"), next = $("#member-next");
  prev.classList.toggle("hidden", state.memberOffset === 0);
  next.classList.toggle("hidden", state.memberOffset + 50 >= data.total);
  prev.onclick = () => { state.memberOffset = Math.max(0, state.memberOffset - 50); loadMembers(); };
  next.onclick = () => { state.memberOffset += 50; loadMembers(); };
}

function memberSheet(m) {
  openModal(`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
      <img src="${m.avatar}" style="width:52px;height:52px;border-radius:50%">
      <div><div style="font-size:17px;font-weight:700">${esc(m.display_name)}</div>
      <div class="muted">@${esc(m.name)} · ${m.id}</div></div>
    </div>
    <label class="field"><span class="lbl">Reason (for actions below)</span>
      <input id="action-reason" placeholder="Optional reason"></label>
    <div class="btn-row">
      <button class="btn warn" data-act="warn">Warn</button>
      <button class="btn" data-act="timeout">Timeout</button>
      ${m.timed_out ? '<button class="btn" data-act="untimeout">Untimeout</button>' : ""}
      <button class="btn danger" data-act="kick">Kick</button>
      <button class="btn danger" data-act="ban">Ban</button>
    </div>
    <div class="btn-row">
      <button class="btn full" id="manage-roles-btn">Manage roles</button>
    </div>`);
  document.querySelectorAll("#modal [data-act]").forEach((btn) => {
    btn.onclick = () => {
      const action = btn.dataset.act;
      const reason = $("#action-reason").value || null;
      const run = async (minutes = null) => {
        await api(`/guilds/${state.guildId}/members/${m.id}/action`, {
          method: "POST", body: { action, reason, minutes },
        });
        toast(`${action} → ${m.display_name}`);
        closeModal();
        loadMembers();
      };
      if (action === "timeout") {
        const mins = parseInt(prompt("Timeout minutes:", "10"), 10);
        if (!mins) return;
        run(mins);
      } else if (action === "kick" || action === "ban") {
        confirmAction(`${action} ${m.display_name}?`, () => run());
      } else {
        run();
      }
    };
  });
  $("#manage-roles-btn").onclick = () => roleSheet(m);
}

async function roleSheet(m) {
  const roles = await api(`/guilds/${state.guildId}/roles`);
  const assignable = roles.filter((r) => !r.managed);
  openModal(`
    <h2>Roles — ${esc(m.display_name)}</h2>
    <div class="list">${assignable.map((r) => `
      <label class="toggle">
        <input type="checkbox" data-role="${r.id}" ${m.roles.includes(r.id) ? "checked" : ""}>
        <span class="color-dot" style="background:${r.color || "#5c5f66"}"></span>
        ${esc(r.name)}
      </label>`).join("")}</div>
    <div class="btn-row"><button class="btn primary full" id="save-roles">Save</button></div>`);
  $("#save-roles").onclick = async () => {
    const add = [], remove = [];
    document.querySelectorAll("#modal [data-role]").forEach((cb) => {
      const had = m.roles.includes(cb.dataset.role);
      if (cb.checked && !had) add.push(cb.dataset.role);
      if (!cb.checked && had) remove.push(cb.dataset.role);
    });
    await api(`/guilds/${state.guildId}/members/${m.id}/roles`, {
      method: "POST", body: { add, remove },
    });
    toast("Roles updated");
    closeModal();
    loadMembers();
  };
}

/* ---------- server (channels & roles) ---------- */

async function renderServer() {
  const [channels, roles] = await Promise.all([
    api(`/guilds/${state.guildId}/channels`),
    api(`/guilds/${state.guildId}/roles`),
  ]);
  state.channels = channels;
  state.roles = roles;
  const textChannels = channels.filter((c) => c.type === "text");
  content().innerHTML = `
    <div class="section-title">Send a message as the bot</div>
    <div class="card">
      <label class="field"><span class="lbl">Channel</span>
        <select id="send-channel">${textChannels.map((c) =>
          `<option value="${c.id}">#${esc(c.name)}</option>`).join("")}</select></label>
      <label class="field"><span class="lbl">Message</span>
        <textarea id="send-content" placeholder="Type a message…"></textarea></label>
      <button class="btn primary full" id="send-btn">Send</button>
    </div>

    <div class="section-title">Channels (${channels.length})</div>
    <div class="inline-form">
      <input id="new-channel-name" placeholder="new-channel">
      <select id="new-channel-type" style="max-width:110px">
        <option value="text">Text</option><option value="voice">Voice</option>
        <option value="category">Category</option>
        <option value="forum">Forum</option>
      </select>
      <button class="btn primary sm" id="create-channel-btn">Add</button>
    </div>
    <div class="list">${channels.map((c) => `
      <div class="row" style="cursor:default">
        <div class="grow">
          <div class="title">${c.type === "text" ? "#" : ""}${esc(c.name)}</div>
          <div class="sub">${esc(c.type)}${c.category ? " · " + esc(c.category) : ""}</div>
        </div>
        <button class="btn ghost sm" data-del-channel="${c.id}" data-name="${esc(c.name)}">&#x1F5D1;</button>
      </div>`).join("")}</div>

    <div class="section-title">Roles (${roles.length})</div>
    <div class="inline-form">
      <input id="new-role-name" placeholder="New role">
      <input id="new-role-color" type="color" value="#5865f2" style="max-width:56px;padding:4px">
      <button class="btn primary sm" id="create-role-btn">Add</button>
    </div>
    <div class="list">${roles.map((r) => `
      <div class="row" style="cursor:default">
        <span class="color-dot" style="background:${r.color || "#5c5f66"}"></span>
        <div class="grow">
          <div class="title">${esc(r.name)} ${r.managed ? '<span class="badge">managed</span>' : ""}</div>
          <div class="sub">${r.members} member(s)</div>
        </div>
        ${r.managed ? "" : `<button class="btn ghost sm" data-del-role="${r.id}" data-name="${esc(r.name)}">&#x1F5D1;</button>`}
      </div>`).join("")}</div>`;

  $("#send-btn").onclick = async () => {
    const channelId = $("#send-channel").value;
    const text = $("#send-content").value.trim();
    if (!text) return toast("Message is empty", true);
    await api(`/guilds/${state.guildId}/channels/${channelId}/messages`, {
      method: "POST", body: { content: text },
    });
    $("#send-content").value = "";
    toast("Message sent");
  };
  $("#create-channel-btn").onclick = async () => {
    const name = $("#new-channel-name").value.trim();
    if (!name) return;
    await api(`/guilds/${state.guildId}/channels`, {
      method: "POST", body: { name, type: $("#new-channel-type").value },
    });
    toast("Channel created");
    renderServer();
  };
  $("#create-role-btn").onclick = async () => {
    const name = $("#new-role-name").value.trim();
    if (!name) return;
    await api(`/guilds/${state.guildId}/roles`, {
      method: "POST", body: { name, color: $("#new-role-color").value },
    });
    toast("Role created");
    renderServer();
  };
  document.querySelectorAll("[data-del-channel]").forEach((btn) => {
    btn.onclick = () => confirmAction(`Delete channel "${btn.dataset.name}"? This cannot be undone.`,
      async () => {
        await api(`/guilds/${state.guildId}/channels/${btn.dataset.delChannel}`, { method: "DELETE" });
        toast("Channel deleted");
        renderServer();
      });
  });
  document.querySelectorAll("[data-del-role]").forEach((btn) => {
    btn.onclick = () => confirmAction(`Delete role "${btn.dataset.name}"?`,
      async () => {
        await api(`/guilds/${state.guildId}/roles/${btn.dataset.delRole}`, { method: "DELETE" });
        toast("Role deleted");
        renderServer();
      });
  });
}

/* ---------- memory console ---------- */

function memorySubNavHtml() {
  const panes = [
    { id: "transcription", label: "Transcription" },
    { id: "longterm", label: "Long Term Memory" },
  ];
  return `<div class="memory-subnav">${panes.map((p) =>
    `<button type="button" class="memory-subnav-item${state.memoryPane === p.id ? " active" : ""}"
      data-memory-pane="${p.id}">${esc(p.label)}</button>`).join("")}</div>`;
}

function chatMemoryLine(msg) {
  const who = msg.role === "assistant" ? "Sara" : "User";
  const cls = msg.role === "assistant" ? "console-line bot" : "console-line";
  return `<div class="${cls}"><span class="who">${esc(who)}:</span> ${esc(msg.text)}</div>`;
}

function formatChatMemoryText(lines) {
  return (lines || []).map((m) => `${m.role}: ${m.text}`).join("\n");
}

function formatVoiceTranscriptText(lines) {
  return (lines || []).filter((l) => !l.system).map((l) => `${l.name}: ${l.text}`).join("\n");
}

const commitMemoryBtnHtml =
  `<div class="btn-row"><button type="button" class="btn primary full" id="commit-memory">commit to long-term memory</button></div>`;

async function commitTranscriptionToMemory(channelId, text) {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    toast("Nothing to commit", true);
    return;
  }
  const btn = $("#commit-memory");
  if (btn) btn.disabled = true;
  try {
    await api(`/guilds/${state.guildId}/memory/summaries`, {
      method: "POST",
      body: { channel_id: channelId, text: trimmed },
    });
    toast("Committed to long-term memory");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function summaryCard(entry) {
  const t = entry.ts
    ? new Date(entry.ts * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" })
    : "";
  return `<div class="summary-card">
    <div class="summary-card-meta">
      <span class="badge">weight ${esc(String(entry.weight))}</span>
      ${t ? `<span class="muted">${esc(t)}</span>` : ""}
    </div>
    <p>${esc(entry.summary)}</p>
  </div>`;
}

async function renderMemory() {
  content().innerHTML = `
    <div class="section-title">Memory</div>
    ${memorySubNavHtml()}
    <div id="memory-pane"></div>`;

  document.querySelectorAll("[data-memory-pane]").forEach((btn) => {
    btn.onclick = () => {
      state.memoryPane = btn.dataset.memoryPane;
      renderMemory();
    };
  });

  if (state.memoryPane === "longterm") {
    await renderLongTermPane();
  } else {
    await renderTranscriptionPane();
  }
}

async function renderTranscriptionPane() {
  const pane = $("#memory-pane");
  pane.innerHTML = `
    <p class="muted" style="margin:8px 0 10px">Recent verbatim memory — full messages before they are summarized.</p>
    <div class="memory-source-tabs">
      <button type="button" class="memory-source-tab${state.transcriptionSource === "chat" ? " active" : ""}" data-tx-source="chat">AI chat</button>
      <button type="button" class="memory-source-tab${state.transcriptionSource === "voice" ? " active" : ""}" data-tx-source="voice">Voice</button>
    </div>
    <div id="transcription-body"><div class="muted" style="padding:8px">Loading…</div></div>`;

  document.querySelectorAll("[data-tx-source]").forEach((btn) => {
    btn.onclick = () => {
      state.transcriptionSource = btn.dataset.txSource;
      renderTranscriptionPane();
    };
  });

  if (state.transcriptionSource === "voice") {
    pane.innerHTML = `
      <p class="muted" style="margin:8px 0 10px">Live speech-to-text from voice channels.</p>
      <div class="memory-source-tabs">
        <button type="button" class="memory-source-tab" data-tx-source="chat">AI chat</button>
        <button type="button" class="memory-source-tab active" data-tx-source="voice">Voice</button>
      </div>
      <div class="inline-form">
        <select id="voice-channel"></select>
        <label class="muted" style="display:flex;align-items:center;gap:6px;font-size:13px">
          <input type="checkbox" id="voice-follow" checked> follow
        </label>
        <span id="voice-live" class="badge hidden"></span>
      </div>
      <div id="voice-console" class="console"><div class="muted" style="padding:8px">Loading…</div></div>
      ${commitMemoryBtnHtml}`;
    document.querySelectorAll("[data-tx-source]").forEach((btn) => {
      btn.onclick = () => { state.transcriptionSource = btn.dataset.txSource; renderTranscriptionPane(); };
    });
    $("#voice-channel")?.addEventListener("change", (e) => {
      state.voiceChannel = e.target.value;
      refreshVoiceTranscription(true).catch(() => {});
    });
    $("#commit-memory")?.addEventListener("click", () => {
      commitTranscriptionToMemory(
        state.voiceChannel,
        formatVoiceTranscriptText(state.voiceTranscriptLines),
      );
    });
    await refreshVoiceTranscription(true);
    state.memoryTimer = setInterval(() => refreshVoiceTranscription(false).catch(() => {}), 3000);
    return;
  }

  const data = await api(`/guilds/${state.guildId}/memory/recent`);
  const channels = data.channels || [];
  if (!channels.length) {
    $("#transcription-body").innerHTML =
      `<div class="card muted">No AI chat memory yet — @mention Sara or talk in an AI channel.</div>`;
    return;
  }
  if (!state.chatMemoryChannel || !channels.some((c) => c.id === state.chatMemoryChannel)) {
    state.chatMemoryChannel = channels[0].id;
  }
  const options = channels.map((c) =>
    `<option value="${c.id}" ${c.id === state.chatMemoryChannel ? "selected" : ""}>#${esc(c.name)} (${c.lines.length})</option>`).join("");
  const chan = channels.find((c) => c.id === state.chatMemoryChannel);
  state.chatMemoryLines = chan.lines;
  $("#transcription-body").innerHTML = `
    <div class="inline-form">
      <select id="chat-memory-channel">${options}</select>
    </div>
    <div class="console">${chan.lines.map(chatMemoryLine).join("") || '<div class="muted" style="padding:8px">Empty</div>'}</div>
    ${commitMemoryBtnHtml}`;
  $("#chat-memory-channel").addEventListener("change", (e) => {
    state.chatMemoryChannel = e.target.value;
    renderTranscriptionPane();
  });
  $("#commit-memory")?.addEventListener("click", () => {
    commitTranscriptionToMemory(
      state.chatMemoryChannel,
      formatChatMemoryText(state.chatMemoryLines),
    );
  });
}

async function renderLongTermPane() {
  const pane = $("#memory-pane");
  pane.innerHTML = `<div class="muted" style="padding:8px">Loading…</div>`;
  const [data, settings] = await Promise.all([
    api(`/guilds/${state.guildId}/memory/summaries`),
    api(`/guilds/${state.guildId}/settings`),
  ]);
  if (!settings.ai_long_term_memory_enabled) {
    pane.innerHTML = `
      <p class="muted" style="margin:8px 0 10px">Weighted summaries of older conversation, kept after recent memory rolls off.</p>
      <div class="card muted">Long-term memory is turned off for this server. Enable it in Settings → AI chat.</div>`;
    return;
  }
  const channels = data.channels || [];
  if (!channels.length) {
    pane.innerHTML = `
      <p class="muted" style="margin:8px 0 10px">Weighted summaries of older conversation, kept after recent memory rolls off.</p>
      <div class="card muted">No long-term summaries yet. They appear when chat memory fills up and older turns are compressed.</div>`;
    return;
  }
  if (!state.summaryChannel || !channels.some((c) => c.id === state.summaryChannel)) {
    state.summaryChannel = channels[0].id;
  }
  const options = channels.map((c) =>
    `<option value="${c.id}" ${c.id === state.summaryChannel ? "selected" : ""}>#${esc(c.name)} (${c.summaries.length})</option>`).join("");
  const chan = channels.find((c) => c.id === state.summaryChannel);
  pane.innerHTML = `
    <p class="muted" style="margin:8px 0 10px">Weighted summaries of older conversation. Higher weight = more recent.</p>
    <div class="inline-form">
      <select id="summary-channel">${options}</select>
    </div>
    <div class="summary-list">${chan.summaries.map(summaryCard).join("")}</div>`;
  $("#summary-channel").addEventListener("change", (e) => {
    state.summaryChannel = e.target.value;
    renderLongTermPane();
  });
}

function consoleLine(l) {
  const t = new Date(l.ts * 1000).toLocaleTimeString([], { hour12: false });
  if (l.system) return `<div class="console-line system"><span class="t">${t}</span> ${esc(l.text)}</div>`;
  const cls = l.bot ? "console-line bot" : l.flagged ? "console-line flagged" : "console-line";
  return `<div class="${cls}"><span class="t">${t}</span> <span class="who">${esc(l.name)}:</span> ${esc(l.text)}${l.flagged ? ' <span class="badge danger">flagged</span>' : ""}</div>`;
}

async function refreshVoiceTranscription(force) {
  const box = $("#voice-console");
  if (!box) return;
  const data = await api(`/guilds/${state.guildId}/transcripts`);

  const live = $("#voice-live");
  if (live) {
    live.classList.remove("hidden");
    if (!data.enabled) {
      live.textContent = "transcription off";
      live.className = "badge";
    } else if (data.listening) {
      live.textContent = "listening";
      live.className = "badge ok";
    } else {
      live.textContent = "idle";
      live.className = "badge";
    }
  }

  const select = $("#voice-channel");
  if (!select) return;
  const options = data.channels
    .map((c) => `<option value="${c.id}">${esc("#" + c.name)}${c.live ? " · live" : ""}</option>`)
    .join("");
  if (select.innerHTML !== options) select.innerHTML = options;

  if (!data.channels.length) {
    box.innerHTML = `<div class="muted" style="padding:8px">No voice transcripts yet.</div>`;
    return;
  }
  if (!data.channels.some((c) => c.id === state.voiceChannel)) {
    state.voiceChannel = (data.channels.find((c) => c.live) || data.channels[0]).id;
  }
  select.value = state.voiceChannel;

  const chan = data.channels.find((c) => c.id === state.voiceChannel);
  state.voiceTranscriptLines = chan?.lines || [];
  const html = chan.lines.map(consoleLine).join("");
  if (box._html !== html) {
    const follow = $("#voice-follow")?.checked;
    box.innerHTML = html;
    box._html = html;
    if (force || follow) box.scrollTop = box.scrollHeight;
  }
}

const EDGE_TTS_VOICES = [
  { id: "en-US-GuyNeural", label: "Guy — US male" },
  { id: "en-US-JennyNeural", label: "Jenny — US female" },
  { id: "en-US-AriaNeural", label: "Aria — US female" },
  { id: "en-US-DavisNeural", label: "Davis — US male" },
  { id: "en-GB-SoniaNeural", label: "Sonia — British female" },
  { id: "en-GB-RyanNeural", label: "Ryan — British male" },
  { id: "en-AU-NatashaNeural", label: "Natasha — Australian female" },
];

/* ---------- moderation ---------- */

async function renderMod() {
  const [warnings, logs] = await Promise.all([
    api(`/guilds/${state.guildId}/warnings`),
    api(`/guilds/${state.guildId}/logs?limit=100`),
  ]);
  content().innerHTML = `
    <div class="section-title">Warnings (${warnings.length})</div>
    <div class="list">${warnings.map((w) => `
      <div class="row" style="cursor:default">
        <div class="grow">
          <div class="title">${esc(w.user_name)}</div>
          <div class="sub">${esc(w.reason || "No reason")} · by ${esc(w.moderator_name)} · ${timeAgo(w.created_at)}</div>
        </div>
        <button class="btn ghost sm" data-del-warning="${w.id}">&#x1F5D1;</button>
      </div>`).join("") || '<div class="card muted">No warnings</div>'}</div>

    <div class="section-title">Moderation log</div>
    <div class="list">${logs.map((l) => `
      <div class="row" style="cursor:default">
        <span class="badge ${["ban", "kick", "automod"].includes(l.action) ? "danger" :
          ["warn", "timeout"].includes(l.action) ? "warn" : ""}">${esc(l.action)}</span>
        <div class="grow">
          <div class="title">${esc(l.target || "—")}</div>
          <div class="sub">${esc(l.reason || "")} · by ${esc(l.actor)} · ${timeAgo(l.created_at)}</div>
        </div>
      </div>`).join("") || '<div class="card muted">No log entries</div>'}</div>`;
  document.querySelectorAll("[data-del-warning]").forEach((btn) => {
    btn.onclick = async () => {
      await api(`/guilds/${state.guildId}/warnings/${btn.dataset.delWarning}`, { method: "DELETE" });
      toast("Warning removed");
      renderMod();
    };
  });
}

/* ---------- settings ---------- */

const SETTINGS_SECTIONS = [
  { id: "app", label: "App & API keys", desc: "Bot token, credentials" },
  { id: "voice", label: "Voice", desc: "Wake words & TTS" },
  { id: "welcome", label: "Welcome", desc: "Greetings & autorole" },
  { id: "automod", label: "Automod", desc: "Banned words & filters" },
  { id: "ai", label: "AI chat", desc: "Model & prompts" },
  { id: "cursor", label: "Cursor", desc: "Cloud coding agents" },
  { id: "tasks", label: "Tasks", desc: "External task API" },
  { id: "logging", label: "Logging", desc: "Mod log channel" },
  { id: "presence", label: "Presence", desc: "Bot status & activity" },
];

function settingsNavHtml() {
  return SETTINGS_SECTIONS.map((s) => `
    <button type="button" class="settings-nav-item${state.settingsSection === s.id ? " active" : ""}"
      data-settings-section="${s.id}">
      <span class="settings-nav-label">${esc(s.label)}</span>
      <span class="settings-nav-desc">${esc(s.desc)}</span>
    </button>`).join("");
}

function settingsPanelApp(appCfg) {
  return `
    <h2 class="settings-panel-title">App &amp; API keys</h2>
    <p class="muted settings-panel-lead">Bot credentials and API keys. Leave secret fields blank to keep the current value. Token: ${esc(appCfg.discord_token || "not set")}</p>
    <div class="card">
      <label class="field"><span class="lbl">Discord bot token ${appCfg.discord_token_set ? "(set)" : ""}</span>
        <input type="password" id="a-discord_token" placeholder="Leave blank to keep current" autocomplete="off"></label>
      <label class="field"><span class="lbl">Owner Discord ID</span>
        <input id="a-owner_id" value="${esc(appCfg.owner_id || "")}" inputmode="numeric"></label>
      <label class="field"><span class="lbl">OpenRouter API key ${appCfg.openrouter_api_key_set ? "(set)" : ""}</span>
        <input type="password" id="a-openrouter_api_key" placeholder="Leave blank to keep current" autocomplete="off"></label>
      <label class="field"><span class="lbl">OpenRouter default model</span>
        <input id="a-openrouter_model" value="${esc(appCfg.openrouter_model || "")}"></label>
      <label class="field"><span class="lbl">GitHub token ${appCfg.github_token_set ? "(set)" : ""}</span>
        <input type="password" id="a-github_token" placeholder="Optional" autocomplete="off"></label>
      <label class="field"><span class="lbl">Transcription API key ${appCfg.transcription_api_key_set ? "(set)" : ""}</span>
        <input type="password" id="a-transcription_api_key" placeholder="Groq or OpenAI — voice monitoring" autocomplete="off"></label>
      <label class="field"><span class="lbl">Dashboard password ${appCfg.dashboard_password_set ? "(set)" : ""}</span>
        <input type="password" id="a-dashboard_password" placeholder="Leave blank to keep current" autocomplete="new-password"></label>
      <button class="btn primary full" id="save-app-config">Save</button>
    </div>`;
}

function edgeVoiceLabel(id) {
  const match = EDGE_TTS_VOICES.find((v) => v.id === id);
  return match ? match.label : id;
}

function settingsPanelVoice(settings, appCfg) {
  const edgeVoice = appCfg.edge_tts_voice || "en-US-GuyNeural";
  const edgeOptions = EDGE_TTS_VOICES.map((v) =>
    `<option value="${v.id}" ${edgeVoice === v.id ? "selected" : ""}>${esc(v.label)}</option>`).join("");
  const fishModel = appCfg.fish_tts_model || "s1";
  const wakeWords = (settings.voice_wake_words || []).join(", ");
  return `
    <h2 class="settings-panel-title">Voice</h2>
    <p class="muted settings-panel-lead">Wake words, speech-to-text, and spoken replies in voice channels.</p>
    <div class="card">
      <h3 style="font-size:15px;margin-bottom:8px">Wake words</h3>
      <p class="muted" style="margin-bottom:12px">Sara joins the conversation when she hears one of these phrases in voice. Changes apply immediately — no restart needed.</p>
      <label class="field"><span class="lbl">Phrases (comma-separated)</span>
        <input id="v-wake_words" value="${esc(wakeWords)}"
          placeholder="hey sara">
        <span class="muted">Example: <code>hey sara</code> or <code>hey sara, computer</code>. Also editable in Discord with <code>/wakewords</code>.</span></label>
      <button class="btn primary full" id="save-wake-words">Save wake words</button>
    </div>
    <div class="card" style="margin-top:12px">
      <h3 style="font-size:15px;margin-bottom:8px">Spoken voice</h3>
        <select id="v-edge_tts_voice">${edgeOptions}</select>
        <span class="muted">Active: <strong id="v-edge_tts_active">${esc(edgeVoiceLabel(edgeVoice))}</strong> (<code id="v-edge_tts_code">${esc(edgeVoice)}</code>). Used when Fish Audio is not configured.</span></label>
      <label class="field"><span class="lbl">Fish Audio API key ${appCfg.fish_api_key_set ? "(set)" : ""}</span>
        <input type="password" id="v-fish_api_key" placeholder="Leave blank to keep current" autocomplete="off">
        <span class="muted">Optional — from <a href="https://fish.audio" target="_blank" rel="noopener">fish.audio</a>. Overrides the free voice.</span></label>
      <label class="field"><span class="lbl">Fish TTS model</span>
        <select id="v-fish_tts_model">
          <option value="s1" ${fishModel === "s1" ? "selected" : ""}>s1 (emotion tags)</option>
          <option value="s2-pro" ${fishModel === "s2-pro" ? "selected" : ""}>s2-pro</option>
        </select></label>
      <label class="field"><span class="lbl">Fish voice ID</span>
        <input id="v-fish_voice_id" value="${esc(appCfg.fish_voice_id || "")}"
          placeholder="reference_id from fish.audio"></label>
      <button class="btn primary full" id="save-voice-settings">Save voice settings</button>
    </div>`;
}

function settingsPanelWelcome(settings, channelOptions, roleOptions) {
  return `
    <h2 class="settings-panel-title">Welcome &amp; autorole</h2>
    <p class="muted settings-panel-lead">Messages sent when members join or leave, and optional autorole.</p>
    <div class="card">
      <label class="field"><span class="lbl">Welcome channel</span>
        <select id="s-welcome_channel">${channelOptions(settings.welcome_channel)}</select></label>
      <label class="field"><span class="lbl">Welcome message ({user}, {server}, {membercount})</span>
        <textarea id="s-welcome_message">${esc(settings.welcome_message)}</textarea></label>
      <label class="field"><span class="lbl">Goodbye message</span>
        <textarea id="s-goodbye_message">${esc(settings.goodbye_message)}</textarea></label>
      <label class="field"><span class="lbl">Autorole (given to new members)</span>
        <select id="s-autorole">${roleOptions(settings.autorole)}</select></label>
      <button class="btn primary full" id="save-welcome-settings">Save</button>
    </div>`;
}

function settingsPanelAutomod(settings) {
  return `
    <h2 class="settings-panel-title">Auto-moderation</h2>
    <p class="muted settings-panel-lead">Automatic filters for text and voice transcripts.</p>
    <div class="card">
      <label class="toggle"><input type="checkbox" id="s-automod_enabled"
        ${settings.automod_enabled ? "checked" : ""}> Enable automod</label>
      <label class="toggle"><input type="checkbox" id="s-block_invites"
        ${settings.block_invites ? "checked" : ""}> Block Discord invite links</label>
      <label class="field"><span class="lbl">Banned words (comma-separated)</span>
        <input id="s-banned_words" value="${esc((settings.banned_words || []).join(", "))}"></label>
      <label class="field"><span class="lbl">Max mentions per message (0 = off)</span>
        <input id="s-max_mentions" type="number" min="0" value="${settings.max_mentions || 0}"></label>
      <button class="btn primary full" id="save-automod-settings">Save</button>
    </div>`;
}

function settingsPanelAI(settings, textChannels, memoryStatus) {
  const memChannels = memoryStatus?.channels || [];
  const ltmEnabled = settings.ai_long_term_memory_enabled !== false;
  const memSummary = memChannels.length
    ? `${memChannels.length} channel(s) · ${memoryStatus.total_messages} recent message(s) · ${memoryStatus.total_summaries || 0} summary chunk(s)${ltmEnabled ? "" : " · long-term off"}`
    : ltmEnabled
      ? "No conversation memory stored right now"
      : "Long-term memory is off — only recent messages are kept";
  return `
    <h2 class="settings-panel-title">AI chat</h2>
    <p class="muted settings-panel-lead">OpenRouter model and behavior for @mentions and AI channels.</p>
    <div class="card">
      <label class="toggle"><input type="checkbox" id="s-ai_enabled"
        ${settings.ai_enabled ? "checked" : ""}> Enable AI replies</label>
      <label class="toggle"><input type="checkbox" id="s-ai_long_term_memory_enabled"
        ${ltmEnabled ? "checked" : ""}> Enable long-term memory</label>
      <span class="muted" style="display:block;margin:-4px 0 12px 28px">Summarize older chat turns so the bot remembers beyond recent messages. Applies to AI chat and voice wake-word replies.</span>
      <label class="field"><span class="lbl">Model</span>
        <input id="s-ai_model" value="${esc(settings.ai_model)}" placeholder="openai/gpt-4o-mini"></label>
      <label class="field"><span class="lbl">Recent memory (messages per channel)</span>
        <input id="s-ai_memory_size" type="number" min="5" max="100" value="${settings.ai_memory_size || 20}">
        <span class="muted">Full recent turns kept verbatim (5–100). Oldest turns are summarized when long-term memory is on, or dropped when it is off.</span></label>
      <label class="field" id="s-ai_summary_slots-wrap"${ltmEnabled ? "" : ' style="opacity:.55"'}><span class="lbl">Summary memory (chunks per channel)</span>
        <input id="s-ai_summary_slots" type="number" min="0" max="20" value="${settings.ai_summary_slots ?? 5}"${ltmEnabled ? "" : " disabled"}>
        <span class="muted">Weighted summaries of older conversation (0–20). Higher weight = more recent summary.</span></label>
      <label class="field"><span class="lbl">System prompt</span>
        <textarea id="s-ai_system_prompt">${esc(settings.ai_system_prompt)}</textarea></label>
      <label class="field"><span class="lbl">Always-on AI channels</span>
        <select id="s-ai_channels" multiple size="5">${textChannels.map((c) =>
          `<option value="${c.id}" ${(settings.ai_channels || []).map(String).includes(c.id) ? "selected" : ""}>#${esc(c.name)}</option>`).join("")}</select>
        <span class="muted">The bot always replies when @mentioned, in any channel.</span></label>
      <button class="btn primary full" id="save-ai-settings">Save</button>
    </div>
    <div class="card" style="margin-top:12px">
      <h3 style="font-size:15px;margin-bottom:8px">Conversation memory</h3>
      <p class="muted" style="margin-bottom:12px">${esc(memSummary)}</p>
      ${memChannels.length ? `<div class="list" style="margin-bottom:12px">${memChannels.map((c) => `
        <div class="row" style="cursor:default">
          <div class="grow">
            <div class="title">#${esc(c.name)}</div>
            <div class="sub">${c.messages} recent · ${c.summaries || 0} summarized</div>
          </div>
        </div>`).join("")}</div>` : ""}
      <button class="btn danger full" id="reset-ai-memory">Reset all AI memory</button>
      <span class="muted" style="display:block;margin-top:8px">Clears recent messages and summary memory in every channel on this server.</span>
    </div>`;
}

function settingsPanelCursor(settings, appCfg, cursorModels) {
  const models = cursorModels || [];
  const currentModel = settings.cursor_default_model || "";
  const modelOptions = [
    `<option value="">Server / account default</option>`,
    ...models.map((m) =>
      `<option value="${esc(m.id)}" ${currentModel === m.id ? "selected" : ""}>${esc(m.displayName || m.id)}</option>`),
  ].join("");
  const mode = settings.cursor_mode || "agent";
  const branch = settings.cursor_default_branch || "main";
  return `
    <h2 class="settings-panel-title">Cursor cloud agents</h2>
    <p class="muted settings-panel-lead">Owner-only: Sara can launch Cursor cloud agents on GitHub repos from chat. Cloud-only for v1.</p>
    <div class="card">
      <h3 style="font-size:15px;margin-bottom:8px">API key</h3>
      <p class="muted" style="margin-bottom:12px">From <a href="https://cursor.com/dashboard/api" target="_blank" rel="noopener">Cursor Dashboard → API Keys</a>.</p>
      <label class="field"><span class="lbl">Cursor API key ${appCfg.cursor_api_key_set ? "(set)" : ""}</span>
        <input type="password" id="c-cursor_api_key" placeholder="Leave blank to keep current" autocomplete="off"></label>
      <div class="inline-form" style="margin-top:8px">
        <button class="btn" type="button" id="test-cursor-api">Test connection</button>
        <span id="cursor-api-test-result" class="muted"></span>
      </div>
      <button class="btn primary full" id="save-cursor-api" style="margin-top:12px">Save API key</button>
    </div>
    <div class="card" style="margin-top:12px">
      <h3 style="font-size:15px;margin-bottom:8px">This server</h3>
      <label class="toggle"><input type="checkbox" id="s-cursor_enabled"
        ${settings.cursor_enabled ? "checked" : ""}> Enable Cursor tools (owner only)</label>
      <label class="field"><span class="lbl">Default GitHub repo URL</span>
        <input id="s-cursor_default_repo" value="${esc(settings.cursor_default_repo || "")}"
          placeholder="https://github.com/org/repo"></label>
      <label class="field"><span class="lbl">Default branch</span>
        <select id="s-cursor_default_branch">
          <option value="${esc(branch)}" selected>${esc(branch)}</option>
        </select>
        <span class="muted" id="cursor-branch-hint">Loads from GitHub when repo URL is set.</span></label>
      <label class="field"><span class="lbl">Default model</span>
        <select id="s-cursor_default_model">${modelOptions}</select>
        <span class="muted">Or type a model ID: <input id="s-cursor_default_model_custom" value="${esc(currentModel && !models.some((m) => m.id === currentModel) ? currentModel : "")}" placeholder="optional override"></span></label>
      <label class="field"><span class="lbl">Mode</span>
        <select id="s-cursor_mode">
          <option value="agent" ${mode === "agent" ? "selected" : ""}>Agent (code directly)</option>
          <option value="plan" ${mode === "plan" ? "selected" : ""}>Plan (plan first)</option>
        </select></label>
      <label class="toggle"><input type="checkbox" id="s-cursor_auto_create_pr"
        ${settings.cursor_auto_create_pr ? "checked" : ""}> Auto-create pull request when done</label>
      <p class="muted">@mention Sara as the bot owner to launch agents. Tools: <code>launch_cursor_agent</code>, <code>cursor_agent_status</code>.</p>
      <button class="btn primary full" id="save-cursor-settings">Save server settings</button>
    </div>`;
}

function settingsPanelTasks(settings, appCfg) {
  const apiUrl = appCfg.task_api_url || "";
  return `
    <h2 class="settings-panel-title">Task management</h2>
    <p class="muted settings-panel-lead">Connect Sara to an external task API. She can create and look up tasks from chat and voice when enabled.</p>
    <div class="card">
      <h3 style="font-size:15px;margin-bottom:8px">API connection</h3>
      <p class="muted" style="margin-bottom:12px">Your API should expose <code>POST /tasks</code>, <code>GET /tasks</code>, and <code>GET /tasks/:id</code> with JSON bodies. Bearer auth is optional.</p>
      <label class="field"><span class="lbl">API base URL</span>
        <input id="t-task_api_url" value="${esc(apiUrl)}" placeholder="https://tasks.example.com/api/v1"></label>
      <label class="field"><span class="lbl">API key ${appCfg.task_api_key_set ? "(set)" : ""}</span>
        <input type="password" id="t-task_api_key" placeholder="Leave blank to keep current" autocomplete="off"></label>
      <div class="inline-form" style="margin-top:8px">
        <button class="btn" type="button" id="test-task-api">Test connection</button>
        <span id="task-api-test-result" class="muted"></span>
      </div>
      <button class="btn primary full" id="save-task-api" style="margin-top:12px">Save API settings</button>
    </div>
    <div class="card" style="margin-top:12px">
      <h3 style="font-size:15px;margin-bottom:8px">This server</h3>
      <label class="toggle"><input type="checkbox" id="s-tasks_enabled"
        ${settings.tasks_enabled ? "checked" : ""}> Enable task tools for Sara</label>
      <label class="field"><span class="lbl">Default project / list ID</span>
        <input id="s-tasks_default_project" value="${esc(settings.tasks_default_project || "")}"
          placeholder="Optional — sent as project_id on create"></label>
      <p class="muted">When enabled, Sara uses <code>create_task</code>, <code>list_tasks</code>, and <code>get_task</code> in AI chat and voice wake responses.</p>
      <button class="btn primary full" id="save-task-settings">Save server settings</button>
    </div>`;
}

function settingsPanelLogging(settings, channelOptions) {
  return `
    <h2 class="settings-panel-title">Logging</h2>
    <p class="muted settings-panel-lead">Where moderation actions are posted.</p>
    <div class="card">
      <label class="field"><span class="lbl">Mod log channel</span>
        <select id="s-log_channel">${channelOptions(settings.log_channel)}</select></label>
      <button class="btn primary full" id="save-logging-settings">Save</button>
    </div>`;
}

function settingsPanelPresence(me) {
  return `
    <h2 class="settings-panel-title">Bot presence</h2>
    <p class="muted settings-panel-lead">Global status and activity shown in Discord (all servers).</p>
    <div class="card">
      <label class="field"><span class="lbl">Status</span>
        <select id="p-status">${["online", "idle", "dnd", "invisible"].map((s) =>
          `<option ${me.presence.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="field"><span class="lbl">Activity</span>
        <select id="p-type">${["playing", "watching", "listening", "competing"].map((s) =>
          `<option ${me.presence.activity_type === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="field"><span class="lbl">Activity text (empty = none)</span>
        <input id="p-text" value="${esc(me.presence.text)}"></label>
      <button class="btn primary full" id="save-presence">Update presence</button>
    </div>`;
}

function bindSettingsHandlers(section) {
  if (section === "app") {
    $("#save-app-config").onclick = async () => {
      await api("/app-config", {
        method: "PUT",
        body: {
          owner_id: $("#a-owner_id").value.trim(),
          openrouter_model: $("#a-openrouter_model").value.trim(),
          discord_token: $("#a-discord_token").value,
          openrouter_api_key: $("#a-openrouter_api_key").value,
          github_token: $("#a-github_token").value,
          transcription_api_key: $("#a-transcription_api_key").value,
          dashboard_password: $("#a-dashboard_password").value,
        },
      });
      toast("App configuration saved");
    };
  }
  if (section === "voice") {
    const voiceSelect = $("#v-edge_tts_voice");
    voiceSelect.addEventListener("change", () => {
      const id = voiceSelect.value;
      $("#v-edge_tts_active").textContent = edgeVoiceLabel(id);
      $("#v-edge_tts_code").textContent = id;
    });
    $("#save-wake-words").onclick = async () => {
      const wakeWords = $("#v-wake_words").value.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
      await api(`/guilds/${state.guildId}/settings`, {
        method: "PUT",
        body: { voice_wake_words: wakeWords },
      });
      toast(wakeWords.length ? `Wake words saved: ${wakeWords.join(", ")}` : "Wake words cleared");
    };
    $("#save-voice-settings").onclick = async () => {
      const voiceId = $("#v-edge_tts_voice").value;
      const appBody = {
        edge_tts_voice: voiceId,
        fish_tts_model: $("#v-fish_tts_model").value,
        fish_voice_id: $("#v-fish_voice_id").value.trim(),
      };
      const fishKey = $("#v-fish_api_key").value;
      if (fishKey) appBody.fish_api_key = fishKey;
      const saved = await api("/app-config", { method: "PUT", body: appBody });
      toast(`Voice saved: ${edgeVoiceLabel(saved.edge_tts_voice || voiceId)}`);
    };
  }
  if (section === "welcome") {
    $("#save-welcome-settings").onclick = async () => {
      await api(`/guilds/${state.guildId}/settings`, {
        method: "PUT",
        body: {
          welcome_channel: $("#s-welcome_channel").value || null,
          welcome_message: $("#s-welcome_message").value,
          goodbye_message: $("#s-goodbye_message").value,
          autorole: $("#s-autorole").value || null,
        },
      });
      toast("Welcome settings saved");
    };
  }
  if (section === "automod") {
    $("#save-automod-settings").onclick = async () => {
      await api(`/guilds/${state.guildId}/settings`, {
        method: "PUT",
        body: {
          automod_enabled: $("#s-automod_enabled").checked,
          block_invites: $("#s-block_invites").checked,
          banned_words: $("#s-banned_words").value.split(",").map((w) => w.trim()).filter(Boolean),
          max_mentions: parseInt($("#s-max_mentions").value, 10) || 0,
        },
      });
      toast("Automod settings saved");
    };
  }
  if (section === "ai") {
    const ltmToggle = $("#s-ai_long_term_memory_enabled");
    const slotsWrap = $("#s-ai_summary_slots-wrap");
    const slotsInput = $("#s-ai_summary_slots");
    const syncLongTermFields = () => {
      const on = ltmToggle.checked;
      slotsInput.disabled = !on;
      slotsWrap.style.opacity = on ? "" : ".55";
    };
    ltmToggle.addEventListener("change", syncLongTermFields);
    syncLongTermFields();

    $("#save-ai-settings").onclick = async () => {
      await api(`/guilds/${state.guildId}/settings`, {
        method: "PUT",
        body: {
          ai_enabled: $("#s-ai_enabled").checked,
          ai_long_term_memory_enabled: ltmToggle.checked,
          ai_model: $("#s-ai_model").value.trim(),
          ai_memory_size: parseInt($("#s-ai_memory_size").value, 10) || 20,
          ai_summary_slots: parseInt($("#s-ai_summary_slots").value, 10),
          ai_system_prompt: $("#s-ai_system_prompt").value,
          ai_channels: [...$("#s-ai_channels").selectedOptions].map((o) => o.value),
        },
      });
      toast("AI settings saved");
    };
    $("#reset-ai-memory").onclick = () => {
      confirmAction("Clear all remembered AI conversations on this server?", async () => {
        const result = await api(`/guilds/${state.guildId}/ai/reset-memory`, { method: "POST" });
        toast(`Memory cleared (${result.channels_cleared} channel(s))`);
        renderSettings();
      });
    };
  }
  if (section === "cursor") {
    const refreshCursorBranches = async () => {
      const repo = $("#s-cursor_default_repo")?.value.trim();
      const select = $("#s-cursor_default_branch");
      const hint = $("#cursor-branch-hint");
      if (!select) return;
      if (!repo) {
        if (hint) hint.textContent = "Enter a repo URL to load branches.";
        return;
      }
      const current = select.value || "main";
      select.innerHTML = `<option>Loading branches…</option>`;
      select.disabled = true;
      if (hint) hint.textContent = "Loading from GitHub…";
      try {
        const data = await api(`/github/branches?repo=${encodeURIComponent(repo)}`);
        const branches = data.branches || [];
        const selected = branches.includes(current) ? current : (data.default || branches[0] || "main");
        select.innerHTML = branches.map((b) =>
          `<option value="${esc(b)}" ${b === selected ? "selected" : ""}>${esc(b)}${b === data.default ? " (default)" : ""}</option>`
        ).join("");
        if (hint) hint.textContent = `${branches.length} branch(es) from GitHub`;
      } catch (e) {
        select.innerHTML = `<option value="${esc(current)}" selected>${esc(current)}</option>`;
        if (hint) hint.textContent = `Could not load branches: ${e.message}`;
      }
      select.disabled = false;
    };
    $("#s-cursor_default_repo")?.addEventListener("change", refreshCursorBranches);
    refreshCursorBranches();
    $("#save-cursor-api").onclick = async () => {
      const body = {};
      const key = $("#c-cursor_api_key").value;
      if (key) body.cursor_api_key = key;
      await api("/app-config", { method: "PUT", body });
      toast("Cursor API key saved");
    };
    $("#test-cursor-api").onclick = async () => {
      const el = $("#cursor-api-test-result");
      el.textContent = "Testing…";
      try {
        const result = await api("/cursor/test", { method: "POST" });
        el.textContent = result.ok
          ? `OK (${result.model_count ?? 0} models)`
          : `Failed: ${result.error || "unknown error"}`;
        el.className = result.ok ? "badge" : "muted";
      } catch (e) {
        el.textContent = `Failed: ${e.message}`;
        el.className = "muted";
      }
    };
    $("#save-cursor-settings").onclick = async () => {
      const customModel = $("#s-cursor_default_model_custom").value.trim();
      const selectModel = $("#s-cursor_default_model").value.trim();
      await api(`/guilds/${state.guildId}/settings`, {
        method: "PUT",
        body: {
          cursor_enabled: $("#s-cursor_enabled").checked,
          cursor_default_repo: $("#s-cursor_default_repo").value.trim() || null,
          cursor_default_branch: $("#s-cursor_default_branch").value.trim() || "main",
          cursor_default_model: customModel || selectModel || "",
          cursor_mode: $("#s-cursor_mode").value,
          cursor_auto_create_pr: $("#s-cursor_auto_create_pr").checked,
        },
      });
      toast("Cursor settings saved");
    };
  }
  if (section === "tasks") {
    $("#save-task-api").onclick = async () => {
      const body = { task_api_url: $("#t-task_api_url").value.trim() };
      const key = $("#t-task_api_key").value;
      if (key) body.task_api_key = key;
      await api("/app-config", { method: "PUT", body });
      toast("Task API settings saved");
    };
    $("#test-task-api").onclick = async () => {
      const el = $("#task-api-test-result");
      el.textContent = "Testing…";
      try {
        const result = await api("/tasks/test", { method: "POST" });
        el.textContent = result.ok
          ? `OK (HTTP ${result.status || 200})`
          : `Failed: ${result.error || "unknown error"}`;
        el.className = result.ok ? "badge" : "muted";
      } catch (e) {
        el.textContent = `Failed: ${e.message}`;
        el.className = "muted";
      }
    };
    $("#save-task-settings").onclick = async () => {
      await api(`/guilds/${state.guildId}/settings`, {
        method: "PUT",
        body: {
          tasks_enabled: $("#s-tasks_enabled").checked,
          tasks_default_project: $("#s-tasks_default_project").value.trim() || null,
        },
      });
      toast("Task settings saved");
    };
  }
  if (section === "logging") {
    $("#save-logging-settings").onclick = async () => {
      await api(`/guilds/${state.guildId}/settings`, {
        method: "PUT",
        body: { log_channel: $("#s-log_channel").value || null },
      });
      toast("Logging settings saved");
    };
  }
  if (section === "presence") {
    $("#save-presence").onclick = async () => {
      await api("/presence", {
        method: "POST",
        body: {
          status: $("#p-status").value,
          activity_type: $("#p-type").value,
          text: $("#p-text").value.trim(),
        },
      });
      toast("Presence updated");
    };
  }
}

async function renderSettings() {
  const [settings, channels, roles, me, appCfg, memoryStatus, cursorModels] = await Promise.all([
    api(`/guilds/${state.guildId}/settings`),
    api(`/guilds/${state.guildId}/channels`),
    api(`/guilds/${state.guildId}/roles`),
    api("/me"),
    api("/app-config"),
    api(`/guilds/${state.guildId}/ai/memory`).catch(() => ({ channels: [], total_messages: 0 })),
    api("/cursor/models").catch(() => ({ models: [] })),
  ]);

  const section = state.settingsSection;
  if (section === "cursor" && typeof needsCursorSetup === "function" && needsCursorSetup(appCfg)) {
    showCursorSetup(() => renderSettings());
    return;
  }

  const textChannels = channels.filter((c) => c.type === "text");
  const channelOptions = (selected) =>
    `<option value="">— none —</option>` + textChannels.map((c) =>
      `<option value="${c.id}" ${String(selected) === c.id ? "selected" : ""}>#${esc(c.name)}</option>`).join("");
  const roleOptions = (selected) =>
    `<option value="">— none —</option>` + roles.filter((r) => !r.managed).map((r) =>
      `<option value="${r.id}" ${String(selected) === r.id ? "selected" : ""}>${esc(r.name)}</option>`).join("");

  const panels = {
    app: () => settingsPanelApp(appCfg),
    voice: () => settingsPanelVoice(settings, appCfg),
    welcome: () => settingsPanelWelcome(settings, channelOptions, roleOptions),
    automod: () => settingsPanelAutomod(settings),
    ai: () => settingsPanelAI(settings, textChannels, memoryStatus),
    cursor: () => settingsPanelCursor(settings, appCfg, cursorModels.models),
    tasks: () => settingsPanelTasks(settings, appCfg),
    logging: () => settingsPanelLogging(settings, channelOptions),
    presence: () => settingsPanelPresence(me),
  };
  const panelHtml = (panels[section] || panels.app)();

  content().innerHTML = `
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">${settingsNavHtml()}</nav>
      <div class="settings-panel">${panelHtml}</div>
    </div>`;

  document.querySelectorAll("[data-settings-section]").forEach((btn) => {
    btn.onclick = () => {
      state.settingsSection = btn.dataset.settingsSection;
      renderSettings();
    };
  });
  bindSettingsHandlers(section);
}

/* expose for inline handlers */
window.closeModal = closeModal;

boot();
