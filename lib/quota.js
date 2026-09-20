/**
 * quota.js - Kuota harian per user
 */
const fs = require('fs');
const path = require('path');

const QUOTA_FILE = path.join(__dirname, '..', 'data', 'quota.json');

function utcDateString() {
  const now = new Date();
  return now.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

class QuotaManager {
  constructor() {
    this.file = QUOTA_FILE;
    this._ensure();
  }
  _ensure() {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, JSON.stringify({ setup: {}, reinstall: {} }, null, 2));
    }
  }
  _read() {
    this._ensure();
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (!data.setup) data.setup = {};
      if (!data.reinstall) data.reinstall = {};
      return data;
    } catch {
      return { setup: {}, reinstall: {} };
    }
  }
  _write(data) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  _getUserRecord(type, userId) {
    const data = this._read();
    const uid = String(userId);
    const rec = data[type][uid];
    const today = utcDateString();
    if (!rec || rec.date !== today) {
      return { date: today, count: 0 };
    }
    return rec;
  }
  canUse(userId, type, limit, isOwner) {
    if (isOwner) return { allowed: true, remaining: Infinity };
    const rec = this._getUserRecord(type, userId);
    if (rec.count >= limit) {
      return { allowed: false, remaining: 0, count: rec.count, limit };
    }
    return { allowed: true, remaining: limit - rec.count, count: rec.count, limit };
  }
  use(userId, type) {
    const data = this._read();
    const uid = String(userId);
    const today = utcDateString();
    if (!data[type][uid] || data[type][uid].date !== today) {
      data[type][uid] = { date: today, count: 0 };
    }
    data[type][uid].count += 1;
    data[type][uid].date = today;
    this._write(data);
    return data[type][uid];
  }
  getRemaining(userId, type, limit, isOwner) {
    if (isOwner) return Infinity;
    const rec = this._getUserRecord(type, userId);
    return Math.max(0, limit - rec.count);
  }
}

module.exports = QuotaManager;
