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
  setTimeout(() => {
    process.stdout.write(
      JSON.stringify({
        sessionKey,
        events: [{ type: "assistant", text: `Stub reply for ${sessionKey}: you said "${message.slice(0, 40)}"` }],
        finalAssistantVisibleText: `Stub reply for **${sessionKey}** — got "${message.slice(0, 60)}"`,
        assistantTurns: 2,
        toolSummary: { calls: 3, tools: ["browser", "read"], totalToolTimeMs: 120 },
        model: "stub-model",
        provider: "stub",
      })
    );
    process.exit(0);
  }, 250);
  return;
}

process.stderr.write(`stub: unsupported mode ${args[0] || "(none)"}\n`);
process.exit(2);
