/* Internal provisioning queue.

   This is the "and then we manage what gets selected" half of onboarding. The
   automated stages have already run by the time a request lands here; what is
   left is a human deciding whether the module set is right, and — for
   enterprise — whether the keys have actually arrived.

   Approving from here mutates the same store the customer dashboard reads, so
   provisioning a request makes a server appear on their account. */
(function () {
  'use strict';

  var P = window.PLATFORM;
  var C = window.CATALOG;
  if (!P || !C) return;

  var $ = function (s) { return document.querySelector(s); };
  var selected = null;

  var CAPS = {};
  C.GROUPS.forEach(function (g) {
    g.caps.forEach(function (c) { CAPS[c.id] = Object.assign({ group: g.id }, c); });
  });

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  function requests() { return P.Store.read().requests; }

  function byId(id) {
    return requests().filter(function (r) { return r.id === id; })[0] || null;
  }

  /** Lowest tier that covers every module currently switched on. */
  function requiredTier(modules) {
    var idx = modules.reduce(function (max, id) {
      var cap = CAPS[id];
      return cap ? Math.max(max, C.TIER_INDEX[cap.tier]) : max;
    }, 0);
    return C.TIERS[idx];
  }

  function pipelineHTML(stageId) {
    var at = P.PIPELINE_INDEX[stageId];
    return P.PIPELINE.map(function (step, i) {
      var cls = i < at ? ' is-done' : (i === at ? ' is-on' : '');
      return (
        '<div class="pipe__step' + cls + '">'
        + '<span class="pipe__dot">' + (i < at ? '&#10003;' : (i + 1)) + '</span>'
        + '<span class="pipe__name">' + step.name + '</span>'
        + '<span class="pipe__auto">' + (step.auto ? 'automatic' : 'needs a person') + '</span>'
        + '</div>'
      );
    }).join('');
  }

  /* ---------- render ---------- */

  function render() {
    var all = requests();
    var waiting = all.filter(function (r) { return r.stage !== 'ready'; });
    var ent = all.filter(function (r) { return r.venue === 'enterprise' && r.stage !== 'ready'; });

    $('[data-count-waiting]').textContent = waiting.length + ' waiting';
    $('[data-count-total]').textContent = all.length + ' total';
    $('[data-stat-review]').textContent = String(
      all.filter(function (r) { return r.stage === 'review' && r.venue === 'managed'; }).length,
    );
    $('[data-stat-ent]').textContent = String(ent.length);
    $('[data-stat-ready]').textContent = String(
      all.filter(function (r) { return r.stage === 'ready'; }).length,
    );

    $('[data-queue]').innerHTML =
      '<thead><tr><th>Account</th><th>Venue</th><th>Tier</th><th>Stage</th>'
      + '<th>Blocked on</th><th>Age</th></tr></thead><tbody>'
      + (all.length ? all.map(rowHTML).join('')
        : '<tr><td colspan="6" class="empty">Queue is empty. Submit one from the onboarding form.</td></tr>')
      + '</tbody>';

    renderDetail();
  }

  function rowHTML(r) {
    var tier = C.TIERS.filter(function (t) { return t.id === r.tier; })[0] || C.TIERS[0];
    var blocked = P.needsHuman(r);
    var stageCls = r.stage === 'ready' ? 'pill--ok'
      : (r.stage === 'provisioning' ? 'pill--warn' : 'pill--idle');
    return (
      '<tr class="is-clickable' + (selected === r.id ? ' is-on' : '') + '" data-row="' + r.id + '">'
      + '<td><span class="strong">' + esc(r.accountName) + '</span>'
      + '<div class="dim">' + esc(r.serverName) + ' &middot; ' + esc(r.botName) + '</div></td>'
      + '<td><span class="pill ' + (r.venue === 'enterprise' ? 'pill--enterprise' : 'pill--managed')
      + '">' + (r.venue === 'enterprise' ? 'enterprise' : 'managed') + '</span></td>'
      + '<td>' + tier.name + '</td>'
      + '<td><span class="pill ' + stageCls + '">' + r.stage + '</span></td>'
      + '<td class="dim">' + (blocked || '—') + '</td>'
      + '<td class="dim">' + P.fmt.when(r.submittedAt) + '</td>'
      + '</tr>'
    );
  }

  function renderDetail() {
    var r = selected ? byId(selected) : null;
    $('[data-detail]').hidden = !r;
    if (!r) return;

    $('[data-detail-title]').textContent = r.accountName;
    $('[data-detail-id]').textContent = r.id;
    $('[data-detail-stage]').textContent = P.needsHuman(r) || 'nothing blocking';
    $('[data-detail-pipe]').innerHTML = pipelineHTML(r.stage);

    var atEnd = r.stage === 'ready';
    $('[data-advance]').disabled = atEnd;
    $('[data-hold]').disabled = r.stage === 'review';
    $('[data-advance-note]').textContent = atEnd
      ? 'Provisioned. The server is live on the customer dashboard.'
      : (r.venue === 'enterprise'
        ? 'Confirm the keys have landed before approving — nothing runs on keys we did not receive.'
        : 'Approving runs the remaining automatic stages and issues the invite.');

    var pack = r.packId
      ? P.CREDIT_PACKS.filter(function (p) { return p.id === r.packId; })[0] : null;
    var tier = C.TIERS.filter(function (t) { return t.id === r.tier; })[0] || C.TIERS[0];

    $('[data-detail-account]').innerHTML = [
      ['Contact', esc(r.email || '—')],
      ['Discord server', esc(r.serverName)],
      ['Bot name', esc(r.botName)],
      ['Submitted', P.fmt.when(r.submittedAt)],
    ].map(kv).join('');

    var planRows = [['Tier', tier.name + ' — ' + (tier.price ? P.fmt.money(tier.price) + '/mo' : 'free')]];
    if (r.venue === 'managed') {
      planRows.push(['Starting credits', pack
        ? P.fmt.credits(pack.credits) + ' (' + P.fmt.money(pack.price) + ')' : '—']);
    } else {
      var keys = r.keys || {};
      planRows.push(['OpenRouter key', keyPill(keys.openrouter)]);
      planRows.push(['Transcription key', keyPill(keys.transcription)]);
      planRows.push(['Fish Audio key', keyPill(keys.fish)]);
    }
    $('[data-detail-plan]').innerHTML = planRows.map(kv).join('');

    /* Module management — the actual point of this screen. */
    $('[data-detail-modules]').innerHTML = C.GROUPS.map(function (g) {
      var caps = g.caps.filter(function (c) { return c.builder; });
      if (!caps.length) return '';
      return (
        '<div class="modgroup"><div class="modgroup__head">'
        + '<span class="ico">' + g.icon + '</span><h3>' + g.name + '</h3></div>'
        + '<div class="mods">'
        + caps.map(function (c) {
          var on = r.modules.indexOf(c.id) !== -1;
          return (
            '<div class="mod' + (on ? ' is-on' : '') + '" data-mod="' + c.id + '" role="checkbox" '
            + 'aria-checked="' + on + '" tabindex="0">'
            + '<span class="mod__box"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" '
            + 'stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg></span>'
            + '<span class="mod__text"><span class="mod__name">' + c.name
            + '<span class="lock' + (C.TIER_INDEX[c.tier] <= C.TIER_INDEX[r.tier] ? ' lock--in' : '')
            + '">' + c.tier + '</span></span>'
            + '<span class="mod__detail">' + c.detail + '</span></span></div>'
          );
        }).join('')
        + '</div></div>'
      );
    }).join('');

    /* If a toggle pushed the module set above the paid-for tier, say so here
       rather than letting provisioning quietly grant something unpaid. */
    var need = requiredTier(r.modules);
    $('[data-detail-tierwarn]').innerHTML =
      C.TIER_INDEX[need.id] > C.TIER_INDEX[r.tier]
        ? '<div class="banner banner--warn" style="margin-top:16px"><span>'
          + 'These modules need the <b>' + need.name + '</b> tier but this request is on <b>'
          + tier.name + '</b>. Approving would grant ' + P.fmt.money(need.price - tier.price)
          + '/mo of capability unbilled — move the tier up or switch modules off.'
          + '</span></div>'
        : '';

    var notes = $('[data-detail-notes]');
    if (notes.value !== r.notes) notes.value = r.notes || '';
  }

  function kv(pair) {
    return '<div class="rail__line"><span>' + pair[0] + '</span><b>' + pair[1] + '</b></div>';
  }

  function keyPill(state) {
    var s = state || 'not-supplied';
    var cls = s === 'supplied' ? 'pill--ok' : (s === 'pending' ? 'pill--warn' : 'pill--idle');
    return '<span class="pill ' + cls + '">' + s.replace('-', ' ') + '</span>';
  }

  /** Approving walks to `ready` and materialises the server on the account. */
  function provision(id) {
    P.Store.update(function (data) {
      var r = data.requests.filter(function (x) { return x.id === id; })[0];
      if (!r || r.stage === 'ready') return;
      r.stage = 'ready';
      if (!data.servers.some(function (s) { return s.requestId === r.id; })) {
        data.servers.push({
          id: P.newId('srv'),
          requestId: r.id,
          name: r.serverName,
          botName: r.botName,
          accent: r.accent || 'blurple',
          members: 0,
          status: 'ready',
          tier: r.tier,
          modules: r.modules.slice(),
          creditsThisPeriod: 0,
          provisionedAt: Date.now(),
        });
      }
      if (r.venue === 'managed' && r.packId) {
        var pack = P.CREDIT_PACKS.filter(function (p) { return p.id === r.packId; })[0];
        if (pack) data.account.credits += pack.credits;
      }
    });
  }

  /* ---------- events ---------- */

  document.addEventListener('click', function (e) {
    var t = e.target;

    var row = t.closest('[data-row]');
    if (row) {
      selected = selected === row.dataset.row ? null : row.dataset.row;
      render();
      if (selected) $('[data-detail]').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    var mod = t.closest('[data-mod]');
    if (mod && selected) {
      P.Store.update(function (data) {
        var r = data.requests.filter(function (x) { return x.id === selected; })[0];
        if (!r) return;
        var at = r.modules.indexOf(mod.dataset.mod);
        if (at === -1) r.modules.push(mod.dataset.mod);
        else r.modules.splice(at, 1);
      });
      return render();
    }

    if (t.closest('[data-advance]') && selected) { provision(selected); return render(); }

    if (t.closest('[data-hold]') && selected) {
      P.Store.update(function (data) {
        var r = data.requests.filter(function (x) { return x.id === selected; })[0];
        if (r) r.stage = 'review';
      });
      return render();
    }

    if (t.closest('[data-reset]')) {
      P.Store.reset();
      selected = null;
      return render();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var mod = e.target.closest && e.target.closest('[data-mod]');
    if (!mod) return;
    e.preventDefault();
    mod.click();
  });

  document.addEventListener('input', function (e) {
    if (!e.target.matches('[data-detail-notes]') || !selected) return;
    P.Store.update(function (data) {
      var r = data.requests.filter(function (x) { return x.id === selected; })[0];
      if (r) r.notes = e.target.value;
    });
  });

  render();
})();
