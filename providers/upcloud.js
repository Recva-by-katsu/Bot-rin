/**
 * providers/upcloud.js - Klien API UpCloud
 * Base https://api.upcloud.com, auth Bearer <token>
 */
const { shellEscape } = require('../lib/validators');

const BASE = 'https://api.upcloud.com';

function asArray(maybe) {
  if (!maybe) return [];
  if (Array.isArray(maybe)) return maybe;
  return [maybe];
}

class UpCloudClient {
  constructor(token, opts = {}) {
    this.token = token;
    this.timeout = opts.timeout || 15000;
  }

  async _request(method, path, body = null, retries = 1) {
    const url = `${BASE}${path}`;
    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const fetchOpts = {
      method,
      headers,
      signal: controller.signal
    };
    if (body) fetchOpts.body = JSON.stringify(body);

    try {
      let res = await fetch(url, fetchOpts);
      clearTimeout(timeoutId);

      // Retry on 429
      if (res.status === 429 && retries > 0) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '2', 10);
        await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
        return this._request(method, path, body, retries - 1);
      }

      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }

      if (!res.ok) {
        const errCode = json?.error?.error_code || `HTTP_${res.status}`;
        const errMsg = json?.error?.error_message || text || `HTTP ${res.status}`;
        const err = new Error(errMsg);
        err.status = res.status;
        err.code = errCode;
        err.raw = json;
        throw err;
      }
      return json;
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        const err = new Error('Timeout koneksi ke UpCloud');
        err.status = 0;
        err.code = 'TIMEOUT';
        throw err;
      }
      throw e;
    }
  }

  translateError(err) {
    if (!err.status) return `⚠️ Gagal terhubung ke UpCloud: ${err.message}. Coba lagi nanti.`;
    if (err.status === 401) return `❌ Token salah / dicabut / kedaluwarsa (401). Buat token baru di panel UpCloud.`;
    if (err.status === 403) {
      return `⚠️ Ditolak (403): izin kurang atau token dibatasi IP. Cek Allowed IP ranges token di panel UpCloud dan pastikan IP server bot diizinkan.`;
    }
    if (err.status === 404) return `❌ Tidak ditemukan (404): ${err.message}`;
    if (err.status === 409) return `⚠️ Konflik (409): ${err.message}. Mungkin VPS masih dalam proses.`;
    if (err.status === 429) return `⚠️ Terlalu banyak request (429). Coba lagi sebentar.`;
    if (err.status >= 500) return `⚠️ Server UpCloud error (${err.status}). Coba lagi nanti.`;
    return `⚠️ Error UpCloud (${err.status}): ${err.message}`;
  }

  // Account
  async getAccount() {
    return this._request('GET', '/1.3/account');
  }
  async getTokens() {
    // Returns array directly per spec
    try {
      const res = await this._request('GET', '/1.3/account/tokens');
      // API returns array directly? Spec says array
      if (Array.isArray(res)) return res;
      if (res && Array.isArray(res.tokens)) return res.tokens;
      return [];
    } catch (e) {
      if (e.status === 403 || e.status === 404) return null; // no permission, skip silently
      throw e;
    }
  }
  async getBillingSummary(yearMonth) {
    // yearMonth: YYYY-MM
    return this._request('GET', `/1.3/account/billing_summary/${yearMonth}`);
  }

  // Zone
  async getZones() {
    const data = await this._request('GET', '/1.3/zone');
    const zones = asArray(data?.zones?.zone);
    return zones.filter(z => z.public === 'yes');
  }

  // Plan
  async getPlans() {
    const data = await this._request('GET', '/1.3/plan');
    let plans = asArray(data?.plans?.plan);
    // Buang GPU dan current_offering no
    plans = plans.filter(p => {
      if (p.gpu_amount && parseInt(p.gpu_amount) > 0) return false;
      if (p.current_offering === 'no') return false;
      return true;
    });
    // Urutkan naik: core, memory, storage
    plans.sort((a,b) => {
      if (a.core_number !== b.core_number) return a.core_number - b.core_number;
      if (a.memory_amount !== b.memory_amount) return a.memory_amount - b.memory_amount;
      return (a.storage_size||0) - (b.storage_size||0);
    });
    return plans;
  }

  // Templates
  async getTemplates() {
    let all = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const data = await this._request('GET', `/1.3/storage/template?limit=${limit}&offset=${offset}`);
      const storages = asArray(data?.storages?.storage);
      if (storages.length === 0) break;
      all = all.concat(storages);
      if (storages.length < limit) break;
      offset += limit;
      if (offset > 1000) break; // safety
    }
    // Buang private dan Windows
    all = all.filter(s => {
      if (s.access === 'private') return false;
      if (s.type && s.type !== 'template') {
        // keep only templates? spec says storage/template, so type template
      }
      // Buang Windows: title mengandung Windows
      if (/windows/i.test(s.title)) return false;
      return true;
    });
    return all;
  }
  async getAllTemplatesIncludingWindows() {
    // Untuk internal cek, tapi kita tetap filter Windows di UI sesuai spec
    let all = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const data = await this._request('GET', `/1.3/storage/template?limit=${limit}&offset=${offset}`);
      const storages = asArray(data?.storages?.storage);
      if (storages.length === 0) break;
      all = all.concat(storages);
      if (storages.length < limit) break;
      offset += limit;
      if (offset > 1000) break;
    }
    return all.filter(s => s.access !== 'private');
  }

  // Servers
  async getServers() {
    const data = await this._request('GET', '/1.3/server');
    return asArray(data?.servers?.server);
  }
  async getServer(uuid) {
    const data = await this._request('GET', `/1.3/server/${uuid}`);
    return data?.server;
  }
  async createServer(payload) {
    return this._request('POST', '/1.3/server', payload);
  }
  async startServer(uuid) {
    return this._request('POST', `/1.3/server/${uuid}/start`);
  }
  async stopServer(uuid, type='soft') {
    return this._request('POST', `/1.3/server/${uuid}/stop`, { stop_server: { stop_type: type, timeout: "60" } });
  }
  async restartServer(uuid, type='soft') {
    return this._request('POST', `/1.3/server/${uuid}/restart`, { restart_server: { stop_type: type, timeout: "60", timeout_action: "destroy" } });
  }
  async deleteServer(uuid) {
    // DELETE ?storages=1&backups=delete
    return this._request('DELETE', `/1.3/server/${uuid}?storages=1&backups=delete`);
  }
  async getVncDetails(uuid) {
    const data = await this._request('GET', `/1.3/server/${uuid}/vnc_details`);
    return data?.server;
  }
  async getFirewallRules(uuid) {
    const data = await this._request('GET', `/1.3/server/${uuid}/firewall_rule`);
    return asArray(data?.firewall_rules?.firewall_rule);
  }
  async setFirewallRules(uuid, rules) {
    return this._request('PUT', `/1.3/server/${uuid}/firewall_rule`, { firewall_rules: { firewall_rule: rules } });
  }
  async setFirewallStatus(uuid, on, defaultAction='drop') {
    if (on) {
      return this._request('PUT', `/1.3/server/${uuid}`, { server: { firewall: "on", firewall_public_default_incoming_action: defaultAction } });
    } else {
      return this._request('PUT', `/1.3/server/${uuid}`, { server: { firewall: "off" } });
    }
  }
  async setRemoteAccess(uuid, enabled) {
    return this._request('PUT', `/1.3/server/${uuid}`, { server: { remote_access_enabled: enabled ? "yes" : "no" } });
  }
  async setMetadata(uuid, enabled) {
    return this._request('PUT', `/1.3/server/${uuid}`, { server: { metadata: enabled ? "yes" : "no" } });
  }
  async rebuildServer(uuid, payload) {
    return this._request('POST', `/1.3/server/${uuid}/rebuild`, payload);
  }
}

module.exports = UpCloudClient;
