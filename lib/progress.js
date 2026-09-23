/**
 * progress.js - LiveProgress checklist animasi
 */
const SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

/**
 * Escape teks mentah (nama langkah/detail/error/log) sebelum dikirim ke Telegram
 * dengan parse_mode HTML. Tanpa ini, satu karakter '<' dari pesan error API/SSH
 * membuat editMessageText gagal (400) dan checklist macet.
 */
function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

class LiveProgress {
  constructor(bot, chatId, messageId, title = '⏳ Proses...', tickMs = 900) {
    this.bot = bot;
    this.chatId = chatId;
    this.messageId = messageId;
    this.title = title;
    this.tickMs = tickMs;
    this.steps = []; // {name, status: pending|running|done|fail, detail}
    this.startTime = Date.now();
    this.spinnerIdx = 0;
    this.timer = null;
    this.lastText = '';
    this.stopped = false;
  }
  addStep(name, detail = '') {
    this.steps.push({ name, status: 'pending', detail: detail.slice(0,42) });
  }
  setRunning(index, detail = '') {
    if (this.steps[index]) {
      this.steps[index].status = 'running';
      if (detail) this.steps[index].detail = detail.slice(0,42);
    }
  }
  setDone(index, detail = '') {
    if (this.steps[index]) {
      this.steps[index].status = 'done';
      if (detail) this.steps[index].detail = detail.slice(0,42);
    }
  }
  setFail(index, detail = '') {
    if (this.steps[index]) {
      this.steps[index].status = 'fail';
      if (detail) this.steps[index].detail = detail.slice(0,42);
    }
  }
  updateDetail(index, detail) {
    if (this.steps[index]) {
      this.steps[index].detail = String(detail).slice(0,42);
    }
  }
  _elapsed() {
    const ms = Date.now() - this.startTime;
    const s = Math.floor(ms/1000);
    const m = Math.floor(s/60);
    const sec = s%60;
    if (m>0) return `${m}m ${sec}d`;
    return `${sec}d`;
  }
  _render() {
    const elapsed = this._elapsed();
    const spinner = SPINNER[this.spinnerIdx % SPINNER.length];
    let lines = [];
    lines.push(`${escHtml(this.title)} (${elapsed})`);
    lines.push('');
    for (let i=0;i<this.steps.length;i++) {
      const st = this.steps[i];
      let icon = '◻️';
      if (st.status === 'pending') icon = '◻️';
      else if (st.status === 'running') icon = spinner;
      else if (st.status === 'done') icon = '✅';
      else if (st.status === 'fail') icon = '❌';
      let line = `${icon} ${escHtml(st.name)}`;
      if (st.detail) line += ` - ${escHtml(st.detail)}`;
      lines.push(line);
    }
    return lines.join('\n');
  }
  async _edit(text) {
    if (text === this.lastText) return;
    this.lastText = text;
    try {
      await this.bot.telegram.editMessageText(this.chatId, this.messageId, undefined, text, { parse_mode: 'HTML' });
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('message is not modified')) return;
      if (msg.includes('Too Many Requests') || e.code === 429) {
        // tunggu sebentar
        await new Promise(r=>setTimeout(r, 1500));
        try {
          await this.bot.telegram.editMessageText(this.chatId, this.messageId, undefined, text, { parse_mode: 'HTML' });
        } catch {}
      }
      // ignore other
    }
  }
  start() {
    // Idempotent: kalau timer sudah jalan dengan tickMs yang sama, abaikan.
    // Kalau tickMs berubah (mis. fase polling panjang), restart intervalnya.
    if (this.timer && this._timerTickMs === this.tickMs) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._timerTickMs = this.tickMs;
    this.timer = setInterval(async () => {
      this.spinnerIdx++;
      const txt = this._render();
      await this._edit(txt);
    }, this.tickMs);
    if (typeof this.timer.unref === 'function') {
      try { this.timer.unref(); } catch {}
    }
  }
  setTickMs(tickMs) {
    this.tickMs = tickMs;
    if (this.timer) {
      // Terapkan segera dengan restart timer
      this.start();
    }
  }
  async tickNow() {
    const txt = this._render();
    await this._edit(txt);
  }
  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  async finish(finalText) {
    this.stop();
    try {
      await this.bot.telegram.editMessageText(this.chatId, this.messageId, undefined, finalText, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch {}
  }
}

module.exports = LiveProgress;
