// LEASH wallet-control — platform client. Transparently uses the hosted challenge
// API when LEASH_BASE_URL + TEAM_API_KEY are set, otherwise the local simulator.
import { LocalApi } from '../sim/local-api.js';

export class HttpApiClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.mode = 'live';
  }

  async #call(method, path, body) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(35000),
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`API ${res.status} ${path}: ${json?.error?.message || json?.error || text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  bootstrap() { return this.#call('GET', '/v1/bootstrap'); }
  referenceData() { return this.#call('GET', '/v1/reference-data'); }
  createMandate(body) { return this.#call('POST', '/v1/mandates', body); }
  confirmMandate(draftId, body) { return this.#call('POST', `/v1/mandates/${draftId}/confirm`, body); }
  getMandate(id) { return this.#call('GET', `/v1/mandates/${id}`); }
  patchMandate(id, body) { return this.#call('PATCH', `/v1/mandates/${id}`, body); }
  revokeMandate(id) { return this.#call('DELETE', `/v1/mandates/${id}`); }
  startRun(body) { return this.#call('POST', '/v1/scenario-runs', body); }
  getRun(id) { return this.#call('GET', `/v1/scenario-runs/${id}`); }
  async nextRequest(runId, waitMs = 25000) {
    const json = await this.#call('GET', `/v1/decision-requests/next?wait=${Math.round(waitMs / 1000)}`);
    return json ? { envelope: json } : null;
  }
  submitDecision(authId, body) { return this.#call('POST', `/v1/authorizations/${authId}/decision`, body); }
  resolve(authId, body) { return this.#call('POST', `/v1/authorizations/${authId}/resolve`, body); }
}

export function makeClient(store) {
  const base = process.env.LEASH_BASE_URL;
  const key = process.env.TEAM_API_KEY;
  if (base && key && process.env.LEASH_MODE !== 'offline') {
    return new HttpApiClient(base, key);
  }
  const packDir = process.env.PACK_DIR || new URL('../data/pack/', import.meta.url).pathname;
  return new LocalApi(packDir, store);
}
