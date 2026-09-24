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

    el.innerHTML = `
      <div class="msg-meta"><span class="red">${marks[role] || "·"}</span> ${names[role] || role} — ${nowLabel()}</div>
      <div class="msg-body">${role === "agent" ? md(text) : esc(text).replace(/\n/g, "<br>")}</div>`;
    feed.appendChild(el);
    feed.scrollTop = feed.scrollHeight;
    return el;
  }

  function setBusy(on) {
    busy = on;
    composer.classList.toggle("busy", on);
    sendBtn.disabled = on;
    typing.hidden = !on;
    if (on) {
      let i = 0;
      typingText.textContent = THINKING_WORDS[0];
      thinkingTimer = setInterval(() => {
        i = (i + 1) % THINKING_WORDS.length;
        typingText.textContent = THINKING_WORDS[i];
      }, 2200);
    } else if (thinkingTimer) {
      clearInterval(thinkingTimer);
      thinkingTimer = null;
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
      // Safety net: the bridge itself gives up on the agent after 5 min; if the
      // connection dies without notice (proxy dropped it), abort so the
      // indicator never spins forever.
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 390000);
      let r, j;
      try {
        r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text.trim() }),
          signal: controller.signal,
        });
        j = await r.json().catch(() => ({}));
      } finally {
        clearTimeout(abortTimer);
      }
      if (r.ok && j.reply) {
        addMessage("agent", j.reply);
      } else {
        addMessage("error", j.error || `Request failed (HTTP ${r.status}).`);
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
