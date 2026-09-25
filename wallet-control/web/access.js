/* Device-held signing keys never leave this browser. */
(() => {
  const encoder = new TextEncoder();
  const endpoint = path => (location.pathname.startsWith('/wallet/') ? '/wallet' : '') + path;
  let identity, access;
  const banner = document.createElement('aside');
  banner.className = 'wallet-access';
  banner.style.cssText = 'padding:12px 24px;border-bottom:1px solid #b8b2a3;background:#f7f0dd;font:14px system-ui;overflow-wrap:anywhere';
  document.body.prepend(banner);
  const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = async raw => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(raw)))].map(x => x.toString(16).padStart(2, '0')).join('');
  function database() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('wallet-device-identity', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function stored(value) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('keys', value ? 'readwrite' : 'readonly');
      const req = value ? tx.objectStore('keys').put(value, 'primary') : tx.objectStore('keys').get('primary');
      let result;
      req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => { db.close(); resolve(value || result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }
  async function check() {
    const response = await fetch(endpoint('/api/access' + (identity?.id ? '?device=' + encodeURIComponent(identity.id) : '')));
    if (!response.ok) throw new Error('Device access is unavailable.');
    access = await response.json();
    const status = typeof access.device === 'string' ? access.device : access.device?.status;
    const active = status === 'active' || status === 'approved';
    banner.hidden = !access.required || active;
    if (!banner.hidden) banner.textContent = identity?.id ? `Device approval pending · ${identity.id}. Approve this device from an enrolled browser or the wallet host.` : 'Register this browser to manage your wallet.';
    window.dispatchEvent(new CustomEvent('wallet:access', { detail: { ...access, deviceId: identity?.id } }));
    return access;
  }
  const ready = (async () => {
    await check();
    if (!access.required) return;
    identity = await stored();
    if (!identity) {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      identity = { privateKey: pair.privateKey, publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey) };
      await stored(identity);
    }
    if (!identity.id) {
      const response = await fetch(endpoint('/api/devices/request'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public_key: identity.publicKey, name: 'Wallet browser' }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Device registration failed.');
      identity.id = result.id || result.device_id || result.device?.id;
      if (!identity.id) throw new Error('Device registration did not return an identity.');
      await stored(identity);
    }
    await check();
  })().catch(error => { banner.hidden = false; banner.textContent = error.message; });
  window.walletHeaders = async (path, method = 'GET', raw = '') => {
    await ready;
    if (!access?.required || /\/api\/(access|devices\/request|proofs\/key|proofs\/verify)(?:[/?]|$)/.test(path)) return {};
    if (!identity?.id) throw new Error('Register this browser before changing the wallet.');
    const timestamp = String(Date.now());
    const nonce = crypto.randomUUID();
    const message = [method.toUpperCase(), path, timestamp, nonce, await digest(raw)].join('\n');
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, encoder.encode(message));
    return { 'x-wallet-device': identity.id, 'x-wallet-time': timestamp, 'x-wallet-nonce': nonce, 'x-wallet-signature': encode(signature) };
  };
  setInterval(() => { if (identity?.id && access?.required) check().catch(() => {}); }, 5000);
})();
