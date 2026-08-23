/* Customer dashboard.

   Two views off one account: managed accounts see a credit balance, burn rate
   and top-ups; enterprise accounts see a usage report and no balance at all —
   they are billed by their own providers, and showing them a balance would be
   a lie.

   Every read and write goes through PLATFORM.API, which talks to the bot. The
   numbers on this page are what the bot actually metered. */
(function () {
  'use strict';

  var P = window.PLATFORM;
  var C = window.CATALOG;
  if (!P || !C) return;

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  /* Pack selected for purchase — UI state, not persisted. */
  var selectedPack = 'pack-50';
  /* Last loaded snapshot: { me, usage }. */
  var state = null;

  var CAPS = {};
  C.GROUPS.forEach(function (g) {
    g.caps.forEach(function (c) { CAPS[c.id] = c; });
  });

  var ENTERPRISE_FEE = 149; // per server, per month

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  /* ---------- static tables ---------- */

  function renderStatic() {
    $('[data-packs]').innerHTML = P.CREDIT_PACKS.map(function (pack) {
      var save = P.packSavingPct(pack);
      return (
        '<button class="pack" data-pack="' + pack.id + '">'
        + (save > 0 ? '<span class="pack__save">save ' + save + '%</span>' : '')
        + '<div class="pack__credits">' + P.fmt.compact(pack.credits) + '</div>'
        + '<div class="pack__price">credits &middot; ' + P.fmt.money(pack.price) + '</div>'
        + '</button>'
      );
    }).join('');

    $('[data-rates]').innerHTML =
      '<thead><tr><th>What</th><th>Provider</th><th class="num">Credits</th><th></th></tr></thead><tbody>'
      + P.CREDIT_RATES.map(function (r) {
        return (
          '<tr' + (r.integrated ? '' : ' style="opacity:.55"') + '>'
          + '<td><span class="strong">' + esc(r.name) + '</span>'
          + '<div class="dim">' + esc(r.note) + '</div></td>'
          + '<td class="dim">' + esc(r.provider) + '</td>'
          + '<td class="num strong">' + r.credits + '</td>'
          + '<td class="dim">' + esc(r.unit)
          + (r.integrated ? '' : ' <span class="pill pill--warn" style="margin-left:6px">not wired up yet</span>')
          + '</td></tr>'
        );
      }).join('')
      + '</tbody>';
  }

  /* ---------- signed out ---------- */

  function showAuth(message) {
    $('[data-app]').hidden = true;
    var box = $('[data-auth]');
    box.hidden = false;
    box.innerHTML =
      '<div class="card2" style="max-width:440px;margin:40px auto">'
      + '<div class="card2__head"><h2 class="card2__title" data-auth-title>Sign in</h2></div>'
      + (message ? '<div class="banner banner--warn"><span>' + esc(message) + '</span></div>' : '')
      + '<div data-auth-error></div>'
      + '<div class="field" data-auth-name-field hidden><label for="auth-name">Name</label>'
      + '<input class="input" id="auth-name" type="text" data-auth-name '
      + 'placeholder="Your community or company"></div>'
      + '<div class="field"><label for="auth-email">Email</label>'
      + '<input class="input" id="auth-email" type="email" data-auth-email '
      + 'autocomplete="username"></div>'
      + '<div class="field"><label for="auth-password">Password</label>'
      + '<input class="input" id="auth-password" type="password" data-auth-password '
      + 'autocomplete="current-password"></div>'
      + '<button class="btn btn--primary" style="width:100%;margin-top:14px" data-auth-submit>Sign in</button>'
      + '<div class="hint" style="margin-top:14px">'
      + '<a href="#" data-auth-switch>Need an account? Create one</a></div>'
      + '<div class="hint" style="margin-top:10px">Just want a bot? '
      + '<a href="build.html">Start with the order form</a> — you can do that before signing up.</div>'
      + '</div>';
  }

  var authMode = 'signin';

  function setAuthMode(mode) {
    authMode = mode;
    var signup = mode === 'signup';
    $('[data-auth-title]').textContent = signup ? 'Create an account' : 'Sign in';
    $('[data-auth-name-field]').hidden = !signup;
    $('[data-auth-submit]').textContent = signup ? 'Create account' : 'Sign in';
    $('[data-auth-switch]').textContent = signup
      ? 'Already have an account? Sign in'
      : 'Need an account? Create one';
  }

  function authError(message) {
    $('[data-auth-error]').innerHTML = message
      ? '<div class="banner banner--warn"><span>' + esc(message) + '</span></div>' : '';
  }

  /* ---------- load ---------- */

  async function load() {
    try {
      await P.API.catalog();
    } catch (err) {
      // Static copies are already in place; the page still renders.
    }
    renderStatic();

    var me;
    try {
      me = await P.API.me();
    } catch (err) {
      showAuth(err.status === 0
        ? 'Could not reach the server. This page needs the bot running behind it.'
        : err.message);
      return;
    }
    if (!me) { showAuth(); setAuthMode('signin'); return; }

    var usage = { daily: [], byKind: [], byServer: [] };
    try {
      usage = await P.API.usage(30);
    } catch (err) { /* an account with no usage yet is not an error */ }

    state = { me: me, usage: usage };
    $('[data-auth]').hidden = true;
    $('[data-app]').hidden = false;
    render();
  }

  /* ---------- render ---------- */

  function highestTier(servers) {
    var idx = servers.reduce(function (m, s) {
      return Math.max(m, C.TIER_INDEX[s.tier] === undefined ? 0 : C.TIER_INDEX[s.tier]);
    }, 0);
    return C.TIERS[idx];
  }

  function render() {
    var acct = state.me.account;
    var servers = state.me.servers;
    var enterprise = acct.venue === 'enterprise';
    var tier = highestTier(servers);

    $('[data-acct-initial]').textContent = (acct.name.trim()[0] || 'A').toUpperCase();
    $('[data-acct-name]').textContent = acct.name;
    $('[data-acct-sub]').textContent = acct.email;
    var vp = $('[data-venue-pill]');
    vp.className = 'pill ' + (enterprise ? 'pill--enterprise' : 'pill--managed');
    vp.textContent = enterprise ? 'Enterprise · own keys' : 'Managed · credits';
    $('[data-tier-pill]').textContent = servers.length ? tier.name + ' tier' : 'no bots yet';

    $('[data-managed-block]').hidden = enterprise;
    $('[data-enterprise-block]').hidden = !enterprise;

    if (enterprise) renderEnterprise();
    else renderManaged();

    renderServers(enterprise);
  }

  function renderManaged() {
    var credits = state.me.credits;
    var daily = state.usage.daily;
    var balance = credits.balance;
    var burn = credits.burnRate;
    var days = credits.daysRemaining === null ? Infinity : credits.daysRemaining;

    /* A balance is only meaningful against what it is being spent at, so the
       meter is scaled to 30 days of the current burn rate rather than to some
       arbitrary maximum. */
    var full = burn * 30;
    var pct = full > 0 ? Math.min(100, (balance / full) * 100) : (balance > 0 ? 100 : 0);
    var level = balance <= 0 ? 'critical' : (days <= 3 ? 'critical' : (days <= 10 ? 'low' : ''));

    var bal = $('[data-balance]');
    bal.textContent = P.fmt.credits(balance);
    bal.className = 'metric__value' + (level ? ' is-' + level : '');
    var meter = $('[data-balance-meter]');
    meter.style.width = pct + '%';
    meter.className = 'meter__fill' + (level ? ' is-' + level : '');
    $('[data-balance-sub]').textContent = 'about '
      + P.fmt.money(balance / 100) + ' of usage at list price';

    $('[data-burn]').textContent = P.fmt.credits(burn);
    $('[data-burn-sub]').textContent = burn > 0
      ? 'roughly ' + P.fmt.money(burn * 30 / 100) + ' a month at this rate'
      : 'nothing metered yet';

    var d = $('[data-days]');
    d.textContent = days === Infinity ? '∞' : String(days);
    d.className = 'metric__value' + (level ? ' is-' + level : '');
    $('[data-days-sub]').textContent = days === Infinity
      ? 'no usage yet to project from'
      : (state.me.account.autoTopUp && state.me.account.autoTopUp.enabled
        ? 'auto top-up is requested below this threshold'
        : 'no auto top-up — you will run dry');

    /* Warnings, only when actually true. */
    var banner = '';
    if (balance <= 0) {
      banner = '<div class="banner banner--warn"><span><b>Out of credits.</b> '
        + 'Your bots have stopped replying with AI. Moderation, automod, welcome '
        + 'messages and the slash commands all keep working. Top up below and they '
        + 'pick straight back up.</span></div>';
    } else if (days <= 10) {
      banner = '<div class="banner banner--warn"><span><b>Balance running low.</b> About '
        + days + ' days left at your current rate. When credits hit zero the bots stop '
        + 'replying — moderation and automod keep working.</span></div>';
    }
    if (credits.writtenOff > 0) {
      banner += '<div class="banner"><span>' + P.fmt.credits(credits.writtenOff)
        + ' credits of usage were not charged — work that finished after the balance '
        + 'reached zero. We absorb that rather than billing you for it.</span></div>';
    }
    $('[data-low-banner]').innerHTML = banner;

    /* usage chart */
    var maxDay = Math.max.apply(null, daily.map(function (r) { return r.credits; }).concat([1]));
    $('[data-chart]').innerHTML = daily.map(function (row) {
      var weekend = [0, 6].indexOf(new Date(row.day).getDay()) !== -1;
      return '<span class="chart__bar" data-weekend="' + (weekend ? 1 : 0) + '" '
        + 'style="height:' + Math.max(4, (row.credits / maxDay) * 100) + '%" '
        + 'title="' + P.fmt.credits(row.credits) + ' credits"></span>';
    }).join('') || '<span class="dim">Nothing metered in the last 30 days.</span>';

    /* breakdown */
    var totals = P.usageByProvider(state.usage.byKind);
    var names = Object.keys(totals);
    var sum = names.reduce(function (a, n) { return a + totals[n]; }, 0) || 1;
    $('[data-breakdown]').innerHTML = (names.length ? names.map(function (name) {
      var share = (totals[name] / sum) * 100;
      return (
        '<div style="margin-bottom:16px">'
        + '<div style="display:flex;justify-content:space-between;font-size:.87rem;margin-bottom:7px">'
        + '<span>' + esc(name) + '</span>'
        + '<span class="dim">' + P.fmt.credits(totals[name]) + ' &middot; ' + share.toFixed(0) + '%</span>'
        + '</div>'
        + '<div class="meter" style="margin:0"><span class="meter__fill" style="width:' + share + '%"></span></div>'
        + '</div>'
      );
    }).join('') : '<div class="dim">No usage yet.</div>')
      + '<div class="hint" style="margin-top:4px">Background work is the bulk of OpenRouter'
      + ' volume and the cheapest line on the card — that is deliberate.</div>';

    /* packs */
    $$('[data-pack]').forEach(function (el) {
      el.classList.toggle('is-on', el.dataset.pack === selectedPack);
    });
    var pack = P.CREDIT_PACKS.filter(function (p) { return p.id === selectedPack; })[0];
    var addDays = burn > 0 ? Math.round(pack.credits / burn) : Infinity;
    $('[data-buy-note]').innerHTML = P.fmt.money(pack.price) + ' for '
      + P.fmt.credits(pack.credits) + ' credits — about <b>'
      + (addDays === Infinity ? '∞' : addDays) + ' more days</b> at your current rate.';

    var autoTopUp = state.me.account.autoTopUp || {};
    var toggle = $('[data-autotopup]');
    toggle.classList.toggle('is-on', !!autoTopUp.enabled);
    var tp = P.CREDIT_PACKS.filter(function (p) { return p.id === autoTopUp.packId; })[0]
      || P.CREDIT_PACKS[1];
    $('[data-autotopup-detail]').textContent = autoTopUp.enabled
      ? 'We will get in touch to top up ' + P.fmt.compact(tp.credits) + ' credits ('
        + P.fmt.money(tp.price) + ') when the balance drops below '
        + P.fmt.credits(autoTopUp.threshold || 0)
        + '. Not automatic yet — there is no card on file.'
      : 'Off. The bots stop replying if the balance reaches zero.';
  }

  function renderEnterprise() {
    var servers = state.me.servers;
    var live = servers.filter(function (s) { return s.status === 'ready'; });
    $('[data-ent-servers]').textContent = String(live.length);
    $('[data-ent-fee]').textContent = P.fmt.money(live.length * ENTERPRISE_FEE)
      + ' / month platform fee (' + P.fmt.money(ENTERPRISE_FEE) + ' per server)';

    var byKind = {};
    state.usage.byKind.forEach(function (r) { byKind[r.kind] = r; });
    var replies = ((byKind['reply-standard'] || {}).quantity || 0)
      + ((byKind['reply-frontier'] || {}).quantity || 0);
    var voice = (byKind.transcription || {}).quantity || 0;
    $('[data-ent-replies]').textContent = P.fmt.compact(replies);
    $('[data-ent-voice]').textContent = P.fmt.compact(voice);

    /* Key handover happens on the call, and rotation is not self-serve yet —
       so this says that rather than showing a vault that does nothing. */
    $('[data-ent-keys]').innerHTML =
      '<div class="banner"><span>Your provider keys are held for your bots and never '
      + 'billed by us. Rotation goes through your contact here — self-serve rotation '
      + 'is not built yet, and a box that looked like it worked would be worse than '
      + 'this sentence.</span></div>'
      + '<div class="hint" style="margin-top:14px">Usage above is what your bots '
      + 'actually consumed, priced at our list rate so you can compare it against '
      + 'your own provider invoices. You are not charged it.</div>';
  }

  function renderServers(enterprise) {
    var byServer = {};
    state.usage.byServer.forEach(function (r) { byServer[r.serverId] = r.credits; });

    var rows = state.me.servers.map(function (s) {
      var tier = C.TIERS.filter(function (t) { return t.id === s.tier; })[0] || C.TIERS[0];
      var statusCls = s.status === 'ready' ? 'pill--ok'
        : (s.status === 'provisioning' ? 'pill--warn' : 'pill--idle');
      var mods = s.modules.slice(0, 4).map(function (id) {
        return '<span class="chip">' + esc(CAPS[id] ? CAPS[id].name : id) + '</span>';
      }).join('');
      var extra = s.modules.length > 4
        ? '<span class="chip chip--muted">+' + (s.modules.length - 4) + ' more</span>' : '';
      var canUpgrade = C.TIER_INDEX[s.tier] < C.TIERS.length - 1;

      return (
        '<tr>'
        + '<td><span class="strong">' + esc(s.name) + '</span>'
        + '<div class="dim">' + esc(s.botName || '—')
        + (s.guildId ? '' : ' &middot; not yet invited') + '</div></td>'
        + '<td><span class="pill ' + statusCls + '">' + esc(s.status) + '</span></td>'
        + '<td>' + esc(tier.name) + '</td>'
        + '<td><div class="modlist">' + mods + extra + '</div></td>'
        + '<td class="num">' + (enterprise ? '—' : P.fmt.credits(byServer[s.id] || 0)) + '</td>'
        + '<td style="white-space:nowrap">'
        + (canUpgrade
          ? '<button class="btn btn--ghost btn--sm" data-upgrade="' + s.id + '">Ask to upgrade</button>'
          : '<span class="dim">top tier</span>')
        + '</td></tr>'
      );
    }).join('');

    $('[data-servers]').innerHTML =
      '<thead><tr><th>Server</th><th>Status</th><th>Tier</th><th>Capabilities</th>'
      + '<th class="num">' + (enterprise ? 'Usage' : 'Credits (30d)') + '</th><th></th></tr></thead>'
      + '<tbody>' + (rows
        || '<tr><td colspan="6" class="empty">No bots yet. '
          + '<a href="build.html">Start an order</a> and we will build one with you.</td></tr>')
      + '</tbody>';

    $('[data-servers-note]').textContent = enterprise
      ? P.fmt.money(state.me.servers.filter(function (s) { return s.status === 'ready'; }).length
        * ENTERPRISE_FEE) + ' / month across ' + state.me.servers.length + ' server(s)'
      : state.me.servers.length + ' bot(s) on this account';
  }

  /* ---------- events ---------- */

  document.addEventListener('click', async function (e) {
    var t = e.target;

    /* auth */
    if (t.closest('[data-auth-switch]')) {
      e.preventDefault();
      authError('');
      return setAuthMode(authMode === 'signup' ? 'signin' : 'signup');
    }
    if (t.closest('[data-auth-submit]')) {
      var email = $('[data-auth-email]').value.trim();
      var password = $('[data-auth-password]').value;
      var btn = $('[data-auth-submit]');
      btn.disabled = true;
      try {
        if (authMode === 'signup') {
          await P.API.signUp({ name: $('[data-auth-name]').value, email: email, password: password });
        } else {
          await P.API.signIn(email, password);
        }
        authError('');
        await load();
      } catch (err) {
        authError(err.message);
      } finally {
        btn.disabled = false;
      }
      return undefined;
    }
    if (t.closest('[data-signout]')) {
      await P.API.signOut();
      state = null;
      showAuth();
      setAuthMode('signin');
      return undefined;
    }

    if (!state) return undefined;

    var pack = t.closest('[data-pack]');
    if (pack) { selectedPack = pack.dataset.pack; return render(); }

    /* No checkout yet, deliberately. Saying exactly what happens next beats a
       button that pretends to take a payment. */
    if (t.closest('[data-buy]')) {
      var chosen = P.CREDIT_PACKS.filter(function (p) { return p.id === selectedPack; })[0];
      $('[data-buy-note]').innerHTML = '<b>' + P.fmt.money(chosen.price) + ' for '
        + P.fmt.credits(chosen.credits) + ' credits.</b> Card payment is not wired up yet — '
        + 'message your contact here and we will send payment details, then put the '
        + 'credits on this account as soon as it clears. They show up on this page '
        + 'the moment they do.';
      return undefined;
    }

    if (t.closest('[data-autotopup]')) {
      var current = state.me.account.autoTopUp || {};
      try {
        state.me = await P.API.setAutoTopUp({
          enabled: !current.enabled,
          threshold: current.threshold || 5000,
          packId: current.packId || 'pack-50',
        });
        render();
      } catch (err) { /* leave the toggle where it was */ }
      return undefined;
    }

    var up = t.closest('[data-upgrade]');
    if (up) {
      /* An upgrade is a conversation, same as the first order — so it files
         one, and lands in the same queue somebody is already watching. */
      var srv = state.me.servers.filter(function (s) { return s.id === up.dataset.upgrade; })[0];
      if (!srv) return undefined;
      var next = C.TIERS[Math.min(C.TIER_INDEX[srv.tier] + 1, C.TIERS.length - 1)];
      up.disabled = true;
      try {
        await P.API.submitOrder({
          venue: state.me.account.venue,
          accountName: state.me.account.name,
          email: state.me.account.email,
          serverName: srv.name,
          botName: srv.botName,
          tier: next.id,
          modules: srv.modules,
          notes: 'Upgrade request for an existing bot (' + srv.id + ') from '
            + srv.tier + ' to ' + next.id + '.',
        });
        up.textContent = 'Requested';
      } catch (err) {
        up.disabled = false;
      }
      return undefined;
    }
    return undefined;
  });

  load();
})();
