/**
 * stats.js - Statistik bot
 */
const fs = require('fs');
const path = require('path');

const STATS_FILE = path.join(__dirname, '..', 'data', 'stats.json');

class Stats {
  constructor() {
    this.file = STATS_FILE;
    this.startTime = Date.now();
    this._ensure();
  }
  _ensure() {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, JSON.stringify({
        deploySuccess: 0,
        deployFail: 0,
        reinstallStarted: 0,
        reinstallFailed: 0,
        totalUsers: 0
      }, null, 2));
    }
  }
  _read() {
    this._ensure();
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return JSON.parse(raw);
    } catch {
      return { deploySuccess: 0, deployFail: 0, reinstallStarted: 0, reinstallFailed: 0 };
    }
  }
  _write(data) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  inc(key) {
    const data = this._read();
    if (typeof data[key] !== 'number') data[key] = 0;
    data[key] += 1;
    this._write(data);
  }
  get() {
    return this._read();
  }
  getUptime() {
    const ms = Date.now() - this.startTime;
    const sec = Math.floor(ms / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${h}j ${m}m ${s}d`;
  }
  getMemory() {
    const mem = process.memoryUsage();
    return `${(mem.rss / 1024 / 1024).toFixed(1)} MB RSS, ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB heap`;
  }
}

module.exports = Stats;
