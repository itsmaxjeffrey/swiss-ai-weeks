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
    const inj = (f.manipulation && f.manipulation.length)
      ? `<div class="inj-banner">🚨 Manipulation attempt blocked — merchant text tried: “<code>${esc(f.manipulation[0].snippet)}</code>”</div>` : '';
    const evs = (f.evidence || []).map(e => `<span class="ev">${esc(e.label)}: <b>${esc(e.value)}</b></span>`).join('');
    const items = (f.items || []).map(i => `${i.qty}× ${esc(i.name)} — ${chf(i.price)} ${esc(i.currency || '')}${i.details ? ` <span style="opacity:.7">(${esc(String(i.details).slice(0, 80))}…)</span>` : ''}`).join('<br>');
    return `<div class="decision-card ${esc(f.decision)}">
      <div class="dc-head">
        <span class="dc-title">#${f.replay_order ?? '?'} ${esc(f.merchant || '')} — ${chf(f.amount)}</span>
        <span class="dc-badge ${esc(f.decision)}">${badge}</span>
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
    return `<div class="approval-card" data-auth="${esc(p.authorization_id)}">
      <div class="dc-head"><span class="dc-title">${esc(p.merchant)} — ${chf(p.amount)}</span><span class="ap-count" data-left>${Math.ceil(left / 1000)}s left</span></div>
      <div class="ap-bar"><div style="width:${pct}%"></div></div>
      <div class="ap-items">${items}</div>
      ${inj}
      <div class="dc-msg">${esc(p.message)}</div>
      <div class="evidence-grid">${evs}</div>
      <div class="ap-actions">
        <button class="btn primary" data-do="approve">Approve purchase</button>
        <button class="btn danger" data-do="decline">Decline</button>
      </div>
    </div>`;
  }).join('');
  wrap.querySelectorAll('button[data-do]').forEach(b => {
    b.onclick = async () => {
      const card = b.closest('.approval-card');
      const authId = card.dataset.auth;
      b.disabled = true;
      try {
        await api(`/api/stepups/${authId}/resolve`, 'POST', { decision: b.dataset.do, message: `Customer ${b.dataset.do}d this purchase in the wallet UI.` });
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

$('btn-compile').onclick = compile;
$('btn-confirm').onclick = confirmMandate;
$('btn-edit').onclick = () => { $('tighten-box').classList.remove('hidden'); };
$('btn-tighten').onclick = showTighten;
$('btn-add-rule').onclick = addRule;
$('btn-auto-decline').onclick = autoDecline;
$('btn-revoke').onclick = revoke;
$('btn-run').onclick = startRun;
$('btn-reset').onclick = async () => { if (confirm('Reset session (mandates, runs, feed)?')) { await api('/api/reset', 'POST'); location.reload(); } };
