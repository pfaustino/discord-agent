/* First-run setup wizard */
"use strict";

const qs = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, isError = false) {
  const el = qs("#toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("error-toast", isError);
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 3000);
}

let setupNavBound = false;

const setupState = {
  step: 0,
  discord_token: "",
  botInfo: null,
  owner_id: "",
  openrouter_api_key: "",
  openrouter_model: "openai/gpt-4o-mini",
  github_token: "",
  transcription_api_key: "",
  transcription_api_url: "https://api.openai.com/v1",
  transcription_model: "whisper-1",
  dashboard_password: "",
  secret_key: "",
  fish_api_key: "",
  fish_tts_model: "s1",
  fish_voice_id: "",
  envLocked: {},
};

const SETUP_STEPS = [
  { id: "welcome", title: "Overview" },
  { id: "discord", title: "Discord Bot Token" },
  { id: "owner", title: "Your Discord ID" },
  { id: "ai", title: "AI (Optional)" },
  { id: "security", title: "Dashboard Password" },
  { id: "extras", title: "Extras (Optional)" },
  { id: "finish", title: "Launch" },
];

async function setupApi(path, opts = {}) {
  const res = await fetch("/api/setup" + path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let detail = "Request failed";
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

function bindSetupNav() {
  if (setupNavBound) return;
  qs("#setup-back")?.addEventListener("click", setupNavBack);
  qs("#setup-next")?.addEventListener("click", setupNavNext);
  setupNavBound = true;
}

function showSetup() {
  qs("#login-screen").classList.add("hidden");
  qs("#app").classList.add("hidden");
  qs("#setup-screen").classList.remove("hidden");
  bindSetupNav();
  renderSetupStep();
}

function hideSetup() {
  qs("#setup-screen").classList.add("hidden");
}

function setupProgress() {
  return SETUP_STEPS.map((s, i) =>
    `<div class="setup-dot ${i === setupState.step ? "active" : ""} ${i < setupState.step ? "done" : ""}"></div>`
  ).join("");
}

function renderSetupStep() {
  const step = SETUP_STEPS[setupState.step];
  qs("#setup-progress").innerHTML = setupProgress();
  qs("#setup-step-label").textContent = `Step ${setupState.step + 1} of ${SETUP_STEPS.length} — ${step.title}`;

  const renderers = {
    welcome: renderWelcome,
    discord: renderDiscord,
    owner: renderOwner,
    ai: renderAI,
    security: renderSecurity,
    extras: renderExtras,
    finish: renderFinish,
  };
  qs("#setup-content").innerHTML = renderers[step.id]();
  bindSetupHandlers(step.id);

  const nextBtn = qs("#setup-next");
  if (nextBtn) {
    nextBtn.textContent = setupState.step === SETUP_STEPS.length - 1 ? "Launch bot" : "Continue";
  }
  const backBtn = qs("#setup-back");
  if (backBtn) backBtn.classList.toggle("hidden", setupState.step === 0);
}

function renderWelcome() {
  return `
    <div class="setup-hero">
      <div class="setup-icon">🤖</div>
      <h1>Welcome to Discord Agent</h1>
      <p class="muted">This wizard walks you through everything. Takes about 10 minutes. You can skip optional steps and fill them in later.</p>
    </div>
    <div class="setup-guide">
      <div class="setup-guide-step">
        <h3><span class="num">1</span> Discord Bot <span class="muted">— required</span></h3>
        <p>Connect your bot from the Developer Portal. You'll copy a <strong>bot token</strong>.</p>
      </div>
      <div class="setup-guide-step">
        <h3><span class="num">2</span> Your Account <span class="muted">— required</span></h3>
        <p>Tell the bot who <strong>you</strong> are so only you can run admin commands.</p>
      </div>
      <div class="setup-guide-step">
        <h3><span class="num">3</span> AI <span class="muted">— optional</span></h3>
        <p>Add an OpenRouter key for <code>/ask</code>, @mentions, and smart replies.</p>
      </div>
      <div class="setup-guide-step">
        <h3><span class="num">4</span> Security <span class="muted">— required</span></h3>
        <p>Pick a password for this dashboard (the page you're on right now).</p>
      </div>
      <div class="setup-guide-step">
        <h3><span class="num">5</span> Extras <span class="muted">— optional</span></h3>
        <p>Voice monitoring, GitHub repo lookup, better TTS — skip if unsure.</p>
      </div>
      <div class="setup-guide-step">
        <h3><span class="num">6</span> Launch</h3>
        <p>Review everything and start the bot.</p>
      </div>
    </div>
    <p class="setup-note">Nothing leaves your machine unless you deploy to the cloud. Settings are saved in a local database.</p>`;
}

function renderDiscord() {
  const locked = setupState.envLocked.discord_token;
  return `
    <div class="card">
      <h2>Get your bot token</h2>
      <p class="muted">You're looking for one secret string — the <strong>bot token</strong>. Based on the current Discord Developer Portal, here's exactly what to click.</p>

      <div class="setup-portal-cta">
        <a class="btn primary" href="https://discord.com/developers/applications" target="_blank" rel="noopener">Open Developer Portal ↗</a>
      </div>

      <div class="setup-guide">
        <div class="setup-guide-step">
          <h3><span class="num">1</span> Open your application</h3>
          <ol>
            <li>Go to the <strong>Developer Portal</strong> (button above).</li>
            <li>Click your app in the list — e.g. <strong>Listening Agent</strong>.</li>
            <li>If you don't have an app yet: click <strong>Create</strong> (top right) → name it → <strong>Create</strong>.</li>
          </ol>
        </div>

        <div class="setup-guide-step">
          <h3><span class="num">2</span> Go to the Bot page</h3>
          <ol>
            <li>In the <strong>left sidebar</strong>, under <strong>Settings</strong>, click <strong>Bot</strong>.</li>
            <li>You should now see sections for <strong>Icon</strong>, <strong>Banner</strong>, <strong>Username</strong>, and <strong>Token</strong>.</li>
          </ol>
          <div class="setup-callout info">
            <strong>Already on this page?</strong> If you see your bot's username (e.g. <code>Listening Agent #0651</code>) and a blue <strong>Reset Token</strong> button, you're in the right place — skip to step 4.
          </div>
          <div class="setup-callout warn">
            <strong>Only if you're brand new:</strong> if the page says <strong>Add Bot</strong> instead of showing a username, click that once → confirm → then continue.
          </div>
        </div>

        <div class="setup-guide-step">
          <h3><span class="num">3</span> Enable intents (scroll down on the Bot page)</h3>
          <p>Keep scrolling past <strong>Authorization Flow</strong> until you reach <strong>Privileged Gateway Intents</strong>. Turn <strong>ON</strong>:</p>
          <ul>
            <li><strong>Server Members Intent</strong></li>
            <li><strong>Message Content Intent</strong></li>
          </ul>
          <p class="muted" style="margin-top:6px">Click <strong>Save Changes</strong> if Discord shows that button.</p>
        </div>

        <div class="setup-guide-step">
          <h3><span class="num">4</span> Copy your token — this is the important part</h3>
          <p>Scroll back up to the <strong>Token</strong> section (above Authorization Flow).</p>
          <ol>
            <li>You'll see: <em>"For security purposes, tokens can only be viewed once…"</em></li>
            <li>Click the blue <strong>Reset Token</strong> button. <span class="muted">(Discord hides old tokens — reset is normal even if you made the bot before.)</span></li>
            <li>Confirm in the popup. Discord may ask for your password or 2FA.</li>
            <li>Discord shows the token <strong>once</strong>. Click <strong>Copy</strong> immediately — you can't view it again later.</li>
          </ol>
          <div class="setup-callout warn"><strong>Never share this token.</strong> Anyone with it controls your bot. Lost it? Click <strong>Reset Token</strong> again to get a new one.</div>
        </div>

        <div class="setup-guide-step">
          <h3><span class="num">5</span> Invite the bot to your server</h3>
          <ol>
            <li>In the left sidebar, click <strong>OAuth2</strong> (under Settings, same area as Bot).</li>
            <li>Open the <strong>URL Generator</strong> tab.</li>
            <li>Under <strong>Scopes</strong>, check <strong>bot</strong> and <strong>applications.commands</strong>.</li>
            <li>Under <strong>Bot Permissions</strong>, check <strong>Administrator</strong> <span class="muted">(easiest)</span>.</li>
            <li>Copy the URL at the bottom → open in a new tab → pick your server → <strong>Authorize</strong>.</li>
          </ol>
          <div class="setup-callout info"><strong>Public Bot</strong> can stay on (that's fine). You don't need <strong>Requires OAuth2 Code Grant</strong>.</div>
        </div>
      </div>

      ${locked ? `<p class="setup-env-badge">Token is set via environment variable — no paste needed.</p>` : `
      <div class="setup-paste-zone">
        <h3>Paste your token here</h3>
        <p class="muted">After clicking <strong>Reset Token</strong> → <strong>Copy</strong>, paste it below. It's a long string (~70 characters).</p>
        <label class="field"><span class="lbl">Bot token</span>
          <input type="password" id="setup-discord-token" placeholder="Paste here right after copying from Discord" value="${esc(setupState.discord_token)}" autocomplete="off"></label>
        <div id="setup-bot-preview" class="setup-bot-preview hidden"></div>
        <p id="setup-discord-error" class="error hidden"></p>
        <button type="button" class="btn primary full" id="setup-test-discord">Test connection</button>
        <p class="muted" style="margin-top:10px;text-align:center">Click <strong>Test connection</strong> — you should see your bot name (e.g. Listening Agent) before continuing.</p>
      </div>`}
    </div>`;
}

function renderOwner() {
  const locked = setupState.envLocked.owner_id;
  return `
    <div class="card">
      <h2>Who can control this bot?</h2>
      <p class="muted">The bot needs <strong>your Discord user ID</strong> so only you can run admin commands like <code>/kick</code>, <code>/ban</code>, role changes, and channel management. Everyone else can still use AI chat and info commands.</p>

      <div class="setup-guide">
        <div class="setup-guide-step">
          <h3><span class="num">1</span> Turn on Developer Mode (one-time)</h3>
          <p><strong>On desktop (Discord app or browser):</strong></p>
          <ol>
            <li>Click the <strong>gear icon</strong> next to your name (bottom-left) to open <strong>User Settings</strong>.</li>
            <li>Scroll down to <strong>App Settings</strong> → click <strong>Advanced</strong>.</li>
            <li>Flip <strong>Developer Mode</strong> to <strong>ON</strong> (blue).</li>
            <li>Close settings — you're done, you won't need this again.</li>
          </ol>
          <p style="margin-top:10px"><strong>On phone:</strong> tap your profile picture → <strong>Settings</strong> → <strong>Advanced</strong> → turn on <strong>Developer Mode</strong>.</p>
        </div>

        <div class="setup-guide-step">
          <h3><span class="num">2</span> Copy your User ID</h3>
          <p><strong>On desktop — easiest way:</strong></p>
          <ol>
            <li>Look at the bottom-left of Discord where your avatar and username are.</li>
            <li><strong>Right-click</strong> your own avatar or username.</li>
            <li>Click <strong>Copy User ID</strong> in the menu.</li>
          </ol>
          <p style="margin-top:10px"><strong>Alternative:</strong> go to any server → member list → right-click your name → <strong>Copy User ID</strong>.</p>
          <p style="margin-top:10px"><strong>On phone:</strong> tap your profile → three dots menu → <strong>Copy User ID</strong>.</p>
          <div class="setup-callout info">The ID is a long number like <code>123456789012345678</code> (17–20 digits). It's <em>not</em> your username — it's a numeric ID.</div>
        </div>

        <div class="setup-guide-step">
          <h3><span class="num">3</span> Paste it below</h3>
          <p>If you don't see <strong>Copy User ID</strong> in the menu, Developer Mode isn't on yet — go back to step 1.</p>
        </div>
      </div>

      ${locked ? `<p class="setup-env-badge">Owner ID is set via environment variable.</p>` : `
      <div class="setup-paste-zone">
        <h3>Your Discord user ID</h3>
        <label class="field"><span class="lbl">Paste your numeric user ID</span>
          <input type="text" id="setup-owner-id" inputmode="numeric" placeholder="e.g. 123456789012345678" value="${esc(setupState.owner_id)}"></label>
        <p class="muted">Must be numbers only — 17 to 20 digits. This should be <em>your</em> account, not the bot's.</p>
      </div>`}
    </div>`;
}

function renderAI() {
  return `
    <div class="card">
      <h2>AI chat (optional)</h2>
      <p class="muted">This powers <code>/ask</code>, @mention replies, and voice conversations. You can <strong>skip this step</strong> and add a key later in Settings — the bot still works for moderation without it.</p>

      <div class="setup-portal-cta">
        <a class="btn primary" href="https://openrouter.ai/keys" target="_blank" rel="noopener">Open OpenRouter Keys ↗</a>
      </div>

      <div class="setup-guide">
        <div class="setup-guide-step">
          <h3><span class="num">1</span> Create an OpenRouter account</h3>
          <ol>
            <li>Click <strong>Open OpenRouter Keys</strong> above (or go to <strong>openrouter.ai</strong>).</li>
            <li>Click <strong>Sign In</strong> → use Google, GitHub, or email.</li>
            <li>It's free to start — you add credits later if you use it heavily.</li>
          </ol>
        </div>

        <div class="setup-guide-step">
          <h3><span class="num">2</span> Create an API key</h3>
          <ol>
            <li>On the Keys page, click <strong>Create Key</strong>.</li>
            <li>Name it anything (e.g. <code>discord-agent</code>).</li>
            <li>Click <strong>Create</strong> → then <strong>Copy</strong> the key.</li>
          </ol>
          <div class="setup-callout info">The key starts with <code>sk-or-</code>. Keep it secret like your bot token.</div>
        </div>

        <div class="setup-guide-step">
          <h3><span class="num">3</span> Pick a model <span class="muted">(or keep the default)</span></h3>
          <p>The default <code>openai/gpt-4o-mini</code> is fast, cheap, and works on most OpenRouter accounts. You can change it per-server later in the dashboard.</p>
          <p class="muted" style="margin-top:6px">Browse models at <a href="https://openrouter.ai/models" target="_blank" rel="noopener">openrouter.ai/models</a> if you want something else.</p>
        </div>
      </div>

      <div class="setup-paste-zone">
        <h3>Paste your OpenRouter key</h3>
        <p class="muted">Leave blank to skip — you can add this anytime in Settings → App configuration.</p>
        <label class="field"><span class="lbl">OpenRouter API key</span>
          <input type="password" id="setup-openrouter-key" placeholder="sk-or-v1-… (optional)" value="${esc(setupState.openrouter_api_key)}" autocomplete="off"></label>
        <label class="field"><span class="lbl">Default model</span>
          <input type="text" id="setup-openrouter-model" value="${esc(setupState.openrouter_model)}" placeholder="openai/gpt-4o-mini"></label>
      </div>
    </div>`;
}

function renderSecurity() {
  const lockedPw = setupState.envLocked.dashboard_password;
  const lockedSk = setupState.envLocked.secret_key;
  return `
    <div class="card">
      <h2>Protect your dashboard</h2>
      <p class="muted">This web page controls your entire Discord server — kick, ban, roles, messages, AI settings. Lock it with a password so only you can open it.</p>

      <div class="setup-guide">
        <div class="setup-guide-step">
          <h3><span class="num">1</span> Choose a dashboard password</h3>
          <ol>
            <li>Pick something strong — at least 8 characters.</li>
            <li>Don't reuse your Discord password.</li>
            <li>You'll enter this every time you open the dashboard (e.g. <code>localhost:8001</code> on this PC, or your Railway URL in the cloud).</li>
          </ol>
          <div class="setup-callout warn">Anyone with this password has full control of your bot and server settings. Don't share it.</div>
        </div>

        <div class="setup-guide-step">
          <h3><span class="num">2</span> Session secret <span class="muted">(automatic)</span></h3>
          <p>We auto-generate a random <strong>session secret</strong> below. It keeps you logged in and secures the voice listener. You don't need to memorize it — just leave it as-is unless you know what you're doing.</p>
        </div>
      </div>

      ${lockedPw ? `<p class="setup-env-badge">Dashboard password is set via environment variable.</p>` : `
      <div class="setup-paste-zone">
        <h3>Create your password</h3>
        <label class="field"><span class="lbl">Dashboard password (min 8 characters)</span>
          <input type="password" id="setup-password" placeholder="Choose a strong password" autocomplete="new-password"></label>
        <label class="field"><span class="lbl">Confirm password</span>
          <input type="password" id="setup-password-confirm" placeholder="Type it again" autocomplete="new-password"></label>
      </div>`}
      ${lockedSk ? `<p class="setup-env-badge">Session secret is set via environment variable.</p>` : `
      <label class="field" style="margin-top:14px"><span class="lbl">Session secret <span class="muted">(auto-generated — leave as-is)</span></span>
        <div class="inline-form">
          <input type="text" id="setup-secret-key" value="${esc(setupState.secret_key)}" readonly>
          <button type="button" class="btn" id="setup-regen-secret">Regenerate</button>
        </div></label>`}
    </div>`;
}

function renderExtras() {
  return `
    <div class="card">
      <h2>Optional extras</h2>
      <p class="muted"><strong>Skip this entire step</strong> if you're not sure — click Continue with everything blank. You can add these later in Settings.</p>

      <div class="setup-callout info" style="margin:12px 0">Nothing here is required for the bot to join your server and handle moderation.</div>

      <div class="setup-guide">
        <div class="setup-guide-step">
          <h3><span class="num">1</span> GitHub token <span class="muted">(optional)</span></h3>
          <p>Lets the bot analyze GitHub repos when someone shares a link. Without it, the feature still works but hits a low rate limit.</p>
          <ol>
            <li>Go to <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">github.com/settings/tokens</a></li>
            <li><strong>Generate new token</strong> → <strong>Generate new token (classic)</strong></li>
            <li>Name it <code>discord-agent</code>, set expiration, <strong>no scopes needed</strong> for public repos</li>
            <li>Click <strong>Generate token</strong> → copy the <code>ghp_…</code> string</li>
          </ol>
        </div>

        <div class="setup-guide-step">
          <h3><span class="num">2</span> Voice monitoring <span class="muted">(optional)</span></h3>
          <p>Transcribes voice channel speech, flags banned words, responds to wake words. Needs a transcription API key.</p>
          <p style="margin-top:6px"><strong>Option A — Groq (free tier, recommended):</strong></p>
          <ol>
            <li>Sign up at <a href="https://console.groq.com" target="_blank" rel="noopener">console.groq.com</a></li>
            <li>Go to <strong>API Keys</strong> → <strong>Create API Key</strong> → copy it</li>
            <li>Select <strong>Groq</strong> in the dropdown below</li>
          </ol>
          <p style="margin-top:10px"><strong>Option B — OpenAI:</strong> use an OpenAI API key and select <strong>OpenAI</strong> below.</p>
        </div>

        <div class="setup-guide-step">
          <h3><span class="num">3</span> Fish Audio TTS <span class="muted">(optional)</span></h3>
          <p>Better spoken voice replies in voice channels. Without it, the bot uses free edge-tts instead.</p>
          <ol>
            <li>Sign up at <a href="https://fish.audio" target="_blank" rel="noopener">fish.audio</a></li>
            <li>Copy your API key from the dashboard</li>
          </ol>
        </div>
      </div>

      <div class="setup-paste-zone">
        <h3>Optional keys</h3>
        <label class="field"><span class="lbl">GitHub token</span>
          <input type="password" id="setup-github-token" placeholder="ghp_… (leave blank to skip)" value="${esc(setupState.github_token)}" autocomplete="off"></label>
        <label class="field"><span class="lbl">Transcription API key</span>
          <input type="password" id="setup-transcription-key" placeholder="Groq or OpenAI key (leave blank to skip)" value="${esc(setupState.transcription_api_key)}" autocomplete="off"></label>
        <label class="field"><span class="lbl">Transcription provider</span>
          <select id="setup-transcription-url">
            <option value="https://api.groq.com/openai/v1" ${setupState.transcription_api_url.includes("groq") ? "selected" : ""}>Groq (recommended — free tier)</option>
            <option value="https://api.openai.com/v1" ${setupState.transcription_api_url.includes("openai") ? "selected" : ""}>OpenAI</option>
          </select></label>
        <label class="field"><span class="lbl">Fish Audio API key</span>
          <input type="password" id="setup-fish-key" placeholder="Leave blank to skip" value="${esc(setupState.fish_api_key)}" autocomplete="off"></label>
      </div>
    </div>`;
}

function renderFinish() {
  const bot = setupState.botInfo;
  return `
    <div class="card">
      <h2>Ready to launch</h2>
      <p class="muted">Review your choices below. Click <strong>Launch bot</strong> to save everything and connect to Discord.</p>

      ${bot ? `<div class="setup-bot-preview visible">
        <img src="https://cdn.discordapp.com/avatars/${bot.id}/${bot.avatar}.png?size=64" alt="" onerror="this.style.display='none'">
        <div><strong>@${esc(bot.username)}</strong><br><span class="muted">Bot connected during setup</span></div>
      </div>` : ""}

      <div class="setup-guide" style="margin-top:14px">
        <div class="setup-guide-step">
          <h3>What happens when you launch</h3>
          <ol>
            <li>Your settings are saved to the local database.</li>
            <li>The bot logs into Discord and syncs slash commands.</li>
            <li>You'll land in the dashboard — manage servers from your phone or browser.</li>
          </ol>
        </div>
      </div>

      <ul class="setup-summary">
        <li>Bot token: <strong>${setupState.discord_token || setupState.envLocked.discord_token ? "Set" : "Missing"}</strong></li>
        <li>Owner ID: <strong>${esc(setupState.owner_id) || "—"}</strong></li>
        <li>AI (OpenRouter): <strong>${setupState.openrouter_api_key ? "Configured" : "Skipped — add later in Settings"}</strong></li>
        <li>Voice monitoring: <strong>${setupState.transcription_api_key ? "Enabled" : "Off"}</strong></li>
        <li>Dashboard password: <strong>${setupState.dashboard_password || setupState.envLocked.dashboard_password ? "Set" : "Missing"}</strong></li>
      </ul>

      <div class="setup-callout warn">Make sure you <strong>invited the bot to a server</strong> (Developer Portal → OAuth2 → URL Generator). It won't show up anywhere until you do.</div>
      <p id="setup-finish-error" class="error hidden"></p>
    </div>`;
}

function bindSetupHandlers(stepId) {
  if (stepId === "discord") {
    const btn = qs("#setup-test-discord");
    if (btn) btn.onclick = testDiscordToken;
    qs("#setup-discord-token")?.addEventListener("input", (e) => {
      setupState.discord_token = e.target.value;
      setupState.botInfo = null;
    });
  }
  if (stepId === "security") {
    qs("#setup-regen-secret")?.addEventListener("click", () => {
      setupState.secret_key = randomHex(32);
      const el = qs("#setup-secret-key");
      if (el) el.value = setupState.secret_key;
    });
    if (!setupState.secret_key && !setupState.envLocked.secret_key) {
      setupState.secret_key = randomHex(32);
      const el = qs("#setup-secret-key");
      if (el) el.value = setupState.secret_key;
    }
  }
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function testDiscordToken() {
  const err = qs("#setup-discord-error");
  const preview = qs("#setup-bot-preview");
  err.classList.add("hidden");
  preview.classList.add("hidden");
  setupState.discord_token = qs("#setup-discord-token").value.trim();
  try {
    const result = await setupApi("/validate-discord", {
      method: "POST",
      body: { discord_token: setupState.discord_token },
    });
    setupState.botInfo = result;
    preview.innerHTML = `
      <img src="https://cdn.discordapp.com/avatars/${result.id}/${result.avatar}.png?size=64" alt="" onerror="this.style.display='none'">
      <div><strong>@${esc(result.username)}</strong><br><span class="muted">Connected — looks good!</span></div>`;
    preview.classList.remove("hidden");
    toast("Bot token verified");
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove("hidden");
  }
}

function collectStepData() {
  const step = SETUP_STEPS[setupState.step].id;
  if (step === "discord") setupState.discord_token = qs("#setup-discord-token")?.value.trim() || setupState.discord_token;
  if (step === "owner") setupState.owner_id = qs("#setup-owner-id")?.value.trim() || "";
  if (step === "ai") {
    setupState.openrouter_api_key = qs("#setup-openrouter-key")?.value.trim() || "";
    setupState.openrouter_model = qs("#setup-openrouter-model")?.value.trim() || setupState.openrouter_model;
  }
  if (step === "security") {
    if (!setupState.envLocked.dashboard_password) {
      setupState.dashboard_password = qs("#setup-password")?.value || "";
    }
    if (!setupState.envLocked.secret_key) {
      setupState.secret_key = qs("#setup-secret-key")?.value.trim() || setupState.secret_key;
    }
  }
  if (step === "extras") {
    setupState.github_token = qs("#setup-github-token")?.value.trim() || "";
    setupState.transcription_api_key = qs("#setup-transcription-key")?.value.trim() || "";
    setupState.transcription_api_url = qs("#setup-transcription-url")?.value || setupState.transcription_api_url;
    setupState.transcription_model = setupState.transcription_api_url.includes("groq")
      ? "whisper-large-v3" : "whisper-1";
    setupState.fish_api_key = qs("#setup-fish-key")?.value.trim() || "";
  }
}

function validateCurrentStep() {
  const step = SETUP_STEPS[setupState.step].id;
  if (step === "discord" && !setupState.envLocked.discord_token && !setupState.discord_token) {
    toast("Enter your bot token", true);
    return false;
  }
  if (step === "discord" && !setupState.envLocked.discord_token && !setupState.botInfo) {
    toast("Test your bot token before continuing", true);
    return false;
  }
  if (step === "owner" && !setupState.envLocked.owner_id) {
    if (!/^\d{17,20}$/.test(setupState.owner_id)) {
      toast("Paste your numeric Discord user ID (17–20 digits). Enable Developer Mode, then right-click your avatar → Copy User ID.", true);
      return false;
    }
  }
  if (step === "security" && !setupState.envLocked.dashboard_password) {
    const pw = setupState.dashboard_password;
    const confirm = qs("#setup-password-confirm")?.value || "";
    if (pw.length < 8) { toast("Password must be at least 8 characters", true); return false; }
    if (pw !== confirm) { toast("Passwords don't match", true); return false; }
  }
  return true;
}

async function finishSetup() {
  const err = qs("#setup-finish-error");
  err.classList.add("hidden");
  try {
    await setupApi("/complete", {
      method: "POST",
      body: {
        discord_token: setupState.discord_token,
        owner_id: setupState.owner_id,
        openrouter_api_key: setupState.openrouter_api_key,
        openrouter_model: setupState.openrouter_model,
        github_token: setupState.github_token,
        transcription_api_key: setupState.transcription_api_key,
        transcription_api_url: setupState.transcription_api_url,
        transcription_model: setupState.transcription_model,
        dashboard_password: setupState.dashboard_password,
        secret_key: setupState.secret_key,
        fish_api_key: setupState.fish_api_key,
        fish_tts_model: setupState.fish_tts_model,
        fish_voice_id: setupState.fish_voice_id,
      },
    });
    hideSetup();
    init();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove("hidden");
  }
}

function setupNavBack() {
  if (setupState.step > 0) {
    collectStepData();
    setupState.step--;
    renderSetupStep();
  }
}

function setupNavNext() {
  collectStepData();
  if (!validateCurrentStep()) return;
  if (setupState.step < SETUP_STEPS.length - 1) {
    setupState.step++;
    renderSetupStep();
  } else {
    finishSetup();
  }
}

async function checkSetupStatus() {
  const status = await setupApi("/status");
  if (status.needs_setup) {
    setupState.envLocked = status.env_locked || {};
    if (status.config) {
      Object.assign(setupState, {
        discord_token: "",
        owner_id: String(status.config.owner_id || ""),
        openrouter_model: status.config.openrouter_model || setupState.openrouter_model,
      });
    }
    showSetup();
    return true;
  }
  return false;
}

window.checkSetupStatus = checkSetupStatus;

/* ---------- Cursor API key onboarding ---------- */

let cursorSetupNavBound = false;

const cursorSetupState = {
  step: 0,
  cursor_api_key: "",
  tested: false,
  envLocked: false,
  onComplete: null,
};

const CURSOR_SETUP_STEPS = [
  { id: "welcome", title: "Cursor cloud agents" },
  { id: "create", title: "Create an API key" },
  { id: "connect", title: "Connect" },
];

async function dashboardApi(path, opts = {}) {
  const res = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let detail = "Request failed";
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

function bindCursorSetupNav() {
  if (cursorSetupNavBound) return;
  qs("#cursor-setup-back")?.addEventListener("click", cursorSetupNavBack);
  qs("#cursor-setup-next")?.addEventListener("click", cursorSetupNavNext);
  qs("#cursor-setup-skip")?.addEventListener("click", skipCursorSetup);
  cursorSetupNavBound = true;
}

function showCursorSetup(onComplete) {
  cursorSetupState.onComplete = onComplete || null;
  cursorSetupState.step = 0;
  cursorSetupState.cursor_api_key = "";
  cursorSetupState.tested = false;
  qs("#app")?.classList.add("hidden");
  qs("#cursor-setup-screen")?.classList.remove("hidden");
  bindCursorSetupNav();
  renderCursorSetupStep();
}

function hideCursorSetup() {
  qs("#cursor-setup-screen")?.classList.add("hidden");
  qs("#app")?.classList.remove("hidden");
}

function skipCursorSetup() {
  hideCursorSetup();
  if (cursorSetupState.onComplete) cursorSetupState.onComplete({ skipped: true });
}

function cursorSetupProgress() {
  return CURSOR_SETUP_STEPS.map((s, i) =>
    `<div class="setup-dot ${i === cursorSetupState.step ? "active" : ""} ${i < cursorSetupState.step ? "done" : ""}"></div>`
  ).join("");
}

function renderCursorSetupStep() {
  const step = CURSOR_SETUP_STEPS[cursorSetupState.step];
  qs("#cursor-setup-progress").innerHTML = cursorSetupProgress();
  qs("#cursor-setup-step-label").textContent =
    `Step ${cursorSetupState.step + 1} of ${CURSOR_SETUP_STEPS.length} — ${step.title}`;

  const renderers = {
    welcome: renderCursorWelcome,
    create: renderCursorCreate,
    connect: renderCursorConnect,
  };
  qs("#cursor-setup-content").innerHTML = renderers[step.id]();
  bindCursorSetupHandlers(step.id);

  const nextBtn = qs("#cursor-setup-next");
  const skipBtn = qs("#cursor-setup-skip");
  const backBtn = qs("#cursor-setup-back");
  if (nextBtn) {
    nextBtn.textContent = step.id === "connect" ? "Save & finish" : "Continue";
  }
  if (backBtn) {
    backBtn.classList.toggle("hidden", cursorSetupState.step === 0);
  }
  if (skipBtn) {
    skipBtn.classList.toggle("hidden", cursorSetupState.step > 0);
  }
}

function renderCursorWelcome() {
  return `
    <div class="setup-hero">
      <div class="setup-icon">⚡</div>
      <h1>Connect Cursor</h1>
      <p class="muted">Sara can dispatch <strong>Cursor cloud agents</strong> to work on your GitHub repos — owner-only, from Discord chat.</p>
    </div>
    <ul class="setup-checklist">
      <li>You describe a coding task to Sara</li>
      <li>She launches a cloud agent on your repo</li>
      <li>Cursor codes, pushes a branch, and can open a PR</li>
    </ul>
    <div class="setup-note">You need a <strong>Cursor API key</strong> from your Cursor account. The next steps walk you through creating one — takes about a minute.</div>`;
}

function renderCursorCreate() {
  return `
    <div class="card">
      <h2>Get your Cursor API key</h2>
      <p class="muted">Follow these steps in the Cursor dashboard. The key is shown <strong>once</strong> — copy it immediately.</p>

      <div class="setup-portal-cta">
        <a class="btn primary" href="https://cursor.com/dashboard/api" target="_blank" rel="noopener">Open Cursor API Keys ↗</a>
      </div>

      <div class="setup-guide">
        <div class="setup-guide-step">
          <h3><span class="num">1</span> Sign in to Cursor</h3>
          <p>Use the same account that has access to the repos you want Sara to work on.</p>
        </div>
        <div class="setup-guide-step">
          <h3><span class="num">2</span> Create an API key</h3>
          <p>On the API Keys page, click <strong>Create API Key</strong> (or similar). Give it a name like <code>discord-agent</code>.</p>
        </div>
        <div class="setup-guide-step">
          <h3><span class="num">3</span> Copy the key</h3>
          <p>Cursor shows the full key only once. Copy it before closing the dialog — you'll paste it on the next step.</p>
        </div>
        <div class="setup-guide-step">
          <h3><span class="num">4</span> Repo access</h3>
          <p>Cloud agents clone from GitHub. Make sure your Cursor account (or team) can access the repositories you'll configure in Settings → Cursor.</p>
        </div>
      </div>

      <div class="setup-callout">Key format is usually <code>cursor_…</code> or similar. Store it somewhere safe — you can't view it again in Cursor.</div>
    </div>`;
}

function renderCursorConnect() {
  const locked = cursorSetupState.envLocked;
  return `
    <div class="card">
      <h2>Paste your API key</h2>
      ${locked ? `<div class="setup-env-badge">Set via CURSOR_API_KEY environment variable</div>` : ""}
      <p class="muted">We'll test the connection before saving. The key is stored locally in your bot database (same as other API keys).</p>

      <div class="setup-paste-zone">
        <label class="field"><span class="lbl">Cursor API key</span>
          <input type="password" id="cursor-setup-api-key"
            placeholder="Paste key from cursor.com/dashboard/api"
            value="${esc(cursorSetupState.cursor_api_key)}"
            ${locked ? "disabled" : ""} autocomplete="off"></label>
      </div>

      <button type="button" class="btn" id="cursor-setup-test" ${locked ? "disabled" : ""}>Test connection</button>
      <div id="cursor-setup-test-result" class="muted" style="margin-top:10px"></div>
      <div id="cursor-setup-preview" class="setup-bot-preview hidden" style="margin-top:12px"></div>
      <p id="cursor-setup-error" class="error hidden"></p>
    </div>`;
}

function bindCursorSetupHandlers(stepId) {
  if (stepId === "connect") {
    qs("#cursor-setup-api-key")?.addEventListener("input", (e) => {
      cursorSetupState.cursor_api_key = e.target.value;
      cursorSetupState.tested = false;
      qs("#cursor-setup-preview")?.classList.add("hidden");
    });
    qs("#cursor-setup-test")?.addEventListener("click", testCursorApiKey);
  }
}

async function testCursorApiKey() {
  const err = qs("#cursor-setup-error");
  const resultEl = qs("#cursor-setup-test-result");
  const preview = qs("#cursor-setup-preview");
  err?.classList.add("hidden");
  preview?.classList.add("hidden");
  const input = qs("#cursor-setup-api-key");
  cursorSetupState.cursor_api_key = input?.value.trim() || "";
  if (!cursorSetupState.cursor_api_key) {
    toast("Paste your Cursor API key first", true);
    if (resultEl) resultEl.textContent = "";
    return;
  }
  resultEl.textContent = "Testing…";
  try {
    const result = await dashboardApi("/cursor/test", {
      method: "POST",
      body: { cursor_api_key: cursorSetupState.cursor_api_key },
    });
    if (!result.ok) {
      resultEl.textContent = result.error || "Connection failed";
      cursorSetupState.tested = false;
      return;
    }
    cursorSetupState.tested = true;
    resultEl.textContent = `Connected — ${result.model_count ?? 0} model(s) available`;
    preview.innerHTML = `<div><strong>API key works</strong><br><span class="muted">Click Save & finish to store it.</span></div>`;
    preview.classList.remove("hidden");
    toast("Cursor API key verified");
  } catch (e) {
    resultEl.textContent = e.message;
    cursorSetupState.tested = false;
  }
}

function collectCursorStepData() {
  if (CURSOR_SETUP_STEPS[cursorSetupState.step].id === "connect") {
    cursorSetupState.cursor_api_key = qs("#cursor-setup-api-key")?.value.trim() || "";
  }
}

function validateCursorStep() {
  const step = CURSOR_SETUP_STEPS[cursorSetupState.step].id;
  if (step === "connect" && !cursorSetupState.envLocked) {
    if (!cursorSetupState.cursor_api_key) {
      toast("Paste your Cursor API key", true);
      return false;
    }
    if (!cursorSetupState.tested) {
      toast("Test your API key before saving", true);
      return false;
    }
  }
  return true;
}

async function finishCursorSetup() {
  const err = qs("#cursor-setup-error");
  err?.classList.add("hidden");
  try {
    if (!cursorSetupState.envLocked) {
      await dashboardApi("/app-config", {
        method: "PUT",
        body: { cursor_api_key: cursorSetupState.cursor_api_key },
      });
    }
    hideCursorSetup();
    toast("Cursor API key saved");
    if (cursorSetupState.onComplete) cursorSetupState.onComplete({ saved: true });
  } catch (e) {
    if (err) {
      err.textContent = e.message;
      err.classList.remove("hidden");
    } else {
      toast(e.message, true);
    }
  }
}

function cursorSetupNavBack() {
  if (cursorSetupState.step > 0) {
    collectCursorStepData();
    cursorSetupState.step--;
    renderCursorSetupStep();
  }
}

function cursorSetupNavNext() {
  collectCursorStepData();
  if (!validateCursorStep()) return;
  if (cursorSetupState.step < CURSOR_SETUP_STEPS.length - 1) {
    cursorSetupState.step++;
    renderCursorSetupStep();
  } else {
    finishCursorSetup();
  }
}

function needsCursorSetup(appCfg) {
  if (!appCfg) return false;
  if (appCfg.cursor_api_key_set) return false;
  if (appCfg.env_locked?.cursor_api_key) return false;
  return true;
}

window.showCursorSetup = showCursorSetup;
window.needsCursorSetup = needsCursorSetup;
