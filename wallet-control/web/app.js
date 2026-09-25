// LEASH wallet-control — customer UI logic.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const chf = (n) => `CHF ${Number(n).toFixed(2)}`;

let currentDraft = null;
let seenFeedIds = new Set();

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- header ----------
function setChips(state) {
  const mode = $('mode-chip');
  mode.textContent = state.mode === 'LIVE PLATFORM' ? 'LIVE' : 'OFFLINE SIM';
  mode.classList.toggle('live', state.mode === 'LIVE PLATFORM');
  const man = $('mandate-chip');
  const m = state.mandate;
  if (m && m.status === 'active') { man.textContent = 'policy active'; man.className = 'chip ok'; }
  else if (m && m.status === 'revoked') { man.textContent = 'policy revoked'; man.className = 'chip live'; }
  else if (m) { man.textContent = 'draft (not active)'; man.className = 'chip'; }
  else { man.textContent = 'no mandate'; man.className = 'chip'; }
}

// ---------- policy panel ----------
function renderScenarios(state) {
  const wrap = $('scenario-chips');
  if (wrap.dataset.done) return;
  wrap.dataset.done = '1';
  const sel = $('scenario-select');
  for (const s of state.scenarios) {
    const b = document.createElement('button');
    b.textContent = `${s.scenario_id} · ${s.name}`;
    b.title = s.instruction;
    b.onclick = () => {
      $('instruction').value = s.instruction;
      wrap.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    };
    wrap.appendChild(b);
    const opt = document.createElement('option');
    opt.value = s.scenario_id;
    opt.textContent = `${s.scenario_id} — ${s.name} (${s.event_count} purchases)`;
    sel.appendChild(opt);
  }
}

function renderBanner(state) {
  const banner = $('mandate-banner');
  const m = state.mandate;
  if (!m || !['active', 'revoked'].includes(m.status)) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  banner.classList.toggle('revoked', m.status === 'revoked');
  $('mandate-status').textContent = m.status === 'active'
    ? `— the agent may operate under these permissions (${(m.hard_rules || []).length} rules).`
    : '— REVOKED. The agent can no longer spend.';
  $('mandate-rules').innerHTML = (m.hard_rules || [])
    .map(r => `• <code>${esc(r.field)} ${esc(r.operator)} ${esc(JSON.stringify(r.value))}${r.period_days ? ` / ${r.period_days}d rolling` : ''}</code>`)
    .join('<br>');
}

async function compile() {
  const instruction = $('instruction').value.trim();
  if (!instruction) return alert('Write an instruction first.');
  currentDraft = await api('/api/policy/compile', 'POST', { instruction });
  const u = $('understood');
  u.innerHTML = currentDraft.understood.map(p =>
    `<div class="permission"><span class="p-label">${esc(p.label)}</span><span class="p-plain">${esc(p.plain)}</span></div>`
  ).join('');
  $('warnings').innerHTML = (currentDraft.warnings || []).length
    ? `<div class="warning-box">⚠ ${currentDraft.warnings.map(esc).join('<br>⚠ ')}</div>` : '';
  $('open-questions').innerHTML = (currentDraft.open_questions || []).length
    ? `<div class="question-box"><b>Questions before you confirm:</b><br>• ${currentDraft.open_questions.map(esc).join('<br>• ')}</div>` : '';
  $('rules-json').textContent = JSON.stringify(
    { hard_rules: currentDraft.hard_rules, uncertainty_policy: currentDraft.uncertainty_policy }, null, 2);
  $('draft').classList.remove('hidden');
  $('tighten-box').classList.add('hidden');
}

async function confirmMandate() {
  if (!currentDraft) return;
  const created = await api('/api/mandates', 'POST', {
    instruction: currentDraft.instruction,
    hard_rules: currentDraft.hard_rules,
    uncertainty_policy: currentDraft.uncertainty_policy,
    guidance: currentDraft.guidance,
    open_questions: currentDraft.open_questions,
  });
  await api(`/api/mandates/${created.draft_id}/confirm`, 'POST', { confirmed: true });
  $('draft').classList.add('hidden');
  refresh();
}

function showTighten() { $('tighten-box').classList.remove('hidden'); }

async function addRule() {
  const field = $('tighten-field').value;
  const raw = $('tighten-value').value.trim();
  if (!raw) return;
  let rule;
  if (field === 'authorization.billing_amount_chf') rule = { field, operator: '<=', value: parseFloat(raw), currency: 'CHF', scope: 'purchase' };
  else if (field === 'basket.return_window_days_min') rule = { field, operator: '>=', value: parseInt(raw, 10) };
  else if (field === 'merchant.merchant_category') rule = { field, operator: 'in', value: [raw] };
  else if (field === 'basket.categories') rule = { field, operator: 'in', value: [raw] };
  else if (field === 'merchant.familiar_to_customer') rule = { field, operator: '=', value: 'true' };
  try {
    const cur = await api(`/api/mandates/${state.activeMandateId}`);
    const rules = [...(cur.hard_rules || []), rule];
    await api(`/api/mandates/${state.activeMandateId}`, 'PATCH', { hard_rules: rules });
    $('tighten-msg').textContent = 'Rule added — applies to the next run.';
    $('tighten-value').value = '';
    refresh();
  } catch (e) { $('tighten-msg').textContent = `Rejected: ${e.message}`; }
}

async function autoDecline() {
  try {
    await api(`/api/mandates/${state.activeMandateId}`, 'PATCH', { uncertainty_policy: 'decline' });
    $('tighten-msg').textContent = 'Uncertainty policy is now: decline when unsure.';
    refresh();
  } catch (e) { $('tighten-msg').textContent = `Rejected: ${e.message}`; }
}

async function revoke() {
  if (!confirm('Revoke the wallet policy? The agent immediately loses all spending permission.')) return;
  await api(`/api/mandates/${state.activeMandateId}`, 'DELETE');
  refresh();
}

// ---------- run panel ----------
async function startRun() {
  const scenario = $('scenario-select').value;
  if (!scenario) return;
  await api('/api/runs', 'POST', { scenario_id: scenario });
  seenFeedIds = new Set();
  refresh();
}

function renderFeed(state) {
  const feed = $('feed');
  const items = (state.feed || []).filter(f => f.kind === 'decision' || f.kind === 'resolution' || f.kind === 'mandate' || f.kind === 'run');
  if (!items.length) { feed.innerHTML = ''; return; }
  feed.innerHTML = items.map(f => {
    const key = f.at + f.authorization_id + f.kind;
    if (seenFeedIds.has(key)) return undefined;
    return null;
  }).filter(Boolean).length ? '' : ''; // ids handled below
  feed.innerHTML = items.map(f => {
    if (f.kind === 'error') return `<div class="decision-card" style="border-left-color:var(--red)"><div class="dc-msg">⚠ ${esc(f.text)}</div></div>`;
    if (f.kind === 'run') return `<div class="decision-card" style="border-left-color:var(--ink-soft)"><div class="dc-msg">${esc(f.text)}</div></div>`;
    if (f.kind === 'mandate') return `<div class="decision-card" style="border-left-color:var(--red)"><div class="dc-msg">${esc(f.text)}</div></div>`;
    if (f.kind === 'resolution') return `<div class="decision-card" style="border-left-color:var(--ink-soft)"><div class="dc-msg">👤 ${esc(f.text)}</div></div>`;
    const badge = f.decision === 'approve' ? 'APPROVED' : f.decision === 'decline' ? 'DECLINED' : 'PAUSED · ASKING YOU';
    const conf = f.confidence;
    const confCls = !conf ? '' : conf.percent >= 90 ? 'conf-high' : conf.percent >= 70 ? 'conf-mid' : 'conf-low';
    const confBadge = conf ? `<span class="conf-badge ${confCls}" title="${esc(conf.method || 'share of decision-relevant facts verified by deterministic checks')}">${conf.percent}% confidence · ${conf.verified_facts}/${conf.verified_facts + conf.open_points} facts verified</span>` : '';
    const inj = (f.manipulation && f.manipulation.length)
      ? `<div class="inj-banner">🚨 Manipulation attempt blocked — merchant text tried: “<code>${esc(f.manipulation[0].snippet)}</code>”</div>` : '';
    const evs = (f.evidence || []).map(e => `<span class="ev">${esc(e.label)}: <b>${esc(e.value)}</b></span>`).join('');
    const items = (f.items || []).map(i => `${i.qty}× ${esc(i.name)} — ${chf(i.price)} ${esc(i.currency || '')}${i.details ? ` <span style="opacity:.7">(${esc(String(i.details).slice(0, 80))}…)</span>` : ''}`).join('<br>');
    return `<div class="decision-card ${esc(f.decision)}">
      <div class="dc-head">
        <span class="dc-title">#${f.replay_order ?? '?'} ${esc(f.merchant || '')} — ${chf(f.amount)}</span>
        <span style="display:flex;gap:6px;align-items:center">${confBadge}<span class="dc-badge ${esc(f.decision)}">${badge}</span></span>
      </div>
      <div class="dc-items">${items}</div>
      <div class="dc-msg">${esc(f.message)}</div>
      ${inj}
      <div class="evidence-grid">${evs}</div>
      <div class="dc-meta">engine ${esc(f.evaluation_ms ?? '<1')}ms · ${esc((f.reason_codes || []).join(', '))}</div>
    </div>`;
  }).join('');
}

function renderProgress(state) {
  const box = $('run-progress');
  const r = state.run;
  if (!r) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const pct = r.total ? Math.round((r.decided / r.total) * 100) : 0;
  $('meter-fill').style.width = pct + '%';
  $('run-counts').innerHTML =
    `<span>${esc(r.scenario_id)} · ${esc(r.status)}</span><span>${r.decided}/${r.total} decided</span>` +
    `<span style="color:var(--green)">✓ ${r.approved} approved</span>` +
    `<span style="color:var(--red)">✗ ${r.declined} declined</span>` +
    `<span style="color:var(--amber)">⏸ ${r.pending} waiting for you</span>` +
    (r.spend_window ? `<span>rolling ${r.spend_window.days}d: ${chf(r.spend_window.used)} / ${chf(r.spend_window.cap)}</span>` : '');
}

// ---------- approvals ----------
// ---------- approvals ----------

// Yellow-list dossier client cache: domain -> {status, data} — the approval list
// re-renders every poll tick, so dossier fetches are de-duplicated here.
const dossierCache = new Map();

function renderDossier(d) {
  const verdict = d?.registry?.compare?.verdict || 'unknown';
  const vLabel = verdict === 'strong' ? 'imprint = registry ✓' : verdict === 'partial' ? 'imprint ≈ registry' : verdict === 'mismatch' ? 'imprint ≠ registry ✗' : 'registry compare n/a';
  const sum = (arr, cls, mark) => arr.map(s => `<div class="${cls}">${mark} ${esc(s)}</div>`).join('');
  const r = d?.registry || {};
  const i = d?.imprint || {};
  const c = d?.country || {};
  const cell = (label, val) => val ? `<div class="cell"><b>${esc(label)}</b><span>${val}</span></div>` : '';
  const link = (u) => u ? `<a href="${esc(u)}" target="_blank" rel="noreferrer">${esc(u.replace(/^https?:\/\/(?:www\.)?/, '').slice(0, 42))}</a>` : '—';
  const ts = d?.reviews?.shop;
  const pr = d?.reviews?.product;
  const chips = (d?.payments?.methods || []).map(m => `<span class="dz-chip">${esc(m)}</span>`).join(' ') || '<span style="color:var(--ink-soft)">not detected</span>';
  return `
    <div style="font-size:13px">Merchant: <b>${esc(d.domain)}</b>
      <span class="dz-verdict ${esc(verdict)}">${esc(vLabel)}</span>
      ${c.same_country === true ? '<span class="dz-verdict strong">same country ✓</span>' : c.same_country === false ? `<span class="dz-verdict mismatch">${esc(c.merchant_country)} ≠ your ${esc(c.customer_country)}</span>` : ''}
      ${d.trusted ? '<span class="dz-verdict strong">trusted ✓</span>' : (d.domain ? `<button class="btn dz-trust" data-trust-domain="${esc(d.domain)}" type="button">🤝 trust this merchant</button>` : '')}
    </div>
    <div class="dz-sum">
      ${sum(d.summary?.positives || [], 'pos', '✓')}
      ${sum(d.summary?.negatives || [], 'neg', '✗')}
      ${sum(d.summary?.unknowns || [], 'unk', '?')}
    </div>
    <div class="dz-grid">
      ${cell('Swiss registry (Zefix)', r.status === 'found' ? `${esc(r.company_name || '')}${r.uid ? ` · ${esc(r.uid)}` : ''}${r.address?.city ? ` · seat ${esc(r.address.city)}` : ''}` : r.status === 'not_found' ? 'no Swiss register entry' : esc(r.status || 'n/a'))}
      ${cell('Registry age', r.age_years != null ? `${r.age_years} year${r.age_years === 1 ? '' : 's'} (since ${esc(r.registration_date)})` : 'unknown')}
      ${cell('Imprint (Impressum)', i.status === 'found' ? `${esc(i.company_name || '')}${i.address ? ` · ${esc(i.address.street || '')}, ${esc(i.address.postal_code || '')} ${esc(i.address.city || '')}` : ''}` : esc(i.status || 'n/a'))}
      ${cell('Social presence', `LinkedIn: ${link(d.social?.linkedin)} · Instagram: ${link(d.social?.instagram)}`)}
      ${cell('Payment methods', chips)}
      ${cell('Reviews', ts?.listed === true && ts.rating != null ? `Trusted Shops ${esc(String(ts.rating))}/5 (${esc(String(ts.review_count ?? '?'))} reviews)` : ts?.listed === true ? 'Trusted Shops listed (no rating)' : pr?.rating != null ? `Product page ${esc(String(pr.rating))}/${esc(String(pr.best || 5))} (${esc(String(pr.count ?? '?'))} reviews)` : 'no ratings found')}
      ${cell('🌱 Sustainability', d.sustainability ? (d.sustainability.score != null ? `<b>${esc(String(d.sustainability.score))}</b>/100 · ${esc(d.sustainability.band)}${d.sustainability.note ? ` — ${esc(d.sustainability.note)}` : ''}` : `unknown${d.sustainability.note ? ` — ${esc(d.sustainability.note)}` : ''}`) : '—')}
    </div>
    ${d.product_url ? `<div class="dz-url">Product URL the agent wants to buy from: <a href="${esc(d.product_url)}" target="_blank" rel="noreferrer">${esc(d.product_url)}</a></div>` : `<div class="dz-url">Shop URL: <a href="https://${esc(d.domain)}" target="_blank" rel="noreferrer">https://${esc(d.domain)}</a></div>`}
  `;
}

// "Trust this merchant" on yellow-list dossiers: one click adds the domain to
// the persisted trusted list (and mirrors it to the shopper bridge) — a
// yellow-listed merchant becomes a resolved one without a paused purchase.
// Event delegation because approval cards re-render every poll tick.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-trust-domain]');
  if (!btn) return;
  const domain = btn.dataset.trustDomain;
  btn.disabled = true;
  btn.textContent = 'trusting…';
  try {
    const out = await api('/api/merchant/trust', 'POST', { domain });
    btn.textContent = 'trusted ✓';
    btn.classList.add('trusted');
    const entry = dossierCache.get(out.domain);
    if (entry?.data) entry.data.trusted = true; // next poll renders the badge
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '🤝 trust this merchant';
    console.error('trust failed:', err.message);
  }
});

async function hydrateDossiers(root) {
  const slots = [...root.querySelectorAll('.ap-dossier[data-site]')];
  for (const slot of slots) {
    const site = slot.dataset.site;
    let entry = dossierCache.get(site);
    if (!entry) {
      entry = { status: 'loading', data: null };
      dossierCache.set(site, entry);
      api(`/api/merchant/dossier?merchant=${encodeURIComponent(site)}`)
        .then((out) => { entry.status = 'done'; entry.data = out.results?.[0] || { domain: site, error: 'empty dossier response' }; })
        .catch((e) => { entry.status = 'done'; entry.data = { domain: site, error: e.message }; })
        .finally(() => {
          document.querySelectorAll(`.ap-dossier[data-site="${CSS.escape(site)}"]`).forEach(el => { el.innerHTML = entry.data ? renderDossier(entry.data) : '<span class="dz-loading">Dossier unavailable.</span>'; });
        });
    }
    if (entry.status === 'loading') {
      slot.innerHTML = '<span class="dz-loading">⏳ Building merchant dossier — Zefix register, imprint, socials, payments, reviews…</span>';
    } else if (entry.data) {
      slot.innerHTML = renderDossier(entry.data);
    }
  }
}

function renderApprovals(state) {
  const wrap = $('approvals');
  const list = state.pending_step_ups || [];
  if (!list.length) { wrap.innerHTML = '<p class="hint">Nothing waiting.</p>'; return; }
  wrap.innerHTML = list.map(p => {
    const left = Math.max(0, p.deadline - Date.now());
    const pct = Math.max(0, Math.min(100, (left / 120000) * 100));
    const items = (p.items || []).map(i => `${i.qty}× ${esc(i.name)} — ${chf(i.price)} ${esc(i.currency || '')}`).join('<br>');
    const inj = (p.manipulation && p.manipulation.length)
      ? `<div class="inj-banner">🚨 Merchant text contains a manipulation attempt: “<code>${esc(p.manipulation[0].snippet)}</code>” — the wallet did not follow it.</div>` : '';
    const evs = (p.evidence || []).map(e => `<span class="ev">${esc(e.label)}: <b>${esc(e.value)}</b></span>`).join('');
    const pconf = p.confidence;
    const pconfCls = !pconf ? '' : pconf.percent >= 90 ? 'conf-high' : pconf.percent >= 70 ? 'conf-mid' : 'conf-low';
    const pconfBadge = pconf ? `<span class="conf-badge ${pconfCls}" title="${esc(pconf.method || 'share of decision-relevant facts verified by deterministic checks')}">${pconf.percent}% confidence · ${pconf.verified_facts}/${pconf.verified_facts + pconf.open_points} facts verified</span>` : '';
    const yellow = p.merchant_site
      ? `<div class="ap-dossier" data-site="${esc(p.merchant_site)}" data-auth="${esc(p.authorization_id)}"></div>`
      : '';
    const actions = p.merchant_site
      ? `<div class="ap-actions">
          <button class="btn primary" data-do="approve" data-wl="1">🤝 Trust merchant &amp; approve</button>
          <button class="btn" data-do="approve">Approve once</button>
          <button class="btn danger" data-do="decline">Decline</button>
        </div>`
      : `<div class="ap-actions">
          <button class="btn primary" data-do="approve">Approve purchase</button>
          <button class="btn danger" data-do="decline">Decline</button>
        </div>`;
    return `<div class="approval-card" data-auth="${esc(p.authorization_id)}">
      <div class="dc-head"><span class="dc-title">${esc(p.merchant)} — ${chf(p.amount)}</span>${pconfBadge}<span class="ap-count" data-left>${Math.ceil(left / 1000)}s left</span></div>
      <div class="ap-bar"><div style="width:${pct}%"></div></div>
      <div class="ap-items">${items}</div>
      ${inj}
      <div class="dc-msg">${esc(p.message)}</div>
      <div class="evidence-grid">${evs}</div>
      ${yellow}
      ${actions}
    </div>`;
  }).join('');
  hydrateDossiers(wrap);
  wrap.querySelectorAll('button[data-do]').forEach(b => {
    b.onclick = async () => {
      const card = b.closest('.approval-card');
      const authId = card.dataset.auth;
      b.disabled = true;
      try {
        await api(`/api/stepups/${authId}/resolve`, 'POST', {
          decision: b.dataset.do,
          whitelist: b.dataset.wl === '1',
          message: b.dataset.wl === '1'
            ? 'Customer reviewed the merchant dossier and chose to trust this merchant and approve the purchase in the wallet UI.'
            : `Customer ${b.dataset.do === 'approve' ? 'approved once' : 'declined'} this purchase in the wallet UI.`,
        });
        refresh();
      } catch (e) { alert(e.message); b.disabled = false; }
    };
  });
}

// ---------- polling loop ----------
let state = null;
async function refresh() {
  try {
    state = await api('/api/state');
    setChips(state);
    renderSusToggle(state);
    renderScenarios(state);
    renderBanner(state);
    renderProgress(state);
    renderFeed(state);
    renderApprovals(state);
    // live countdown on approval cards
    document.querySelectorAll('.approval-card [data-left]').forEach(el => {
      // recomputed on next tick anyway
    });
  } catch (e) { console.error(e); }
}

setInterval(refresh, 1200);
refresh();

// countdown ticker for approval cards
setInterval(() => {
  document.querySelectorAll('.approval-card').forEach(card => {
    const p = (state?.pending_step_ups || []).find(x => x.authorization_id === card.dataset.auth);
    if (p) {
      const left = Math.max(0, p.deadline - Date.now());
      card.querySelector('[data-left]').textContent = `${Math.ceil(left / 1000)}s left`;
      card.querySelector('.ap-bar > div').style.width = (left / 120000) * 100 + '%';
    }
  });
}, 500);

// ---------- sustainability preference + offer comparison ----------
function renderSusToggle(state) {
  const b = $('sus-toggle');
  if (!b) return;
  const on = state?.sustainability?.prefer === true;
  b.textContent = on ? '🌱 Prefer sustainable: ON' : '🌱 Prefer sustainable: off';
  b.classList.toggle('on', on);
}

async function toggleSustainability() {
  try {
    const on = !(state?.sustainability?.prefer === true);
    await api('/api/settings/sustainability', 'POST', { enabled: on });
    refresh();
  } catch (e) { alert(e.message); }
}

const bandChip = (kind, band) => `<span class="band ${kind} ${esc(band)}">${esc(band)}</span>`;

function renderOffers(out) {
  const rows = out.offers.map((o, i) => {
    const best = i === 0 && out.recommended && o.merchant === out.recommended.merchant;
    const sus = o.sustainability.score != null
      ? `<b>${o.sustainability.score}</b>/100 ${bandChip('sus', o.sustainability.band)}${o.sustainability.note ? `<div class="offer-note">${esc(o.sustainability.note)}</div>` : ''}`
      : `${bandChip('sus', 'unknown')}<div class="offer-note">${esc(o.sustainability.note || 'no data')}</div>`;
    const risk = `<b>${o.risk.score}</b>/100 ${bandChip('risk', o.risk.band)}<div class="offer-note">${esc(o.risk.reasons.join(' · '))}</div>`;
    return `<tr class="${best ? 'best' : ''}">
      <td>${esc(o.name)}<div class="offer-note mono">${esc(o.merchant)}</div></td>
      <td>${risk}</td>
      <td>${sus}</td>
      <td class="pick-cell">${best ? '<span class="pick">🌱 suggested</span>' : ''}</td>
    </tr>`;
  }).join('');
  return `<table class="offers-table">
    <thead><tr><th>Shop</th><th>Risk score</th><th>🌱 Sustainability</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${out.recommended ? `<p class="hint">Suggested pick: <b>${esc(out.recommended.merchant)}</b> — ${esc(out.recommended.reason)}</p>` : ''}
  ${out.prefer ? '' : '<p class="hint">Tip: turn on “🌱 Prefer sustainable” (top right) to factor sustainability into the suggestion.</p>'}`;
}

async function compareOffers() {
  const raw = $('offers-merchants').value.trim();
  if (!raw) { $('offers-status').textContent = 'paste at least one shop domain first'; return; }
  $('offers-status').textContent = 'checking shops… (Trusted Shops lookup, cached)';
  $('btn-compare-offers').disabled = true;
  try {
    const out = await api('/api/offers/compare', 'POST', {
      item: $('offers-item').value.trim(),
      merchants: raw.split(/[,,;\n]/).map(s => s.trim()).filter(Boolean),
    });
    $('offers-status').textContent = `${out.count} shop${out.count === 1 ? '' : 's'} compared${out.item ? ` — ${out.item}` : ''}`;
    $('offers-result').innerHTML = renderOffers(out);
  } catch (e) { $('offers-status').textContent = `error: ${e.message}`; }
  finally { $('btn-compare-offers').disabled = false; }
}

$('sus-toggle').onclick = toggleSustainability;
$('btn-compare-offers').onclick = compareOffers;

$('btn-compile').onclick = compile;
$('btn-confirm').onclick = confirmMandate;
$('btn-edit').onclick = () => { $('tighten-box').classList.remove('hidden'); };
$('btn-tighten').onclick = showTighten;
$('btn-add-rule').onclick = addRule;
$('btn-auto-decline').onclick = autoDecline;
$('btn-revoke').onclick = revoke;
$('btn-run').onclick = startRun;
$('btn-reset').onclick = async () => { if (confirm('Reset session (mandates, runs, feed)?')) { await api('/api/reset', 'POST'); location.reload(); } };
