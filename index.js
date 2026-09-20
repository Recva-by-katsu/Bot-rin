/**
 * index.js - Bot Telegram UpCloud VPS Manager
 * Bahasa Indonesia, untuk pemula, multi-user multi-akun
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const config = require('./config');

// Cek config placeholder SEBELUM require modul eksternal (agar node index.js langsung tolak placeholder tanpa butuh node_modules)
if (!config.BOT_TOKEN || config.BOT_TOKEN === 'ISI_TOKEN_BOT_DISINI' || config.BOT_TOKEN.includes('ISI_')) {
  console.error('❌ BOT_TOKEN masih placeholder di config.js. Isi token bot dari @BotFather dulu!');
  process.exit(1);
}
if (!config.OWNER_ID || config.OWNER_ID === 0) {
  console.error('❌ OWNER_ID masih 0 di config.js. Isi ID Telegram owner (dari @userinfobot) dulu!');
  process.exit(1);
}

const { Telegraf, Markup } = require('telegraf');
const { ensureKeypair } = require('./lib/keygen');
const Vault = require('./lib/vault');
const QuotaManager = require('./lib/quota');
const Stats = require('./lib/stats');
const JobManager = require('./lib/jobs');
const LiveProgress = require('./lib/progress');
const SshSession = require('./lib/sshClient');
const { setupVpsFlow } = require('./lib/setupFlow');
const reinstallFlow = require('./lib/reinstallFlow');
const { getPage } = require('./lib/guide');
const UpCloudClient = require('./providers/upcloud');
const ui = require('./ui/manager');
const validators = require('./lib/validators');
const passwordLib = require('./lib/password');

// Pastikan folder data
const dataDir = path.join(__dirname, 'data');
const keysDir = path.join(dataDir, 'keys');
const logsDir = path.join(dataDir, 'logs');
for (const d of [dataDir, keysDir, logsDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// Inisialisasi komponen
let BOT_PUBLIC_IP = config.BOT_PUBLIC_IP || '';
async function detectPublicIp() {
  if (BOT_PUBLIC_IP) return BOT_PUBLIC_IP;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
    clearTimeout(t);
    if (res.ok) {
      const j = await res.json();
      if (j.ip) {
        BOT_PUBLIC_IP = j.ip;
        console.log(`🌐 Deteksi IP publik bot: ${BOT_PUBLIC_IP}`);
        return BOT_PUBLIC_IP;
      }
    }
  } catch (e) {
    console.log('⚠️ Gagal deteksi IP publik otomatis, pakai placeholder');
  }
  return BOT_PUBLIC_IP || 'IP tidak terdeteksi';
}

let vault, quota, stats, jobs;
let botKeyPair = null;
let botPublicKey = '';

async function init() {
  // Keypair
  try {
    botKeyPair = await ensureKeypair(keysDir);
    botPublicKey = fs.readFileSync(botKeyPair.pubPath, 'utf8').trim();
    console.log('🔑 SSH key bot siap:', botKeyPair.pubPath);
  } catch (e) {
    console.error('❌ Gagal buat SSH key:', e.message);
    process.exit(1);
  }

  vault = new Vault(config);
  quota = new QuotaManager();
  stats = new Stats();
  jobs = new JobManager(config.MAX_CONCURRENT_JOBS || 8);

  await detectPublicIp();

  const bot = new Telegraf(config.BOT_TOKEN);

  // Sesi percakapan in-memory per user
  const sessions = new Map(); // userId -> {type, step, data, createdAt}

  function getSession(userId) {
    return sessions.get(String(userId)) || null;
  }
  function setSession(userId, sess) {
    sess.createdAt = Date.now();
    sessions.set(String(userId), sess);
  }
  function clearSession(userId) {
    sessions.delete(String(userId));
  }
  function isOwner(userId) {
    return String(userId) === String(config.OWNER_ID);
  }

  // Helper redaksi & hapus pesan sensitif
  async function tryDeleteUserMessage(ctx) {
    try {
      if (ctx.message) {
        await ctx.deleteMessage();
      }
    } catch {}
  }
  async function safeReply(ctx, text, extra = {}) {
    try {
      return await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
    } catch (e) {
      console.error('safeReply error:', e.message);
    }
  }
  async function safeEdit(ctx, text, extra = {}) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('message is not modified')) return;
      if (msg.includes('Too Many Requests') || e.code === 429) {
        await new Promise(r=>setTimeout(r, 1200));
        try {
          await ctx.editMessageText(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
        } catch {}
      } else {
        console.error('safeEdit error:', validators.redactSecrets(msg));
      }
    }
  }

  // Helper TCP port check
  function checkPortOpen(host, port, timeout=5000) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          socket.destroy();
          resolve(false);
        }
      }, timeout);
      socket.connect(port, host, () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          socket.end();
          resolve(true);
        }
      });
      socket.on('error', () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
    });
  }
  async function waitForPort(host, port, timeoutMs=5*60*1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const open = await checkPortOpen(host, port, 3000);
      if (open) return true;
      await new Promise(r=>setTimeout(r, 5000));
    }
    return false;
  }
  async function waitForServerState(client, uuid, desired='started', timeoutMs=5*60*1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const srv = await client.getServer(uuid);
        if (srv.state === desired) return srv;
        if (srv.state === 'error') throw new Error('Server state error');
      } catch (e) {
        if (e.status === 404) throw new Error('Server tidak ditemukan (mungkin sudah dihapus)');
      }
      await new Promise(r=>setTimeout(r, 5000));
    }
    throw new Error(`Timeout menunggu server ${desired}`);
  }
  async function waitForSsh(host, port, username, privateKeyPath, password, timeoutMs=5*60*1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const sess = new SshSession({ host, port, username, privateKeyPath, password });
        await sess.connect();
        sess.close();
        return true;
      } catch {}
      await new Promise(r=>setTimeout(r, 5000));
    }
    return false;
  }

  // Helper: get decrypted token with ownership check
  function getTokenForAccount(userId, accountId) {
    if (!vault.isOwner(userId, accountId)) throw new Error('Akun bukan milikmu');
    return vault.getDecryptedToken(userId, accountId);
  }

  // Bot catch
  bot.catch((err, ctx) => {
    console.error(`Bot error untuk ${ctx.updateType}:`, validators.redactSecrets(err.message || String(err)));
    try {
      ctx.reply('⚠️ Terjadi error internal. Coba lagi nanti.').catch(()=>{});
    } catch {}
  });

  // Middleware: count user
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      // Track total users via stats file? We'll compute from vault later
    }
    return next();
  });

  // === COMMANDS ===
  async function showMainMenu(ctx) {
    const { text, keyboard } = ui.mainMenu();
    if (ctx.callbackQuery) {
      await safeEdit(ctx, text, { reply_markup: keyboard });
    } else {
      await safeReply(ctx, text, { reply_markup: keyboard });
    }
  }

  bot.start(async (ctx) => {
    clearSession(ctx.from.id);
    await showMainMenu(ctx);
  });
  bot.command('start', async (ctx) => {
    clearSession(ctx.from.id);
    await showMainMenu(ctx);
  });
  bot.command('akun', async (ctx) => {
    clearSession(ctx.from.id);
    if (config.MANAGER_OWNER_ONLY && !isOwner(ctx.from.id)) {
      return safeReply(ctx, '🔒 Manajer Akun hanya untuk owner bot.');
    }
    const accounts = vault.getUserAccounts(ctx.from.id);
    const { text, keyboard } = ui.accountsMenu(accounts, BOT_PUBLIC_IP);
    await safeReply(ctx, text, { reply_markup: keyboard });
  });
  bot.command('ssh', async (ctx) => {
    clearSession(ctx.from.id);
    await showSshMenu(ctx);
  });
  bot.command('os', async (ctx) => {
    clearSession(ctx.from.id);
    await showOsMenu(ctx);
  });
  bot.command('key', async (ctx) => {
    await showSshKey(ctx);
  });
  bot.command('bantuan', async (ctx) => {
    await showGuide(ctx, 0);
  });
  bot.command('ip', async (ctx) => {
    await showIp(ctx);
  });
  bot.command('hapusdata', async (ctx) => {
    const accounts = vault.getUserAccounts(ctx.from.id);
    if (accounts.length === 0) {
      return safeReply(ctx, 'Kamu belum punya akun tersimpan.');
    }
    const text = `🗑 <b>Hapus Semua Data Saya</b>

Kamu punya ${accounts.length} akun tersimpan. Yakin mau hapus semua?

Ini akan menghapus semua token API yang tersimpan untuk user ini. Tidak bisa dibatalkan!`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Ya, hapus semua', callback_data: 'mgr:upcloud:deleteall:confirm' }],
        [{ text: '❌ Batal', callback_data: 'menu:main' }]
      ]
    };
    await safeReply(ctx, text, { reply_markup: keyboard });
  });
  bot.command('cancel', async (ctx) => {
    clearSession(ctx.from.id);
    await safeReply(ctx, '✅ Sesi dibatalkan.', { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Utama', callback_data: 'menu:main' }]] } });
  });
  bot.command('admin', async (ctx) => {
    if (!isOwner(ctx.from.id)) return safeReply(ctx, '🔒 Hanya owner.');
    const allAccounts = vault.getAllAccounts();
    let totalAccounts = 0;
    let totalUsers = Object.keys(allAccounts).length;
    for (const uid of Object.keys(allAccounts)) totalAccounts += allAccounts[uid].length;
    const st = stats.get();
    const text = `📊 <b>Admin Panel</b>

Uptime: ${stats.getUptime()}
Memori: ${stats.getMemory()}
Total user: ${totalUsers}
Total akun tersimpan: ${totalAccounts}
Deploy berhasil: ${st.deploySuccess || 0}
Deploy gagal: ${st.deployFail || 0}
Reinstall dimulai: ${st.reinstallStarted || 0}
Reinstall gagal: ${st.reinstallFailed || 0}
Job aktif: ${jobs.getActiveCount()} / ${config.MAX_CONCURRENT_JOBS}

IP Bot: ${BOT_PUBLIC_IP || 'tidak terdeteksi'}
`;
    await safeReply(ctx, text);
  });

  // === MENU HELPERS ===
  async function showSshMenu(ctx) {
    const text = `🔐 <b>Aktifkan Password VPS</b>

Menu ini untuk VPS Ubuntu/Debian yang sudah ada (bukan buat baru).

Pilih:
• <b>Show SSH Key</b> - lihat public key bot
• <b>Setup VPS</b> - aktifkan login password
• <b>Check VPS</b> - cek konfigurasi SSH saat ini
`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '🔑 Show SSH Key', callback_data: 'ssh:showkey' }],
        [{ text: '⚙️ Setup VPS', callback_data: 'ssh:setup' }],
        [{ text: '🔍 Check VPS', callback_data: 'ssh:check' }],
        [{ text: '⬅️ Kembali', callback_data: 'menu:main' }]
      ]
    };
    if (ctx.callbackQuery) await safeEdit(ctx, text, { reply_markup: keyboard });
    else await safeReply(ctx, text, { reply_markup: keyboard });
  }

  async function showSshKey(ctx) {
    const text = `🔑 <b>Public Key Bot</b>

Ini public key bot yang dipakai untuk login awal (mode password otomatis).

<pre>${botPublicKey}</pre>

<b>Cara pakai:</b> Tambahkan key ini ke <code>~/.ssh/authorized_keys</code> VPS-mu, lalu jalankan Setup VPS.

⚠️ Jangan share private key bot!
`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Kembali', callback_data: 'menu:ssh' }]
      ]
    };
    if (ctx.callbackQuery) await safeEdit(ctx, text, { reply_markup: keyboard });
    else await safeReply(ctx, text, { reply_markup: keyboard });
  }

  async function showOsMenu(ctx) {
    const text = `💿 <b>Install/Reinstall OS via reinstall.sh</b>

Memakai script <b>reinstall.sh</b> (github.com/bin456789/reinstall) untuk ganti OS VPS apa saja (bukan hanya UpCloud).

⚠️ <b>SEMUA DATA DI VPS AKAN DIHAPUS PERMANEN!</b>

Pilih aksi:`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '🐧 Linux', callback_data: 'os:linux' }],
        [{ text: '🪟 Windows', callback_data: 'os:windows' }],
        [{ text: '⬅️ Kembali', callback_data: 'menu:main' }]
      ]
    };
    if (ctx.callbackQuery) await safeEdit(ctx, text, { reply_markup: keyboard });
    else await safeReply(ctx, text, { reply_markup: keyboard });
  }

  async function showGuide(ctx, index) {
    const page = getPage(index);
    const text = `${page.title}\n\n${page.text}`;
    const keyboard = { inline_keyboard: [] };
    const row = [];
    if (page.index > 0) row.push({ text: '⬅️ Kembali', callback_data: `guide:${page.index-1}` });
    if (page.index < page.total-1) row.push({ text: 'Lanjut ➡️', callback_data: `guide:${page.index+1}` });
    if (row.length) keyboard.inline_keyboard.push(row);
    keyboard.inline_keyboard.push([{ text: '🏠 Menu Utama', callback_data: 'menu:main' }]);
    if (ctx.callbackQuery) await safeEdit(ctx, text, { reply_markup: keyboard });
    else await safeReply(ctx, text, { reply_markup: keyboard });
  }

  async function showIp(ctx) {
    const ip = await detectPublicIp();
    const text = `🌐 <b>IP Publik Server Bot</b>

IP: <code>${ip || 'tidak terdeteksi'}</code>

Gunakan IP ini untuk:
• Mengisi <b>Allowed IP ranges</b> saat membuat API token UpCloud (lebih aman)
• Cek kalau token dibatasi IP dan butuh ditambahkan

Jika IP berubah, token yang dibatasi IP akan 403 (ditolak).
`;
    const keyboard = { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'menu:main' }]] };
    if (ctx.callbackQuery) await safeEdit(ctx, text, { reply_markup: keyboard });
    else await safeReply(ctx, text, { reply_markup: keyboard });
  }

  // === CALLBACK HANDLERS ===
  bot.action(/menu:main/, async (ctx) => {
    clearSession(ctx.from.id);
    await ctx.answerCbQuery();
    await showMainMenu(ctx);
  });
  bot.action(/menu:accounts/, async (ctx) => {
    await ctx.answerCbQuery();
    if (config.MANAGER_OWNER_ONLY && !isOwner(ctx.from.id)) {
      return safeEdit(ctx, '🔒 Manajer Akun hanya untuk owner bot.', { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Utama', callback_data: 'menu:main' }]] } });
    }
    const { text, keyboard } = ui.providerMenu();
    await safeEdit(ctx, text, { reply_markup: keyboard });
  });
  bot.action(/menu:ssh/, async (ctx) => {
    await ctx.answerCbQuery();
    await showSshMenu(ctx);
  });
  bot.action(/menu:os/, async (ctx) => {
    await ctx.answerCbQuery();
    await showOsMenu(ctx);
  });
  bot.action(/menu:ip/, async (ctx) => {
    await ctx.answerCbQuery();
    await showIp(ctx);
  });
  bot.action(/guide:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const idx = parseInt(ctx.match[1], 10);
    await showGuide(ctx, idx);
  });

  // Manager UpCloud
  bot.action(/mgr:upcloud$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (config.MANAGER_OWNER_ONLY && !isOwner(ctx.from.id)) {
      return safeEdit(ctx, '🔒 Manajer Akun hanya untuk owner bot.');
    }
    const accounts = vault.getUserAccounts(ctx.from.id);
    const { text, keyboard } = ui.accountsMenu(accounts, BOT_PUBLIC_IP);
    await safeEdit(ctx, text, { reply_markup: keyboard });
  });

  bot.action(/mgr:consent:ok/, async (ctx) => {
    await ctx.answerCbQuery();
    const { text } = ui.addAccountPrompt(BOT_PUBLIC_IP);
    setSession(ctx.from.id, { type: 'add_account', step: 'await_token', data: {} });
    await safeEdit(ctx, text + '\n\nKirim token sekarang (pesan akan dihapus).', { reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'mgr:upcloud' }]] } });
  });

  bot.action(/mgr:upcloud:add/, async (ctx) => {
    await ctx.answerCbQuery();
    const accounts = vault.getUserAccounts(ctx.from.id);
    if (accounts.length >= (config.MAX_ACCOUNTS_PER_USER || 5)) {
      return safeEdit(ctx, `⚠️ Maksimal ${config.MAX_ACCOUNTS_PER_USER} akun per user. Hapus akun lama dulu.`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'mgr:upcloud' }]] } });
    }
    // Tampilkan consent dulu
    const { text, keyboard } = ui.consentScreen(BOT_PUBLIC_IP);
    await safeEdit(ctx, text, { reply_markup: keyboard });
  });

  bot.action(/mgr:upcloud:deleteall/, async (ctx) => {
    await ctx.answerCbQuery();
    const accounts = vault.getUserAccounts(ctx.from.id);
    if (accounts.length === 0) return safeEdit(ctx, 'Tidak ada akun tersimpan.');
    const text = `🗑 <b>Hapus Semua Data Saya</b>

Kamu punya ${accounts.length} akun. Yakin hapus semua?`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Ya, hapus semua', callback_data: 'mgr:upcloud:deleteall:confirm' }],
        [{ text: '❌ Batal', callback_data: 'mgr:upcloud' }]
      ]
    };
    await safeEdit(ctx, text, { reply_markup: keyboard });
  });
  bot.action(/mgr:upcloud:deleteall:confirm/, async (ctx) => {
    await ctx.answerCbQuery();
    const count = vault.deleteAllUserAccounts(ctx.from.id);
    await safeEdit(ctx, `✅ Berhasil hapus ${count} akun.`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'mgr:upcloud' }]] } });
  });

  // Account detail
  bot.action(/mgr:acc:([a-f0-9]{6})$/, async (ctx) => {
    await ctx.answerCbQuery();
    const accId = ctx.match[1];
    if (!vault.isOwner(ctx.from.id, accId)) return ctx.answerCbQuery('Sesi ini sudah tidak berlaku atau bukan milikmu', { show_alert: true });
    const acc = vault.findAccount(ctx.from.id, accId);
    const { text, keyboard } = ui.accountDetailMenu(acc);
    await safeEdit(ctx, text, { reply_markup: keyboard });
  });

  bot.action(/mgr:acc:([a-f0-9]{6}):delete/, async (ctx) => {
    await ctx.answerCbQuery();
    const accId = ctx.match[1];
    if (!vault.isOwner(ctx.from.id, accId)) return ctx.answerCbQuery('Bukan milikmu', { show_alert: true });
    const acc = vault.findAccount(ctx.from.id, accId);
    const text = `🗑 <b>Hapus Akun ${acc.label}?</b>

Yakin mau hapus akun ini dari bot? Token tetap ada di UpCloud, hanya dihapus dari bot.`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Ya, hapus', callback_data: `mgr:acc:${accId}:delete:confirm` }],
        [{ text: '❌ Batal', callback_data: `mgr:acc:${accId}` }]
      ]
    };
    await safeEdit(ctx, text, { reply_markup: keyboard });
  });
  bot.action(/mgr:acc:([a-f0-9]{6}):delete:confirm/, async (ctx) => {
    await ctx.answerCbQuery();
    const accId = ctx.match[1];
    if (!vault.isOwner(ctx.from.id, accId)) return;
    vault.deleteAccount(ctx.from.id, accId);
    const accounts = vault.getUserAccounts(ctx.from.id);
    const { text, keyboard } = ui.accountsMenu(accounts, BOT_PUBLIC_IP);
    await safeEdit(ctx, `✅ Akun ${accId} dihapus.\n\n` + text, { reply_markup: keyboard });
  });

  // Check API single
  bot.action(/mgr:acc:([a-f0-9]{6}):check/, async (ctx) => {
    await ctx.answerCbQuery('🔍 Mengecek API...');
    const accId = ctx.match[1];
    if (!vault.isOwner(ctx.from.id, accId)) return;
    const token = vault.getDecryptedToken(ctx.from.id, accId);
    const client = new UpCloudClient(token);
    let resultText = '';
    try {
      const accData = await client.getAccount();
      const username = accData.account?.username || 'unknown';
      let tokens = await client.getTokens();
      resultText = `✅ <b>Hidup</b>\nUsername: ${username}\n`;
      if (tokens) {
        resultText += `Total token di akun: ${tokens.length}\n`;
        for (const t of tokens.slice(0,5)) {
          const exp = t.expires_at ? new Date(t.expires_at).toLocaleDateString() : 'no exp';
          resultText += `- ${t.name}: exp ${exp}\n`;
          if (t.expires_at) {
            const diff = (new Date(t.expires_at).getTime() - Date.now())/(1000*60*60*24);
            if (diff <= 7) resultText += `  ⚠️ Token mau kedaluwarsa ≤7 hari!\n`;
          }
        }
      }
    } catch (e) {
      resultText = client.translateError(e) + `\nIP Bot: ${BOT_PUBLIC_IP}`;
    }
    const keyboard = { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: `mgr:acc:${accId}` }]] };
    await safeEdit(ctx, `🔐 <b>Cek Akun ${accId}</b>\n\n${resultText}`, { reply_markup: keyboard });
  });

  // Check all
  bot.action(/mgr:upcloud:checkall/, async (ctx) => {
    await ctx.answerCbQuery('🔍 Mengecek semua akun...');
    const accounts = vault.getUserAccounts(ctx.from.id);
    if (accounts.length === 0) return safeEdit(ctx, 'Belum ada akun.');
    const msg = await safeReply(ctx, `🔍 Mengecek ${accounts.length} akun... (maks 3 paralel)`);
    // Progress live simple
    const results = [];
    const queue = [...accounts];
    async function checkOne(acc) {
      try {
        const token = vault.getDecryptedToken(ctx.from.id, acc.id);
        const client = new UpCloudClient(token, { timeout: 15000 });
        const accData = await client.getAccount();
        const tokens = await client.getTokens();
        return { id: acc.id, label: acc.label, status: 'ok', username: accData.account?.username, tokens };
      } catch (e) {
        const status = e.status === 401 ? '401' : e.status === 403 ? '403' : 'fail';
        return { id: acc.id, label: acc.label, status, error: e.message };
      }
    }
    // Paralel max 3
    const workers = [];
    const concurrency = 3;
    for (let i=0;i<concurrency;i++) {
      workers.push((async () => {
        while (queue.length) {
          const acc = queue.shift();
          if (!acc) break;
          const res = await checkOne(acc);
          results.push(res);
          // Update progress
          try {
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `🔍 Mengecek... ${results.length}/${accounts.length}`, { parse_mode: 'HTML' });
          } catch {}
        }
      })());
    }
    await Promise.all(workers);
    const { text, keyboard } = ui.formatCheckApiResults(results, BOT_PUBLIC_IP);
    await safeEdit({ ...ctx, chat: ctx.chat, telegram: ctx.telegram, editMessageText: (chatId, msgId, _, txt, extra) => ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, txt, extra) }, text, { reply_markup: keyboard }).catch(async () => {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, text, { parse_mode: 'HTML', reply_markup: keyboard });
    });
  });

  bot.action(/mgr:upcloud:cleanDead/, async (ctx) => {
    await ctx.answerCbQuery();
    const accounts = vault.getUserAccounts(ctx.from.id);
    let deleted = 0;
    for (const acc of [...accounts]) {
      try {
        const token = vault.getDecryptedToken(ctx.from.id, acc.id);
        const client = new UpCloudClient(token);
        await client.getAccount();
      } catch (e) {
        if (e.status === 401) {
          vault.deleteAccount(ctx.from.id, acc.id);
          deleted++;
        }
      }
    }
    const remaining = vault.getUserAccounts(ctx.from.id);
    const { text, keyboard } = ui.accountsMenu(remaining, BOT_PUBLIC_IP);
    await safeEdit(ctx, `🗑 Berhasil hapus ${deleted} akun mati.\n\n` + text, { reply_markup: keyboard });
  });

  // === BUAT VPS WIZARD ===
  bot.action(/mgr:acc:([a-f0-9]{6}):create/, async (ctx) => {
    await ctx.answerCbQuery();
    const accId = ctx.match[1];
    if (!vault.isOwner(ctx.from.id, accId)) return ctx.answerCbQuery('Bukan milikmu', { show_alert: true });
    // Mulai wizard
    setSession(ctx.from.id, { type: 'create_vps', step: 'zone', data: { accountId: accId } });
    // Fetch zones
    try {
      const token = vault.getDecryptedToken(ctx.from.id, accId);
      const client = new UpCloudClient(token);
      const zones = await client.getZones();
      const { text, keyboard } = ui.formatZones(zones);
      await safeEdit(ctx, text, { reply_markup: keyboard });
    } catch (e) {
      const client = new UpCloudClient('');
      await safeEdit(ctx, `❌ Gagal ambil zona: ${client.translateError(e)}`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: `mgr:acc:${accId}` }]] } });
      clearSession(ctx.from.id);
    }
  });

  bot.action(/wiz:zone:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'create_vps') return ctx.answerCbQuery('Sesi ini sudah tidak berlaku', { show_alert: true });
    const zone = ctx.match[1];
    sess.data.zone = zone;
    sess.step = 'plan';
    setSession(ctx.from.id, sess);
    try {
      const token = vault.getDecryptedToken(ctx.from.id, sess.data.accountId);
      const client = new UpCloudClient(token);
      const plans = await client.getPlans();
      const { text, keyboard } = ui.formatPlans(plans);
      await safeEdit(ctx, text, { reply_markup: keyboard });
    } catch (e) {
      const c = new UpCloudClient('');
      await safeEdit(ctx, `❌ Gagal ambil plan: ${c.translateError(e)}`);
    }
  });

  bot.action(/wiz:plan:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'create_vps') return ctx.answerCbQuery('Sesi ini sudah tidak berlaku', { show_alert: true });
    sess.data.plan = ctx.match[1];
    sess.step = 'login';
    setSession(ctx.from.id, sess);
    const { text, keyboard } = ui.formatLoginMethods();
    await safeEdit(ctx, text, { reply_markup: keyboard });
  });

  // Pilih tipe IP (IPv4 default)
  bot.action(/wiz:ip:(ipv4|dual)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'create_vps') return ctx.answerCbQuery('Sesi ini sudah tidak berlaku', { show_alert: true });
    const choice = ctx.match[1];
    sess.data.ipVersion = choice === 'dual' ? 'dual' : 'ipv4'; // default ipv4
    sess.data.ipv6 = choice === 'dual' ? 'yes' : 'no';
    sess.step = 'confirm';
    setSession(ctx.from.id, sess);
    const planInfo = sess.data.plan;
    const osInfo = sess.data.osTitle || sess.data.osTemplateUuid;
    const ipLabel = sess.data.ipVersion === 'dual' ? 'IPv4 + IPv6 (dual)' : 'IPv4 saja (default)';
    const confirmText = `📋 <b>Konfirmasi Buat VPS</b>

Akun: ${sess.data.accountId}
Zona: ${sess.data.zone}
Plan: ${planInfo}
OS: ${osInfo}
Login: ${sess.data.loginMode === 'password' ? 'Password otomatis' : 'SSH key sendiri'}
Nama: ${sess.data.serverName}
IP: ${ipLabel}
${sess.data.loginMode === 'password' ? `Password: ${sess.data.passwordChoice === 'random' ? 'acak (akan ditampilkan)' : sess.data.passwordChoice}` : ''}

⚠️ <b>Peringatan biaya:</b> VPS ditagih per jam sampai <b>dihapus</b>. VPS yang hanya di-Stop umumnya tetap ditagih karena resource masih dialokasikan.
${sess.data.ipVersion === 'dual' ? '\nℹ️ Dual stack: VPS akan dapat IPv4 publik + IPv6 publik.' : '\nℹ️ Default: VPS hanya IPv4 publik (paling kompatibel).'}

Yakin buat VPS?`;
    const keyboard = { inline_keyboard: [[{ text: '✅ Ya, buat VPS', callback_data: 'wiz:confirm:create' }], [{ text: '❌ Batal', callback_data: 'wiz:cancel' }]] };
    await safeEdit(ctx, confirmText, { reply_markup: keyboard });
  });

  bot.action(/wiz:login:(password|key)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess) return ctx.answerCbQuery('Sesi ini sudah tidak berlaku', { show_alert: true });
    const mode = ctx.match[1];
    if (sess.type === 'create_vps') {
      sess.data.loginMode = mode;
      sess.step = 'os';
      setSession(ctx.from.id, sess);
      try {
        const token = vault.getDecryptedToken(ctx.from.id, sess.data.accountId);
        const client = new UpCloudClient(token);
        const templates = await client.getTemplates();
        const { text, keyboard } = ui.formatTemplates(templates, sess.data.loginMode);
        await safeEdit(ctx, text, { reply_markup: keyboard });
      } catch (e) {
        const c = new UpCloudClient('');
        await safeEdit(ctx, `❌ Gagal ambil template: ${c.translateError(e)}`);
      }
    } else if (sess.type === 'rebuild') {
      sess.data.loginMode = mode;
      if (mode === 'key') {
        sess.step = 'ask_pubkey';
        setSession(ctx.from.id, sess);
        await safeEdit(ctx, `🔑 Kirim public key untuk VPS baru (setelah rebuild).`);
      } else {
        sess.step = 'ask_password';
        setSession(ctx.from.id, sess);
        const { text, keyboard } = ui.formatPasswordChoices(isOwner(ctx.from.id), config);
        await safeEdit(ctx, text, { reply_markup: keyboard });
      }
    } else {
      return ctx.answerCbQuery('Sesi tidak berlaku untuk login', { show_alert: true });
    }
  });

  bot.action(/wiz:os:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'create_vps') return ctx.answerCbQuery('Sesi ini sudah tidak berlaku', { show_alert: true });
    const uuid = ctx.match[1];
    sess.data.osTemplateUuid = uuid;
    // Fetch template detail untuk title & cloud-init & size
    try {
      const token = vault.getDecryptedToken(ctx.from.id, sess.data.accountId);
      const client = new UpCloudClient(token);
      const all = await client.getAllTemplatesIncludingWindows();
      const tpl = all.find(t=>t.uuid===uuid);
      if (tpl) {
        sess.data.osTitle = tpl.title;
        sess.data.osIsCloudInit = tpl.template_type === 'cloud-init';
        sess.data.osSize = tpl.size || 25;
      }
    } catch {}
    if (sess.data.loginMode === 'key') {
      sess.step = 'ask_pubkey';
      setSession(ctx.from.id, sess);
      await safeEdit(ctx, `🔑 <b>Kirim Public Key SSH</b>

Kirim public key kamu (diawali ssh-ed25519, ssh-rsa, ecdsa-sha2-...).

Contoh: <code>ssh-ed25519 AAAAC3... user@hp</code>

⚠️ Jangan kirim private key! Kalau kamu kirim private key, pesan akan dihapus dan diperingatkan.

Ketik /cancel untuk batal.`, { reply_markup: { inline_keyboard: [[{ text: '📖 Cara Buat SSH Key', callback_data: 'guide:4' }], [{ text: '❌ Batal', callback_data: 'wiz:cancel' }]] } });
    } else {
      sess.step = 'ask_password';
      setSession(ctx.from.id, sess);
      const { text, keyboard } = ui.formatPasswordChoices(isOwner(ctx.from.id), config);
      await safeEdit(ctx, text, { reply_markup: keyboard });
    }
  });

  // Password choice for create VPS & others
  bot.action(/wiz:pw:(random|custom|default)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess) return ctx.answerCbQuery('Sesi ini sudah tidak berlaku', { show_alert: true });
    const choice = ctx.match[1];
    if (choice === 'random') {
      const isWin = sess.data.osType === 'windows';
      const pw = passwordLib.generateRandom(16, isWin);
      sess.data.password = pw;
      sess.data.passwordChoice = 'random';
      if (sess.type === 'create_vps') {
        sess.step = 'ask_name';
        setSession(ctx.from.id, sess);
        await safeEdit(ctx, `✅ Password acak dibuat.

Sekarang kirim <b>nama VPS</b> (mis. katsu-vps). Huruf angka dash saja, 3-20 karakter.

Ketik /cancel untuk batal.`, { reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'wiz:cancel' }]] } });
      } else if (sess.type === 'setup_vps' || sess.type === 'reinstall' || sess.type === 'rebuild') {
        await handlePasswordSetForOtherFlows(ctx, sess);
      }
    } else if (choice === 'custom') {
      sess.data.passwordChoice = 'custom';
      setSession(ctx.from.id, sess);
      await safeEdit(ctx, `✏️ <b>Ketik Password Sendiri</b>

Kirim password (10-64 karakter, ada huruf & angka, tanpa spasi/kutip/backslash).

⚠️ Pesan password akan langsung dihapus demi keamanan.

Ketik /cancel untuk batal.`);
      sess.step = 'await_custom_password';
      setSession(ctx.from.id, sess);
    } else if (choice === 'default') {
      if (!isOwner(ctx.from.id) && !config.DEFAULT_PASSWORD_FOR_EVERYONE) {
        return ctx.answerCbQuery('Password default hanya untuk owner', { show_alert: true });
      }
      sess.data.password = config.DEFAULT_PASSWORD;
      sess.data.passwordChoice = 'default';
      if (sess.type === 'create_vps') {
        sess.step = 'ask_name';
        setSession(ctx.from.id, sess);
        await safeEdit(ctx, `✅ Pakai password default.

Sekarang kirim <b>nama VPS</b> (mis. katsu-vps).`, { reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'wiz:cancel' }]] } });
      } else {
        await handlePasswordSetForOtherFlows(ctx, sess);
      }
    }
  });

  async function handlePasswordSetForOtherFlows(ctx, sess) {
    if (sess.type === 'setup_vps') {
      sess.step = 'confirm';
      setSession(ctx.from.id, sess);
      const text = `🔐 <b>Konfirmasi Setup VPS</b>

IP: <code>${sess.data.ip}</code>
User: <code>${sess.data.username}</code>
Password: <code>${sess.data.password ? '*** (akan ditampilkan setelah sukses)' : 'belum'}</code>

Yakin lanjut?`;
      const keyboard = { inline_keyboard: [[{ text: '✅ Ya, lanjut', callback_data: 'ssh:confirm' }], [{ text: '❌ Batal', callback_data: 'wiz:cancel' }]] };
      await safeEdit(ctx, text, { reply_markup: keyboard });
    } else if (sess.type === 'reinstall') {
      await showReinstallConfirm(ctx, sess);
    } else if (sess.type === 'rebuild') {
      sess.step = 'confirm';
      setSession(ctx.from.id, sess);
      const text = `🔁 <b>Konfirmasi Rebuild (Password ${sess.data.passwordChoice})</b>

VPS: ${sess.data.serverUuid}
OS: ${sess.data.osTitle}
Password: ${sess.data.passwordChoice === 'random' ? 'acak (akan ditampilkan)' : '***'}

⚠️ SEMUA DATA DIHAPUS PERMANEN!

Yakin?`;
      await safeEdit(ctx, text, { reply_markup: { inline_keyboard: [[{ text: '✅ Ya, rebuild', callback_data: 'rebuild:confirm' }], [{ text: '❌ Batal', callback_data: 'wiz:cancel' }]] } });
    }
  }

  bot.action(/wiz:cancel/, async (ctx) => {
    await ctx.answerCbQuery();
    clearSession(ctx.from.id);
    await safeEdit(ctx, '❌ Dibatalkan.', { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Utama', callback_data: 'menu:main' }]] } });
  });

  // Billing
  bot.action(/mgr:acc:([a-f0-9]{6}):billing/, async (ctx) => {
    await ctx.answerCbQuery('💰 Mengambil tagihan...');
    const accId = ctx.match[1];
    if (!vault.isOwner(ctx.from.id, accId)) return;
    try {
      const token = vault.getDecryptedToken(ctx.from.id, accId);
      const client = new UpCloudClient(token);
      const accData = await client.getAccount();
      const now = new Date();
      const curMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}`;
      const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth()-1, 1));
      const lastMonth = `${lastMonthDate.getUTCFullYear()}-${String(lastMonthDate.getUTCMonth()+1).padStart(2,'0')}`;
      let curBilling = { total: 'N/A', currency: '', month: curMonth };
      let lastBilling = { total: 'N/A', currency: '', month: lastMonth };
      try {
        const cur = await client.getBillingSummary(curMonth);
        curBilling = { total: cur.billing?.total_amount || 'N/A', currency: cur.billing?.currency || '', month: curMonth };
      } catch {}
      try {
        const last = await client.getBillingSummary(lastMonth);
        lastBilling = { total: last.billing?.total_amount || 'N/A', currency: last.billing?.currency || '', month: lastMonth };
      } catch {}
      const servers = await client.getServers().catch(()=>[]);
      const accountInfo = { id: accId, label: vault.findAccount(ctx.from.id, accId).label, username: accData.account?.username, credits: accData.account?.credits };
      const { text, keyboard } = ui.formatBilling(accountInfo, curBilling, lastBilling, servers);
      await safeEdit(ctx, text, { reply_markup: keyboard });
    } catch (e) {
      const c = new UpCloudClient('');
      await safeEdit(ctx, `❌ Gagal ambil tagihan: ${c.translateError(e)}`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: `mgr:acc:${accId}` }]] } });
    }
  });

  // Server list
  bot.action(/mgr:acc:([a-f0-9]{6}):list/, async (ctx) => {
    await ctx.answerCbQuery('🖥 Mengambil daftar VPS...');
    const accId = ctx.match[1];
    if (!vault.isOwner(ctx.from.id, accId)) return;
    try {
      const token = vault.getDecryptedToken(ctx.from.id, accId);
      const client = new UpCloudClient(token);
      const servers = await client.getServers();
      const { text, keyboard } = ui.formatServerList(servers, accId);
      await safeEdit(ctx, text, { reply_markup: keyboard });
    } catch (e) {
      const c = new UpCloudClient('');
      await safeEdit(ctx, `❌ Gagal ambil VPS: ${c.translateError(e)}`);
    }
  });

  // Server detail (stateless)
  bot.action(/srv:([a-f0-9]{6}):([a-f0-9-]{36})/, async (ctx) => {
    await ctx.answerCbQuery();
    const accId = ctx.match[1];
    const uuid = ctx.match[2];
    if (!vault.isOwner(ctx.from.id, accId)) return ctx.answerCbQuery('Bukan milikmu', { show_alert: true });
    try {
      const token = vault.getDecryptedToken(ctx.from.id, accId);
      const client = new UpCloudClient(token);
      const srv = await client.getServer(uuid);
      const { text, keyboard } = ui.formatServerDetail(srv, accId);
      await safeEdit(ctx, text, { reply_markup: keyboard });
    } catch (e) {
      const c = new UpCloudClient('');
      await safeEdit(ctx, `❌ Gagal ambil detail: ${c.translateError(e)}`);
    }
  });

  // Server actions
  bot.action(/srvact:([a-f0-9]{6}):([a-f0-9-]{36}):(start|stop|restart|delete|vnc|ssh|os|rebuild|fw|fwlock)/, async (ctx) => {
    const accId = ctx.match[1];
    const uuid = ctx.match[2];
    const action = ctx.match[3];
    if (!vault.isOwner(ctx.from.id, accId)) return ctx.answerCbQuery('Bukan milikmu', { show_alert: true });
    await ctx.answerCbQuery(`⏳ ${action}...`);

    const token = vault.getDecryptedToken(ctx.from.id, accId);
    const client = new UpCloudClient(token);

    if (['start','stop','restart'].includes(action)) {
      try {
        if (action === 'start') await client.startServer(uuid);
        if (action === 'stop') await client.stopServer(uuid, 'soft');
        if (action === 'restart') await client.restartServer(uuid, 'soft');
        await safeEdit(ctx, `✅ Perintah ${action} dikirim untuk VPS ${uuid}. Tunggu beberapa detik lalu refresh.`, { reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: `srv:${accId}:${uuid}` }], [{ text: '⬅️ Kembali', callback_data: `mgr:acc:${accId}:list` }]] } });
      } catch (e) {
        await safeEdit(ctx, `❌ Gagal ${action}: ${client.translateError(e)}`);
      }
    } else if (action === 'delete') {
      const text = `🗑 <b>Hapus VPS ${uuid}?</b>

⚠️ <b>PERMANEN!</b> Semua data di VPS ini akan DIHAPUS dan tidak bisa dikembalikan. VPS akan di-Stop dulu kalau masih running, lalu dihapus dengan storages & backups.

Yakin?`;
      const keyboard = { inline_keyboard: [[{ text: '✅ Ya, hapus permanen', callback_data: `srvact:${accId}:${uuid}:delete:confirm` }], [{ text: '❌ Batal', callback_data: `srv:${accId}:${uuid}` }]] };
      await safeEdit(ctx, text, { reply_markup: keyboard });
    } else if (action === 'vnc') {
      try {
        const vnc = await client.getVncDetails(uuid);
        if (vnc.remote_access_enabled === 'no') {
          const text = `🖥 <b>Console VNC Nonaktif</b>

Remote access belum aktif. Aktifkan dulu?`;
          const keyboard = { inline_keyboard: [[{ text: '✅ Aktifkan VNC', callback_data: `srvact:${accId}:${uuid}:vnc:enable` }], [{ text: '⬅️ Kembali', callback_data: `srv:${accId}:${uuid}` }]] };
          return safeEdit(ctx, text, { reply_markup: keyboard });
        }
        const text = `🖥 <b>Console VNC VPS ${uuid}</b>

Host: <code>${vnc.vnc_host || vnc.remote_access_host || 'N/A'}</code>
Port: <code>${vnc.vnc_port || 'N/A'}</code>
Password: <code>${vnc.vnc_password || vnc.remote_access_password || 'N/A'}</code>

<b>Cara pakai:</b>
1. Install aplikasi VNC Viewer (RealVNC, TightVNC)
2. Masukkan host & port
3. Masukkan password

Berguna untuk darurat kalau VPS macet setelah reinstall.

<i>Pesan ini bisa kamu hapus setelah dicatat.</i>`;
        await safeEdit(ctx, text, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: `srv:${accId}:${uuid}` }]] } });
      } catch (e) {
        await safeEdit(ctx, `❌ Gagal ambil VNC: ${client.translateError(e)}`);
      }
    } else if (action === 'ssh') {
      // Pintasan Aktifkan Password: isi IP otomatis
      try {
        const srv = await client.getServer(uuid);
        const ips = srv.ip_addresses ? (Array.isArray(srv.ip_addresses.ip_address) ? srv.ip_addresses.ip_address : [srv.ip_addresses.ip_address]) : [];
        const ipv4 = ips.filter(ip => ip.access === 'public' && ip.family === 'IPv4')[0]?.address;
        if (!ipv4) return safeEdit(ctx, '❌ VPS belum punya IPv4 publik');
        // Mulai sesi setup VPS dengan IP terisi otomatis
        setSession(ctx.from.id, { type: 'setup_vps', step: 'source', data: { ip: ipv4, username: 'root', fromVps: uuid, accountId: accId } });
        const text = `🔐 <b>Aktifkan Password - IP otomatis</b>

IP terisi otomatis: <code>${ipv4}</code>
VPS: ${srv.title}

Pilih sumber key:`;
        const keyboard = { inline_keyboard: [[{ text: '🔑 Key bawaan bot', callback_data: 'ssh:source:bot' }], [{ text: '🔑 Key sendiri', callback_data: 'ssh:source:custom' }], [{ text: '❌ Batal', callback_data: `srv:${accId}:${uuid}` }]] };
        await safeEdit(ctx, text, { reply_markup: keyboard });
      } catch (e) {
        await safeEdit(ctx, `❌ Gagal: ${client.translateError(e)}`);
      }
    } else if (action === 'os') {
      // Pintasan reinstall via Menu 3
      try {
        const srv = await client.getServer(uuid);
        const ips = srv.ip_addresses ? (Array.isArray(srv.ip_addresses.ip_address) ? srv.ip_addresses.ip_address : [srv.ip_addresses.ip_address]) : [];
        const ipv4 = ips.filter(ip => ip.access === 'public' && ip.family === 'IPv4')[0]?.address;
        if (!ipv4) return safeEdit(ctx, '❌ VPS belum punya IPv4');
        setSession(ctx.from.id, { type: 'reinstall', step: 'source', data: { ip: ipv4, username: 'root', fromVps: uuid, accountId: accId } });
        const text = `💿 <b>Reinstall via Menu 3 - IP otomatis</b>

IP: <code>${ipv4}</code>
VPS: ${srv.title}

Pilih sumber key:`;
        const keyboard = { inline_keyboard: [[{ text: '🔑 Key bawaan bot', callback_data: 'reinstall:source:bot' }], [{ text: '🔑 Key sendiri', callback_data: 'reinstall:source:custom' }], [{ text: '❌ Batal', callback_data: `srv:${accId}:${uuid}` }]] };
        await safeEdit(ctx, text, { reply_markup: keyboard });
      } catch (e) {
        await safeEdit(ctx, `❌ Gagal: ${client.translateError(e)}`);
      }
    } else if (action === 'rebuild') {
      // Reinstall resmi Linux
      setSession(ctx.from.id, { type: 'rebuild', step: 'os', data: { accountId: accId, serverUuid: uuid } });
      try {
        const token = vault.getDecryptedToken(ctx.from.id, accId);
        const cl = new UpCloudClient(token);
        const templates = await cl.getTemplates();
        const { text, keyboard } = ui.formatTemplates(templates, 'password'); // tampilkan semua linux, tapi nanti filter
        // Override callback untuk rebuild
        const kb = { inline_keyboard: [] };
        for (const tpl of templates.slice(0,10)) {
          kb.inline_keyboard.push([{ text: tpl.title.slice(0,40), callback_data: `rebuild:os:${tpl.uuid}` }]);
        }
        kb.inline_keyboard.push([{ text: '❌ Batal', callback_data: `srv:${accId}:${uuid}` }]);
        await safeEdit(ctx, `🔁 <b>Reinstall Resmi (Linux)</b>\n\nPilih OS baru (semua data akan DIHAPUS PERMANEN):`, { reply_markup: kb });
      } catch (e) {
        await safeEdit(ctx, `❌ Gagal ambil template: ${client.translateError(e)}`);
      }
    } else if (action === 'fw') {
      try {
        const srv = await client.getServer(uuid);
        const rules = await client.getFirewallRules(uuid).catch(()=>[]);
        const { text, keyboard } = ui.formatFirewallStatus(srv, rules, accId);
        await safeEdit(ctx, text, { reply_markup: keyboard });
      } catch (e) {
        await safeEdit(ctx, `❌ Gagal ambil firewall: ${client.translateError(e)}`);
      }
    } else if (action === 'fwlock') {
      setSession(ctx.from.id, { type: 'firewall', step: 'await_ip', data: { accountId: accId, serverUuid: uuid } });
      await safeEdit(ctx, `🔒 <b>Kunci SSH/RDP ke IP-ku</b>

Kirim IPv4 atau CIDR IPv4 kamu (mis. 203.0.113.5 atau 203.0.113.0/24).

<b>Cara lihat IP:</b> Buka situs "what is my IP" di HP/PC yang dipakai login.

⚠️ Peringatan: IP rumah/seluler bisa berganti! Kalau IP salah, kamu terkunci sampai firewall dimatikan lewat bot atau Console VNC.

Ketik /cancel untuk batal.`);
    }
  });

  bot.action(/srvact:([a-f0-9]{6}):([a-f0-9-]{36}):delete:confirm/, async (ctx) => {
    await ctx.answerCbQuery('🗑 Menghapus...');
    const accId = ctx.match[1];
    const uuid = ctx.match[2];
    if (!vault.isOwner(ctx.from.id, accId)) return;
    // Detached job
    const can = jobs.canStart(ctx.from.id);
    if (!can.allowed) {
      const msg = can.reason === 'user_busy' ? 'Kamu masih punya job aktif.' : 'Server bot sedang sibuk, coba lagi sebentar.';
      return ctx.answerCbQuery(msg, { show_alert: true });
    }
    const token = vault.getDecryptedToken(ctx.from.id, accId);
    const chatId = ctx.chat.id;
    const msg = await ctx.telegram.sendMessage(chatId, `🗑 Menghapus VPS ${uuid}...`);
    const prog = new LiveProgress(ctx.telegram ? { telegram: ctx.telegram } : ctx, chatId, msg.message_id, '🗑 Hapus VPS', 900);
    prog.addStep('Cek status VPS');
    prog.addStep('Stop VPS (jika perlu)');
    prog.addStep('Hapus VPS + storage');
    prog.start();

    jobs.runDetached(ctx.from.id, async () => {
      try {
        const client = new UpCloudClient(token);
        prog.setRunning(0);
        await prog.tickNow();
        const srv = await client.getServer(uuid);
        prog.setDone(0, srv.state);
        if (srv.state !== 'stopped') {
          prog.setRunning(1, 'stop soft');
          await prog.tickNow();
          await client.stopServer(uuid, 'soft').catch(()=>{});
          // Tunggu stopped
          try {
            await waitForServerState(client, uuid, 'stopped', 2*60*1000);
            prog.setDone(1, 'stopped');
          } catch {
            prog.setRunning(1, 'stop hard');
            await client.stopServer(uuid, 'hard').catch(()=>{});
            await waitForServerState(client, uuid, 'stopped', 2*60*1000).catch(()=>{});
            prog.setDone(1, 'stopped (hard)');
          }
        } else {
          prog.setDone(1, 'sudah stopped');
        }
        prog.setRunning(2, 'delete');
        await prog.tickNow();
        await client.deleteServer(uuid);
        prog.setDone(2, 'terhapus');
        await prog.finish(`✅ VPS ${uuid} berhasil dihapus permanen.`);
        stats.inc('deploySuccess'); // reuse?
      } catch (e) {
        const c = new UpCloudClient('');
        prog.setFail(2, e.message.slice(0,42));
        await prog.finish(`❌ Gagal hapus VPS ${uuid}: ${c.translateError(e)}`);
        stats.inc('deployFail');
      }
    });
  });

  bot.action(/srvact:([a-f0-9]{6}):([a-f0-9-]{36}):vnc:enable/, async (ctx) => {
    await ctx.answerCbQuery();
    const accId = ctx.match[1];
    const uuid = ctx.match[2];
    if (!vault.isOwner(ctx.from.id, accId)) return;
    try {
      const token = vault.getDecryptedToken(ctx.from.id, accId);
      const client = new UpCloudClient(token);
      await client.setRemoteAccess(uuid, true);
      const vnc = await client.getVncDetails(uuid);
      const text = `✅ VNC diaktifkan.\n\nHost: ${vnc.vnc_host}\nPort: ${vnc.vnc_port}\nPass: ${vnc.vnc_password}`;
      await safeEdit(ctx, text, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: `srv:${accId}:${uuid}` }]] } });
    } catch (e) {
      const c = new UpCloudClient('');
      await safeEdit(ctx, `❌ Gagal aktifkan VNC: ${c.translateError(e)}`);
    }
  });

  // Rebuild OS flow
  bot.action(/rebuild:os:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'rebuild') return ctx.answerCbQuery('Sesi tidak berlaku', { show_alert: true });
    const tplUuid = ctx.match[1];
    sess.data.osTemplateUuid = tplUuid;
    try {
      const token = vault.getDecryptedToken(ctx.from.id, sess.data.accountId);
      const client = new UpCloudClient(token);
      const all = await client.getAllTemplatesIncludingWindows();
      const tpl = all.find(t=>t.uuid===tplUuid);
      sess.data.osTitle = tpl?.title || tplUuid;
      sess.data.osIsCloudInit = tpl?.template_type === 'cloud-init';
    } catch {}
    sess.step = 'login';
    setSession(ctx.from.id, sess);
    const { text, keyboard } = ui.formatLoginMethods();
    await safeEdit(ctx, text + `\n\nOS terpilih: ${sess.data.osTitle}`, { reply_markup: keyboard });
  });

  // Firewall list from account menu
  bot.action(/mgr:acc:([a-f0-9]{6}):fwlist/, async (ctx) => {
    await ctx.answerCbQuery();
    const accId = ctx.match[1];
    if (!vault.isOwner(ctx.from.id, accId)) return;
    // Show server list for firewall
    try {
      const token = vault.getDecryptedToken(ctx.from.id, accId);
      const client = new UpCloudClient(token);
      const servers = await client.getServers();
      const text = `🛡 Pilih VPS untuk kelola firewall:`;
      const keyboard = { inline_keyboard: [] };
      for (const s of servers.slice(0,20)) {
        keyboard.inline_keyboard.push([{ text: `${s.title} (${s.firewall})`, callback_data: `srvact:${accId}:${s.uuid}:fw` }]);
      }
      keyboard.inline_keyboard.push([{ text: '⬅️ Kembali', callback_data: `mgr:acc:${accId}` }]);
      await safeEdit(ctx, text, { reply_markup: keyboard });
    } catch (e) {
      const c = new UpCloudClient('');
      await safeEdit(ctx, `❌ Gagal: ${c.translateError(e)}`);
    }
  });

  // === SSH MENU ACTIONS ===
  bot.action(/ssh:showkey/, async (ctx) => {
    await ctx.answerCbQuery();
    await showSshKey(ctx);
  });
  bot.action(/ssh:setup/, async (ctx) => {
    await ctx.answerCbQuery();
    setSession(ctx.from.id, { type: 'setup_vps', step: 'source', data: {} });
    const text = `⚙️ <b>Setup VPS - Aktifkan Password</b>

Pilih sumber SSH key untuk login awal:`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '🔑 Key bawaan bot', callback_data: 'ssh:source:bot' }],
        [{ text: '🔑 Key sendiri (upload private)', callback_data: 'ssh:source:custom' }],
        [{ text: '❌ Batal', callback_data: 'menu:ssh' }]
      ]
    };
    await safeEdit(ctx, text, { reply_markup: keyboard });
  });
  bot.action(/ssh:check/, async (ctx) => {
    await ctx.answerCbQuery();
    setSession(ctx.from.id, { type: 'check_vps', step: 'source', data: {} });
    const text = `🔍 <b>Check VPS</b>

Pilih sumber key:`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '🔑 Key bawaan bot', callback_data: 'check:source:bot' }],
        [{ text: '🔑 Key sendiri', callback_data: 'check:source:custom' }],
        [{ text: '❌ Batal', callback_data: 'menu:ssh' }]
      ]
    };
    await safeEdit(ctx, text, { reply_markup: keyboard });
  });

  bot.action(/ssh:source:(bot|custom)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'setup_vps') return ctx.answerCbQuery('Sesi tidak berlaku', { show_alert: true });
    const src = ctx.match[1];
    sess.data.keySource = src;
    if (src === 'custom') {
      sess.step = 'await_private_key';
      setSession(ctx.from.id, sess);
      await safeEdit(ctx, `🔑 <b>Kirim Private Key</b>

Paste isi private key (format OpenSSH, diawali -----BEGIN ... PRIVATE KEY-----) atau upload file ≤32KB.

⚠️ Pesan akan langsung dihapus! Hanya disimpan di memori selama proses.

Key ber-passphrase belum didukung.

Ketik /cancel untuk batal.`);
    } else {
      sess.data.privateKeyPath = botKeyPair.privPath;
      sess.step = 'await_ip';
      setSession(ctx.from.id, sess);
      await safeEdit(ctx, `✅ Pakai key bawaan bot.

Sekarang kirim <b>IP/host VPS</b> (IPv4/IPv6/hostname).

Ketik /cancel untuk batal.`);
    }
  });

  bot.action(/check:source:(bot|custom)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'check_vps') return;
    const src = ctx.match[1];
    sess.data.keySource = src;
    if (src === 'custom') {
      sess.step = 'await_private_key';
      setSession(ctx.from.id, sess);
      await safeEdit(ctx, `🔑 Kirim private key (akan dihapus).`);
    } else {
      sess.data.privateKeyPath = botKeyPair.privPath;
      sess.step = 'await_ip';
      setSession(ctx.from.id, sess);
      await safeEdit(ctx, `✅ Pakai key bawaan bot. Kirim IP/host VPS.`);
    }
  });

  bot.action(/ssh:user:(root|ubuntu|debian|custom)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess) return;
    const user = ctx.match[1];
    if (user === 'custom') {
      sess.step = 'await_username';
      setSession(ctx.from.id, sess);
      await safeEdit(ctx, `👤 Ketik username manual (regex ^[a-z_][a-z0-9_-]{0,31}$, /skip = root):`);
    } else {
      sess.data.username = user;
      sess.step = 'ask_password';
      setSession(ctx.from.id, sess);
      const { text, keyboard } = ui.formatPasswordChoices(isOwner(ctx.from.id), config);
      await safeEdit(ctx, text, { reply_markup: keyboard });
    }
  });

  // OS menu
  bot.action(/os:linux/, async (ctx) => {
    await ctx.answerCbQuery();
    setSession(ctx.from.id, { type: 'reinstall', step: 'source', data: { osType: 'linux' } });
    const text = `🐧 <b>Pilih Sumber Key untuk Reinstall Linux</b>`;
    const keyboard = { inline_keyboard: [[{ text: '🔑 Key bawaan bot', callback_data: 'reinstall:source:bot' }], [{ text: '🔑 Key sendiri', callback_data: 'reinstall:source:custom' }], [{ text: '❌ Batal', callback_data: 'menu:os' }]] };
    await safeEdit(ctx, text, { reply_markup: keyboard });
  });
  bot.action(/os:windows/, async (ctx) => {
    await ctx.answerCbQuery();
    setSession(ctx.from.id, { type: 'reinstall', step: 'source', data: { osType: 'windows' } });
    const text = `🪟 <b>Pilih Sumber Key untuk Reinstall Windows</b>`;
    const keyboard = { inline_keyboard: [[{ text: '🔑 Key bawaan bot', callback_data: 'reinstall:source:bot' }], [{ text: '🔑 Key sendiri', callback_data: 'reinstall:source:custom' }], [{ text: '❌ Batal', callback_data: 'menu:os' }]] };
    await safeEdit(ctx, text, { reply_markup: keyboard });
  });

  bot.action(/reinstall:source:(bot|custom)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'reinstall') return ctx.answerCbQuery('Sesi tidak berlaku', { show_alert: true });
    const src = ctx.match[1];
    sess.data.keySource = src;
    if (src === 'custom') {
      sess.step = 'await_private_key';
      setSession(ctx.from.id, sess);
      await safeEdit(ctx, `🔑 Kirim private key (akan dihapus).`);
    } else {
      sess.data.privateKeyPath = botKeyPair.privPath;
      sess.step = 'await_ip';
      setSession(ctx.from.id, sess);
      await safeEdit(ctx, `✅ Pakai key bawaan bot. Kirim IP/host VPS.`);
    }
  });

  bot.action(/reinstall:linux:(.+):(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'reinstall') return;
    const distro = ctx.match[1];
    const version = ctx.match[2];
    sess.data.distro = distro;
    sess.data.version = version;
    sess.step = 'ask_password';
    setSession(ctx.from.id, sess);
    const { text, keyboard } = ui.formatPasswordChoices(isOwner(ctx.from.id), config);
    await safeEdit(ctx, `🐧 OS: ${distro} ${version}\n\n` + text, { reply_markup: keyboard });
  });

  bot.action(/reinstall:winpreset:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'reinstall') return;
    const label = ctx.match[1];
    const preset = config.WINDOWS_PRESETS.find(p=>p.label===label);
    if (!preset) return ctx.answerCbQuery('Preset tidak ditemukan', { show_alert: true });
    sess.data.iso = preset.iso;
    sess.data.imageName = preset.imageName;
    sess.data.osLabel = preset.label;
    sess.step = 'ask_password';
    setSession(ctx.from.id, sess);
    const { text, keyboard } = ui.formatPasswordChoices(isOwner(ctx.from.id), config);
    await safeEdit(ctx, `🪟 OS: ${preset.label}\nISO: ${preset.iso.split('/').pop()}\nImage: ${preset.imageName}\n\n` + text, { reply_markup: keyboard });
  });

  // Confirmations
  bot.action(/ssh:confirm/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'setup_vps') return ctx.answerCbQuery('Sesi tidak berlaku', { show_alert: true });
    // Check quota
    const q = quota.canUse(ctx.from.id, 'setup', 3, isOwner(ctx.from.id));
    if (!q.allowed) {
      return safeEdit(ctx, `⚠️ Kuota Setup VPS harian habis (3/hari). Reset 00:00 UTC. Sisa: ${q.remaining}`);
    }
    const can = jobs.canStart(ctx.from.id);
    if (!can.allowed) {
      const msg = can.reason === 'user_busy' ? 'Kamu masih punya job aktif.' : 'Server bot sedang sibuk, coba lagi sebentar.';
      return ctx.answerCbQuery(msg, { show_alert: true });
    }
    const chatId = ctx.chat.id;
    const msg = await ctx.telegram.sendMessage(chatId, `🔐 Setup VPS ${sess.data.ip}...`);
    const prog = new LiveProgress({ telegram: ctx.telegram }, chatId, msg.message_id, '🔐 Setup VPS', 900);
    prog.addStep('Koneksi SSH');
    prog.addStep('Deteksi OS');
    prog.addStep('Backup konfigurasi SSH');
    prog.addStep('Perbaikan konfigurasi');
    prog.addStep('Validasi sshd -t');
    prog.addStep('Restart layanan SSH');
    prog.addStep('Verifikasi konfigurasi efektif');
    prog.addStep('Set password login');
    prog.addStep('Tes ulang koneksi SSH');
    prog.start();

    const sessData = { ...sess.data }; // copy
    clearSession(ctx.from.id);

    jobs.runDetached(ctx.from.id, async () => {
      let ssh = null;
      try {
        const isRootUser = sessData.username === 'root';
        ssh = new SshSession({
          host: sessData.ip,
          port: sessData.port || 22,
          username: sessData.username,
          privateKey: sessData.privateKey || null,
          privateKeyPath: sessData.privateKeyPath || null
        });
        await ssh.connect();
        const result = await require('./lib/setupFlow').setupVpsFlow({ sshSession: ssh, targetUsername: sessData.username, password: sessData.password, isRootUser, progress: prog });
        if (result.success) {
          quota.use(ctx.from.id, 'setup');
          stats.inc('deploySuccess');
          await prog.finish(`✅ <b>Setup VPS Berhasil</b>

IP: <code>${sessData.ip}</code>
User: <code>${sessData.username}</code>
Port: 22
Password: <code>${sessData.password}</code>
OS: ${result.os.id} ${result.os.versionId}
Status: key auth ok, password auth yes, root login yes

Cara login: <code>ssh ${sessData.username}@${sessData.ip}</code>

⚠️ Ganti password setelah login pertama dengan <code>passwd</code>`);
        } else {
          stats.inc('deployFail');
          await prog.finish(`❌ <b>Setup Gagal di tahap: ${result.error}</b>

Error: ${result.error}
Rollback: ${result.rollbackStatus}
Backup dir: ${result.backupDir}

Checklist:
• Pastikan OS Ubuntu/Debian
• Pastikan user punya sudo tanpa password kalau bukan root
• Cek /etc/ssh/sshd_config tidak rusak
`);
        }
      } catch (e) {
        stats.inc('deployFail');
        await prog.finish(`❌ Gagal koneksi/setup: ${validators.redactSecrets(e.message)}`);
      } finally {
        if (ssh) ssh.close();
      }
    });
  });

  // === TEXT MESSAGE HANDLER (for wizard inputs) ===
  bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const sess = getSession(userId);
    if (!sess) return next();

    const text = ctx.message.text.trim();

    // Cancel command
    if (text === '/cancel') {
      clearSession(userId);
      await tryDeleteUserMessage(ctx);
      return safeReply(ctx, '✅ Sesi dibatalkan.');
    }

    // Add account token
    if (sess.type === 'add_account' && sess.step === 'await_token') {
      await tryDeleteUserMessage(ctx);
      const token = text;
      if (!token.startsWith('ucat_')) {
        return safeReply(ctx, '❌ Token harus diawali ucat_. Coba lagi atau /cancel');
      }
      // Validasi via API
      const tempMsg = await safeReply(ctx, '🔍 Memvalidasi token...');
      try {
        const client = new UpCloudClient(token);
        const acc = await client.getAccount();
        const username = acc.account?.username || 'unknown';
        // Simpan
        const accounts = vault.getUserAccounts(userId);
        if (accounts.length >= (config.MAX_ACCOUNTS_PER_USER || 5) && !accounts.find(a=>a.username===username)) {
          await ctx.telegram.editMessageText(ctx.chat.id, tempMsg.message_id, undefined, `⚠️ Maksimal ${config.MAX_ACCOUNTS_PER_USER} akun. Hapus dulu.`);
          clearSession(userId);
          return;
        }
        const saved = vault.addOrUpdateAccount(userId, token, username, username);
        await ctx.telegram.editMessageText(ctx.chat.id, tempMsg.message_id, undefined, `✅ Akun <b>${username}</b> berhasil disimpan! ID: ${saved.id}`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '☁️ Lihat Akun', callback_data: 'mgr:upcloud' }]] } });
        clearSession(userId);
      } catch (e) {
        const client = new UpCloudClient('');
        let errText = client.translateError(e);
        if (e.status === 403) errText += `\n\n🌐 IP Bot: ${BOT_PUBLIC_IP}\nTambahkan IP ini ke Allowed IP ranges token di panel UpCloud.`;
        await ctx.telegram.editMessageText(ctx.chat.id, tempMsg.message_id, undefined, `❌ Gagal validasi token: ${errText}\n\nCoba lagi atau /cancel`, { parse_mode: 'HTML' });
      }
      return;
    }

    // Create VPS & Rebuild: pubkey
    if ((sess.type === 'create_vps' || sess.type === 'rebuild') && sess.step === 'ask_pubkey') {
      await tryDeleteUserMessage(ctx);
      const key = text;
      if (validators.isPrivateKey(key)) {
        await safeReply(ctx, '⚠️ Itu private key! Jangan pernah kirim private key. Kirim hanya public key (.pub). Pesanmu sudah dihapus.');
        return;
      }
      if (!validators.isValidSshPublicKey(key)) {
        return safeReply(ctx, '❌ Public key tidak valid. Harus diawali ssh-ed25519 / ssh-rsa / ecdsa-sha2-*. Coba lagi atau /cancel. Tombol panduan ada di bawah.', { reply_markup: { inline_keyboard: [[{ text: '📖 Cara Buat SSH Key', callback_data: 'guide:4' }]] } });
      }
      sess.data.publicKey = key;
      if (sess.type === 'create_vps') {
        sess.step = 'ask_name';
        setSession(userId, sess);
        return safeReply(ctx, `✅ Public key diterima.

Sekarang kirim <b>nama VPS</b> (mis. katsu-vps). Huruf kecil, angka, dash, 3-20 karakter.`);
      } else {
        // rebuild
        sess.step = 'confirm';
        setSession(userId, sess);
        const confirmText = `🔁 <b>Konfirmasi Rebuild (SSH Key)</b>

VPS: ${sess.data.serverUuid}
OS: ${sess.data.osTitle}
Login: SSH key

⚠️ SEMUA DATA DIHAPUS PERMANEN!

Yakin?`;
        return safeReply(ctx, confirmText, { reply_markup: { inline_keyboard: [[{ text: '✅ Ya, rebuild', callback_data: 'rebuild:confirm' }], [{ text: '❌ Batal', callback_data: 'wiz:cancel' }]] } });
      }
    }

    // Create VPS & Rebuild: custom password
    if ((sess.type === 'create_vps' || sess.type === 'rebuild') && sess.step === 'await_custom_password') {
      await tryDeleteUserMessage(ctx);
      const pw = text;
      const v = passwordLib.validateCustomPassword(pw);
      if (!v.valid) {
        return safeReply(ctx, `❌ ${v.reason} Coba lagi atau /cancel`);
      }
      sess.data.password = pw;
      if (sess.type === 'create_vps') {
        sess.step = 'ask_name';
        setSession(userId, sess);
        return safeReply(ctx, `✅ Password custom diterima.

Sekarang kirim <b>nama VPS</b>.`);
      } else {
        sess.step = 'confirm';
        setSession(userId, sess);
        return safeReply(ctx, `🔁 <b>Konfirmasi Rebuild (Password Custom)</b>

VPS: ${sess.data.serverUuid}
OS: ${sess.data.osTitle}
Password: custom (akan ditampilkan)

⚠️ SEMUA DATA DIHAPUS!

Yakin?`, { reply_markup: { inline_keyboard: [[{ text: '✅ Ya, rebuild', callback_data: 'rebuild:confirm' }], [{ text: '❌ Batal', callback_data: 'wiz:cancel' }]] } });
      }
    }

    // Create VPS: ask_name -> pilih IP version (IPv4 default)
    if (sess.type === 'create_vps' && sess.step === 'ask_name') {
      const name = text.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0,20);
      if (name.length < 3) return safeReply(ctx, '❌ Nama terlalu pendek (min 3). Coba lagi.');
      sess.data.serverName = name;
      sess.step = 'ask_ip_version';
      setSession(userId, sess);
      const { text: ipText, keyboard } = ui.formatIpOptions();
      return safeReply(ctx, `✅ Nama: <b>${name}</b>\n\n${ipText}`, { reply_markup: keyboard });
    }

    // Create VPS: ask_ip_version (text fallback)
    if (sess.type === 'create_vps' && sess.step === 'ask_ip_version') {
      const { text: ipText, keyboard } = ui.formatIpOptions();
      return safeReply(ctx, ipText, { reply_markup: keyboard });
    }

        // Setup VPS: await_ip
    if ((sess.type === 'setup_vps' || sess.type === 'check_vps' || sess.type === 'reinstall') && sess.step === 'await_ip') {
      if (!validators.isValidIpOrHost(text)) {
        return safeReply(ctx, '❌ IP/host tidak valid. Masukkan IPv4/IPv6/hostname yang benar. /cancel untuk batal.');
      }
      sess.data.ip = text;
      sess.data.port = 22;
      sess.step = 'await_username';
      setSession(userId, sess);
      const keyboard = {
        inline_keyboard: [
          [{ text: 'root', callback_data: 'ssh:user:root' }, { text: 'ubuntu', callback_data: 'ssh:user:ubuntu' }, { text: 'debian', callback_data: 'ssh:user:debian' }],
          [{ text: '✏️ Ketik manual', callback_data: 'ssh:user:custom' }]
        ]
      };
      if (sess.type === 'reinstall') {
        // Untuk reinstall, username langsung root default, skip pilih user? Spec: input sumber key → IP → username → pilihan OS
        // Jadi tetap tanya username
        return safeReply(ctx, `✅ IP: ${text}\n\nPilih username atau ketik manual:`, { reply_markup: keyboard });
      }
      return safeReply(ctx, `✅ IP: ${text}\n\nPilih username login:`, { reply_markup: keyboard });
    }

    // Setup VPS: await_username manual
    if ((sess.type === 'setup_vps' || sess.type === 'check_vps' || sess.type === 'reinstall') && sess.step === 'await_username') {
      let username = text;
      if (username === '/skip') username = 'root';
      if (!validators.isValidUsername(username)) {
        return safeReply(ctx, '❌ Username tidak valid (^[a-z_][a-z0-9_-]{0,31}$). Coba lagi atau /skip = root');
      }
      sess.data.username = username;
      if (sess.type === 'check_vps') {
        // Langsung eksekusi check
        const chatId = ctx.chat.id;
        const msg = await safeReply(ctx, `🔍 Check VPS ${sess.data.ip}...`);
        const prog = new LiveProgress({ telegram: ctx.telegram }, chatId, msg.message_id, '🔍 Check VPS', 900);
        prog.addStep('Koneksi SSH');
        prog.addStep('Deteksi OS');
        prog.addStep('Ambil konfigurasi SSH');
        prog.addStep('Cek status layanan SSH');
        prog.start();
        const sessData = { ...sess.data };
        clearSession(userId);
        jobs.runDetached(userId, async () => {
          let ssh = null;
          try {
            ssh = new SshSession({ host: sessData.ip, username: sessData.username, privateKey: sessData.privateKey, privateKeyPath: sessData.privateKeyPath });
            prog.setRunning(0);
            await ssh.connect();
            prog.setDone(0, 'ok');
            prog.setRunning(1);
            const os = await require('./lib/osDetect').detectOS(ssh);
            prog.setDone(1, `${os.id} ${os.versionId}`);
            prog.setRunning(2);
            const res = await ssh.exec('sshd -T 2>/dev/null | grep -E "^(port|passwordauthentication|permitrootlogin|pubkeyauthentication)"');
            prog.setDone(2, 'ok');
            prog.setRunning(3);
            const res2 = await ssh.exec('systemctl is-active ssh 2>/dev/null || systemctl is-active sshd 2>/dev/null || service ssh status 2>/dev/null | head -n1');
            prog.setDone(3, res2.stdout.trim().slice(0,20));
            await prog.finish(`📋 <b>Laporan Check VPS</b>

IP: ${sessData.ip}
User: ${sessData.username}
OS: ${os.id} ${os.versionId}
Config:
<pre>${res.stdout.slice(0,500)}</pre>
Service: ${res2.stdout.slice(0,100)}
`);
          } catch (e) {
            await prog.finish(`❌ Check gagal: ${validators.redactSecrets(e.message)}`);
          } finally {
            if (ssh) ssh.close();
          }
        });
        return;
      }
      if (sess.type === 'setup_vps') {
        sess.step = 'ask_password';
        setSession(userId, sess);
        const { text: pwText, keyboard } = ui.formatPasswordChoices(isOwner(userId), config);
        return safeReply(ctx, pwText, { reply_markup: keyboard });
      }
      if (sess.type === 'reinstall') {
        // Lanjut ke pilihan OS
        if (sess.data.osType === 'linux') {
          const text2 = `🐧 <b>Pilih Distro Linux</b>

Pilih OS yang akan diinstall (SEMUA DATA DIHAPUS!):`;
          const keyboard2 = {
            inline_keyboard: [
              [{ text: 'Debian 12', callback_data: 'reinstall:linux:debian:12' }, { text: 'Debian 13', callback_data: 'reinstall:linux:debian:13' }],
              [{ text: 'Ubuntu 22.04', callback_data: 'reinstall:linux:ubuntu:22.04' }, { text: 'Ubuntu 24.04', callback_data: 'reinstall:linux:ubuntu:24.04' }],
              [{ text: 'AlmaLinux 9', callback_data: 'reinstall:linux:almalinux:9' }, { text: 'Rocky Linux 9', callback_data: 'reinstall:linux:rocky:9' }],
              [{ text: '❌ Batal', callback_data: 'wiz:cancel' }]
            ]
          };
          return safeReply(ctx, text2, { reply_markup: keyboard2 });
        } else {
          // Windows
          const text2 = `🪟 <b>Pilih ISO Windows</b>

Pilih preset atau kirim link ISO sendiri:`;
          const keyboard2 = { inline_keyboard: [] };
          for (const p of config.WINDOWS_PRESETS) {
            keyboard2.inline_keyboard.push([{ text: p.label, callback_data: `reinstall:winpreset:${p.label}` }]);
          }
          keyboard2.inline_keyboard.push([{ text: '🔗 Link ISO sendiri', callback_data: 'reinstall:win:customiso' }]);
          keyboard2.inline_keyboard.push([{ text: '❌ Batal', callback_data: 'wiz:cancel' }]);
          return safeReply(ctx, text2, { reply_markup: keyboard2 });
        }
      }
    }

    // Setup VPS custom password
    if (sess.type === 'setup_vps' && sess.step === 'await_custom_password') {
      await tryDeleteUserMessage(ctx);
      const pw = text;
      const v = passwordLib.validateCustomPassword(pw);
      if (!v.valid) return safeReply(ctx, `❌ ${v.reason}`);
      sess.data.password = pw;
      sess.step = 'confirm';
      setSession(userId, sess);
      const confirmText = `🔐 <b>Konfirmasi Setup VPS</b>

IP: ${sess.data.ip}
User: ${sess.data.username}
Password: *** (akan ditampilkan setelah sukses)

Yakin lanjut?`;
      const keyboard = { inline_keyboard: [[{ text: '✅ Ya', callback_data: 'ssh:confirm' }], [{ text: '❌ Batal', callback_data: 'wiz:cancel' }]] };
      return safeReply(ctx, confirmText, { reply_markup: keyboard });
    }

    // Reinstall custom password
    if (sess.type === 'reinstall' && sess.step === 'await_custom_password') {
      await tryDeleteUserMessage(ctx);
      const pw = text;
      const isWin = sess.data.osType === 'windows';
      const validator = isWin ? passwordLib.validateWindowsPassword : passwordLib.validateCustomPassword;
      let v = validator(pw);
      if (!v.valid) {
        if (isWin) {
          // fallback ke acak dan beri catatan
          const randomPw = passwordLib.generateRandom(16, true);
          sess.data.password = randomPw;
          sess.data.passwordNote = `Password yang kamu ketik tidak aman untuk Windows (${v.reason}), jadi dipakai acak: ${randomPw}`;
          sess.step = 'confirm';
          setSession(userId, sess);
          return showReinstallConfirm(ctx, sess);
        }
        return safeReply(ctx, `❌ ${v.reason}`);
      }
      sess.data.password = pw;
      sess.step = 'confirm';
      setSession(userId, sess);
      return showReinstallConfirm(ctx, sess);
    }

    // Firewall IP input
    if (sess.type === 'firewall' && sess.step === 'await_ip') {
      const ipInput = text;
      if (!validators.isValidIPv4(ipInput) && !validators.isValidCIDR(ipInput)) {
        return safeReply(ctx, '❌ IPv4 atau CIDR tidak valid. Contoh: 203.0.113.5 atau 203.0.113.0/24');
      }
      sess.data.ipInput = ipInput;
      sess.step = 'confirm';
      setSession(userId, sess);
      try {
        const range = validators.cidrToRange(ipInput);
        const confirmText = `🛡 <b>Konfirmasi Kunci Firewall</b>

VPS: ${sess.data.serverUuid}
IP: ${ipInput}
Range: ${range.start} - ${range.end}

Aturan yang akan dibuat:
• accept tcp 22 dari ${range.start}-${range.end} (SSH)
• accept tcp 3389 dari ${range.start}-${range.end} (RDP)
• accept tcp 80 dari mana saja (Web)
• accept tcp 443 dari mana saja (Web TLS)
• default incoming drop
• firewall ON

⚠️ <b>Anti-terkunci:</b> Kalau IP salah, kamu tidak bisa SSH/RDP sampai firewall dimatikan lewat bot atau Console VNC. Perubahan bisa butuh 1-2 menit. Bot sendiri tidak bisa masuk saat firewall aktif.

Yakin?`;
        const keyboard = { inline_keyboard: [[{ text: '✅ Ya, kunci!', callback_data: 'fw:confirm' }], [{ text: '❌ Batal', callback_data: 'wiz:cancel' }]] };
        return safeReply(ctx, confirmText, { reply_markup: keyboard });
      } catch (e) {
        return safeReply(ctx, `❌ Error konversi CIDR: ${e.message}`);
      }
    }

    // Private key upload for setup/reinstall
    if ((sess.type === 'setup_vps' || sess.type === 'check_vps' || sess.type === 'reinstall') && sess.step === 'await_private_key') {
      // This is text handler, but private key might be pasted as text
      await tryDeleteUserMessage(ctx);
      if (!validators.isPrivateKey(text)) {
        // Could be file? handled in document handler
        return safeReply(ctx, '❌ Private key tidak valid (harus mengandung BEGIN PRIVATE KEY). Coba lagi atau /cancel');
      }
      if (text.length > 32*1024) {
        return safeReply(ctx, '❌ File terlalu besar (maks 32KB)');
      }
      if (/ENCRYPTED/.test(text)) {
        return safeReply(ctx, '❌ Private key ber-passphrase belum didukung. Buat key tanpa passphrase.');
      }
      sess.data.privateKey = text;
      sess.data.privateKeyPath = null;
      sess.step = 'await_ip';
      setSession(userId, sess);
      return safeReply(ctx, `✅ Private key diterima (disimpan di memori saja).

Sekarang kirim IP/host VPS.`);
    }

    // Reinstall custom ISO
    if (sess.type === 'reinstall' && sess.step === 'await_custom_iso') {
      await tryDeleteUserMessage(ctx);
      if (!validators.isValidIsoLink(text)) {
        return safeReply(ctx, '❌ Link ISO tidak valid (harus http/https). Coba lagi.');
      }
      sess.data.iso = text;
      sess.step = 'await_image_name';
      setSession(userId, sess);
      const keyboard = {
        inline_keyboard: [
          [{ text: 'Windows 11 Pro', callback_data: 'reinstall:image:Windows 11 Pro' }],
          [{ text: 'Windows 10 Pro', callback_data: 'reinstall:image:Windows 10 Pro' }],
          [{ text: 'Windows 11 Enterprise LTSC 2024', callback_data: 'reinstall:image:Windows 11 Enterprise LTSC 2024' }],
          [{ text: '✏️ Ketik manual', callback_data: 'reinstall:image:custom' }]
        ]
      };
      return safeReply(ctx, `✅ ISO diterima.

Sekarang pilih atau ketik <b>nama edisi</b> (image-name) untuk Windows.`, { reply_markup: keyboard });
    }

    if (sess.type === 'reinstall' && sess.step === 'await_image_name_custom') {
      if (!validators.isValidImageName(text)) {
        return safeReply(ctx, '❌ Nama edisi tidak valid (^[A-Za-z0-9][A-Za-z0-9 .()_+-]{2,79}$). Coba lagi.');
      }
      sess.data.imageName = text;
      sess.step = 'ask_password';
      setSession(userId, sess);
      const { text: pwText, keyboard } = ui.formatPasswordChoices(isOwner(userId), config);
      return safeReply(ctx, `✅ Image name: ${text}\n\n` + pwText, { reply_markup: keyboard });
    }

    return next();
  });

  bot.on('document', async (ctx, next) => {
    const sess = getSession(ctx.from.id);
    if (!sess) return next();
    if ((sess.type === 'setup_vps' || sess.type === 'check_vps' || sess.type === 'reinstall') && sess.step === 'await_private_key') {
      const doc = ctx.message.document;
      if (doc.file_size > 32*1024) {
        await tryDeleteUserMessage(ctx);
        return safeReply(ctx, '❌ File terlalu besar (maks 32KB)');
      }
      try {
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const res = await fetch(fileLink.href);
        const txt = await res.text();
        await tryDeleteUserMessage(ctx);
        if (!validators.isPrivateKey(txt)) {
          return safeReply(ctx, '❌ File bukan private key valid.');
        }
        if (/ENCRYPTED/.test(txt)) {
          return safeReply(ctx, '❌ Private key ber-passphrase belum didukung.');
        }
        sess.data.privateKey = txt;
        sess.data.privateKeyPath = null;
        sess.step = 'await_ip';
        setSession(ctx.from.id, sess);
        return safeReply(ctx, `✅ Private key dari file diterima.

Sekarang kirim IP/host VPS.`);
      } catch (e) {
        await tryDeleteUserMessage(ctx);
        return safeReply(ctx, `❌ Gagal baca file: ${e.message}`);
      }
    }
    return next();
  });

  // Helper for reinstall confirm
  async function showReinstallConfirm(ctx, sess) {
    const ip = sess.data.ip;
    const user = sess.data.username;
    const osType = sess.data.osType;
    let osInfo = '';
    if (osType === 'linux') {
      osInfo = `${sess.data.distro} ${sess.data.version}`;
    } else {
      // Windows: host + filename without query/token
      try {
        const u = new URL(sess.data.iso);
        const host = u.hostname;
        const filename = u.pathname.split('/').pop() || 'windows.iso';
        osInfo = `${sess.data.osLabel || 'Windows'} - ${host}/${filename} (tanpa token) - Image: ${sess.data.imageName}`;
      } catch {
        osInfo = `${sess.data.iso} - ${sess.data.imageName}`;
      }
    }
    const pwNote = sess.data.passwordNote ? `\n\n⚠️ ${sess.data.passwordNote}` : '';
    const text = `💿 <b>Konfirmasi Install/Reinstall OS</b>

IP: <code>${ip}</code>
User: <code>${user}</code>
OS: ${osInfo}
Password: ${sess.data.passwordChoice === 'random' ? 'acak (akan ditampilkan)' : '***'}

⚠️ <b>SEMUA DATA DI VPS INI AKAN DIHAPUS PERMANEN!</b>

Yakin lanjut?${pwNote}`;
    const keyboard = { inline_keyboard: [[{ text: '✅ Ya, install!', callback_data: 'reinstall:confirm' }], [{ text: '❌ Batal', callback_data: 'wiz:cancel' }]] };
    if (ctx.callbackQuery) await safeEdit(ctx, text, { reply_markup: keyboard });
    else await safeReply(ctx, text, { reply_markup: keyboard });
  }

  bot.action(/reinstall:win:customiso/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'reinstall') return;
    sess.step = 'await_custom_iso';
    setSession(ctx.from.id, sess);
    await safeEdit(ctx, `🔗 <b>Kirim Link ISO Windows</b>

Kirim link langsung ISO (http/https). Pesan akan dihapus.

Contoh: https://example.com/win.iso

Ketik /cancel untuk batal.`);
  });

  bot.action(/reinstall:image:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'reinstall') return;
    const img = ctx.match[1];
    if (img === 'custom') {
      sess.step = 'await_image_name_custom';
      setSession(ctx.from.id, sess);
      await safeEdit(ctx, `✏️ Ketik nama edisi manual (regex ^[A-Za-z0-9][A-Za-z0-9 .()_+-]{2,79}$).\nContoh: Windows 11 Pro`);
    } else {
      sess.data.imageName = img;
      sess.step = 'ask_password';
      setSession(ctx.from.id, sess);
      const { text, keyboard } = ui.formatPasswordChoices(isOwner(ctx.from.id), config);
      await safeEdit(ctx, `✅ Image name: ${img}\n\n` + text, { reply_markup: keyboard });
    }
  });

  // Reinstall confirm execution
  bot.action(/reinstall:confirm/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'reinstall') return ctx.answerCbQuery('Sesi tidak berlaku', { show_alert: true });
    // Quota
    const q = quota.canUse(ctx.from.id, 'reinstall', config.REINSTALL_DAILY_LIMIT || 1, isOwner(ctx.from.id));
    if (!q.allowed) {
      return safeEdit(ctx, `⚠️ Kuota reinstall harian habis (${config.REINSTALL_DAILY_LIMIT}/hari). Reset 00:00 UTC.`);
    }
    if (config.REINSTALL_OWNER_ONLY && !isOwner(ctx.from.id)) {
      return safeEdit(ctx, '🔒 Reinstall hanya untuk owner.');
    }
    const can = jobs.canStart(ctx.from.id);
    if (!can.allowed) {
      const msg = can.reason === 'user_busy' ? 'Kamu masih punya job aktif.' : 'Server bot sedang sibuk, coba lagi sebentar.';
      return ctx.answerCbQuery(msg, { show_alert: true });
    }
    const chatId = ctx.chat.id;
    const msg = await ctx.telegram.sendMessage(chatId, `💿 Memulai reinstall ${sess.data.ip}...`);
    const prog = new LiveProgress({ telegram: ctx.telegram }, chatId, msg.message_id, '💿 Reinstall OS', 900);
    prog.addStep('Koneksi SSH & preflight');
    prog.addStep('Download reinstall.sh');
    prog.addStep('Tes link ISO (jika Windows)');
    prog.addStep('Jalankan reinstall.sh detached');
    prog.addStep('Tunggu reboot');
    prog.addStep('Tunggu OS baru siap');
    prog.start();

    const sessData = { ...sess.data };
    clearSession(ctx.from.id);

    jobs.runDetached(ctx.from.id, async () => {
      let ssh = null;
      try {
        ssh = new SshSession({ host: sessData.ip, username: sessData.username, privateKey: sessData.privateKey, privateKeyPath: sessData.privateKeyPath });
        prog.setRunning(0);
        await ssh.connect();
        const pre = await reinstallFlow.preflight(ssh, prog);
        prog.setDone(0, `${pre.arch}, ${pre.ramDisk.slice(0,20)}`);
        prog.setRunning(1);
        await reinstallFlow.downloadReinstallSh(ssh);
        prog.setDone(1, 'ok');
        // Tes ISO jika Windows
        if (sessData.osType === 'windows') {
          prog.setRunning(2, 'tes link');
          const ok = await reinstallFlow.testIsoLinkFromVps(ssh, sessData.iso);
          if (!ok) throw new Error(`Link ISO tidak bisa diakses dari VPS (harus 200/206). Cek link: ${sessData.iso.slice(0,50)}`);
          prog.setDone(2, '200/206 ok');
        } else {
          prog.setDone(2, 'skip (linux)');
        }
        prog.setRunning(3);
        let args = '';
        if (sessData.osType === 'linux') {
          args = reinstallFlow.buildLinuxArgs(sessData.distro, sessData.version, sessData.password);
        } else {
          args = reinstallFlow.buildWindowsArgs(sessData.iso, sessData.imageName, sessData.password);
        }
        const runRes = await reinstallFlow.runReinstallSh(ssh, args, prog);
        prog.setDone(3, 'exit 0');
        prog.setRunning(4, 'reboot');
        // Kirim reboot
        try {
          await ssh.exec('reboot');
        } catch {}
        ssh.close();
        ssh = null;
        prog.setDone(4, 'reboot dikirim');
        quota.use(ctx.from.id, 'reinstall');
        stats.inc('reinstallStarted');

        // Tunggu OS baru
        prog.setRunning(5, 'polling...');
        prog.tickMs = 20000;
        prog.start(); // restart with longer tick
        if (sessData.osType === 'linux') {
          const factory = async (pw) => new SshSession({ host: sessData.ip, username: 'root', password: pw });
          const waitRes = await reinstallFlow.waitForLinux(factory, sessData.password, sessData.distro === 'debian' ? 'debian' : sessData.distro === 'ubuntu' ? 'ubuntu' : sessData.distro, pre.bootId, 40*60*1000);
          if (waitRes.success) {
            prog.setDone(5, `Linux ${waitRes.id} siap`);
            await prog.finish(`✅ <b>Reinstall Linux Berhasil</b>

IP: <code>${sessData.ip}</code>
OS: ${sessData.distro} ${sessData.version}
User: root
Password: <code>${sessData.password}</code>

Cara login: <code>ssh root@${sessData.ip}</code>
`);
          } else {
            throw new Error(`Timeout tunggu Linux: ${waitRes.error}`);
          }
        } else {
          // Windows: tunggu RDP
          const checkFn = () => checkPortOpen(sessData.ip, 3389, 3000);
          const waitRes = await reinstallFlow.waitForRdp(checkFn, 45*60*1000);
          if (waitRes.success) {
            prog.setDone(5, 'RDP terbuka');
            await prog.finish(`✅ <b>Reinstall Windows Berhasil</b>

IP: <code>${sessData.ip}:3389</code>
User: Administrator
Password: <code>${sessData.password}</code>
OS: ${sessData.osLabel}
Image: ${sessData.imageName}

Cara login: aplikasi Remote Desktop ke ${sessData.ip}:3389

⚠️ Ganti password setelah login!
`);
          } else {
            throw new Error(`Timeout tunggu RDP: ${waitRes.error}`);
          }
        }
      } catch (e) {
        stats.inc('reinstallFailed');
        prog.setFail(5, e.message.slice(0,42));
        await prog.finish(`❌ <b>Reinstall Gagal</b>

Error: ${validators.redactSecrets(e.message)}

Jika VPS macet, gunakan 🖥 Console (VNC) di menu Kelola VPS untuk pulihkan.
`);
      } finally {
        if (ssh) ssh.close();
      }
    });
  });

  // Firewall confirm
  bot.action(/fw:confirm/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'firewall') return;
    const accId = sess.data.accountId;
    const uuid = sess.data.serverUuid;
    const ipInput = sess.data.ipInput;
    if (!vault.isOwner(ctx.from.id, accId)) return;
    try {
      const range = validators.cidrToRange(ipInput);
      const token = vault.getDecryptedToken(ctx.from.id, accId);
      const client = new UpCloudClient(token);
      const rules = [
        { action: 'accept', direction: 'in', family: 'IPv4', protocol: 'tcp', destination_port_start: '22', destination_port_end: '22', source_address_start: range.start, source_address_end: range.end, comment: 'SSH dari IP saya' },
        { action: 'accept', direction: 'in', family: 'IPv4', protocol: 'tcp', destination_port_start: '3389', destination_port_end: '3389', source_address_start: range.start, source_address_end: range.end, comment: 'RDP dari IP saya' },
        { action: 'accept', direction: 'in', family: 'IPv4', protocol: 'tcp', destination_port_start: '80', destination_port_end: '80', comment: 'Web' },
        { action: 'accept', direction: 'in', family: 'IPv4', protocol: 'tcp', destination_port_start: '443', destination_port_end: '443', comment: 'Web TLS' }
      ];
      await client.setFirewallRules(uuid, rules);
      await client.setFirewallStatus(uuid, true, 'drop');
      await safeEdit(ctx, `✅ Firewall dikunci ke ${ipInput} (${range.start}-${range.end}) untuk SSH/RDP. Perubahan bisa butuh 1-2 menit.`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: `srv:${accId}:${uuid}` }]] } });
      clearSession(ctx.from.id);
    } catch (e) {
      const c = new UpCloudClient('');
      await safeEdit(ctx, `❌ Gagal set firewall: ${c.translateError(e)}`);
    }
  });

  // Firewall off
  bot.action(/srvact:([a-f0-9]{6}):([a-f0-9-]{36}):fw:off/, async (ctx) => {
    await ctx.answerCbQuery();
    const accId = ctx.match[1];
    const uuid = ctx.match[2];
    if (!vault.isOwner(ctx.from.id, accId)) return;
    try {
      const token = vault.getDecryptedToken(ctx.from.id, accId);
      const client = new UpCloudClient(token);
      await client.setFirewallStatus(uuid, false);
      await safeEdit(ctx, `✅ Firewall dimatikan untuk VPS ${uuid}.`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: `srv:${accId}:${uuid}` }]] } });
    } catch (e) {
      const c = new UpCloudClient('');
      await safeEdit(ctx, `❌ Gagal matikan firewall: ${c.translateError(e)}`);
    }
  });
  // Handle fw off callback with space (legacy)
  bot.action(/srvact:([a-f0-9]{6}):([a-f0-9-]{36}):fw off/, async (ctx) => {
    await ctx.answerCbQuery();
    const accId = ctx.match[1];
    const uuid = ctx.match[2];
    if (!vault.isOwner(ctx.from.id, accId)) return;
    try {
      const token = vault.getDecryptedToken(ctx.from.id, accId);
      const client = new UpCloudClient(token);
      await client.setFirewallStatus(uuid, false);
      await safeEdit(ctx, `✅ Firewall dimatikan untuk VPS ${uuid}.`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: `srv:${accId}:${uuid}` }]] } });
    } catch (e) {
      const c = new UpCloudClient('');
      await safeEdit(ctx, `❌ Gagal matikan firewall: ${c.translateError(e)}`);
    }
  });

  // Rebuild official confirm
  bot.action(/rebuild:confirm/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'rebuild') return ctx.answerCbQuery('Sesi tidak berlaku', { show_alert: true });
    const can = jobs.canStart(ctx.from.id);
    if (!can.allowed) {
      const msg = can.reason === 'user_busy' ? 'Kamu masih punya job aktif.' : 'Server bot sedang sibuk, coba lagi sebentar.';
      return ctx.answerCbQuery(msg, { show_alert: true });
    }
    const chatId = ctx.chat.id;
    const msg = await ctx.telegram.sendMessage(chatId, `🔁 Reinstall resmi ${sess.data.serverUuid}...`);
    const prog = new LiveProgress({ telegram: ctx.telegram }, chatId, msg.message_id, '🔁 Reinstall Resmi', 900);
    prog.addStep('Ambil detail VPS & boot disk');
    prog.addStep('Stop VPS');
    prog.addStep('Set metadata (jika cloud-init)');
    prog.addStep('Rebuild OS');
    prog.addStep('Tunggu state bukan maintenance');
    prog.addStep('Start VPS (jika perlu)');
    prog.addStep('Tunggu SSH & setup password');
    prog.addStep('Cek disk sisa');
    prog.start();

    const sessData = { ...sess.data };
    clearSession(ctx.from.id);

    jobs.runDetached(ctx.from.id, async () => {
      try {
        const token = vault.getDecryptedToken(ctx.from.id, sessData.accountId);
        const client = new UpCloudClient(token);

        prog.setRunning(0);
        const srvDetail = await client.getServer(sessData.serverUuid);
        const storageDevices = srvDetail.storage_devices ? (Array.isArray(srvDetail.storage_devices.storage_device) ? srvDetail.storage_devices.storage_device : [srvDetail.storage_devices.storage_device]) : [];
        const bootDisk = storageDevices.find(d => d.boot_disk === '1' && d.type === 'disk');
        if (!bootDisk) throw new Error('Boot disk tidak ditemukan');
        const oldDiskUuid = bootDisk.storage;
        prog.setDone(0, `old disk ${oldDiskUuid.slice(0,8)}`);

        // Stop if not stopped
        prog.setRunning(1);
        if (srvDetail.state !== 'stopped') {
          await client.stopServer(sessData.serverUuid, 'soft').catch(()=>{});
          try {
            await waitForServerState(client, sessData.serverUuid, 'stopped', 2*60*1000);
          } catch {
            await client.stopServer(sessData.serverUuid, 'hard').catch(()=>{});
            await waitForServerState(client, sessData.serverUuid, 'stopped', 2*60*1000);
          }
          prog.setDone(1, 'stopped');
        } else {
          prog.setDone(1, 'sudah stopped');
        }

        // Metadata if cloud-init
        prog.setRunning(2);
        if (sessData.osIsCloudInit) {
          await client.setMetadata(sessData.serverUuid, true).catch(()=>{});
          prog.setDone(2, 'metadata yes');
        } else {
          prog.setDone(2, 'skip (native)');
        }

        // Rebuild
        prog.setRunning(3);
        const rebuildPayload = {
          server_rebuild: {
            clone_source: sessData.osTemplateUuid,
            storage_title: `${srvDetail.title}-disk`,
            detach_disk: oldDiskUuid,
            delete_detached_disk: 'yes',
            password_delivery: 'none',
            login_user: {
              username: 'root',
              create_password: 'no',
              ssh_keys: { ssh_key: [sessData.loginMode === 'password' ? botPublicKey : sessData.publicKey || botPublicKey] }
            }
          }
        };
        await client.rebuildServer(sessData.serverUuid, rebuildPayload);
        prog.setDone(3, 'rebuild dikirim');

        prog.setRunning(4);
        // Tunggu bukan maintenance
        const startWait = Date.now();
        while (Date.now() - startWait < 5*60*1000) {
          const s = await client.getServer(sessData.serverUuid);
          if (s.state !== 'maintenance') break;
          await new Promise(r=>setTimeout(r,5000));
        }
        prog.setDone(4, 'bukan maintenance');

        prog.setRunning(5);
        const srvAfter = await client.getServer(sessData.serverUuid);
        if (srvAfter.state === 'stopped') {
          await client.startServer(sessData.serverUuid);
          await waitForServerState(client, sessData.serverUuid, 'started', 3*60*1000);
          prog.setDone(5, 'started');
        } else {
          // Tunggu started
          await waitForServerState(client, sessData.serverUuid, 'started', 3*60*1000).catch(()=>{});
          prog.setDone(5, srvAfter.state);
        }

        // Tunggu SSH
        prog.setRunning(6);
        let serverIp = null;
        for (let i=0;i<12;i++) {
          const s = await client.getServer(sessData.serverUuid);
          const ips = s.ip_addresses ? (Array.isArray(s.ip_addresses.ip_address) ? s.ip_addresses.ip_address : [s.ip_addresses.ip_address]) : [];
          const v4 = ips.find(x=>x.access==='public' && x.family==='IPv4');
          if (v4) { serverIp = v4.address; break; }
          await new Promise(r=>setTimeout(r,5000));
        }
        if (!serverIp) throw new Error('Gagal dapat IP setelah rebuild');
        const portOpen = await waitForPort(serverIp, 22, 3*60*1000);
        if (!portOpen) throw new Error('Timeout tunggu port 22 setelah rebuild');

        if (sessData.loginMode === 'password') {
          const sshOk = await waitForSsh(serverIp, 22, 'root', botKeyPair.privPath, null, 2*60*1000);
          if (!sshOk) throw new Error('Gagal SSH dengan key bot setelah rebuild');
          const ssh = new SshSession({ host: serverIp, username: 'root', privateKeyPath: botKeyPair.privPath });
          await ssh.connect();
          const setupRes = await setupVpsFlow({ sshSession: ssh, targetUsername: 'root', password: sessData.password, isRootUser: true, progress: prog });
          if (!setupRes.success) {
            ssh.close();
            throw new Error(`Setup password gagal setelah rebuild: ${setupRes.error}. Key bot masih ada.`);
          }
          // Tes login password
          const sshPw = new SshSession({ host: serverIp, username: 'root', password: sessData.password });
          await sshPw.connect();
          await sshPw.exec('whoami');
          sshPw.close();
          // Hapus key bot
          const delCmd = `sed -i '/upcloud-ssh-bot/d' /root/.ssh/authorized_keys; echo ok`;
          await ssh.exec(delCmd);
          ssh.close();
          prog.setDone(6, 'password ok & key dihapus');
        } else {
          prog.setDone(6, 'skip (key mode)');
        }

        prog.setRunning(7);
        const finalSrv = await client.getServer(sessData.serverUuid);
        const finalDevices = finalSrv.storage_devices ? (Array.isArray(finalSrv.storage_devices.storage_device) ? finalSrv.storage_devices.storage_device : [finalSrv.storage_devices.storage_device]) : [];
        const diskCount = finalDevices.filter(d=>d.type==='disk').length;
        let extraNote = '';
        if (diskCount > 1) extraNote = `\n\n⚠️ Ada ${diskCount} disk di VPS ini, mungkin ada disk sisa yang ditagih. Cek di panel UpCloud.`;
        prog.setDone(7, `${diskCount} disk`);

        await prog.finish(`✅ <b>Reinstall Resmi Berhasil</b>

VPS: ${finalSrv.title}
UUID: ${sessData.serverUuid}
IP: <code>${serverIp}</code>
OS: ${sessData.osTitle}
${sessData.loginMode === 'password' ? `Password: <code>${sessData.password}</code>` : 'Login: SSH key'}
${extraNote}
`);
        stats.inc('deploySuccess');
      } catch (e) {
        const c = new UpCloudClient('');
        prog.setFail(7, e.message.slice(0,42));
        await prog.finish(`❌ <b>Reinstall Resmi Gagal</b>

Error: ${c.translateError(e) || validators.redactSecrets(e.message)}

VPS mungkin masih ada dan ditagih. Cek di Kelola VPS.
`);
        stats.inc('deployFail');
      }
    });
  });

  // Rebuild password & pubkey flows (text handlers extension)
  // These are handled in generic text handler but need confirm steps
  bot.action(/rebuild:pw:(random|custom|default)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'rebuild') return;
    const choice = ctx.match[1];
    if (choice === 'random') {
      sess.data.password = passwordLib.generateRandom(16, false);
      sess.data.passwordChoice = 'random';
      sess.step = 'confirm';
      setSession(ctx.from.id, sess);
      const text = `🔁 <b>Konfirmasi Rebuild</b>

VPS: ${sess.data.serverUuid}
OS: ${sess.data.osTitle}
Login: password acak
Password: akan ditampilkan

⚠️ SEMUA DATA DIHAPUS PERMANEN!

Yakin?`;
      await safeEdit(ctx, text, { reply_markup: { inline_keyboard: [[{ text: '✅ Ya, rebuild', callback_data: 'rebuild:confirm' }], [{ text: '❌ Batal', callback_data: 'wiz:cancel' }]] } });
    } else if (choice === 'custom') {
      sess.step = 'await_custom_password';
      setSession(ctx.from.id, sess);
      await safeEdit(ctx, 'Ketik password custom (akan dihapus).');
    } else {
      if (!isOwner(ctx.from.id) && !config.DEFAULT_PASSWORD_FOR_EVERYONE) return ctx.answerCbQuery('Hanya owner', { show_alert: true });
      sess.data.password = config.DEFAULT_PASSWORD;
      sess.step = 'confirm';
      setSession(ctx.from.id, sess);
      await safeEdit(ctx, `🔁 Konfirmasi rebuild dengan password default.\n\nYakin?`, { reply_markup: { inline_keyboard: [[{ text: '✅ Ya', callback_data: 'rebuild:confirm' }], [{ text: '❌ Batal', callback_data: 'wiz:cancel' }]] } });
    }
  });


  // Create VPS confirm
  bot.action(/wiz:confirm:create/, async (ctx) => {
    await ctx.answerCbQuery();
    const sess = getSession(ctx.from.id);
    if (!sess || sess.type !== 'create_vps') return ctx.answerCbQuery('Sesi tidak berlaku', { show_alert: true });
    const can = jobs.canStart(ctx.from.id);
    if (!can.allowed) {
      const msg = can.reason === 'user_busy' ? 'Kamu masih punya job aktif.' : 'Server bot sedang sibuk, coba lagi sebentar.';
      return ctx.answerCbQuery(msg, { show_alert: true });
    }
    const chatId = ctx.chat.id;
    const msg = await ctx.telegram.sendMessage(chatId, `🚀 Membuat VPS ${sess.data.serverName}...`);
    const prog = new LiveProgress({ telegram: ctx.telegram }, chatId, msg.message_id, '🚀 Buat VPS', 900);
    prog.addStep('Buat server di UpCloud');
    prog.addStep('Tunggu state started');
    prog.addStep('Tunggu port 22');
    prog.addStep('Setup password (jika mode password)');
    prog.addStep('Tes login password');
    prog.addStep('Hapus key bot');
    prog.start();

    const sessData = { ...sess.data };
    clearSession(ctx.from.id);

    jobs.runDetached(ctx.from.id, async () => {
      let createdServerUuid = null;
      let createdServerIp = null;
      try {
        const token = vault.getDecryptedToken(ctx.from.id, sessData.accountId);
        const client = new UpCloudClient(token);
        // Get plan & template details
        const plans = await client.getPlans();
        const plan = plans.find(p=>p.name===sessData.plan);
        if (!plan) throw new Error(`Plan ${sessData.plan} tidak ditemukan`);
        const allTemplates = await client.getAllTemplatesIncludingWindows();
        const tpl = allTemplates.find(t=>t.uuid===sessData.osTemplateUuid);
        if (!tpl) throw new Error('Template tidak ditemukan');
        const size = Math.max(plan.storage_size || 25, tpl.size || 25);
        const tier = plan.storage_tier || 'maxiops';

        prog.setRunning(0, 'POST /server');
        // Payload emas
        const payload = {
          server: {
            zone: sessData.zone,
            title: sessData.serverName,
            hostname: sessData.serverName,
            plan: sessData.plan,
            password_delivery: 'none',
            login_user: {
              username: 'root',
              create_password: 'no',
              ssh_keys: { ssh_key: [sessData.loginMode === 'password' ? botPublicKey : sessData.publicKey] }
            },
            storage_devices: {
              storage_device: [{
                action: 'clone',
                storage: sessData.osTemplateUuid,
                title: `${sessData.serverName}-disk`,
                size: size,
                tier: tier
              }]
            }
          }
        };
        // IPv6 on/off (default IPv4 only)
        const ipVer = sessData.ipVersion || 'ipv4';
        if (ipVer === 'ipv4') {
          // Default: hanya IPv4 publik (paling kompatibel, biaya rendah)
          payload.server.ip_addresses = {
            ip_address: [
              { access: 'public', family: 'IPv4' }
            ]
          };
        } else {
          // Dual stack: IPv4 + IPv6 publik
          payload.server.ip_addresses = {
            ip_address: [
              { access: 'public', family: 'IPv4' },
              { access: 'public', family: 'IPv6' }
            ]
          };
        }
        if (tpl.template_type === 'cloud-init') {
          payload.server.metadata = 'yes';
        }
        const createRes = await client.createServer(payload);
        createdServerUuid = createRes.server?.uuid || createRes.uuid;
        if (!createdServerUuid) throw new Error('Gagal dapat UUID server setelah create');
        prog.setDone(0, `UUID ${createdServerUuid.slice(0,8)}...`);

        prog.setRunning(1, 'tunggu started');
        const srvStarted = await waitForServerState(client, createdServerUuid, 'started', 5*60*1000);
        prog.setDone(1, 'started');

        // Get IP
        let ip = null;
        for (let i=0;i<12;i++) {
          const srv = await client.getServer(createdServerUuid);
          const ips = srv.ip_addresses ? (Array.isArray(srv.ip_addresses.ip_address) ? srv.ip_addresses.ip_address : [srv.ip_addresses.ip_address]) : [];
          const v4 = ips.filter(x=>x.access==='public' && x.family==='IPv4')[0];
          if (v4) { ip = v4.address; break; }
          await new Promise(r=>setTimeout(r, 5000));
        }
        if (!ip) throw new Error('Gagal dapat IPv4 publik setelah started');
        createdServerIp = ip;

        prog.setRunning(2, `tunggu 22 di ${ip}`);
        const portOpen = await waitForPort(ip, 22, 5*60*1000);
        if (!portOpen) throw new Error('Timeout tunggu port 22');
        prog.setDone(2, '22 terbuka');

        if (sessData.loginMode === 'password') {
          prog.setRunning(3, 'setup password');
          // Tunggu SSH dengan key bot
          const sshOk = await waitForSsh(ip, 22, 'root', botKeyPair.privPath, null, 3*60*1000);
          if (!sshOk) throw new Error('Gagal SSH dengan key bot');
          const ssh = new SshSession({ host: ip, username: 'root', privateKeyPath: botKeyPair.privPath });
          await ssh.connect();
          // Setup flow
          const setupRes = await setupVpsFlow({ sshSession: ssh, targetUsername: 'root', password: sessData.password, isRootUser: true, progress: prog });
          // prog steps for setup are inside setupFlow, but we have our own steps. We'll map
          if (!setupRes.success) {
            ssh.close();
            throw new Error(`Setup password gagal: ${setupRes.error}. VPS sudah ada dan ditagih! IP: ${ip}. Key bot masih ada, kamu bisa coba setup manual lewat menu 🔐 Aktifkan Password.`);
          }
          prog.setDone(3, 'password ok');

          prog.setRunning(4, 'tes login password');
          // Tes login dengan password
          const sshPw = new SshSession({ host: ip, username: 'root', password: sessData.password });
          try {
            await sshPw.connect();
            const res = await sshPw.exec('whoami');
            sshPw.close();
            if (!res.stdout.includes('root')) throw new Error('whoami bukan root');
            prog.setDone(4, 'login ok');
          } catch (e) {
            ssh.close();
            throw new Error(`Tes login password gagal: ${e.message}. VPS sudah ada dan ditagih! IP: ${ip}. Key bot masih ada, jangan hapus! Coba setup ulang.`);
          }

          prog.setRunning(5, 'hapus key bot');
          // Hapus public key bot dari authorized_keys
          const delCmd = `sed -i '/upcloud-ssh-bot/d' /root/.ssh/authorized_keys 2>/dev/null; sed -i '/${botPublicKey.split(' ')[1].slice(0,20)}/d' /root/.ssh/authorized_keys 2>/dev/null; echo ok`;
          const delRes = await ssh.exec(delCmd);
          ssh.close();
          prog.setDone(5, 'key bot dihapus');

          await prog.finish(`✅ <b>VPS Berhasil Dibuat!</b>

IP: <code>${ip}</code>
User: root
Password: <code>${sessData.password}</code>
OS: ${sessData.osTitle}
Zona: ${sessData.zone}
Plan: ${sessData.plan}
UUID: <code>${createdServerUuid}</code>

Cara login: <code>ssh root@${ip}</code>

⚠️ <b>Biaya:</b> VPS ditagih per jam sampai dihapus. Hapus via 🖥 Kelola VPS kalau tidak dipakai.

${sessData.passwordNote || ''}
`);
          stats.inc('deploySuccess');
        } else {
          // SSH key mode
          prog.setDone(3, 'skip (key mode)');
          prog.setDone(4, 'skip');
          prog.setDone(5, 'skip');
          await prog.finish(`✅ <b>VPS Berhasil Dibuat (SSH Key)!</b>

IP: <code>${ip}</code>
User: root
OS: ${sessData.osTitle}
Zona: ${sessData.zone}
Plan: ${sessData.plan}
UUID: <code>${createdServerUuid}</code>

Cara login: <code>ssh root@${ip}</code> (pakai private key yang sesuai dengan public key yang kamu kirim)

⚠️ Biaya per jam sampai dihapus.
`);
          stats.inc('deploySuccess');
        }

      } catch (e) {
        stats.inc('deployFail');
        const c = new UpCloudClient('');
        let extra = '';
        if (createdServerUuid) {
          extra = `\n\n⚠️ <b>VPS sudah terbuat dan ditagih!</b>\nUUID: ${createdServerUuid}\nIP: ${createdServerIp || 'belum dapat'}\n\nLangkah lanjutan:\n• Cek di 🖥 Kelola VPS\n• Jika gagal setup password, coba menu 🔑 Aktifkan Password dengan IP ${createdServerIp}\n• Hapus VPS kalau tidak jadi pakai (biar tidak ditagih)`;
        }
        prog.setFail(0, e.message.slice(0,42));
        await prog.finish(`❌ <b>Gagal Buat VPS</b>

Error: ${c.translateError(e) || validators.redactSecrets(e.message)}${extra}
`);
      }
    });
  });

  // Start bot
  bot.launch().then(() => {
    console.log('✅ Bot Telegram UpCloud VPS Manager berjalan!');
  }).catch(err => {
    console.error('❌ Gagal launch bot:', err);
    process.exit(1);
  });

  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

init().catch(e => {
  console.error('Fatal init error:', e);
  process.exit(1);
});
