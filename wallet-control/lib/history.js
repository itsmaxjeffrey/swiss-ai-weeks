// LEASH wallet-control — historical-activity profiles per customer.
// Builds familiarity baselines from authorization_history.csv: which merchants and
// devices the customer has actually used, and at which hours they normally buy.
import { loadCsv, num, parseTs, round2 } from './util.js';

export class HistoryProfiles {
  constructor(historyRows) {
    /** customer -> Map(merchant_id -> {name, approved, declined, lastTs, lastApprovedTs}) */
    this.merchants = new Map();
    /** customer -> Map(device_id -> {approved, lastTs}) */
    this.devices = new Map();
    /** customer -> Uint8Array(24) approved-purchase counts by hour-of-day */
    this.hours = new Map();
    /** customer -> total approved purchase count */
    this.purchaseCount = new Map();

    for (const r of historyRows) {
      const cust = r.customer_id;
      if (!cust) continue;
      const ts = parseTs(r.timestamp);
      const status = (r.status || '').toLowerCase();
      const approved = status === 'approved' || status === 'settled';
      const mid = r.merchant_id;
      if (mid) {
        if (!this.merchants.has(cust)) this.merchants.set(cust, new Map());
        const m = this.merchants.get(cust);
        if (!m.has(mid)) m.set(mid, { name: r.merchant_name || mid, approved: 0, declined: 0, lastTs: null, lastApprovedTs: null });
        const e = m.get(mid);
        if (r.merchant_name) e.name = r.merchant_name;
        if (status === 'declined') e.declined++;
        if (approved) { e.approved++; if (ts && (!e.lastApprovedTs || ts > e.lastApprovedTs)) e.lastApprovedTs = ts; }
        if (ts && (!e.lastTs || ts > e.lastTs)) e.lastTs = ts;
      }
      const dev = r.customer_device_id;
      if (dev) {
        if (!this.devices.has(cust)) this.devices.set(cust, new Map());
        const d = this.devices.get(cust);
        if (!d.has(dev)) d.set(dev, { approved: 0, lastTs: null });
        const e = d.get(dev);
        if (approved) e.approved++;
        if (ts && (!e.lastTs || ts > e.lastTs)) e.lastTs = ts;
      }
      if (approved && ts) {
        if (!this.hours.has(cust)) this.hours.set(cust, new Uint8Array(24));
        // saturating counter is fine: we only test "ever observed"
        const h = this.hours.get(cust);
        if (h[new Date(ts).getUTCHours()] < 255) h[new Date(ts).getUTCHours()]++;
        this.purchaseCount.set(cust, (this.purchaseCount.get(cust) || 0) + 1);
      }
    }
  }

  static load(path) {
    return new HistoryProfiles(loadCsv(path));
  }

  /** Has this customer bought at this merchant before (any approved purchase)? */
  merchantFamiliar(customerId, merchantId) {
    const e = this.merchants.get(customerId)?.get(merchantId);
    if (!e) return { familiar: false, approvedCount: 0 };
    return { familiar: e.approved > 0, approvedCount: e.approved, lastApprovedTs: e.lastApprovedTs, name: e.name };
  }

  /** All merchant names/ids this customer has approved purchases with (for lookalike checks). */
  knownMerchants(customerId) {
    const out = [];
    for (const [mid, e] of this.merchants.get(customerId) || []) {
      if (e.approved > 0) out.push({ merchantId: mid, name: e.name, approvedCount: e.approved });
    }
    return out;
  }

  deviceKnown(customerId, deviceId) {
    if (!deviceId) return { known: false, approvedCount: 0 };
    const e = this.devices.get(customerId)?.get(deviceId);
    return { known: !!e && (e.approved > 0 || !!e.lastTs), approvedCount: e?.approved || 0 };
  }

  /** Hour never observed in this customer's history AND outside a generous 07–23 envelope. */
  hourUnusual(customerId, ts) {
    const h = this.hours.get(customerId);
    const hour = new Date(ts).getUTCHours();
    const everSeen = h ? h[hour] > 0 : false;
    const envelope = hour >= 7 && hour <= 22;
    return { unusual: !everSeen && !envelope, everSeen, hour };
  }
}
