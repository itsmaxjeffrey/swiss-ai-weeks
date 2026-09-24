// LEASH wallet-control — builds live-shaped authorization events from the data pack.
// Follows technical_details.md §3: join purchase_attempts + items + merchants,
// convert amounts to numbers, empty nullable fields -> null, nested objects, fresh
// real-clock deadlines while preserving simulated purchase times.
import { loadCsv, num, str } from '../lib/util.js';

export class PackData {
  constructor(dir) {
    this.dir = dir;
    this.attempts = loadCsv(`${dir}/purchase_attempts.csv`);
    this.attemptItems = loadCsv(`${dir}/purchase_attempt_items.csv`);
    this.merchants = new Map(loadCsv(`${dir}/merchants.csv`).map(m => [m.merchant_id, m]));
    this.scenarios = loadCsv(`${dir}/scenario_catalogue.csv`);
    this.authorities = loadCsv(`${dir}/scenario_authorities.csv`);
    this.itemsById = new Map(loadCsv(`${dir}/items.csv`).map(i => [i.item_id, i]));
    // group cart lines by authorization
    this.itemsByAuth = new Map();
    for (const it of this.attemptItems) {
      if (!this.itemsByAuth.has(it.authorization_id)) this.itemsByAuth.set(it.authorization_id, []);
      this.itemsByAuth.get(it.authorization_id).push(it);
    }
    // attempts grouped by scenario, ordered by replay_order
    this.byScenario = new Map();
    for (const row of this.attempts) {
      if (!this.byScenario.has(row.scenario_id)) this.byScenario.set(row.scenario_id, []);
      this.byScenario.get(row.scenario_id).push(row);
    }
    for (const list of this.byScenario.values()) list.sort((a, b) => num(a.replay_order) - num(b.replay_order));
  }

  scenario(id) { return this.scenarios.find(s => s.scenario_id === id) || null; }

  /** Build one live-shaped event for attempt row `row` (plus mandate + context). */
  buildEvent(row, { mandate, context }) {
    const m = this.merchants.get(row.merchant_id) || {};
    const items = (this.itemsByAuth.get(row.authorization_id) || []).map(l => ({
      line_no: num(l.line_no),
      item_id: l.item_id,
      item_name: l.item_name,
      item_category: l.item_category,
      quantity: num(l.quantity),
      unit_price: num(l.unit_price),
      currency: l.currency,
      item_details: str(l.item_details),
    }));
    return {
      type: 'authorization.request',
      request_id: `req_${row.authorization_id.toLowerCase()}_${Date.now()}`,
      deadline_at: new Date(Date.now() + 8000).toISOString(),
      authorization: {
        authorization_id: row.authorization_id, // offline events use source ids as live ids
        source_authorization_id: row.authorization_id,
        scenario_id: row.scenario_id,
        replay_order: num(row.replay_order),
        mandate_id: mandate.mandate_id,
        profile_id: `PROFILE_${row.authority_id}`,
        card_id: row.card_id,
        initiator_type: 'agent',
        merchant: {
          merchant_id: m.merchant_id ?? row.merchant_id,
          merchant_name: m.merchant_name ?? null,
          merchant_category: m.merchant_category ?? null,
          merchant_mcc: m.merchant_mcc ? String(m.merchant_mcc) : null,
          merchant_country: m.merchant_country ?? null,
          merchant_city: m.merchant_city ?? null,
          availability: m.availability ?? null,
          recurring_capable: m.recurring_capable ? String(m.recurring_capable) : null,
        },
        timestamp: row.timestamp,
        amount: num(row.amount),
        currency: row.currency,
        billing_amount_chf: num(row.billing_amount_chf),
        items_subtotal: num(row.items_subtotal),
        delivery_fee: num(row.delivery_fee),
        channel: row.channel,
        customer_device_id: str(row.customer_device_id),
        authority_status: row.authority_status,
        card_status_at_attempt: row.card_status_at_attempt,
        spend_in_period_before_chf: row.spend_in_period_before_chf === '' ? null : num(row.spend_in_period_before_chf),
        recent_attempt_count_10m: row.recent_attempt_count_10m === '' ? 0 : num(row.recent_attempt_count_10m),
        fulfillment_method: str(row.fulfillment_method),
        delivery_by: str(row.delivery_by),
        order_returnable: str(row.order_returnable),
        order_cancellable: str(row.order_cancellable),
        related_authorization_id: str(row.related_authorization_id),
        related_authorization_status: str(row.related_authorization_status),
        purchase_description: str(row.purchase_description),
        items,
      },
      mandate,
      context: context || {
        approved_spend_in_period_chf: 0.0,
        recent_authorizations: [],
      },
      runtime: {
        received_at: new Date().toISOString(),
        history_window_minutes: 10,
        context_basis: 'run_decisions_and_scenario_timestamps',
      },
    };
  }
}
