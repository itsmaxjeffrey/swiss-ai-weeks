// Keep a hosted reference catalogue separate from a complete offline replay pack.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCsv } from './util.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function coherentReplayPack(dir) {
  try {
    const scenarios = loadCsv(path.join(dir, 'scenario_catalogue.csv'));
    const attempts = loadCsv(path.join(dir, 'purchase_attempts.csv'));
    const merchants = new Set(loadCsv(path.join(dir, 'merchants.csv')).map(r => r.merchant_id));
    const authorities = new Set(loadCsv(path.join(dir, 'scenario_authorities.csv')).map(r => r.authority_id));
    const items = new Set(loadCsv(path.join(dir, 'items.csv')).map(r => r.item_id));
    const lines = loadCsv(path.join(dir, 'purchase_attempt_items.csv'));
    const ids = new Set(attempts.map(a => a.authorization_id));
    const scenarioIds = new Set(scenarios.map(s => s.scenario_id));
    return scenarios.length > 0 && scenarios.every(s => attempts.filter(a => a.scenario_id === s.scenario_id).length === Number(s.event_count))
      && attempts.every(a => scenarioIds.has(a.scenario_id) && merchants.has(a.merchant_id) && authorities.has(a.authority_id) && lines.some(l => l.authorization_id === a.authorization_id))
      && lines.every(l => ids.has(l.authorization_id) && items.has(l.item_id));
  } catch { return false; }
}
export function offlinePackPath(env = process.env) {
  if (env.PACK_DIR) {
    if (!coherentReplayPack(env.PACK_DIR)) throw new Error('PACK_DIR is not a coherent offline replay pack: catalogue, attempts and references must match.');
    return env.PACK_DIR;
  }
  const candidates = [path.join(root, 'data/pack'), path.join(root, 'data/offline-pack'), path.resolve(root, '../merchant-trust-data/data/raw/viseca/extracted/viseca-2026-main/data')];
  const selected = candidates.find(coherentReplayPack);
  if (!selected) throw new Error('No complete offline data pack found. Set PACK_DIR to the original Viseca data pack.');
  return selected;
}
