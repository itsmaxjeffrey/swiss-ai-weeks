// Execution bounds are passed to the gateway, not only to the CLI launcher.
function agentTimeoutSeconds(bridgeMs) {
  const reserveMs = Math.min(10000, Math.max(100, bridgeMs * 0.1));
  return Math.max(1, Math.floor((bridgeMs - reserveMs) / 1000));
}
function classifyFailure({ detail = '', stderr = '', elapsedMs = 0, timeoutMs }) {
  const diagnostic = `${detail}\n${stderr}`;
  if (/PluginInstanceUnavailable|replacement not applied|runtime owner.*(?:not published|not committed)|plugin host cleanup timed out|model catalog is not ready/i.test(diagnostic)) {
    return { kind: 'infrastructure', message: 'Shopping runtime unavailable; automatic resubmission suppressed.' };
  }
  if (/timed out|timeout|stop=aborted/i.test(diagnostic) || elapsedMs >= agentTimeoutSeconds(timeoutMs) * 1000) {
    return { kind: 'agent-timeout', message: 'Agent deadline reached without a final reply.' };
  }
  return { kind: 'no-reply', message: 'Agent JSON contained no reply text.' };
}
function turnSafetyNote(timeoutMs) {
  const seconds = agentTimeoutSeconds(timeoutMs);
  return `\n\n(System: shopper execution limits. This turn has a ${seconds}-second agent deadline. Return a customer-visible answer before the deadline. Before any browsing for a purchase, follow the signed Order Policy Gate. If required policy details are missing, ask a concise plain-chat question and END the turn now. Do not run merchant feasibility searches first. Browser commands must use the bounded scripts/browser-safe.js helper from your workspace. If browser access reports unavailable or times out, stop browsing and return a plain-language failure immediately. Never reload, enable, disable, update, or restart shared plugins, the gateway, or services during a shopper turn. Never bypass a broken browser by reconstructing checkout APIs. Never claim an order succeeded without merchant confirmation. Do not automatically repeat a purchase after an interrupted checkout; first establish its status.)`;
}
module.exports = { agentTimeoutSeconds, classifyFailure, turnSafetyNote };
