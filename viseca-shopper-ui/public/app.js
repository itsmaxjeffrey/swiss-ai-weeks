/* Viseca Shopper UI — frontend logic */
(() => {
  "use strict";

  const feed = document.getElementById("feed");
  const input = document.getElementById("input");
  const composer = document.getElementById("composer");
  const sendBtn = document.getElementById("sendBtn");
  const typing = document.getElementById("typing");
  const typingText = document.getElementById("typingText");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const statusAgent = document.getElementById("statusAgent");
  const turnCounter = document.getElementById("turnCounter");

  const authOverlay = document.getElementById("authOverlay");
  const authView = document.getElementById("authView");
  const accountView = document.getElementById("accountView");
  const tabLogin = document.getElementById("tabLogin");
  const tabRegister = document.getElementById("tabRegister");
  const loginForm = document.getElementById("loginForm");
  const registerForm = document.getElementById("registerForm");
  const loginError = document.getElementById("loginError");
  const registerError = document.getElementById("registerError");
  const accountSignedOut = document.getElementById("accountSignedOut");
  const accountSignedIn = document.getElementById("accountSignedIn");
  const acctName = document.getElementById("acctName");
  const acctPlan = document.getElementById("acctPlan");
  const acctUsage = document.getElementById("acctUsage");
  const acctEmail = document.getElementById("acctEmail");
  const plansGrid = document.getElementById("plansGrid");
  const usageFill = document.getElementById("usageFill");
  const usageText = document.getElementById("usageText");
  const keyList = document.getElementById("keyList");
  const keyForm = document.getElementById("keyForm");
  const newKeyBox = document.getElementById("newKeyBox");
  const newKeyValue = document.getElementById("newKeyValue");
  const btnCopyKey = document.getElementById("btnCopyKey");
  const btnCloseAuth = document.getElementById("btnCloseAuth");
  const btnShowAuth = document.getElementById("btnShowAuth");
  const btnAccount = document.getElementById("btnAccount");
  const btnLogout = document.getElementById("btnLogout");
  const btnClearChat = document.getElementById("btnClearChat");
  const policyList = document.getElementById("policyList");
  const btnStopTurn = document.getElementById("btnStopTurn");
  /* shopping settings */
  const shopCap = document.getElementById("shopCap");
  const shopCapSave = document.getElementById("shopCapSave");
  const shopCapClear = document.getElementById("shopCapClear");
  const shopCapNote = document.getElementById("shopCapNote");
  const wlList = document.getElementById("wlList");
  const wlNote = document.getElementById("wlNote");
  const wlInput = document.getElementById("wlInput");
  const wlAdd = document.getElementById("wlAdd");
  const wlSearch = document.getElementById("wlSearch");
  const wlResults = document.getElementById("wlResults");
  const wlError = document.getElementById("wlError");
  const pmList = document.getElementById("pmList");
  const pmNote = document.getElementById("pmNote");
  const pmForm = document.getElementById("pmForm");
  const pmHolder = document.getElementById("pmHolder");
  const pmNumber = document.getElementById("pmNumber");
  const pmBrandHint = document.getElementById("pmBrandHint");
  const pmExp = document.getElementById("pmExp");
  const pmCvc = document.getElementById("pmCvc");
  const pmError = document.getElementById("pmError");
  /* family / parental controls */
  const famIntro = document.getElementById("famIntro");
  const famBanner = document.getElementById("famBanner");
  const familyChildView = document.getElementById("familyChildView");
  const familyParentView = document.getElementById("familyParentView");
  const famForm = document.getElementById("famForm");
  const famName = document.getElementById("famName");
  const famEmail = document.getElementById("famEmail");
  const famPassword = document.getElementById("famPassword");
  const famError = document.getElementById("famError");
  const famChildren = document.getElementById("famChildren");

  let turns = 0;
  let busy = false;
  let locked = true; // composer locked until signed in
  let authed = false;
  let activeController = null; // aborts the in-flight chat fetch
  let stopRequested = false;

  /* Session token fallback: some embedded contexts (iframes with third-party
   * cookies blocked) never send cookies back, so the login response also
   * returns the token and we attach it as a Bearer header on API calls. */
  const SESSION_KEY = "shopper_session_token";
  function getToken() { try { return localStorage.getItem(SESSION_KEY) || ""; } catch { return ""; } }
  function setToken(t) { try { if (t) localStorage.setItem(SESSION_KEY, t); else localStorage.removeItem(SESSION_KEY); } catch {} }
  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    const t = getToken();
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  }
  let currentUser = null;
  let plansCache = null;

  const THINKING_WORDS = [
    "thinking…",
    "browsing offers…",
    "comparing prices…",
    "checking Swiss shops…",
    "almost there…",
  ];
  let thinkingTimer = null;
  let thinkingStep = 0;
  let lastProgress = null;

  function fmtElapsed(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
  }

  function fmtTokens(n) {
    if (typeof n !== "number" || !isFinite(n)) return "";
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
  }

  /** Renders the live status line: friendly word + real data when available. */
  function renderBusyLine() {
    const base = THINKING_WORDS[thinkingStep % THINKING_WORDS.length];
    if (!lastProgress) {
      typingText.textContent = base;
      return;
    }
    const bits = [base, fmtElapsed(lastProgress.elapsedMs)];
    const tok = fmtTokens(lastProgress.totalTokens);
    if (tok) bits.push(tok);
    if (lastProgress.status && lastProgress.status !== "running") bits.push(lastProgress.status);
    typingText.textContent = bits.join(" · ");
  }

  /* ---------- tiny markdown renderer ---------- */

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function md(src) {
    const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let list = null; // "ul" | "ol"
    let inPre = false;
    let preBuf = [];

    const closeList = () => {
      if (list) { out.push(`</${list}>`); list = null; }
    };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");

      if (/^```/.test(line.trim())) {
        if (inPre) { out.push(`<pre>${esc(preBuf.join("\n"))}</pre>`); preBuf = []; inPre = false; }
        else { closeList(); inPre = true; }
        continue;
      }
      if (inPre) { preBuf.push(raw); continue; }

      const h = line.match(/^(#{1,4})\s+(.*)/);
      if (h) { closeList(); const lvl = Math.min(h[1].length + 1, 4); out.push(`<h${lvl}>${inline(esc(h[2]))}</h${lvl}>`); continue; }

      const ul = line.match(/^\s*[-*•]\s+(.*)/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      if (ul || ol) {
        const want = ul ? "ul" : "ol";
        if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
        out.push(`<li>${inline(esc((ul || ol)[1]))}</li>`);
        continue;
      }

      closeList();
      if (!line.trim()) continue;
      out.push(`<p>${inline(esc(line))}</p>`);
    }
    if (inPre) out.push(`<pre>${esc(preBuf.join("\n"))}</pre>`);
    closeList();
    return out.join("");
  }

  /* ---------- helpers ---------- */

  function nowLabel() {
    return new Date().toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
  }

  function addMessage(role, text, opts) {
    const fromHistory = !!(opts && opts.history);
    const empty = feed.querySelector(".welcome");
    if (empty) empty.remove();

    const el = document.createElement("div");
    el.className = `msg msg--${role}`;

    const names = { user: "You", agent: "Viseca Shopper", error: "Error", system: "System" };
    const marks = { user: "→", agent: "+", error: "!", system: "·" };

    const policyBlocks = role === "agent" ? extractPolicyBlocks(text) : null;
    const bodyHtml = role === "agent"
      ? md(policyBlocks.stripped).replace(/\u0000POLICYCARD(\d+)\u0000/g,
          '<span class="policy-slot" data-policy-slot="$1"></span>')
      : esc(text).replace(/\n/g, "<br>");

    el.innerHTML = `
      <div class="msg-meta"><span class="red">${marks[role] || "·"}</span> ${names[role] || role} — ${nowLabel()}</div>
      <div class="msg-body">${bodyHtml}</div>`;
    feed.appendChild(el);
    if (policyBlocks) {
      policyBlocks.blocks.forEach((raw, i) => {
        const slot = el.querySelector(`[data-policy-slot="${i}"]`);
        if (!slot) return;
        let policy = null;
        try { policy = JSON.parse(raw); } catch { /* card shows invalid state */ }
        slot.replaceWith(buildPolicyCard(policy, { readOnly: fromHistory }));
      });
    }
    feed.scrollTop = feed.scrollHeight;
    return el;
  }

  /* ---------- order policy approval cards ---------- */

  const POLICY_SLOT_PREFIX = "\u0000POLICYCARD";

  /** Pull ```policy-json fenced blocks out of the reply and leave mount slots. */
  function extractPolicyBlocks(text) {
    const blocks = [];
    const stripped = String(text || "").replace(/```policy-json\s*\n([\s\S]*?)```/g, (m, json) => {
      blocks.push(json.trim());
      return `${POLICY_SLOT_PREFIX}${blocks.length - 1}\u0000`;
    });
    return { blocks, stripped };
  }

  function fmtZurich(iso) {
    const t = Date.parse(iso || "");
    if (Number.isNaN(t)) return esc(iso || "—");
    return new Date(t).toLocaleString("de-CH", {
      timeZone: "Europe/Zurich", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  }

  function buildPolicyCard(policy, opts) {
    const readOnly = !!(opts && opts.readOnly);
    const card = document.createElement("div");
    card.className = "policy-card";

    if (!policy || typeof policy !== "object" || !policy.policy_id) {
      card.classList.add("policy-card--failed");
      card.innerHTML = `
        <div class="policy-card-head"><span class="policy-kicker mono-label">Order policy</span>
        <span class="policy-state">unparseable</span></div>
        <p class="policy-note">The agent posted a policy block that is not valid JSON — ask it to re-post.</p>`;
      return card;
    }

    const items = (policy.items || []).map((it) =>
      `<li>${esc((it && it.product) || "?")} × ${esc(String((it && it.quantity) ?? 1))}${
        it && it.max_unit_price ? ` · max ${esc(String(it.max_unit_price.amount))} ${esc(it.max_unit_price.currency || "")}/pc` : ""}</li>`
    ).join("");
    const t = policy.timing || {};
    const msc = (policy.payment || {}).max_single_charge || {};
    const allowed = ((policy.merchant || {}).allowed_domains || []);
    const rows = [
      ["Request", policy.request],
      ["Items", items ? `<ul class="policy-items">${items}</ul>` : "—"],
      ["Budget", policy.budget ? `max ${esc(String(policy.budget.max_total))} ${esc(policy.budget.currency || "")}` : "—"],
      ["Order by", t.order_by ? `${fmtZurich(t.order_by)} <span class="mono-dim">${esc(t.order_by)}</span>` : "—"],
      ["Deliver by", t.deliver_by ? `${fmtZurich(t.deliver_by)} <span class="mono-dim">${esc(t.deliver_by)}</span>` : "—"],
      ...(t.search_until ? [["Search until", fmtZurich(t.search_until)]] : []),
      ["Deliver to", policy.delivery ? esc(policy.delivery.address || "") : "—"],
      ["Payment", policy.payment ? `${esc(policy.payment.method || "")} · max ${esc(String(msc.amount))} ${esc(msc.currency || "")}` : "—"],
      ...(allowed.length ? [["Shops", allowed.map(esc).join(", ")]] : []),
    ];

    card.innerHTML = `
      <div class="policy-card-head">
        <span class="policy-kicker mono-label">Order policy · ${esc(policy.policy_id)}</span>
        <span class="policy-state" data-state>awaiting your approval</span>
      </div>
      <dl class="policy-rows">
        ${rows.map(([k, v]) => `<div class="policy-row"><dt class="mono-label">${esc(k)}</dt><dd>${v == null ? "—" : v}</dd></div>`).join("")}
      </dl>
      <div class="policy-actions">
        <button type="button" class="policy-btn policy-btn--approve">Approve &amp; Sign</button>
        <button type="button" class="policy-btn policy-btn--reject">Reject</button>
        <span class="policy-note">Signing freezes this policy (Ed25519) — the agent cannot change it afterwards.</span>
      </div>
      <div class="policy-result" hidden></div>`;

    const state = card.querySelector("[data-state]");
    const result = card.querySelector(".policy-result");
    const actions = card.querySelector(".policy-actions");

    if (readOnly) {
      // Restored from stored history — past policies must not be re-approvable
      // here; the agent re-proposes (new policy_id) when a purchase is wanted.
      actions.hidden = true;
      state.textContent = "past policy";
      return card;
    }

    const setBusy = (approveDisabled) => {
      card.querySelectorAll(".policy-btn").forEach((b) => {
        b.disabled = b.classList.contains("policy-btn--approve") ? approveDisabled : true;
      });
    };

    card.querySelector(".policy-btn--approve").addEventListener("click", async () => {
      setBusy(true);
      state.textContent = "signing…";
      try {
        const r = await fetch("/api/policy/sign", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ policy }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) {
          card.classList.add("policy-card--signed");
          state.textContent = "signed ✓";
          actions.hidden = true;
          result.hidden = false;
          result.innerHTML = `
            <p><strong>Signed &amp; frozen.</strong> authority <code>${esc(j.signed_by || "")}</code></p>
            <p class="mono-dim">${esc(j.signed_path || "")}</p>
            <p>Telling the agent to run the gate checks…</p>`;
          setTimeout(() => send(`Policy ${policy.policy_id} is approved and signed — run the gate check and proceed.`), 700);
        } else if (r.status === 422) {
          card.classList.add("policy-card--failed");
          setBusy(false);
          result.hidden = false;
          const missing = (j.missing || []).map((m) => `<li><code>${esc(m)}</code></li>`).join("");
          const violations = (j.violations || []).map((v) => `<li>${esc(v)}</li>`).join("");
          if (violations) {
            state.textContent = "refused — settings conflict";
            result.innerHTML = `<p><strong>The authority refused to sign — this order conflicts with your shopping settings.</strong></p><ul>${violations}</ul><p class="form-note">Open Account → Shopping settings to fix the cap or whitelist, then have the agent re-propose.</p>`;
          } else {
            state.textContent = "refused — incomplete";
            result.innerHTML = `<p><strong>The authority refused to sign — the policy is incomplete.</strong> The agent must ask you for:</p><ul>${missing}</ul>`;
          }
        } else if (r.status === 401) {
          openAuth("login");
          throw new Error("Your session expired — sign in again.");
        } else {
          throw new Error(j.error || `HTTP ${r.status}`);
        }
      } catch (e) {
        state.textContent = "signing failed";
        card.classList.add("policy-card--failed");
        setBusy(false);
        result.hidden = false;
        result.innerHTML = `<p><strong>Could not sign:</strong> ${esc(e.message)}</p>`;
      }
    });

    card.querySelector(".policy-btn--reject").addEventListener("click", () => {
      card.classList.add("policy-card--rejected");
      state.textContent = "rejected";
      actions.hidden = true;
      result.hidden = false;
      result.innerHTML = `<p>Rejected. Tell the agent what to change — it must propose a new policy (new policy_id).</p>`;
    });

    return card;
  }

  function setBusy(on) {
    busy = on;
    composer.classList.toggle("busy", on);
    sendBtn.disabled = on || locked;
    typing.hidden = !on;
    if (btnStopTurn) btnStopTurn.hidden = !on;
    if (!on) { activeController = null; stopRequested = false; }
    if (on) {
      thinkingStep = 0;
      lastProgress = null;
      renderBusyLine();
      thinkingTimer = setInterval(() => {
        thinkingStep += 1;
        renderBusyLine();
      }, 1000);
    } else if (thinkingTimer) {
      clearInterval(thinkingTimer);
      thinkingTimer = null;
      lastProgress = null;
    }
  }

  function setStatus(state, label) {
    statusDot.className = `dot ${state}`;
    statusText.textContent = label;
  }

  /* ---------- stored conversation + purchases ---------- */

  const WELCOME_HTML =
    '<div class="welcome">' +
    '<p class="welcome-kicker mono-label">01 — Willkommen</p>' +
    '<p class="welcome-lede">Ask me to <em>find things</em>, <em>compare prices</em>, <em>plan purchases</em> or <em>hunt deals</em> across Swiss shops. I shop, you decide.</p>' +
    '</div>';

  function resetFeed() {
    feed.innerHTML = WELCOME_HTML;
    turns = 0;
    turnCounter.textContent = "no messages yet";
  }

  /** Restore the stored conversation so a reload does not blank the chat. */
  async function loadHistory() {
    try {
      const r = await fetch("/api/history", { headers: authHeaders() });
      if (!r.ok) return;
      const j = await r.json();
      const msgs = Array.isArray(j.messages) ? j.messages : [];
      if (msgs.length) {
        resetFeed();
        msgs.forEach((m) => addMessage(m.role || "system", m.text, { history: true }));
        turns = msgs.filter((m) => m.role === "user").length;
        turnCounter.textContent = `${turns} message${turns === 1 ? "" : "s"}`;
      }
    } catch { /* offline — live chat still works */ }
  }

  async function loadPurchases() {
    if (!policyList) return;
    try {
      const r = await fetch("/api/policies", { headers: authHeaders() });
      const j = await r.json();
      const list = Array.isArray(j.policies) ? j.policies : [];
      if (!list.length) {
        policyList.innerHTML = '<p class="form-note">No signed order policies yet. Approve a policy card in chat to freeze a purchase.</p>';
        return;
      }
      policyList.innerHTML = "";
      list.forEach((p) => {
        const row = document.createElement("div");
        row.className = "purchase-row";
        const budget = p.budget ? `max ${esc(String(p.budget.max_total))} ${esc(p.budget.currency || "")}` : "—";
        const deliverBy = p.timing && p.timing.deliver_by ? fmtZurich(p.timing.deliver_by) : "—";
        const items = (p.items || []).map((it) => esc(String((it && it.product) || "?"))).join(", ");
        const receipt = p.receipt
          ? `receipt ✓${p.receipt.total != null ? ` · ${esc(String(p.receipt.total))}` : ""}`
          : "awaiting receipt";
        row.innerHTML = `
          <div class="purchase-head"><span class="mono-label">${esc(p.policy_id)}</span>
            <span class="purchase-state${p.receipt ? " purchase-state--done" : ""}">${receipt}</span></div>
          <div class="purchase-req">${esc(String(p.request || "").slice(0, 160))}</div>
          <div class="purchase-meta mono-label">${items || "—"} · budget ${budget} · deliver by ${deliverBy} · signed ${fmtZurich(p.signed_at)}</div>`;
        policyList.appendChild(row);
      });
    } catch {
      policyList.innerHTML = '<p class="form-note">Could not load purchases.</p>';
    }
  }

  /* ---------- API ---------- */

  async function health() {
    try {
      const r = await fetch("/api/health");
      const j = await r.json();
      if (j.ok) {
        setStatus("on", "connected");
        if (j.agent) statusAgent.textContent = j.agent;
        if (j.plans) plansCache = j.plans;
        const fs = document.getElementById("footerSession");
        if (fs && j.session) fs.textContent = `${j.session}-u<account>`;
      } else {
        setStatus("off", "bridge error");
      }
    } catch {
      setStatus("off", "offline");
    }
  }

  async function send(text) {
    if (busy || !text.trim()) return;
    addMessage("user", text.trim());
    input.value = "";
    input.style.height = "auto";
    setBusy(true);
    turns += 1;
    turnCounter.textContent = `${turns} message${turns === 1 ? "" : "s"}`;

    try {
      // The bridge streams live progress (SSE frames) and finishes with a
      // final done/error frame. Abort timer is the safety net if the
      // connection dies without notice (bridge gives up after 10 min).
      const controller = new AbortController();
      activeController = controller;
      // Must stay above the server's OPENCLAW_OVERALL_BUDGET_MS (890s) so the
      // UI sees the turn complete instead of aborting first.
      const abortTimer = setTimeout(() => controller.abort(), 920000);
      try {
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ message: text.trim() }),
          signal: controller.signal,
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          if (r.status === 401) {
            renderSignedOut();
            addMessage("error", "Please sign in to chat.");
            openAuth("login");
          } else if (r.status === 429) {
            addMessage("error", j.error || "Daily message limit reached — see Account for plans.");
            refreshMe();
          } else {
            addMessage("error", j.error || `Request failed (HTTP ${r.status}).`);
          }
          return;
        }
        if (!r.body) {
          const j = await r.json().catch(() => ({}));
          if (j.reply) addMessage("agent", j.reply);
          else addMessage("error", "Empty response from the bridge.");
          return;
        }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let settled = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, i).trim();
            buf = buf.slice(i + 2);
            if (!frame.startsWith("data: ")) continue;
            let ev;
            try { ev = JSON.parse(frame.slice(6)); } catch { continue; }
            if (ev.type === "progress") {
              lastProgress = ev;
              renderBusyLine();
            } else if (ev.type === "done") {
              settled = true;
              addMessage("agent", ev.reply);
              refreshMe(); // keep the usage chip honest
            } else if (ev.type === "error") {
              settled = true;
              addMessage("error", ev.error || "Agent error.");
            }
          }
        }
        if (!settled) {
          addMessage("error", "Connection closed before the agent replied. The turn may still have completed — ask a follow-up.");
        }
      } finally {
        clearTimeout(abortTimer);
      }
    } catch (e) {
      if (stopRequested) {
        addMessage("system", "Task stopped — the agent is no longer working on it. (Anything already ordered stays done.)");
      } else {
        addMessage(
          "error",
          e.name === "AbortError"
            ? "Connection lost while the agent was working. The turn may still have completed — reload and ask a follow-up."
            : `Could not reach the bridge: ${e.message}`
        );
      }
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  /* ---------- shopping settings (spend cap / whitelist / card vault) ---------- */

  let shoppingCache = null;
  let searchTimer = null;

  async function loadShopping() {
    try {
      const r = await fetch("/api/account/shopping", { headers: authHeaders() });
      if (!r.ok) return;
      shoppingCache = await r.json();
      renderShopping();
    } catch { /* offline */ }
  }

  function renderShopping() {
    if (!shoppingCache || !shoppingCache.ok) return;
    const cap = shoppingCache.spendCapChf;
    shopCap.value = cap == null ? "" : cap;
    shopCapNote.textContent = cap == null
      ? "No cap set — any approved budget can be signed."
      : `Cap active: the agent can sign orders up to ${cap} CHF per order.`;

    const wl = shoppingCache.whitelist || [];
    wlList.innerHTML = "";
    if (!wl.length) {
      wlNote.textContent = "Empty whitelist — purchases from any website are allowed. Add the shops you actually order from to restrict the agent.";
    } else {
      wlNote.textContent = `${wl.length} site${wl.length === 1 ? "" : "s"} whitelisted — the agent may only buy from these domains.`;
      wl.forEach((d) => {
        const chip = document.createElement("span");
        chip.className = "wl-chip";
        chip.innerHTML = `<code>${esc(d)}</code><button type="button" aria-label="Remove ${esc(d)}">×</button>`;
        chip.querySelector("button").addEventListener("click", async () => {
          await fetch("/api/account/shopping/whitelist/remove", {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ domain: d }),
          }).catch(() => {});
          loadShopping();
        });
        wlList.appendChild(chip);
      });
    }

    const methods = shoppingCache.methods || [];
    pmList.innerHTML = "";
    methods.forEach((m) => {
      const row = document.createElement("div");
      row.className = "pm-row";
      row.innerHTML = `
        <span class="pm-brand-badge pm-brand--${esc(m.brand)}">${m.brand === "visa" ? "VISA" : "Mastercard"}</span>
        <span class="pm-num">•••• ${esc(m.last4)}</span>
        <span class="pm-exp mono-label">${esc(m.exp)}</span>
        ${m.isDefault
          ? '<span class="mono-label pm-default">● default</span>'
          : '<button type="button" class="acct-btn acct-btn--mini pm-default-btn">make default</button>'}
        <button type="button" class="acct-btn acct-btn--danger acct-btn--mini pm-del">Delete</button>`;
      const defBtn = row.querySelector(".pm-default-btn");
      if (defBtn) defBtn.addEventListener("click", async () => {
        await fetch("/api/account/shopping/methods/default", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ id: m.id }),
        }).catch(() => {});
        loadShopping();
      });
      row.querySelector(".pm-del").addEventListener("click", async () => {
        await fetch("/api/account/shopping/methods/delete", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ id: m.id }),
        }).catch(() => {});
        loadShopping();
      });
      pmList.appendChild(row);
    });
    pmNote.textContent = methods.length
      ? "The agent uses your saved card at checkout — you never paste card details into the chat."
      : "No card saved yet — add a Visa or Mastercard so the agent can pay at checkout.";
  }

  shopCapSave.addEventListener("click", async () => {
    const v = shopCap.value.trim();
    const r = await fetch("/api/account/shopping/cap", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ capChf: v === "" ? null : Number(v) }),
    }).catch(() => null);
    if (r && r.ok) loadShopping();
    else if (r) {
      const j = await r.json().catch(() => ({}));
      shopCapNote.textContent = j.error || "Could not save the cap.";
    }
  });

  shopCapClear.addEventListener("click", async () => {
    await fetch("/api/account/shopping/cap", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ capChf: null }),
    }).catch(() => {});
    loadShopping();
  });

  async function wlAddDomain(domain) {
    wlError.hidden = true;
    const r = await fetch("/api/account/shopping/whitelist", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ domain }),
    }).catch(() => null);
    if (r && r.ok) {
      wlInput.value = "";
      [...wlResults.querySelectorAll(".wl-result")].forEach((el) => {
        if (el.dataset.domain === String(domain).toLowerCase()) el.remove();
      });
      loadShopping();
    } else if (r) {
      const j = await r.json().catch(() => ({}));
      wlError.textContent = j.error || "Could not add that domain.";
      wlError.hidden = false;
    }
  }

  wlAdd.addEventListener("click", () => { if (wlInput.value.trim()) wlAddDomain(wlInput.value.trim()); });
  wlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); if (wlInput.value.trim()) wlAddDomain(wlInput.value.trim()); }
  });

  function renderSearchResults(results) {
    wlResults.innerHTML = "";
    if (!results.length) { wlResults.hidden = true; return; }
    results.forEach((r) => {
      const row = document.createElement("div");
      row.className = "wl-result";
      row.dataset.domain = r.domain;
      row.innerHTML = `<span class="wl-result-name">${esc(r.name || r.domain)}</span>
        <code class="wl-result-domain">${esc(r.domain)}</code>
        <span class="mono-label wl-result-cat">${esc(r.category || "")}</span>
        <button type="button" class="acct-btn acct-btn--mini">Whitelist</button>`;
      row.querySelector("button").addEventListener("click", () => wlAddDomain(r.domain));
      wlResults.appendChild(row);
    });
    wlResults.hidden = false;
  }

  wlSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = wlSearch.value.trim();
    if (q.length < 2) { wlResults.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/account/shopping/sites?q=${encodeURIComponent(q)}`, { headers: authHeaders() });
        if (!r.ok) return;
        const j = await r.json();
        renderSearchResults(j.results || []);
      } catch { /* ignore */ }
    }, 350);
  });

  /* live brand detection on the card form */
  pmNumber.addEventListener("input", () => {
    const n = pmNumber.value.replace(/[\s-]/g, "");
    pmBrandHint.textContent = /^4\d{6,}$/.test(n) ? "VISA" : (/^(5[1-5]|2[2-7])\d{5,}$/.test(n) ? "Mastercard" : "");
  });

  pmForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    pmError.hidden = true;
    const r = await fetch("/api/account/shopping/methods", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        holder: pmHolder.value.trim(),
        number: pmNumber.value.trim(),
        exp: pmExp.value.trim(),
        cvc: pmCvc.value.trim(),
      }),
    }).catch(() => null);
    if (r && r.ok) {
      pmForm.reset();
      pmBrandHint.textContent = "";
      loadShopping();
      addMessage("system", "Card saved — the agent can now pay checkout with it (within your budget cap and whitelist).");
    } else if (r) {
      const j = await r.json().catch(() => ({}));
      pmError.textContent = j.error || "Could not save the card.";
      pmError.hidden = false;
    }
  });

  /* ---------- family: parental controls ---------- */

  let familyCache = null;

  const numOrNull = (v) => {
    const s = String(v ?? "").trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : NaN; // NaN → client-side error
  };

  async function loadFamily() {
    if (!currentUser || currentUser.parentId) { familyCache = null; return; }
    try {
      const r = await fetch("/api/account/family", { headers: authHeaders() });
      if (!r.ok) return;
      familyCache = await r.json();
      renderFamily();
    } catch { /* offline */ }
  }

  /** A child sees a read-only banner of the limits that govern them. */
  function renderFamilySelfBanner(user) {
    const f = user.family || {};
    const spend = f.spend || { totalChf: 0, byCategory: {} };
    const parts = [];
    parts.push(f.maxSpendChf != null ? `max ${esc(String(f.maxSpendChf))} CHF per order` : "no per-order cap");
    parts.push(f.monthlyBudgetChf != null
      ? `${esc(String(spend.totalChf))} of ${esc(String(f.monthlyBudgetChf))} CHF used this month`
      : "no monthly budget");
    Object.entries(f.categoryLimits || {}).forEach(([cat, lim]) => {
      parts.push(`${esc(cat)}: ${esc(String(spend.byCategory[cat] || 0))} / ${esc(String(lim))} CHF this month`);
    });
    famBanner.innerHTML = `
      <span class="mono-label shop-label">Family account${f.parentEmail ? ` · managed by ${esc(f.parentEmail)}` : ""}</span>
      <p class="form-note">Your parent's limits apply to every order this account signs: ${parts.join(" · ")}. Resets on the 1st.</p>`;
  }

  function famChildCard(child, categories) {
    const card = document.createElement("div");
    card.className = "fam-child" + (child.suspended ? " fam-child--suspended" : "");
    const spend = child.spend || { month: "", totalChf: 0, byCategory: {}, orders: 0 };
    const mb = child.limits.monthlyBudgetChf;
    const budgetLine = mb != null
      ? `<div class="fam-bar"><div class="fam-bar-fill${spend.totalChf >= mb ? " fam-bar--over" : ""}" style="width:${Math.min(100, Math.round((spend.totalChf / mb) * 100))}%"></div></div>
         <span class="fam-spend-text mono-label">CHF ${esc(String(spend.totalChf))} of ${esc(String(mb))} signed this month · ${esc(String(spend.orders))} order${spend.orders === 1 ? "" : "s"}</span>`
      : `<span class="fam-spend-text mono-label">CHF ${esc(String(spend.totalChf))} signed this month · no monthly budget</span>`;

    const cl = child.limits.categoryLimits || {};
    const catRows = Object.entries(cl).map(([cat, lim]) => `
      <div class="fam-cat-row">
        <span class="fam-cat-name">${esc(cat)}</span>
        <input type="number" class="fam-cat-amt" min="1" step="0.01" value="${esc(String(lim))}" aria-label="${esc(cat)} limit CHF">
        <span class="fam-cat-spent mono-label">spent ${esc(String(spend.byCategory[cat] || 0))} CHF</span>
        <button type="button" class="acct-btn acct-btn--danger acct-btn--mini fam-cat-del" aria-label="Remove ${esc(cat)} limit">×</button>
      </div>`).join("");
    const otherCats = categories.filter((c) => !(c in cl));

    card.innerHTML = `
      <div class="fam-head">
        <span class="fam-name">${esc(child.name)}</span>
        <span class="fam-email mono-label">${esc(child.email)}</span>
        <span class="fam-state mono-label">${child.suspended ? "● suspended" : "● active"}</span>
      </div>
      <div class="fam-spend">${budgetLine}</div>
      <div class="fam-limits">
        <label class="field"><span class="mono-label">Max spend per order · CHF</span>
          <input type="number" class="fam-max" min="1" step="0.01" value="${child.limits.maxSpendChf == null ? "" : esc(String(child.limits.maxSpendChf))}" placeholder="no limit"></label>
        <label class="field"><span class="mono-label">Monthly budget · CHF</span>
          <input type="number" class="fam-monthly" min="1" step="0.01" value="${mb == null ? "" : esc(String(mb))}" placeholder="no budget"></label>
      </div>
      <div class="fam-cats">
        <span class="mono-label fam-cats-label">Category limits · CHF per month</span>
        <div class="fam-cat-list">${catRows || '<p class="form-note">No category limits — only the caps above apply.</p>'}</div>
        <div class="fam-cat-add">
          <select class="fam-cat-sel" aria-label="Category"${otherCats.length ? "" : " hidden"}>
            ${otherCats.map((c) => `<option>${esc(c)}</option>`).join("")}
          </select>
          <input type="number" class="fam-cat-new-amt" min="1" step="0.01" placeholder="CHF / month"${otherCats.length ? "" : " hidden"}>
          <button type="button" class="acct-btn acct-btn--mini fam-cat-addbtn"${otherCats.length ? "" : " hidden"}>Add limit</button>
        </div>
      </div>
      <div class="fam-actions">
        <button type="button" class="acct-btn acct-btn--primary fam-save">Save limits</button>
        <button type="button" class="acct-btn fam-suspend">${child.suspended ? "Unsuspend" : "Suspend"}</button>
        <button type="button" class="acct-btn acct-btn--danger fam-remove">Remove</button>
        <span class="form-error fam-err" hidden></span>
      </div>`;

    const err = card.querySelector(".fam-err");
    const showErr = (m) => { err.textContent = m; err.hidden = false; };

    card.querySelectorAll(".fam-cat-del").forEach((btn) => btn.addEventListener("click", () => {
      btn.closest(".fam-cat-row").remove();
    }));

    card.querySelector(".fam-cat-addbtn").addEventListener("click", () => {
      const sel = card.querySelector(".fam-cat-sel");
      const amt = card.querySelector(".fam-cat-new-amt");
      const cat = sel.value;
      if (!cat) return;
      if (card.querySelector(`.fam-cat-row[data-cat="${cat.replace(/"/g, "\\\"")}"]`)) return;
      const row = document.createElement("div");
      row.className = "fam-cat-row";
      row.dataset.cat = cat;
      row.innerHTML = `
        <span class="fam-cat-name">${esc(cat)}</span>
        <input type="number" class="fam-cat-amt" min="1" step="0.01" value="${esc(String(amt.value || ""))}" aria-label="${esc(cat)} limit CHF">
        <span class="fam-cat-spent mono-label">spent ${esc(String((child.spend.byCategory || {})[cat] || 0))} CHF</span>
        <button type="button" class="acct-btn acct-btn--danger acct-btn--mini fam-cat-del" aria-label="Remove ${esc(cat)} limit">×</button>`;
      row.querySelector(".fam-cat-del").addEventListener("click", () => row.remove());
      card.querySelector(".fam-cat-list").appendChild(row);
      sel.querySelector(`option[value="${cat.replace(/"/g, "\\\"")}"]`)?.remove();
      amt.value = "";
    });

    card.querySelector(".fam-save").addEventListener("click", async () => {
      err.hidden = true;
      const maxSpendChf = numOrNull(card.querySelector(".fam-max").value);
      const monthlyBudgetChf = numOrNull(card.querySelector(".fam-monthly").value);
      if (Number.isNaN(maxSpendChf) || Number.isNaN(monthlyBudgetChf)) return showErr("Limits must be positive numbers (or empty for no limit).");
      const categoryLimits = {};
      let bad = false;
      card.querySelectorAll(".fam-cat-row").forEach((row) => {
        const v = numOrNull(row.querySelector(".fam-cat-amt").value);
        if (Number.isNaN(v) || v == null) bad = true;
        else categoryLimits[row.dataset.cat] = v;
      });
      if (bad) return showErr("Category limits must be positive CHF amounts.");
      const btn = card.querySelector(".fam-save");
      btn.disabled = true;
      try {
        const r = await fetch("/api/account/family/limits", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ childId: child.id, maxSpendChf, monthlyBudgetChf, categoryLimits }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          showErr(j.error || "Could not save the limits.");
        }
      } catch { showErr("Could not reach the bridge."); }
      btn.disabled = false;
      loadFamily();
    });

    card.querySelector(".fam-suspend").addEventListener("click", async () => {
      await fetch("/api/account/family/suspend", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ childId: child.id, suspended: !child.suspended }),
      }).catch(() => {});
      loadFamily();
    });

    card.querySelector(".fam-remove").addEventListener("click", async () => {
      if (!confirm(`Remove ${child.name}'s account? Their sign-ins stop working immediately and their spend history is deleted.`)) return;
      await fetch("/api/account/family/remove", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ childId: child.id }),
      }).catch(() => {});
      loadFamily();
    });

    return card;
  }

  function renderFamily() {
    if (!familyCache || !familyCache.ok) return;
    famChildren.innerHTML = "";
    const children = familyCache.children || [];
    if (!children.length) {
      famChildren.innerHTML = '<p class="form-note">No child accounts yet — create the first one above.</p>';
      return;
    }
    children.forEach((child) => famChildren.appendChild(famChildCard(child, familyCache.categories || [])));
  }

  famForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    famError.hidden = true;
    const r = await fetch("/api/account/family/children", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name: famName.value.trim(), email: famEmail.value.trim(), password: famPassword.value }),
    }).catch(() => null);
    if (r && r.ok) {
      const j = await r.json();
      famForm.reset();
      addMessage("system", `Child account for ${j.child.name} created — they can sign in with the email and password you set. Limits apply once you save them below.`);
      loadFamily();
    } else if (r) {
      const j = await r.json().catch(() => ({}));
      famError.textContent = j.error || "Could not create the child account.";
      famError.hidden = false;
    } else {
      famError.textContent = "Could not reach the bridge.";
      famError.hidden = false;
    }
  });

  /* ---------- events ---------- */

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    send(input.value);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input.value);
    }
  });

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  });

  document.querySelectorAll(".prompt-item").forEach((btn) => {
    btn.addEventListener("click", () => send(btn.dataset.prompt));
  });

  /* ---------- auth & account ---------- */

  function setLocked(on) {
    locked = on;
    input.disabled = on;
    input.placeholder = on ? "Sign in to start shopping…" : "What are we shopping for?";
    sendBtn.disabled = on || busy;
  }

  function renderSignedIn(user) {
    currentUser = user;
    authed = true;
    accountSignedOut.hidden = true;
    accountSignedIn.hidden = false;
    acctName.textContent = user.name + (user.isDemo ? " (demo)" : "");
    acctPlan.textContent = user.planLabel + (user.isDemo ? " · demo" : "");
    acctUsage.textContent = user.usage.limit == null ? `${user.usage.used}/∞ msgs` : `${user.usage.used}/${user.usage.limit} msgs`;
    setLocked(false);
    if (!authOverlay.hidden && !accountView.hidden) renderAccountView(user);
  }
  function renderSignedOut() {
    currentUser = null;
    authed = false;
    accountSignedOut.hidden = false;
    accountSignedIn.hidden = true;
    setLocked(true);
    resetFeed();
  }

  async function refreshMe() {
    try {
      const r = await fetch("/api/auth/me", { headers: authHeaders() });
      if (!r.ok) { renderSignedOut(); return null; }
      const j = await r.json();
      renderSignedIn(j.user);
      return j.user;
    } catch { renderSignedOut(); return null; }
  }

  function showTab(which) {
    const login = which !== "register";
    tabLogin.classList.toggle("tab--active", login);
    tabRegister.classList.toggle("tab--active", !login);
    loginForm.hidden = !login;
    registerForm.hidden = login;
    loginError.hidden = true;
    registerError.hidden = true;
  }

  function openAuth(view) {
    authOverlay.hidden = false;
    newKeyBox.hidden = true;
    if (view === "account" && authed) {
      authView.hidden = true;
      accountView.hidden = false;
      renderAccountView(currentUser);
    } else if (view === "register") {
      authView.hidden = false;
      accountView.hidden = true;
      showTab("register");
    } else {
      authView.hidden = false;
      accountView.hidden = true;
      showTab("login");
    }
  }

  function closeAuth() { authOverlay.hidden = true; }

  function renderAccountView(user) {
    acctEmail.textContent = user.email;

    if (plansCache) {
      plansGrid.innerHTML = "";
      Object.entries(plansCache).forEach(([id, p]) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "plan-card" + (user.plan === id ? " plan-card--current" : "");
        card.innerHTML = `<span class="plan-name">${esc(p.label)}</span>
          <span class="plan-price">${esc(p.price)}</span>
          <span class="plan-note">${esc(p.note)}</span>
          <span class="mono-label plan-state">${user.plan === id ? "● current" : "switch →"}</span>`;
        card.addEventListener("click", async () => {
          if (user.plan === id) return;
          card.disabled = true;
          await fetch("/api/account/plan", {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ plan: id }),
          }).catch(() => {});
          await refreshMe();
        });
        plansGrid.appendChild(card);
      });
    }

    const u = user.usage;
    usageText.textContent = u.limit == null ? `${u.used} messages used today · unlimited` : `${u.used} of ${u.limit} messages used today · ${u.remaining} left`;
    usageFill.style.width = u.limit == null ? "0%" : `${Math.min(100, Math.round((u.used / Math.max(1, u.limit)) * 100))}%`;

    keyList.innerHTML = "";
    const keys = user.apiKeys || [];
    if (!keys.length) {
      keyList.innerHTML = '<p class="form-note">No keys yet.</p>';
    }
    keys.forEach((k) => {
      const row = document.createElement("div");
      row.className = "key-row";
      row.innerHTML = `<span class="key-name">${esc(k.name)}</span>
        <code class="key-masked">${esc(k.masked)}</code>
        <button class="acct-btn acct-btn--danger" type="button">Revoke</button>`;
      row.querySelector("button").addEventListener("click", async () => {
        await fetch("/api/account/keys/revoke", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ id: k.id }),
        });
        await refreshMe();
      });
      keyList.appendChild(row);
    });

    document.getElementById("urlOpenapi").textContent = `${location.origin}/openapi.json`;
    document.getElementById("urlPlugin").textContent = `${location.origin}/.well-known/ai-plugin.json`;

    /* Family: parents manage children; children see their limits read-only. */
    const isChild = Boolean(user.parentId);
    familyParentView.hidden = isChild;
    familyChildView.hidden = !isChild;
    famIntro.hidden = isChild;
    if (isChild) {
      familyCache = null;
      renderFamilySelfBanner(user);
    } else {
      loadFamily();
    }

    loadPurchases();
    loadShopping();
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    const email = String(loginForm.email.value || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      loginError.textContent = "Please enter a valid email address (e.g. you@example.com).";
      loginError.hidden = false;
      return;
    }
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: loginForm.password.value }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { if (j.session) setToken(j.session); loginForm.reset(); closeAuth(); refreshMe().then(loadHistory); }
    else { loginError.textContent = j.error || `Sign-in failed (HTTP ${r.status}).`; loginError.hidden = false; }
  });

  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    registerError.hidden = true;
    const r = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: registerForm.name.value, email: registerForm.email.value, password: registerForm.password.value }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { if (j.session) setToken(j.session); registerForm.reset(); closeAuth(); refreshMe(); addMessage("system", "Welcome — your account is ready. Open Account for plans and API keys."); }
    else { registerError.textContent = j.error || `Registration failed (HTTP ${r.status}).`; registerError.hidden = false; }
  });

  keyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await fetch("/api/account/keys", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name: keyForm.name.value.trim() || "api key" }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.key) {
      newKeyValue.textContent = j.key;
      newKeyBox.hidden = false;
      keyForm.reset();
      refreshMe();
    }
  });

  btnCopyKey.addEventListener("click", () => {
    if (navigator.clipboard) navigator.clipboard.writeText(newKeyValue.textContent).catch(() => {});
    btnCopyKey.textContent = "Copied ✓";
    setTimeout(() => (btnCopyKey.textContent = "Copy"), 1500);
  });

  btnLogout.addEventListener("click", async () => {
    setToken("");
    await fetch("/api/auth/logout", { method: "POST", headers: authHeaders() }).catch(() => {});
    closeAuth();
    renderSignedOut();
  });

  btnClearChat.addEventListener("click", async () => {
    if (busy || !authed) return;
    await fetch("/api/history", { method: "DELETE", headers: authHeaders() }).catch(() => {});
    resetFeed();
    addMessage("system", "Chat view cleared — the agent's memory of this conversation stays.");
  });

  /* stop the running task: abort the stream client-side AND kill the turn server-side */
  if (btnStopTurn) btnStopTurn.addEventListener("click", async () => {
    if (!busy || stopRequested) return;
    stopRequested = true;
    await fetch("/api/chat/stop", { method: "POST", headers: authHeaders() }).catch(() => {});
    if (activeController) activeController.abort();
  });

  btnShowAuth.addEventListener("click", () => openAuth(authed ? "account" : "login"));
  btnAccount.addEventListener("click", () => openAuth("account"));
  btnCloseAuth.addEventListener("click", closeAuth);
  tabLogin.addEventListener("click", () => showTab("login"));
  tabRegister.addEventListener("click", () => showTab("register"));
  authOverlay.addEventListener("click", (e) => { if (e.target === authOverlay) closeAuth(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !authOverlay.hidden) closeAuth(); });

  /* ---------- boot ---------- */

  (async () => {
    const me = await refreshMe();
    if (me) {
      loadHistory(); // restore the stored conversation across reloads
    } else {
      openAuth("login"); // registration-first: gate the concierge
    }
    health();
    input.focus();
  })();
})();
