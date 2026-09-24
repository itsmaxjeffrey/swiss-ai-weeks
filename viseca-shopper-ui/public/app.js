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

  let turns = 0;
  let busy = false;

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

  function addMessage(role, text) {
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
        slot.replaceWith(buildPolicyCard(policy));
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

  function buildPolicyCard(policy) {
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
          headers: { "Content-Type": "application/json" },
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
          state.textContent = "refused — incomplete";
          card.classList.add("policy-card--failed");
          setBusy(false);
          result.hidden = false;
          const missing = (j.missing || []).map((m) => `<li><code>${esc(m)}</code></li>`).join("");
          result.innerHTML = `<p><strong>The authority refused to sign — the policy is incomplete.</strong> The agent must ask you for:</p><ul>${missing}</ul>`;
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
    sendBtn.disabled = on;
    typing.hidden = !on;
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

  /* ---------- API ---------- */

  async function health() {
    try {
      const r = await fetch("/api/health");
      const j = await r.json();
      if (j.ok) {
        setStatus("on", "connected");
        if (j.agent) statusAgent.textContent = j.agent;
        const fs = document.getElementById("footerSession");
        if (fs && j.session) fs.textContent = j.session;
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
      const abortTimer = setTimeout(() => controller.abort(), 630000);
      try {
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text.trim() }),
          signal: controller.signal,
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          addMessage("error", j.error || `Request failed (HTTP ${r.status}).`);
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
      addMessage(
        "error",
        e.name === "AbortError"
          ? "Connection lost while the agent was working. The turn may still have completed — reload and ask a follow-up."
          : `Could not reach the bridge: ${e.message}`
      );
    } finally {
      setBusy(false);
      input.focus();
    }
  }

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

  health();
  input.focus();
})();
