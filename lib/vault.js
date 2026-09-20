/**
 * vault.js - Penyimpanan token terenkripsi AES-256-GCM
 * AAD = userId:accountId
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');
const VAULT_KEY_FILE = path.join(__dirname, '..', 'data', 'vault.key');

function getKeyFromConfig(config) {
  if (config.ENCRYPTION_KEY && typeof config.ENCRYPTION_KEY === 'string' && config.ENCRYPTION_KEY.trim() !== '') {
    const s = config.ENCRYPTION_KEY.trim();
    // 64 hex chars
    if (/^[0-9a-fA-F]{64}$/.test(s)) {
      return Buffer.from(s, 'hex');
    }
    // Try base64 that decodes to 32 bytes
    try {
      const b = Buffer.from(s, 'base64');
      if (b.length === 32) return b;
    } catch {}
    // Fallback: SHA256 hash
    return crypto.createHash('sha256').update(s).digest();
  }
  // Auto key
  if (!fs.existsSync(path.dirname(VAULT_KEY_FILE))) {
    fs.mkdirSync(path.dirname(VAULT_KEY_FILE), { recursive: true });
  }
  if (fs.existsSync(VAULT_KEY_FILE)) {
    const content = fs.readFileSync(VAULT_KEY_FILE, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(content)) {
      return Buffer.from(content, 'hex');
    }
    // If file contains base64 or other, try
    try {
      const b = Buffer.from(content, 'hex');
      if (b.length === 32) return b;
    } catch {}
    // If not hex, maybe base64
    try {
      const b = Buffer.from(content, 'base64');
      if (b.length === 32) return b;
    } catch {}
    // Fallback: hash content
    return crypto.createHash('sha256').update(content).digest();
  } else {
    // Generate new
    const key = crypto.randomBytes(32);
    const hex = key.toString('hex');
    const tmp = VAULT_KEY_FILE + '.tmp';
    fs.writeFileSync(tmp, hex, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, VAULT_KEY_FILE);
    try { fs.chmodSync(VAULT_KEY_FILE, 0o600); } catch {}
    return key;
  }
}

class Vault {
  constructor(config) {
    this.config = config;
    this.key = getKeyFromConfig(config);
    if (this.key.length !== 32) throw new Error('Kunci enkripsi harus 32 byte');
    this.accountsFile = ACCOUNTS_FILE;
    this._ensureFile();
  }
  _ensureFile() {
    const dir = path.dirname(this.accountsFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.accountsFile)) {
      fs.writeFileSync(this.accountsFile, JSON.stringify({}, null, 2));
    }
  }
  _readAll() {
    this._ensureFile();
    try {
      const raw = fs.readFileSync(this.accountsFile, 'utf8');
      const data = JSON.parse(raw);
      if (typeof data !== 'object' || data === null) return {};
      return data;
    } catch {
      return {};
    }
  }
  _writeAll(data) {
    const tmp = this.accountsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.accountsFile);
  }
  encrypt(plaintext, aad) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad));
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: base64(iv):base64(tag):base64(ciphertext)
    return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  }
  decrypt(bundle, aad) {
    const parts = bundle.split(':');
    if (parts.length !== 3) throw new Error('Format bundle tidak valid');
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const enc = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  }
  // Accounts management
  getUserAccounts(userId) {
    const all = this._readAll();
    const uid = String(userId);
    return all[uid] || [];
  }
  getAllAccounts() {
    return this._readAll();
  }
  findAccountById(accountId) {
    const all = this._readAll();
    for (const uid of Object.keys(all)) {
      const list = all[uid];
      for (const acc of list) {
        if (acc.id === accountId) {
          return { account: acc, userId: uid };
        }
      }
    }
    return null;
  }
  findAccount(userId, accountId) {
    const list = this.getUserAccounts(userId);
    return list.find(a => a.id === accountId) || null;
  }
  addOrUpdateAccount(userId, tokenPlain, username, label) {
    const uid = String(userId);
    const all = this._readAll();
    if (!all[uid]) all[uid] = [];
    // Cek apakah username sudah ada -> update token
    const existing = all[uid].find(a => a.username === username);
    let accountId;
    if (existing) {
      accountId = existing.id;
      const aad = `${uid}:${accountId}`;
      existing.tokenEnc = this.encrypt(tokenPlain, aad);
      existing.label = label || username;
      existing.username = username;
      existing.updatedAt = new Date().toISOString();
      this._writeAll(all);
      return existing;
    }
    // Buat baru
    accountId = crypto.randomBytes(3).toString('hex'); // 6 hex
    // Pastikan unik global
    let attempts = 0;
    while (this.findAccountById(accountId) && attempts < 10) {
      accountId = crypto.randomBytes(3).toString('hex');
      attempts++;
    }
    const aad = `${uid}:${accountId}`;
    const enc = this.encrypt(tokenPlain, aad);
    const acc = {
      id: accountId,
      label: label || username,
      username,
      provider: 'upcloud',
      tokenEnc: enc,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    all[uid].push(acc);
    this._writeAll(all);
    return acc;
  }
  deleteAccount(userId, accountId) {
    const uid = String(userId);
    const all = this._readAll();
    if (!all[uid]) return false;
    const before = all[uid].length;
    all[uid] = all[uid].filter(a => a.id !== accountId);
    if (all[uid].length === before) return false;
    if (all[uid].length === 0) delete all[uid];
    this._writeAll(all);
    return true;
  }
  deleteAllUserAccounts(userId) {
    const uid = String(userId);
    const all = this._readAll();
    if (!all[uid]) return 0;
    const count = all[uid].length;
    delete all[uid];
    this._writeAll(all);
    return count;
  }
  getDecryptedToken(userId, accountId) {
    const acc = this.findAccount(userId, accountId);
    if (!acc) throw new Error('Akun tidak ditemukan');
    const aad = `${String(userId)}:${accountId}`;
    return this.decrypt(acc.tokenEnc, aad);
  }
  // Untuk cek kepemilikan
  isOwner(userId, accountId) {
    return !!this.findAccount(userId, accountId);
  }
}

module.exports = Vault;
