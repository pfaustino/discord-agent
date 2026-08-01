/* Customer dashboard.

   Two views off one account record: managed accounts see a credit balance,
   burn rate and top-up packs; enterprise accounts see a usage report and a key
   vault, and no balance at all — they are billed by their own providers, and
   showing them a balance would be a lie.

   Every read and write goes through PLATFORM.Store, so pointing this at a real
   API means changing that one module. */
(function () {
  'use strict';

  var P = window.PLATFORM;
  var C = window.CATALOG;
  if (!P || !C) return;

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  /* Pack selected for purchase — UI state, not persisted. */
  var selectedPack = 'pack-50';

  var CAPS = {};
  C.GROUPS.forEach(function (g) {
    g.caps.forEach(function (c) { CAPS[c.id] = c; });
  });

  var ENTERPRISE_FEE = 149; // per server, per month

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  /* ---------- static ---------- */

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
        + '<td><span class="strong">' + r.name + '</span>'
        + '<div class="dim">' + r.note + '</div></td>'
        + '<td class="dim">' + r.provider + '</td>'
        + '<td class="num strong">' + r.credits + '</td>'
        + '<td class="dim">' + r.unit
        + (r.integrated ? '' : ' <span class="pill pill--warn" style="margin-left:6px">not wired up yet</span>')
        + '</td></tr>'
      );
    }).join('')
    + '</tbody>';

  /* ---------- render ---------- */

  function render() {
    var data = P.Store.read();
    var acct = data.account;
    var enterprise = acct.venue === 'enterprise';
    var tier = C.TIERS.filter(function (t) { return t.id === acct.tier; })[0] || C.TIERS[0];

    /* identity */
    $('[data-acct-initial]').textContent = (acct.name.trim()[0] || 'A').toUpperCase();
    $('[data-acct-name]').textContent = acct.name;
    $('[data-acct-sub]').textContent = acct.email;
    var vp = $('[data-venue-pill]');
    vp.className = 'pill ' + (enterprise ? 'pill--enterprise' : 'pill--managed');
    vp.textContent = enterprise ? 'Enterprise · own keys' : 'Managed · credits';
    $('[data-tier-pill]').textContent = tier.name + ' tier';
    $('[data-venue-toggle]').textContent = enterprise ? 'View as managed' : 'View as enterprise';

    $('[data-managed-block]').hidden = enterprise;
    $('[data-enterprise-block]').hidden = !enterprise;

    if (enterprise) renderEnterprise(data);
    else renderManaged(data);

    renderServers(data, enterprise);
  }

  function renderManaged(data) {
    var acct = data.account;
    var burn = P.burnRate(data.usage);
    var days = P.daysRemaining(acct.credits, data.usage);

    /* A balance is only meaningful against what it is being spent at, so the
       meter is scaled to 30 days of the current burn rate rather than to some
       arbitrary maximum. */
    var full = burn * 30;
    var pct = full > 0 ? Math.min(100, (acct.credits / full) * 100) : 100;
    var level = days <= 3 ? 'critical' : (days <= 10 ? 'low' : '');

    var bal = $('[data-balance]');
    bal.textContent = P.fmt.credits(acct.credits);
    bal.className = 'metric__value' + (level ? ' is-' + level : '');
    var meter = $('[data-balance-meter]');
    meter.style.width = pct + '%';
    meter.className = 'meter__fill' + (level ? ' is-' + level : '');
    $('[data-balance-sub]').textContent = 'about '
      + P.fmt.money(acct.credits / 100) + ' of usage at list price';

    $('[data-burn]').textContent = P.fmt.credits(burn);
    $('[data-burn-sub]').textContent = 'roughly ' + P.fmt.money(burn * 30 / 100) + ' a month at this rate';

    var d = $('[data-days]');
    d.textContent = days === Infinity ? '∞' : String(days);
    d.className = 'metric__value' + (level ? ' is-' + level : '');
    $('[data-days-sub]').textContent = acct.autoTopUp.enabled
      ? 'auto top-up will fire before this runs out'
      : 'no auto top-up — you will run dry';

    /* low balance warning, only when it is actually true */
    $('[data-low-banner]').innerHTML = days <= 10 && !acct.autoTopUp.enabled
      ? '<div class="banner banner--warn"><span><b>Balance running low.</b> About '
        + days + ' days left at your current rate. When credits hit zero the bot stops '
        + 'replying — moderation and automod keep working.</span></div>'
      : '';

    /* usage chart */
    var maxDay = Math.max.apply(null, data.usage.map(P.creditsForDay));
    $('[data-chart]').innerHTML = data.usage.map(function (row) {
      var v = P.creditsForDay(row);
      var weekend = [0, 6].indexOf(new Date(row.day).getDay()) !== -1;
      return '<span class="chart__bar" data-weekend="' + (weekend ? 1 : 0) + '" '
        + 'style="height:' + Math.max(4, (v / maxDay) * 100) + '%" '
        + 'title="' + P.fmt.credits(v) + ' credits"></span>';
    }).join('');

    /* breakdown */
    var totals = P.usageByProvider(data.usage);
    var sum = Object.values(totals).reduce(function (a, b) { return a + b; }, 0) || 1;
    $('[data-breakdown]').innerHTML = Object.keys(totals).map(function (name) {
      var v = totals[name];
      var share = (v / sum) * 100;
      return (
        '<div style="margin-bottom:16px">'
        + '<div style="display:flex;justify-content:space-between;font-size:.87rem;margin-bottom:7px">'
        + '<span>' + name + '</span>'
        + '<span class="dim">' + P.fmt.credits(v) + ' &middot; ' + share.toFixed(0) + '%</span>'
        + '</div>'
        + '<div class="meter" style="margin:0"><span class="meter__fill" style="width:' + share + '%"></span></div>'
        + '</div>'
      );
    }).join('')
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

    var toggle = $('[data-autotopup]');
    toggle.classList.toggle('is-on', acct.autoTopUp.enabled);
    var tp = P.CREDIT_PACKS.filter(function (p) { return p.id === acct.autoTopUp.packId; })[0];
    $('[data-autotopup-detail]').textContent = acct.autoTopUp.enabled
      ? 'Buys ' + P.fmt.compact(tp.credits) + ' credits (' + P.fmt.money(tp.price)
        + ') whenever the balance drops below ' + P.fmt.credits(acct.autoTopUp.threshold) + '.'
      : 'Off. The bot stops replying if the balance reaches zero.';
  }

  function renderEnterprise(data) {
    var live = data.servers.filter(function (s) { return s.status === 'ready'; });
    $('[data-ent-servers]').textContent = String(live.length);
    $('[data-ent-fee]').textContent = P.fmt.money(live.length * ENTERPRISE_FEE)
      + ' / month platform fee (' + P.fmt.money(ENTERPRISE_FEE) + ' per server)';

    var window30 = data.usage.slice(-30);
    var replies = window30.reduce(function (a, r) { return a + r.replies; }, 0);
    var voice = window30.reduce(function (a, r) { return a + r.voiceMinutes; }, 0);
    $('[data-ent-replies]').textContent = P.fmt.compact(replies);
    $('[data-ent-voice]').textContent = P.fmt.compact(voice);

    var KEYS = [
      { id: 'openrouter', name: 'OpenRouter', hint: 'AI replies and all background work.' },
      { id: 'transcription', name: 'Transcription (OpenAI or Groq)', hint: 'Voice channel monitoring.' },
      { id: 'fish', name: 'Fish Audio', hint: 'Spoken replies. edge-tts is the free fallback.' },
    ];
    var stored = data.account.keys || { openrouter: 'active', transcription: 'active', fish: 'not-supplied' };
    $('[data-ent-keys]').innerHTML = KEYS.map(function (k) {
      var st = stored[k.id] || 'not-supplied';
      var cls = st === 'active' ? 'pill--ok' : (st === 'pending' ? 'pill--warn' : 'pill--idle');
      return (
        '<div class="keyrow"><div>'
        + '<div class="keyrow__name">' + k.name + '</div>'
        + '<div class="keyrow__hint">' + k.hint + '</div>'
        + '<input type="password" autocomplete="off" placeholder="paste a new key to rotate" data-rotate="' + k.id + '">'
        + '</div><div><span class="pill ' + cls + '">' + st.replace('-', ' ') + '</span></div></div>'
      );
    }).join('')
      + '<div class="hint" style="margin-top:14px">Rotating a key takes effect on the next '
      + 'request. Nothing is re-encrypted or re-deployed, and the bot does not restart.</div>';
  }

  function renderServers(data, enterprise) {
    var rows = data.servers.map(function (s) {
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
        + '<div class="dim">' + esc(s.botName) + ' &middot; '
        + P.fmt.compact(s.members) + ' members</div></td>'
        + '<td><span class="pill ' + statusCls + '">' + s.status + '</span></td>'
        + '<td>' + tier.name + '</td>'
        + '<td><div class="modlist">' + mods + extra + '</div></td>'
        + '<td class="num">' + (enterprise ? '—' : P.fmt.credits(s.creditsThisPeriod)) + '</td>'
        + '<td style="white-space:nowrap">'
        + (canUpgrade
          ? '<button class="btn btn--ghost btn--sm" data-upgrade="' + s.id + '">Upgrade</button>'
          : '<span class="dim">top tier</span>')
        + '</td></tr>'
      );
    }).join('');

    $('[data-servers]').innerHTML =
      '<thead><tr><th>Server</th><th>Status</th><th>Tier</th><th>Modules</th>'
      + '<th class="num">' + (enterprise ? 'Usage' : 'Credits this period') + '</th><th></th></tr></thead>'
      + '<tbody>' + (rows || '<tr><td colspan="6" class="empty">No servers yet.</td></tr>') + '</tbody>';

    $('[data-servers-note]').textContent = enterprise
      ? P.fmt.money(data.servers.filter(function (s) { return s.status === 'ready'; }).length * ENTERPRISE_FEE)
        + ' / month across ' + data.servers.length + ' server(s)'
      : data.servers.length + ' server(s) on this account';
  }

  /* ---------- events ---------- */

  document.addEventListener('click', function (e) {
    var t = e.target;

    var pack = t.closest('[data-pack]');
    if (pack) { selectedPack = pack.dataset.pack; return render(); }

    if (t.closest('[data-buy]')) {
      var chosen = P.CREDIT_PACKS.filter(function (p) { return p.id === selectedPack; })[0];
      P.Store.update(function (d) { d.account.credits += chosen.credits; });
      return render();
    }

    if (t.closest('[data-autotopup]')) {
      P.Store.update(function (d) {
        d.account.autoTopUp.enabled = !d.account.autoTopUp.enabled;
      });
      return render();
    }

    var up = t.closest('[data-upgrade]');
    if (up) {
      P.Store.update(function (d) {
        var srv = d.servers.filter(function (s) { return s.id === up.dataset.upgrade; })[0];
        if (!srv) return;
        var next = C.TIERS[Math.min(C.TIER_INDEX[srv.tier] + 1, C.TIERS.length - 1)];
        srv.tier = next.id;
        // The account tier tracks the highest tier any of its servers is on,
        // which is what the header badge is claiming.
        var highest = d.servers.reduce(function (m, s) {
          return Math.max(m, C.TIER_INDEX[s.tier]);
        }, 0);
        d.account.tier = C.TIERS[highest].id;
      });
      return render();
    }

    if (t.closest('[data-venue-toggle]')) {
      P.Store.update(function (d) {
        d.account.venue = d.account.venue === 'enterprise' ? 'managed' : 'enterprise';
        if (d.account.venue === 'enterprise' && !d.account.keys) {
          d.account.keys = { openrouter: 'active', transcription: 'active', fish: 'not-supplied' };
        }
      });
      return render();
    }

    if (t.closest('[data-reset]')) {
      P.Store.reset();
      selectedPack = 'pack-50';
      return render();
    }
  });

  render();
})();
