/**
 * jobs.js - Job & konkurensi manager
 * Satu user hanya boleh satu job aktif; total dibatasi MAX_CONCURRENT_JOBS
 */
class JobManager {
  constructor(maxConcurrent = 8) {
    this.maxConcurrent = maxConcurrent;
    this.activeUsers = new Set(); // userId string
    this.activeCount = 0;
  }
  canStart(userId) {
    const uid = String(userId);
    if (this.activeUsers.has(uid)) {
      return { allowed: false, reason: 'user_busy' };
    }
    if (this.activeCount >= this.maxConcurrent) {
      return { allowed: false, reason: 'server_busy' };
    }
    return { allowed: true };
  }
  async runDetached(userId, jobFn) {
    const uid = String(userId);
    const check = this.canStart(uid);
    if (!check.allowed) return check;

    this.activeUsers.add(uid);
    this.activeCount++;

    // Detached: jangan await di handler Telegraf, tapi kita tetap track
    // jobFn harus handle error sendiri dan finally cleanup
    const promise = (async () => {
      try {
        await jobFn();
      } catch (e) {
        console.error(`Job error user ${uid}:`, e);
      } finally {
        this.activeUsers.delete(uid);
        this.activeCount = Math.max(0, this.activeCount - 1);
      }
    })();

    // Jangan await di sini untuk detached, tapi kita return promise untuk tracking jika perlu
    // Untuk tetap detached, kita tidak await, tapi kita simpan agar tidak unhandled
    // Menggunakan setImmediate untuk benar-benar lepas
    setImmediate(() => {
      promise.catch(() => {});
    });

    return { allowed: true, detached: true };
  }
  getActiveCount() {
    return this.activeCount;
  }
  isUserBusy(userId) {
    return this.activeUsers.has(String(userId));
  }
}

module.exports = JobManager;
