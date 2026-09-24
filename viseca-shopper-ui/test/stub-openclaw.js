#!/usr/bin/env node
/**
 * stub-openclaw.js — test double for the OpenClaw CLI.
 *
 *   agent --agent A --session-key S --json -m MSG
 *     → after a short delay prints a CLI-JSON envelope whose reply embeds the
 *       session key, proving per-user session pass-through.
 *   sessions --json --active N --agent A
 *     → {"sessions":[]} (progress frames are best-effort; empty is fine)
 */
const args = process.argv.slice(2);

if (args[0] === "sessions") {
  process.stdout.write(JSON.stringify({ sessions: [] }));
  process.exit(0);
}

if (args[0] === "agent") {
  const keyIdx = args.indexOf("--session-key");
  const sessionKey = keyIdx >= 0 ? args[keyIdx + 1] : "unknown";
  const msgIdx = args.indexOf("-m");
  const message = msgIdx >= 0 ? String(args[msgIdx + 1] || "") : "";
  if (!message.trim()) {
    process.stderr.write("stub: empty message\n");
    process.exit(3);
  }
  // Activity reporting: when the bridge asks for progress steps, POST a few
  // labels exactly like the real agent would, then reply.
  const tokM = /X-Activity-Token: ([0-9a-f]+)/.exec(message);
  const portM = /http:\/\/127\.0\.0\.1:(\d+)\/api\/chat\/activity/.exec(message);
  const stepDelay = parseInt(process.env.STUB_STEP_DELAY_MS || "200", 10);
  const echo = message.split("\n\n(System:")[0]; // never echo the activity-reporting note
  const report = (tokM && portM)
    ? (async () => {
        delete process.env.NODE_USE_ENV_PROXY;
        process.env.NO_PROXY = "127.0.0.1,localhost";
        const base = `http://127.0.0.1:${portM[1]}/api/chat/activity`;
        const labels = [
          "Searching the web for running shoes",
          "Visiting digitec.ch",
          "Comparing prices at digitec.ch, galaxus.ch",
        ];
        for (const label of labels) {
          await new Promise((r) => setTimeout(r, stepDelay));
          try {
            await fetch(base, {
              method: "POST",
              headers: { "X-Activity-Token": tokM[1], "Content-Type": "application/json" },
              body: JSON.stringify({ label }),
            });
          } catch { /* bridge may be shutting down */ }
        }
      })()
    : Promise.resolve();
  report.then(() => {
    setTimeout(() => {
      process.stdout.write(
        JSON.stringify({
          sessionKey,
          events: [{ type: "assistant", text: `Stub reply for ${sessionKey}: you said "${message.slice(0, 40)}"` }],
          finalAssistantVisibleText: `Stub reply for **${sessionKey}** — got "${echo.slice(0, 60)}"`,
          assistantTurns: 2,
          toolSummary: { calls: 3, tools: ["browser", "read"], totalToolTimeMs: 120 },
          model: "stub-model",
          provider: "stub",
        })
      );
      process.exit(0);
    }, 150);
  });
  return;
}

process.stderr.write(`stub: unsupported mode ${args[0] || "(none)"}\n`);
process.exit(2);
