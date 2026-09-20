/**
 * guide.js - Panduan Pemula di dalam bot
 */

const pages = [
  {
    title: '📖 Panduan Pemula - 1/7: Apa itu VPS & Biayanya',
    text: `🖥 <b>Apa itu VPS & Biayanya?</b>

VPS = komputer sewaan yang menyala 24 jam di internet. Kamu bisa install aplikasi, website, bot, dll.

💰 <b>Biaya di UpCloud:</b>
• VPS ditagih <b>per jam</b> sampai kamu <b>HAPUS</b> VPS-nya.
• VPS yang hanya di-Stop (dimatikan) <b>umumnya tetap ditagih</b> karena resource masih dipesan untukmu.
• Cek menu 💰 Tagihan & Saldo untuk lihat perkiraan bulan ini & bulan lalu.

💡 <b>Tips hemat:</b> Hapus VPS yang tidak dipakai lewat menu 🖥 Kelola VPS → 🗑 Hapus.

<i>Catatan: Angka tagihan dari UpCloud, cek panel UpCloud untuk rincian resmi.</i>`
  },
  {
    title: '📖 Panduan Pemula - 2/7: Cara Membuat API Token UpCloud',
    text: `🔑 <b>Cara Membuat API Token UpCloud</b>

1. Masuk <b>UpCloud Control Panel</b> (hub.upcloud.com) → menu <b>Account → API tokens</b>.
2. Klik <b>Add new API token</b>.
3. Isi <b>Name</b> (mis. "bot-telegram").
4. Atur <b>Expiration</b> (bawaan 30 hari, maksimum 365 hari; disarankan pendek).
5. <b>Jangan</b> centang "Allow this token to create other tokens".
6. <b>Allowed IP ranges:</b>
   • Aman = isi IP server bot (lihat /ip)
   • Praktis = izinkan semua IP (kurang aman)
7. Klik <b>Create API token</b>, lalu <b>salin tokennya sekarang</b> (diawali <code>ucat_</code>, hanya tampil sekali).
8. Kirim token ke bot lewat ➕ Tambah Akun. Gunakan akun utama (token dari subakun bisa kekurangan izin).

⚠️ <b>Keamanan:</b> Token = akses ke uang & servermu. Buat token khusus untuk bot, beri masa berlaku pendek, dan bisa dicabut kapan saja di panel UpCloud.`
  },
  {
    title: '📖 Panduan Pemula - 3/7: Cara Membuat VPS lewat Bot',
    text: `🚀 <b>Cara Membuat VPS lewat Bot</b>

1. Buka 👤 Manajer Akun → ☁️ UpCloud → ➕ Tambah Akun (masukkan token).
2. Pilih akunmu → ➕ Buat VPS.
3. Pilih <b>Zona</b>: pilih yang ada ⭐ (sg-xxx biasanya paling dekat untuk Indonesia).
4. Pilih <b>Plan</b>: untuk pemula pilih yang ⭐ Rekomendasi (RAM ≥1GB, paling kecil & murah).
5. Pilih <b>Cara Login</b>:
   • 🔐 Password otomatis = paling mudah untuk pemula (bot buatkan VPS pakai key bot, lalu set password)
   • 🔑 SSH key sendiri = untuk yang sudah punya SSH key
6. Pilih <b>OS</b>: Ubuntu/Debian untuk mode password. Untuk Windows: deploy Debian/Ubuntu dulu, lalu Menu 3 → Reinstall ke Windows.
7. Masukkan <b>Nama VPS</b> (bebas).
8. Konfirmasi & tunggu proses (bisa 2-5 menit).
9. Hasil: IP, user root, password, cara login <code>ssh root@IP</code>

⚠️ <b>Ingat:</b> VPS langsung ditagih per jam setelah dibuat!`
  },
  {
    title: '📖 Panduan Pemula - 4/7: Cara Masuk ke VPS',
    text: `🔓 <b>Cara Masuk ke VPS</b>

<b>Linux (Ubuntu/Debian):</b>
• Di HP/PC: buka Terminal
• Ketik: <code>ssh root@IP_VPS</code>
• Masukkan password yang diberikan bot
• Windows: pakai PuTTY atau Windows Terminal
• Android: Termux / JuiceSSH / ConnectBot

<b>Windows Server:</b>
• Di PC: aplikasi <b>Remote Desktop</b> (RDP)
• Masukkan IP: <code>IP_VPS:3389</code>
• User: <code>Administrator</code>
• Password: dari bot

💡 <b>Setelah login pertama:</b>
• Linux: ganti password dengan <code>passwd</code>
• Windows: ganti password juga

❓ <b>Tidak bisa masuk?</b>
• Cek status VPS di 🖥 Kelola VPS
• Cek firewall (kalau kamu kunci SSH/RDP ke IP, pastikan IP-mu benar)
• Gunakan 🖥 Console (VNC) untuk darurat`
  },
  {
    title: '📖 Panduan Pemula - 5/7: Cara Membuat SSH Key',
    text: `🔑 <b>Cara Membuat SSH Key</b>

SSH key = kunci digital untuk login tanpa password (lebih aman).

<b>Di Termux / Linux / Mac Terminal:</b>
<code>ssh-keygen -t ed25519</code>
• Tekan Enter semua (tanpa passphrase untuk pemula)
• Public key ada di <code>~/.ssh/id_ed25519.pub</code>
• Tampilkan: <code>cat ~/.ssh/id_ed25519.pub</code>

<b>Di Windows (PuTTYgen):</b>
1. Buka PuTTYgen → Generate
2. Copy public key yang muncul
3. Save private key untuk kamu sendiri

<b>Kirim ke bot:</b>
• Kirim hanya file yang berakhiran <code>.pub</code> (public key)
• Contoh: <code>ssh-ed25519 AAAAC3... user@hp</code>
• <b>JANGAN</b> pernah kirim private key (yang ada tulisan BEGIN PRIVATE KEY)

💡 Untuk pemula, pakai mode 🔐 Password otomatis saja, lebih mudah!`
  },
  {
    title: '📖 Panduan Pemula - 6/7: Keamanan',
    text: `🛡 <b>Keamanan</b>

<b>Password:</b>
• Ganti password setelah login pertama
• Jangan pakai password yang sama untuk banyak VPS kalau bot dipakai banyak orang
• Bot menyarankan password acak (🎲)

<b>Firewall (di menu Kelola VPS → 🛡 Firewall):</b>
• Kunci SSH/RDP hanya ke IP-mu sendiri
• Mengurangi serangan brute force
• Hati-hati: kalau IP salah, kamu terkunci! Bisa buka lewat bot (Matikan Firewall) atau Console VNC

<b>Token API:</b>
• Buat token khusus untuk bot, masa berlaku pendek
• Batasi IP ke IP server bot (lihat /ip)
• Cabut token yang tidak dipakai di panel UpCloud
• Cek berkala lewat 🔐 Cek API

<b>Token disimpan terenkripsi di server bot, tapi pemilik bot secara teknis bisa mengaksesnya.</b> Jadi buat token khusus & jangan pakai token utama kalau khawatir.`
  },
  {
    title: '📖 Panduan Pemula - 7/7: Bila Ada Masalah',
    text: `🆘 <b>Bila Ada Masalah</b>

<b>VPS tidak bisa dimasuki:</b>
• Cek status di 🖥 Kelola VPS (apakah 🟢 started?)
• Coba ▶️ Start kalau 🔴 stopped
• Cek firewall: matikan dulu kalau kamu kunci IP
• Gunakan 🖥 Console (VNC) untuk lihat layar VPS langsung (darurat)

<b>Token mati / 401 / 403:</b>
• Cek lewat 🔐 Cek API
• 401 = token salah/dicabut/kedaluwarsa → buat token baru
• 403 = token dibatasi IP → tambahkan IP bot ke Allowed IP di panel UpCloud (lihat /ip)

<b>Tagihan aneh:</b>
• Cek 💰 Tagihan & Saldo
• Hapus VPS yang tidak dipakai (VPS yang di-Stop umumnya tetap ditagih)
• Cek di panel UpCloud untuk rincian resmi

<b>Reinstall gagal / VPS macet setelah reinstall:</b>
• Gunakan 🖥 Console (VNC) untuk lihat
• Coba reinstall ulang lewat Menu 3
• Untuk Windows: ISO dari Google Drive bisa kena limit download, coba lagi nanti

<b>Masih bingung?</b> Baca lagi panduan dari halaman 1, atau tanya owner bot.`
  }
];

function getPage(index) {
  if (index < 0) index = 0;
  if (index >= pages.length) index = pages.length - 1;
  return { ...pages[index], index, total: pages.length };
}

module.exports = { pages, getPage };
