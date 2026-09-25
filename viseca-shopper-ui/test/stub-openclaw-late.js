#!/usr/bin/env node
/**
 * stub-openclaw-late.js — test double for late-delivery tests.
 *
 * Real turns (no pickup marker)  → sleep FAIL_DELAY_MS, then exit with a
 *   parseable CLI-JSON envelope that has NO reply text (the aborted-run shape
 *   that maps to kind=no-reply, "no detail").
 * Pickup turns (message contains "task-completion pickup") → reply instantly
 *   with the captured late result.
 * sessions --json --active N --agent A → {"sessions":[]} (progress frames are
 *   best-effort; empty is fine).
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
  const message = String(args[msgIdx + 1] || "");

  if (message.includes("task-completion pickup")) {
    process.stdout.write(
      JSON.stringify({
        sessionKey,
        finalAssistantVisibleText:
          "Late result: the interrupted task finished after the cutoff — this is the full reply.",
      })
    );
    process.exit(0);
  }

  const failDelay = parseInt(process.env.FAIL_DELAY_MS || "5000", 10);
  setTimeout(() => {
    // Aborted-run shape: parseable JSON, no reply text, no diagnostics.
    process.stdout.write(JSON.stringify({ sessionKey, events: [], assistantTurns: 1 }));
    process.exit(0);
  }, failDelay);
  return;
}

process.stderr.write(`stub-late: unsupported mode ${args[0] || "(none)"}\n`);
process.exit(2);
