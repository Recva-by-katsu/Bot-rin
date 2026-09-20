/**
 * ui/manager.js - UI helper untuk Manajer Akun UpCloud
 */

function mainMenu() {
  const text = `👋 <b>Selamat datang di UpCloud VPS Manager!</b>

Bot ini membantumu membuat & kelola VPS UpCloud, bahkan kalau kamu masih pemula.

Pilih menu di bawah:

👤 <b>Manajer Akun</b> - Kelola akun UpCloud, buat VPS, cek tagihan
🔐 <b>Aktifkan Password</b> - Setup password VPS Ubuntu/Debian
💿 <b>Install/Reinstall OS</b> - Ganti OS ke Linux/Windows via reinstall.sh

Ketik /bantuan untuk panduan lengkap.`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '👤 Manajer Akun', callback_data: 'menu:accounts' }],
      [{ text: '🔐 Aktifkan Password', callback_data: 'menu:ssh' }],
      [{ text: '💿 Install/Reinstall OS', callback_data: 'menu:os' }],
      [{ text: '📖 Panduan Pemula', callback_data: 'guide:0' }, { text: '🌐 IP Bot', callback_data: 'menu:ip' }]
    ]
  };
  return { text, keyboard };
}

function providerMenu() {
  const text = `👤 <b>Manajer Akun</b>

Pilih provider:

☁️ <b>UpCloud</b> - Buat & kelola VPS UpCloud (saat ini tersedia)
➕ Provider lain akan ditambah nanti.

Klik 📖 Panduan Pemula kalau baru pertama kali pakai.`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '☁️ UpCloud', callback_data: 'mgr:upcloud' }],
      [{ text: '📖 Panduan Pemula', callback_data: 'guide:0' }],
      [{ text: '⬅️ Kembali', callback_data: 'menu:main' }]
    ]
  };
  return { text, keyboard };
}

function accountsMenu(accounts, botIp) {
  let text = `☁️ <b>Akun UpCloud-mu</b>

Kamu punya <b>${accounts.length}</b> akun tersimpan.

Pilih akun untuk kelola, atau tambah akun baru.

💡 <b>Token disimpan terenkripsi</b> di server bot. Pemilik bot secara teknis bisa mengaksesnya, jadi buat token khusus dengan masa berlaku pendek & batasi IP ke IP bot kalau bisa.

🌐 IP Bot: <code>${botIp || 'deteksi...'}</code>
`;
  if (accounts.length === 0) {
    text += `\nBelum ada akun. Klik ➕ Tambah Akun untuk mulai.`;
  }
  const keyboard = { inline_keyboard: [] };
  for (const acc of accounts) {
    keyboard.inline_keyboard.push([{ text: `🔑 ${acc.label} (${acc.username})`, callback_data: `mgr:acc:${acc.id}` }]);
  }
  keyboard.inline_keyboard.push([{ text: '➕ Tambah Akun (API Token)', callback_data: 'mgr:upcloud:add' }]);
  keyboard.inline_keyboard.push([{ text: '🔐 Cek API (semua akun)', callback_data: 'mgr:upcloud:checkall' }]);
  keyboard.inline_keyboard.push([{ text: '📖 Panduan', callback_data: 'guide:1' }, { text: '🗑 Hapus Data Saya', callback_data: 'mgr:upcloud:deleteall' }]);
  keyboard.inline_keyboard.push([{ text: '⬅️ Kembali', callback_data: 'menu:accounts' }]);
  return { text, keyboard };
}

function accountDetailMenu(account) {
  const text = `🔑 <b>Akun: ${account.label}</b>
Username: <code>${account.username}</code>
ID: <code>${account.id}</code>
Provider: UpCloud

Pilih aksi:`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '➕ Buat VPS', callback_data: `mgr:acc:${account.id}:create` }],
      [{ text: '🖥 Kelola VPS', callback_data: `mgr:acc:${account.id}:list` }],
      [{ text: '💰 Tagihan & Saldo', callback_data: `mgr:acc:${account.id}:billing` }],
      [{ text: '🔐 Cek Akun Ini', callback_data: `mgr:acc:${account.id}:check` }],
      [{ text: '🛡 Firewall', callback_data: `mgr:acc:${account.id}:fwlist` }],
      [{ text: '🗑 Hapus Akun dari Bot', callback_data: `mgr:acc:${account.id}:delete` }],
      [{ text: '⬅️ Kembali', callback_data: 'mgr:upcloud' }]
    ]
  };
  return { text, keyboard };
}

function consentScreen(botIp) {
  const text = `⚠️ <b>Persetujuan Penyimpanan Token</b>

Token API UpCloud = akses penuh ke uang & server kamu!

Sebelum lanjut, pahami ini:

🔐 Token akan disimpan <b>terenkripsi (AES-256-GCM)</b> di server bot.
👁️ <b>Pemilik bot secara teknis dapat mengakses token</b> karena kunci enkripsi ada di server yang sama.
💡 Saran aman:
• Buat <b>token khusus</b> untuk bot ini (bukan token utama)
• Atur <b>masa berlaku pendek</b> (mis. 30 hari)
• Batasi <b>Allowed IP ranges</b> ke IP server bot: <code>${botIp || '...'}</code>
• Token bisa <b>dicabut kapan saja</b> di panel UpCloud

Kalau setuju, klik tombol di bawah.`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '✅ Saya mengerti, lanjut', callback_data: 'mgr:consent:ok' }],
      [{ text: '❌ Batal', callback_data: 'mgr:upcloud' }],
      [{ text: '📖 Panduan Buat Token', callback_data: 'guide:1' }]
    ]
  };
  return { text, keyboard };
}

function addAccountPrompt(botIp) {
  const text = `➕ <b>Tambah Akun UpCloud</b>

Kirim <b>API token</b> kamu (diawali <code>ucat_</code>).

<b>Cara buat token:</b>
1. Buka hub.upcloud.com → Account → API tokens
2. Add new API token → Name: bot-telegram
3. Expiration: 30 hari (disarankan)
4. Jangan centang "Allow this token to create other tokens"
5. Allowed IP: isi <code>${botIp || 'IP bot'}</code> (aman) atau kosongkan (kurang aman)
6. Create → salin token (hanya tampil sekali)

⚠️ Pesan berisi token akan <b>langsung dihapus</b> dari chat demi keamanan.

Ketik /cancel untuk batal.`;
  return { text };
}

function formatZones(zones) {
  let text = `🌍 <b>Pilih Zona VPS</b>

Zona = lokasi server fisik. Pilih yang dekat dengan pengguna kamu.

⭐ = paling dekat untuk Indonesia (sg-xxx)

`;
  const keyboard = { inline_keyboard: [] };
  for (const z of zones.slice(0, 20)) {
    const star = z.id.startsWith('sg-') ? '⭐ ' : '';
    const label = `${star}${z.id} - ${z.description || z.id}`.slice(0, 40);
    keyboard.inline_keyboard.push([{ text: label, callback_data: `wiz:zone:${z.id}` }]);
  }
  keyboard.inline_keyboard.push([{ text: '❌ Batal', callback_data: 'wiz:cancel' }]);
  return { text, keyboard };
}

function getPlanCategory(plan) {
  const name = (plan.name || '').toLowerCase();
  if (name.includes('starter')) return 'starter';
  if (name.includes('premium')) return 'premium';
  if (name.includes('cloud native') || name.includes('native') || name.includes('cloud_native')) return 'cloud_native';
  if (plan.gpu_amount && parseInt(plan.gpu_amount) > 0) return 'gpu';
  if (plan.storage_size === 0 || plan.storage_tier === null) return 'cloud_native';
  // Heuristik berdasarkan pricing UpCloud 2026:
  // Starter: 10,20,30,40,50 GB dengan kombinasi tertentu
  // Premium: 25,50,100,150,200,300,400,500
  // Bedakan: 25GB pasti Premium, 10/20 pasti Starter, 30/40 cenderung Starter, 50 bisa keduanya
  const mem = plan.memory_amount || 0;
  const stor = plan.storage_size || 0;
  const core = plan.core_number || 0;
  if (stor === 25) return 'premium';
  if (stor === 10 || stor === 20) return 'starter';
  if (stor === 30 || stor === 40) return 'starter';
  if (stor === 50) {
    // Starter 16GB 50GB, Premium 2GB/4GB 50GB -> bedakan via mem
    if (mem >= 16384) return 'starter'; // 16GB 50GB starter
    if (mem <= 4096) return 'premium'; // 2GB/4GB 50GB premium
    return 'starter';
  }
  if (stor >= 100) return 'premium';
  // fallback
  return 'premium';
}

function formatPlanCategories(plans) {
  const counts = { starter: 0, premium: 0, cloud_native: 0, other: 0 };
  for (const p of plans) {
    const cat = getPlanCategory(p);
    if (counts[cat] !== undefined) counts[cat]++;
    else counts.other++;
  }
  let text = `📦 <b>Pilih Kategori Plan</b>

Sesuai panel UpCloud asli ada 3 tipe:

• <b>Starter</b> (€3/mo+) – murah, untuk dev/test/self-hosting, 99.99% SLA
• <b>Premium</b> (€5/mo+) – performa tinggi AMD EPYC + MaxIOPS, 99.999% SLA
• <b>Cloud Native</b> (€12/mo+) – compute & storage terpisah, stop tidak ditagih

Free trial limit contoh: max 6 CPU / 12GB RAM (sesuai screenshot)

Ditemukan:
• Starter: ${counts.starter} plan
• Premium: ${counts.premium} plan
• Cloud Native: ${counts.cloud_native} plan
${counts.other ? `• Lainnya: ${counts.other} plan\n` : ''}

Pilih kategori untuk lihat daftar (max 10 termurah per kategori).

💰 Biaya per jam sampai dihapus. Stop tetap ditagih kecuali Cloud Native.
`;
  const keyboard = { inline_keyboard: [] };
  if (counts.starter > 0) keyboard.inline_keyboard.push([{ text: `🚀 Starter (${counts.starter}) – dari €3/mo`, callback_data: 'wiz:plancat:starter' }]);
  if (counts.premium > 0) keyboard.inline_keyboard.push([{ text: `⚡ Premium (${counts.premium}) – dari €5/mo`, callback_data: 'wiz:plancat:premium' }]);
  if (counts.cloud_native > 0) keyboard.inline_keyboard.push([{ text: `☁️ Cloud Native (${counts.cloud_native}) – dari €12/mo`, callback_data: 'wiz:plancat:cloud_native' }]);
  keyboard.inline_keyboard.push([{ text: `📋 Semua (${plans.length}) – termurah dulu`, callback_data: 'wiz:plancat:all' }]);
  keyboard.inline_keyboard.push([{ text: '❌ Batal', callback_data: 'wiz:cancel' }]);
  return { text, keyboard };
}

function formatPlans(plans, category = 'all') {
  let catLabel = 'Semua';
  if (category === 'starter') catLabel = 'Starter (€3/mo+)';
  if (category === 'premium') catLabel = 'Premium (€5/mo+)';
  if (category === 'cloud_native') catLabel = 'Cloud Native (€12/mo+)';
  let text = `📦 <b>Pilih Plan – ${catLabel}</b>

Plan = CPU/RAM/Disk. Makin besar makin mahal.

⭐ = Rekomendasi pemula (RAM ≥1GB, paling kecil & murah)
${category === 'cloud_native' ? '\nℹ️ Cloud Native: storage tidak termasuk plan, akan dibuat terpisah sesuai template (di bot ini otomatis pakai size template). Compute tidak ditagih saat stopped.\n' : ''}
💰 <b>Biaya:</b> VPS ditagih per jam sampai dihapus. VPS Stop tetap ditagih kecuali Cloud Native.

`;
  const keyboard = { inline_keyboard: [] };
  // Filter already done by caller, but ensure sorting still
  const toShow = plans.slice(0, 10);
  let smallestWith1GB = null;
  for (const p of plans) {
    if (p.memory_amount >= 1024) { smallestWith1GB = p; break; }
  }
  for (const p of toShow) {
    const vcpu = p.core_number;
    const ram = (p.memory_amount / 1024).toFixed(p.memory_amount % 1024 === 0 ? 0 : 1);
    const disk = p.storage_size;
    const isRec = smallestWith1GB && p.name === smallestWith1GB.name;
    const star = isRec ? '⭐ ' : '';
    const diskLabel = disk === 0 ? 'tanpa disk (CN)' : `${disk} GB disk`;
    const label = `${star}${vcpu} vCPU · ${ram} GB · ${diskLabel}`.slice(0, 44);
    keyboard.inline_keyboard.push([{ text: label, callback_data: `wiz:plan:${p.name}` }]);
  }
  if (plans.length > 10) {
    text += `\nMenampilkan 10 dari ${plans.length} plan termurah di kategori ini.`;
  }
  keyboard.inline_keyboard.push([{ text: '⬅️ Kategori Lain', callback_data: 'wiz:plancat:back' }]);
  keyboard.inline_keyboard.push([{ text: '❌ Batal', callback_data: 'wiz:cancel' }]);
  return { text, keyboard };
}

function formatLoginMethods() {
  const text = `🔐 <b>Pilih Cara Login VPS</b>

🔑 <b>SSH Key sendiri</b> = kamu sudah punya SSH key, lebih aman, tapi agak ribet untuk pemula.
🔐 <b>Password otomatis</b> = paling mudah untuk pemula. Bot akan buat VPS pakai key bot, lalu set password untukmu, lalu hapus key bot.

Untuk Windows: deploy Debian/Ubuntu dulu pakai password otomatis, lalu Menu 3 → Reinstall ke Windows.
`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔐 Password otomatis (paling mudah)', callback_data: 'wiz:login:password' }],
      [{ text: '🔑 SSH key sendiri', callback_data: 'wiz:login:key' }],
      [{ text: '❌ Batal', callback_data: 'wiz:cancel' }]
    ]
  };
  return { text, keyboard };
}

function formatTemplates(templates, loginMode) {
  let text = `💿 <b>Pilih OS</b>

`;
  if (loginMode === 'password') {
    text += `Mode password hanya menampilkan Ubuntu/Debian (didukung untuk setup password otomatis).

Untuk Windows: deploy Debian/Ubuntu dulu, lalu Menu 3 → Reinstall ke Windows.
`;
  } else {
    text += `Semua template Linux (tanpa Windows). Untuk Windows: deploy Debian/Ubuntu dulu, lalu Menu 3 → Reinstall ke Windows.
`;
  }
  const keyboard = { inline_keyboard: [] };
  // Filter untuk password mode: hanya ubuntu/debian
  let filtered = templates;
  if (loginMode === 'password') {
    filtered = templates.filter(t => /ubuntu|debian/i.test(t.title));
  }
  // Urutkan, tampilkan 10
  const toShow = filtered.slice(0, 15);
  for (const tpl of toShow) {
    const label = `${tpl.title}`.slice(0, 40);
    keyboard.inline_keyboard.push([{ text: label, callback_data: `wiz:os:${tpl.uuid}` }]);
  }
  keyboard.inline_keyboard.push([{ text: '❌ Batal', callback_data: 'wiz:cancel' }]);
  return { text, keyboard };
}

function formatIpOptions() {
  const text = `🌐 <b>Pilih Tipe IP</b>

Default: <b>IPv4 saja</b> (paling kompatibel, murah, disarankan untuk pemula).

• <b>IPv4 saja</b> = VPS hanya dapat IPv4 publik (default, biaya paling rendah, kompatibel semua aplikasi)
• <b>Dual IPv4+IPv6</b> = VPS dapat IPv4 + IPv6 publik (kalau butuh IPv6, mis. untuk akses IPv6-only atau testing)

<i>Catatan: UpCloud mengenakan biaya untuk IPv4 tambahan, tapi IPv4 pertama & IPv6 biasanya termasuk plan. Pilih IPv4 saja kalau tidak butuh IPv6.</i>

Pilih:`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '✅ IPv4 saja (default, disarankan)', callback_data: 'wiz:ip:ipv4' }],
      [{ text: '🌐 IPv4 + IPv6 (dual)', callback_data: 'wiz:ip:dual' }],
      [{ text: '❌ Batal', callback_data: 'wiz:cancel' }]
    ]
  };
  return { text, keyboard };
}

function formatPasswordChoices(isOwner, config) {
  const text = `🔑 <b>Pilih Password VPS</b>

Password akan dipakai untuk login root.

🎲 Acak = bot buatkan password kuat (disarankan)
✏️ Ketik sendiri = kamu ketik password (10-64 karakter, ada huruf & angka, tanpa spasi/kutip/backslash)

${isOwner || config.DEFAULT_PASSWORD_FOR_EVERYONE ? '🔁 Password Default tersedia (hanya owner atau kalau diizinkan)' : ''}
`;
  const keyboard = { inline_keyboard: [] };
  keyboard.inline_keyboard.push([{ text: '🎲 Acak (disarankan)', callback_data: 'wiz:pw:random' }]);
  keyboard.inline_keyboard.push([{ text: '✏️ Ketik sendiri', callback_data: 'wiz:pw:custom' }]);
  if (isOwner || config.DEFAULT_PASSWORD_FOR_EVERYONE) {
    keyboard.inline_keyboard.push([{ text: '🔁 Password Default', callback_data: 'wiz:pw:default' }]);
  }
  keyboard.inline_keyboard.push([{ text: '❌ Batal', callback_data: 'wiz:cancel' }]);
  return { text, keyboard };
}

function formatServerList(servers, accountId) {
  let text = `🖥 <b>Daftar VPS Akun ${accountId}</b>

Total: ${servers.length} VPS
🟢 = started, 🔴 = stopped, 🟡 = maintenance

Pilih VPS untuk detail & aksi:
`;
  const keyboard = { inline_keyboard: [] };
  const toShow = servers.slice(0, 25);
  for (const s of toShow) {
    let icon = '⚪';
    if (s.state === 'started') icon = '🟢';
    else if (s.state === 'stopped') icon = '🔴';
    else if (s.state === 'maintenance') icon = '🟡';
    const label = `${icon} ${s.title} (${s.zone})`.slice(0, 40);
    // callback_data ≤64: srv:<acc6>:<uuid>
    keyboard.inline_keyboard.push([{ text: label, callback_data: `srv:${accountId}:${s.uuid}` }]);
  }
  keyboard.inline_keyboard.push([{ text: '🔄 Refresh', callback_data: `mgr:acc:${accountId}:list` }]);
  keyboard.inline_keyboard.push([{ text: '⬅️ Kembali', callback_data: `mgr:acc:${accountId}` }]);
  return { text, keyboard };
}

function formatServerDetail(server, accountId) {
  const ips = server.ip_addresses ? (Array.isArray(server.ip_addresses.ip_address) ? server.ip_addresses.ip_address : [server.ip_addresses.ip_address]) : [];
  const ipv4 = ips.filter(ip => ip.access === 'public' && ip.family === 'IPv4').map(ip=>ip.address).join(', ') || 'belum ada';
  const text = `🖥 <b>Detail VPS</b>

<b>${server.title}</b> (${server.state})
Hostname: <code>${server.hostname}</code>
UUID: <code>${server.uuid}</code>
Zona: ${server.zone}
Plan: ${server.plan}
vCPU: ${server.core_number} | RAM: ${server.memory_amount} MB
IPv4 Publik: <code>${ipv4}</code>
Firewall: ${server.firewall || 'off'} | Remote Access: ${server.remote_access_enabled || 'no'}

Pilih aksi:
`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '▶️ Start', callback_data: `srvact:${accountId}:${server.uuid}:start` }, { text: '⏹ Stop', callback_data: `srvact:${accountId}:${server.uuid}:stop` }],
      [{ text: '🔁 Restart', callback_data: `srvact:${accountId}:${server.uuid}:restart` }, { text: '🗑 Hapus', callback_data: `srvact:${accountId}:${server.uuid}:delete` }],
      [{ text: '🖥 Console (VNC)', callback_data: `srvact:${accountId}:${server.uuid}:vnc` }],
      [{ text: '🔑 Aktifkan Password', callback_data: `srvact:${accountId}:${server.uuid}:ssh` }, { text: '💿 Reinstall via Menu 3', callback_data: `srvact:${accountId}:${server.uuid}:os` }],
      [{ text: '🔁 Reinstall Resmi (Linux)', callback_data: `srvact:${accountId}:${server.uuid}:rebuild` }],
      [{ text: '🛡 Firewall', callback_data: `srvact:${accountId}:${server.uuid}:fw` }],
      [{ text: '⬅️ Kembali', callback_data: `mgr:acc:${accountId}:list` }]
    ]
  };
  if (server.firewall === 'on') {
    // warning will be in text extra
  }
  return { text, keyboard };
}

function formatBilling(account, billingCurrent, billingLast, servers) {
  const started = servers.filter(s=>s.state==='started').length;
  const stopped = servers.filter(s=>s.state==='stopped').length;
  let text = `💰 <b>Tagihan & Saldo - ${account.label}</b>

Username: <code>${account.username}</code>
Saldo Kredit: ${account.credits !== undefined ? account.credits : 'N/A'}

<b>Tagihan:</b>
Bulan ini (${billingCurrent.month}): ${billingCurrent.total} ${billingCurrent.currency}
Bulan lalu (${billingLast.month}): ${billingLast.total} ${billingLast.currency}

<b>VPS:</b> ${started} started, ${stopped} stopped, total ${servers.length}

<i>Angka dari UpCloud, satuannya mengikuti akunmu. Cek panel UpCloud untuk rincian resmi. VPS yang di-Stop umumnya tetap ditagih.</i>
`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔄 Refresh', callback_data: `mgr:acc:${account.id}:billing` }],
      [{ text: '⬅️ Kembali', callback_data: `mgr:acc:${account.id}` }]
    ]
  };
  return { text, keyboard };
}

function formatCheckApiResults(results, botIp) {
  let text = `🔐 <b>Hasil Cek API</b>

Bot cek semua akun tersimpan:

`;
  for (const r of results) {
    let icon = '⚪';
    let detail = '';
    if (r.status === 'ok') {
      icon = '✅ Hidup';
      detail = `${r.username}`;
      if (r.tokens) {
        detail += ` | ${r.tokens.length} token`;
        // Cek kedaluwarsa ≤7 hari
        const now = Date.now();
        const expiring = r.tokens.filter(t => {
          if (!t.expires_at) return false;
          const exp = new Date(t.expires_at).getTime();
          const diffDays = (exp - now) / (1000*60*60*24);
          return diffDays <= 7 && diffDays >= -365;
        });
        if (expiring.length > 0) detail += ` ⚠️ ${expiring.length} token mau habis ≤7 hari!`;
      }
    } else if (r.status === '401') {
      icon = '❌ Mati/dicabut/kedaluwarsa';
      detail = '401';
    } else if (r.status === '403') {
      icon = '⚠️ Ditolak (403)';
      detail = `Cek Allowed IP, IP bot: ${botIp}`;
    } else {
      icon = '⚠️ Gagal terhubung';
      detail = r.error || 'coba cek ulang';
    }
    text += `${icon} <b>${r.label}</b> (${r.id}): ${detail}\n`;
    if (r.tokens && r.tokens.length > 0) {
      for (const t of r.tokens.slice(0,3)) {
        const exp = t.expires_at ? new Date(t.expires_at).toLocaleDateString() : 'no exp';
        const last = t.last_used_at ? new Date(t.last_used_at).toLocaleDateString() : 'belum pernah';
        text += `  - ${t.name}: exp ${exp}, last ${last}\n`;
      }
      if (r.tokens.length > 3) text += `  ... dan ${r.tokens.length-3} lagi\n`;
    }
  }
  text += `\n<i>API tidak memberi tahu token mana yang dipakai bot, jadi daftar ini untuk seluruh token di akun.</i>`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔄 Cek Ulang', callback_data: 'mgr:upcloud:checkall' }],
      [{ text: '🗑 Hapus Semua Akun Mati', callback_data: 'mgr:upcloud:cleanDead' }],
      [{ text: '➕ Tambah Akun', callback_data: 'mgr:upcloud:add' }],
      [{ text: '⬅️ Kembali', callback_data: 'mgr:upcloud' }]
    ]
  };
  return { text, keyboard };
}

function formatFirewallStatus(server, rules, accountId) {
  const text = `🛡 <b>Firewall VPS ${server.title}</b>

Status: <b>${server.firewall === 'on' ? 'ON (aktif)' : 'OFF (mati)'}</b>
Jumlah aturan: ${rules.length}
Default incoming: ${server.firewall_public_default_incoming_action || 'accept'}

<b>Tujuan:</b> Mengurangi serangan brute force dengan kunci SSH (22) & RDP (3389) hanya ke IP-mu.

⚠️ <b>Peringatan anti-terkunci:</b>
• Kalau IP salah, kamu tidak bisa SSH/RDP sampai firewall dimatikan (bisa lewat bot atau Console VNC)
• Perubahan aturan bisa butuh 1-2 menit
• Bot sendiri tidak bisa masuk ke VPS (Setup/Reinstall via SSH) saat firewall aktif!

Pilih aksi:
`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '🔒 Kunci SSH/RDP ke IP-ku', callback_data: `srvact:${accountId}:${server.uuid}:fwlock` }],
      [{ text: '🔓 Matikan Firewall', callback_data: `srvact:${accountId}:${server.uuid}:fw off` }],
      [{ text: '⬅️ Kembali', callback_data: `srv:${accountId}:${server.uuid}` }]
    ]
  };
  return { text, keyboard };
}

module.exports = {
  mainMenu,
  providerMenu,
  accountsMenu,
  accountDetailMenu,
  consentScreen,
  addAccountPrompt,
  formatZones,
  formatPlans,
  formatPlanCategories,
  getPlanCategory,
  formatLoginMethods,
  formatTemplates,
  formatIpOptions,
  formatPasswordChoices,
  formatServerList,
  formatServerDetail,
  formatBilling,
  formatCheckApiResults,
  formatFirewallStatus
};
