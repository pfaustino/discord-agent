/* Internal queue.

   This is the "and then we manage what gets selected" half of onboarding. The
   automated stages have already run by the time an order lands here; what is
   left is a person deciding what the bot should actually do, building it out
   with the customer, and — for enterprise — confirming the keys arrived.

   It is also where credit gets issued. There is no payment processor: the
   customer pays us the way we agreed, and somebody here records it against a
   reference. That is the whole funding path today.

   Everything here goes through PLATFORM.API and needs a staff account. */
(function () {
  'use strict';

  var P = window.PLATFORM;
  var C = window.CATALOG;
  if (!P || !C) return;

  var $ = function (s) { return document.querySelector(s); };
  var selected = null;
  var queue = [];
  var accounts = [];
  var accountDetail = null;
  var notesTimer = null;

  var CAPS = {};
  C.GROUPS.forEach(function (g) {
    g.caps.forEach(function (c) { CAPS[c.id] = Object.assign({ group: g.id }, c); });
  });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  function byId(id) {
    return queue.filter(function (r) { return r.id === id; })[0] || null;
  }

  function flash(message, warn) {
    var box = $('[data-flash]');
    if (!box) return;
    box.innerHTML = message
      ? '<div class="banner' + (warn ? ' banner--warn' : '') + '"><span>'
        + esc(message) + '</span></div>' : '';
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
        + '<span class="pipe__name">' + esc(step.name) + '</span>'
        + '<span class="pipe__auto">' + (step.auto ? 'automatic' : 'needs a person') + '</span>'
        + '</div>'
      );
    }).join('');
  }

  /* ---------- load ---------- */

  async function load() {
    try {
      await P.API.catalog();
      var q = await P.API.queue();
      queue = q.requests;
      var a = await P.API.accounts();
      accounts = a.accounts;
    } catch (err) {
      $('[data-gate]').hidden = false;
      $('[data-gate]').innerHTML = '<div class="card2" style="max-width:520px;margin:40px auto">'
        + '<div class="card2__head"><h2 class="card2__title">Staff only</h2></div>'
        + '<p class="dim">' + esc(err.status === 401
          ? 'Sign in with a staff account to see the queue.'
          : (err.status === 403
            ? 'That account is not staff. Add its email to PLATFORM_STAFF_EMAILS.'
            : err.message)) + '</p>'
        + '<a class="btn btn--primary" style="margin-top:14px" href="app.html">Go to sign in</a>'
        + '</div>';
      $('[data-console]').hidden = true;
      return;
    }
    $('[data-gate]').hidden = true;
    $('[data-console]').hidden = false;
    render();
  }

  async function reload() {
    var q = await P.API.queue();
    queue = q.requests;
    var a = await P.API.accounts();
    accounts = a.accounts;
    render();
  }

  /* ---------- render ---------- */

  function render() {
    var waiting = queue.filter(function (r) { return r.stage !== 'ready' && r.stage !== 'rejected'; });
    var ent = queue.filter(function (r) {
      return r.venue === 'enterprise' && r.stage !== 'ready';
    });

    $('[data-count-waiting]').textContent = waiting.length + ' waiting';
    $('[data-count-total]').textContent = queue.length + ' total';
    $('[data-stat-review]').textContent = String(
      queue.filter(function (r) { return r.stage === 'review' && r.venue === 'managed'; }).length,
    );
    $('[data-stat-ent]').textContent = String(ent.length);
    $('[data-stat-ready]').textContent = String(
      queue.filter(function (r) { return r.stage === 'ready'; }).length,
    );

    $('[data-queue]').innerHTML =
      '<thead><tr><th>Account</th><th>Venue</th><th>Tier</th><th>Stage</th>'
      + '<th>Blocked on</th><th>Age</th></tr></thead><tbody>'
      + (queue.length ? queue.map(rowHTML).join('')
        : '<tr><td colspan="6" class="empty">Queue is empty.</td></tr>')
      + '</tbody>';

    renderDetail();
    renderAccounts();
  }

  function rowHTML(r) {
    var tier = C.TIERS.filter(function (t) { return t.id === r.tier; })[0] || C.TIERS[0];
    var blocked = r.needsHuman || P.needsHuman(r);
    var stageCls = r.stage === 'ready' ? 'pill--ok'
      : (r.stage === 'provisioning' ? 'pill--warn' : 'pill--idle');
    return (
      '<tr class="is-clickable' + (selected === r.id ? ' is-on' : '') + '" data-row="' + r.id + '">'
      + '<td><span class="strong">' + esc(r.accountName || '—') + '</span>'
      + '<div class="dim">' + esc(r.serverName) + ' &middot; ' + esc(r.botName || '—') + '</div></td>'
      + '<td><span class="pill ' + (r.venue === 'enterprise' ? 'pill--enterprise' : 'pill--managed')
      + '">' + esc(r.venue) + '</span></td>'
      + '<td>' + esc(tier.name) + '</td>'
      + '<td><span class="pill ' + stageCls + '">' + esc(r.stage) + '</span></td>'
      + '<td class="dim">' + esc(blocked || '—') + '</td>'
      + '<td class="dim">' + P.fmt.when(r.submittedAt) + '</td>'
      + '</tr>'
    );
  }

  function renderDetail() {
    var r = selected ? byId(selected) : null;
    $('[data-detail]').hidden = !r;
    if (!r) return;

    $('[data-detail-title]').textContent = r.accountName || r.serverName;
    $('[data-detail-id]').textContent = r.id;
    $('[data-detail-stage]').textContent = r.needsHuman || P.needsHuman(r) || 'nothing blocking';
    $('[data-detail-pipe]').innerHTML = pipelineHTML(r.stage);

    var atEnd = r.stage === 'ready' || r.stage === 'rejected';
    var next = P.PIPELINE[P.PIPELINE_INDEX[r.stage] + 1];
    $('[data-advance]').disabled = atEnd || !next;
    $('[data-advance]').textContent = next ? 'Move to ' + next.name.toLowerCase() : 'Done';
    $('[data-hold]').disabled = atEnd;
    $('[data-advance-note]').textContent = atEnd
      ? 'Finished. The bot shows up on the customer dashboard.'
      : (r.venue === 'enterprise'
        ? 'Confirm the keys have landed before provisioning — nothing runs on keys we did not receive.'
        : (r.accountId
          ? 'Approving creates the bot record. Attach the Discord server once it is invited.'
          : 'This order has no account attached — the customer needs to sign up first, '
            + 'with ' + (r.email || 'the email on the order') + '.'));

    var tier = C.TIERS.filter(function (t) { return t.id === r.tier; })[0] || C.TIERS[0];
    var keys = (r.details && r.details.keys) || {};

    $('[data-detail-account]').innerHTML = [
      ['Contact', esc(r.email || '—')],
      ['Account', r.accountId ? esc(r.accountId) : '<span class="pill pill--warn">not signed up</span>'],
      ['Discord server', esc(r.serverName)],
      ['Bot name', esc(r.botName || '—')],
      ['Submitted', P.fmt.when(r.submittedAt)],
    ].map(kv).join('');

    var planRows = [['Tier', esc(tier.name) + ' — ' + (tier.price ? P.fmt.money(tier.price) + '/mo' : 'free')]];
    if (r.venue === 'managed') {
      var pack = (r.details && r.details.packId)
        ? P.CREDIT_PACKS.filter(function (p) { return p.id === r.details.packId; })[0] : null;
      planRows.push(['Quoted pack', pack
        ? P.fmt.credits(pack.credits) + ' (' + P.fmt.money(pack.price) + ')' : '—']);
    } else {
      planRows.push(['OpenRouter key', keyPill(keys.openrouter)]);
      planRows.push(['Transcription key', keyPill(keys.transcription)]);
      planRows.push(['Fish Audio key', keyPill(keys.fish)]);
    }
    $('[data-detail-plan]').innerHTML = planRows.map(kv).join('');

    /* Capability management — the actual point of this screen. */
    $('[data-detail-modules]').innerHTML = C.GROUPS.map(function (g) {
      var caps = g.caps.filter(function (c) { return c.builder; });
      if (!caps.length) return '';
      return (
        '<div class="modgroup"><div class="modgroup__head">'
        + '<span class="ico">' + g.icon + '</span><h3>' + esc(g.name) + '</h3></div>'
        + '<div class="mods">'
        + caps.map(function (c) {
          var on = r.modules.indexOf(c.id) !== -1;
          return (
            '<div class="mod' + (on ? ' is-on' : '') + '" data-mod="' + c.id + '" role="checkbox" '
            + 'aria-checked="' + on + '" tabindex="0">'
            + '<span class="mod__box"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" '
            + 'stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">'
            + '<path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg></span>'
            + '<span class="mod__text"><span class="mod__name">' + esc(c.name)
            + '<span class="lock' + (C.TIER_INDEX[c.tier] <= C.TIER_INDEX[r.tier] ? ' lock--in' : '')
            + '">' + esc(c.tier) + '</span></span>'
            + '<span class="mod__detail">' + esc(c.detail) + '</span></span></div>'
          );
        }).join('')
        + '</div></div>'
      );
    }).join('');

    /* The backend validates the same rules; this is the same answer shown
       where the toggling happens, so the problem is visible as it is made. */
    var problems = (r.details && r.details.validationErrors) || [];
    var need = requiredTier(r.modules);
    $('[data-detail-tierwarn]').innerHTML = problems.length
      ? '<div class="banner banner--warn" style="margin-top:16px"><span>'
        + esc(problems.join('; '))
        + (C.TIER_INDEX[need.id] > C.TIER_INDEX[r.tier]
          ? ' Moving to <b>' + esc(need.name) + '</b> would cover it.' : '')
        + '</span></div>'
      : '';

    var notes = $('[data-detail-notes]');
    if (document.activeElement !== notes && notes.value !== r.notes) notes.value = r.notes || '';
  }

  function renderAccounts() {
    $('[data-accounts]').innerHTML =
      '<thead><tr><th>Account</th><th>Venue</th><th class="num">Balance</th>'
      + '<th class="num">Bots</th><th></th></tr></thead><tbody>'
      + (accounts.length ? accounts.map(function (a) {
        return (
          '<tr class="is-clickable' + (accountDetail && accountDetail.account.id === a.id ? ' is-on' : '')
          + '" data-account="' + a.id + '">'
          + '<td><span class="strong">' + esc(a.name) + '</span>'
          + '<div class="dim">' + esc(a.email) + (a.isStaff ? ' &middot; staff' : '') + '</div></td>'
          + '<td><span class="pill ' + (a.venue === 'enterprise' ? 'pill--enterprise' : 'pill--managed')
          + '">' + esc(a.venue) + '</span></td>'
          + '<td class="num strong">' + P.fmt.credits(a.credits) + '</td>'
          + '<td class="num">' + a.servers + '</td>'
          + '<td><button class="btn btn--ghost btn--sm" data-account="' + a.id + '">Open</button></td>'
          + '</tr>'
        );
      }).join('') : '<tr><td colspan="5" class="empty">No accounts yet.</td></tr>')
      + '</tbody>';

    var box = $('[data-account-detail]');
    box.hidden = !accountDetail;
    if (!accountDetail) return;
    var a = accountDetail.account;
    var servers = accountDetail.servers;

    $('[data-account-title]').textContent = a.name;
    $('[data-account-sub]').textContent = a.email + ' · ' + a.venue
      + ' · ' + P.fmt.credits(accountDetail.credits.balance) + ' credits';

    $('[data-account-servers]').innerHTML = servers.length
      ? servers.map(function (s) {
        return (
          '<div class="rail__line"><span>' + esc(s.name) + ' <span class="dim">('
          + esc(s.status) + ')</span></span><b>'
          + (s.guildId
            ? esc(s.guildId)
            : '<input class="input" placeholder="Discord server id" '
              + 'data-guild-for="' + s.id + '" style="width:190px;display:inline-block">'
              + '<button class="btn btn--ghost btn--sm" data-attach="' + s.id + '">Attach</button>')
          + (s.guildId && s.status !== 'ready'
            ? ' <button class="btn btn--ghost btn--sm" data-ready="' + s.id + '">Mark ready</button>'
            : '')
          + '</b></div>'
        );
      }).join('')
      : '<div class="dim">No bots on this account yet.</div>';

    $('[data-grants]').innerHTML = accountDetail.grants.length
      ? accountDetail.grants.map(function (g) {
        return '<div class="rail__line"><span>' + P.fmt.credits(g.credits) + ' credits'
          + ' <span class="dim">' + esc(g.reference || '') + '</span></span>'
          + '<b class="dim">' + P.fmt.when(g.at) + '</b></div>';
      }).join('')
      : '<div class="dim">Nothing issued yet.</div>';

    var opts = P.CREDIT_PACKS.map(function (p) {
      return '<option value="' + p.id + '">' + P.fmt.compact(p.credits) + ' credits — '
        + P.fmt.money(p.price) + '</option>';
    }).join('');
    var picker = $('[data-issue-pack]');
    if (picker.innerHTML !== opts + '<option value="">Custom amount</option>') {
      picker.innerHTML = opts + '<option value="">Custom amount</option>';
    }
  }

  function kv(pair) {
    return '<div class="rail__line"><span>' + pair[0] + '</span><b>' + pair[1] + '</b></div>';
  }

  function keyPill(state) {
    var s = state || 'not-supplied';
    var cls = s === 'supplied' ? 'pill--ok' : (s === 'pending' ? 'pill--warn' : 'pill--idle');
    return '<span class="pill ' + cls + '">' + esc(s.replace('-', ' ')) + '</span>';
  }

  /* ---------- events ---------- */

  document.addEventListener('click', async function (e) {
    var t = e.target;

    var acctBtn = t.closest('[data-account]');
    if (acctBtn) {
      var id = acctBtn.dataset.account;
      try {
        accountDetail = (accountDetail && accountDetail.account.id === id)
          ? null : await P.API.account(id);
        render();
      } catch (err) { flash(err.message, true); }
      return;
    }

    var row = t.closest('[data-row]');
    if (row) {
      selected = selected === row.dataset.row ? null : row.dataset.row;
      render();
      if (selected) $('[data-detail]').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    var mod = t.closest('[data-mod]');
    if (mod && selected) {
      var r = byId(selected);
      var mods = r.modules.slice();
      var at = mods.indexOf(mod.dataset.mod);
      if (at === -1) mods.push(mod.dataset.mod);
      else mods.splice(at, 1);
      try {
        var updated = await P.API.updateRequest(selected, { modules: mods });
        Object.assign(r, updated.request);
        render();
      } catch (err) { flash(err.message, true); }
      return;
    }

    if (t.closest('[data-advance]') && selected) {
      var cur = byId(selected);
      var next = P.PIPELINE[P.PIPELINE_INDEX[cur.stage] + 1];
      if (!next) return;
      try {
        // Moving into provisioning is what creates the bot record, and it has
        // to be the same idempotent call the backend guards — not a second
        // path that could make a duplicate.
        if (next.id === 'provisioning') await P.API.approve(selected);
        else await P.API.advance(selected, next.id);
        flash('Moved to ' + next.name.toLowerCase() + '.');
        await reload();
      } catch (err) { flash(err.message, true); }
      return;
    }

    if (t.closest('[data-hold]') && selected) {
      // Terminal on purpose — there is no walking a rejection back onto the
      // happy path, because "we already told them no" is not a state you want
      // to leave reversible by a stray click.
      // eslint-disable-next-line no-alert
      if (!window.confirm('Reject this order? That cannot be undone.')) return;
      try {
        await P.API.advance(selected, 'rejected');
        flash('Order rejected.');
        await reload();
      } catch (err) { flash(err.message, true); }
      return;
    }

    var attach = t.closest('[data-attach]');
    if (attach) {
      var input = document.querySelector('[data-guild-for="' + attach.dataset.attach + '"]');
      try {
        await P.API.attachGuild(attach.dataset.attach, input.value.trim());
        flash('Discord server attached — this bot now bills to this account.');
        accountDetail = await P.API.account(accountDetail.account.id);
        render();
      } catch (err) { flash(err.message, true); }
      return;
    }

    var ready = t.closest('[data-ready]');
    if (ready) {
      try {
        await P.API.setServerStatus(ready.dataset.ready, 'ready');
        accountDetail = await P.API.account(accountDetail.account.id);
        render();
      } catch (err) { flash(err.message, true); }
      return;
    }

    if (t.closest('[data-issue]') && accountDetail) {
      var packId = $('[data-issue-pack]').value;
      var amount = parseFloat($('[data-issue-amount]').value);
      var reference = $('[data-issue-reference]').value.trim();
      try {
        var result = await P.API.issueCredits(accountDetail.account.id, {
          packId: packId || null,
          credits: packId ? null : amount,
          reference: reference,
          note: $('[data-issue-note]').value.trim() || null,
        });
        flash(result.granted
          ? 'Issued. Balance is now ' + P.fmt.credits(result.balance) + ' credits.'
          : 'Already issued — nothing changed.');
        $('[data-issue-reference]').value = '';
        $('[data-issue-note]').value = '';
        accountDetail = await P.API.account(accountDetail.account.id);
        await reload();
      } catch (err) { flash(err.message, true); }
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var mod = e.target.closest && e.target.closest('[data-mod]');
    if (!mod) return;
    e.preventDefault();
    mod.click();
  });

  /* Notes save on a pause rather than a keystroke — a PUT per character would
     be silly, and losing the last few characters to a missed blur is worse. */
  document.addEventListener('input', function (e) {
    if (!e.target.matches('[data-detail-notes]') || !selected) return;
    var value = e.target.value;
    var id = selected;
    clearTimeout(notesTimer);
    notesTimer = setTimeout(function () {
      P.API.updateRequest(id, { notes: value }).then(function (updated) {
        var r = byId(id);
        if (r) Object.assign(r, updated.request);
      }, function (err) { flash(err.message, true); });
    }, 600);
  });

  load();
})();
