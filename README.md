# UpCloud VPS Manager — Bot Telegram (Node.js)

Bot Telegram ramah pemula untuk mengelola VPS UpCloud. Multi-user & multi-akun: satu user Telegram bisa menyimpan beberapa akun UpCloud (maksimal `MAX_ACCOUNTS_PER_USER`). Dibuat untuk owner yang tidak bisa CLI (panel Pterodactyl, upload zip, edit `config.js`).

**Bahasa:** Semua pesan bot, panduan, dan error memakai Bahasa Indonesia ramah pemula.

**Stack:** Node.js 18+, Telegraf 4.15, ssh2 1.15. Tidak ada dependensi lain.

## Fitur Utama

### 3 Menu Utama
- 👤 **Manajer Akun** (Provider UpCloud via API token)
  - Tambah akun: input token `ucat_...`, validasi `GET /1.3/account`, error 401/403/429 ramah + tampilkan IP bot (`BOT_PUBLIC_IP` auto-detect via ipify 5s timeout) untuk allowed_ip.
  - Buat VPS wizard:
    - Pilih zona: filter `public=yes`, tampilkan ⭐ untuk `sg-` (Singapore dekat Indonesia), paginasi.
    - Pilih plan: buang GPU (`gpu_amount>0`) dan `current_offering=no`, urut naik core/memory/storage, maks 10 per halaman, ⭐ rekomendasi `RAM≥1GB`.
    - Pilih login: **Password Otomatis** (buat dengan key bot → setup password → tes login → hapus key bot) atau **SSH Key sendiri** (PEM ≤32KB, pesan dihapus setelah input).
    - Pilih OS: dari `/1.3/storage/template` paginasi, buang `access=private` + Windows (title mengandung Windows), tampil size & tier.
    - Konfirmasi biaya per jam (dari plan `price`), eksekusi detached dengan LiveProgress checklist animasi.
  - Kelola VPS: list 25 terbaru, detail IPv4 public/private, firewall on/off, aksi Start/Stop soft/Restart/Hapus (`DELETE ?storages=1&backups=delete`), VNC remote_access, pintasan ke Aktifkan Password & Reinstall.
  - Reinstall Resmi Linux via API: urutan wajib `stop → set metadata=yes → rebuild (clone_source, detach_disk, delete_detached_disk=yes, password_delivery=none, login_user ssh_keys bot) → start`.
  - Cek API multi-akun paralel 3, timeout 15 detik, status: hidup / mati / ditolak / gagal, list token (`expires_at`, `last_used_at`, `allowed_ip_ranges`) + peringatan kedaluwarsa ≤7 hari.
  - Tagihan: credits + billing_summary bulan ini & lalu (YYYY-MM).
  - Firewall: kunci SSH/RDP ke IP user, konversi CIDR → range (`192.168.1.0/24` → `192.168.1.0` - `192.168.1.255`), konfirmasi anti-terkunci.
  - Panduan Pemula: 7 topik (token, IP allowlist, biaya, firewall, dll).

- 🔐 **Aktifkan Password** (Show SSH Key, Setup VPS, Check VPS)
  - **Show Key Bot:** tampilkan public key ED25519 bot.
  - **Setup VPS** (Ubuntu/Debian): input sumber key (key bot / key sendiri), IP/host, username (`root/ubuntu/debian` regex `^[a-z_][a-z0-9_-]*$`), 9 langkah:
    1. backup `/etc/ssh/sshd_config` → `/etc/ssh/sshd_config.bak.<ts>`
    2. fix `PasswordAuthentication yes` di `sshd_config` + drop-in `/etc/ssh/sshd_config.d/60-bot-allow-password.conf`
    3. `sshd -t` validasi config
    4. restart `ssh`/`sshd` (systemctl/service)
    5. `sshd -T | grep passwordauthentication`
    6. `chpasswd` via `echo user:pass | base64` (tanpa spasi/kutip/backslash di password)
    7. tes login ulang dengan password baru
    8. rollback jika gagal (restore backup)
    9. hapus key bot dari `authorized_keys` setelah sukses.
  - Check VPS: cek `PasswordAuthentication`.

- 💿 **Install/Reinstall OS (reinstall.sh)**
  - Preflight: root/sudo, arch `x86_64`, RAM/disk, curl/wget, boot_id (`/proc/sys/kernel/random/boot_id`).
  - Download `reinstall.sh` dari GitHub + fallback `cnb.cool`, cek shebang `#!`.
  - Eksekusi detached: `bash reinstall.sh <os> --password <pw> --ssh-port 22 --web-port 80 ... |` + poll exitfile, reboot.
  - Deteksi:
    - Linux: SSH terbuka + `/etc/os-release ID` cocok + boot_id beda, timeout 40 menit.
    - Windows: RDP 3389 tertutup dulu baru terbuka, timeout 45 menit, tes link ISO dari VPS target `curl -r 0-0` wajib 200/206.
  - Konfirmasi tanpa query/token: link ditampilkan terpotong, tapi konfirmasi hanya ya/tidak, tidak tampilkan URL penuh lagi.
  - Kuota: Setup 3x/hari, Reinstall 1x/hari per user (owner unlimited), reset 00:00 UTC. Job limit: 1 per user & global `MAX_CONCURRENT_JOBS`.
  - Preset Windows 5: Server 2022/2025/2012 R2, Win11 IoT Ent 24H2, Win10 IoT Ent 22H2, host `windows.katsuvip.eu.cc` (permanen, tanpa token), `imageName` tebakan belum terverifikasi.

### Keamanan
- Token disimpan terenkripsi AES-256-GCM, AAD `userId:accountId`, key dari `ENCRYPTION_KEY` atau `data/vault.key` (0600).
- `DEFAULT_PASSWORD` hanya untuk owner kecuali `DEFAULT_PASSWORD_FOR_EVERYONE=true`.
- Password pilihan: acak (`A-Z a-z 0-9`), ketik sendiri (10-64 huruf+angka tanpa spasi/kutip/backslash), Windows charset `A-Za-z0-9@_+=.-`.
- Tidak simpan password VPS, hanya di memori sesi.
- Hapus key bot setelah password terbukti (flow password otomatis).
- Isolasi data: `isOwner(userId, accountId)` cek kepemilikan setiap aksi.
- `/hapusdata` hapus semua akun user.
- Redaksi secret: log & pesan tidak tampilkan token/URL lengkap.
- Callback_data ≤64 byte, stateless format `<acc6hex>:<uuid>` (contoh `srv:a1b2c3:uuid`, `srvact:a1b2c3:uuid:start`).
- Firewall off tersedia via `fw:off` dan legacy `fw off`.
- SshSession wrapper timeout 15/20/30 detik.
- Key ED25519 generate di `data/keys/upcloud_ed25519` (0600) + `.pub` (0644), verifikasi `ssh2`.

## Cara Install (Pterodactyl / Panel)

1. Upload zip (tanpa `node_modules`) ke panel, extract.
2. Edit `config.js`:
   ```js
   BOT_TOKEN: "123456:ABC...",
   OWNER_ID: 123456789,
   BOT_PUBLIC_IP: "" // kosong = auto-detect
   ```
   Bot **menolak start** jika `BOT_TOKEN` masih `ISI_TOKEN_BOT_DISINI` atau `OWNER_ID` 0.
3. `npm install` (di panel biasanya otomatis atau via startup command `npm install && node index.js`).
4. Jalankan: `node index.js` atau `npm start`.
5. Di Telegram, `/start` → pilih menu.

## Konfigurasi Lengkap (config.js)

```js
BOT_TOKEN, OWNER_ID, BOT_PUBLIC_IP,
ENCRYPTION_KEY, DEFAULT_PASSWORD,
DEFAULT_PASSWORD_FOR_EVERYONE=false,
MANAGER_OWNER_ONLY=false,
MAX_ACCOUNTS_PER_USER=5,
MAX_CONCURRENT_JOBS=8,
REINSTALL_OWNER_ONLY=false,
REINSTALL_DAILY_LIMIT=1,
WINDOWS_PRESETS=[5 preset]
```

- `BOT_PUBLIC_IP`: jika kosong, bot fetch `https://api.ipify.org?format=json` timeout 5 detik.
- `ENCRYPTION_KEY`: kosong → buat `data/vault.key` random 32 byte hex.
- `DEFAULT_PASSWORD`: contoh `KatsuAja@55`, hanya owner kecuali flag true.
- `WINDOWS_PRESETS`: array 5, tiap item `{label, iso, imageName}`.

## Perintah Bot

- `/start` - menu utama
- `/hapusdata` - hapus semua akun UpCloud milikmu
- `/admin` - stats (owner only): jumlah user, akun, job aktif, kuota.

## Payload Emas (Lampiran A) — Wajib Cocok

### Buat VPS
```json
{
  "server": {
    "zone": "sg-sin1",
    "title": "katsu-ab12cd",
    "hostname": "katsu-ab12cd",
    "plan": "1xCPU-1GB",
    "password_delivery": "none",
    "metadata": "yes",
    "login_user": {
      "username": "root",
      "create_password": "no",
      "ssh_keys": { "ssh_key": ["ssh-ed25519 AAAA... user@host"] }
    },
    "storage_devices": {
      "storage_device": [{
        "action": "clone",
        "storage": "<uuid template>",
        "title": "katsu-ab12cd-disk",
        "size": 25,
        "tier": "maxiops"
      }]
    }
  }
}
```

### Rebuild
```json
{
  "server_rebuild": {
    "clone_source": "<uuid template>",
    "storage_title": "katsu-ab12cd-disk",
    "detach_disk": "<uuid boot disk lama>",
    "delete_detached_disk": "yes",
    "password_delivery": "none",
    "login_user": {
      "username": "root",
      "create_password": "no",
      "ssh_keys": { "ssh_key": ["ssh-ed25519 AAAA... bot"] }
    }
  }
}
```

### Firewall
```json
{
  "firewall_rules": {
    "firewall_rule": [
      { "action": "accept", "direction": "in", "family": "IPv4", "protocol": "tcp", "destination_port_start": "22", "destination_port_end": "22", "source_address_start": "203.0.113.5", "source_address_end": "203.0.113.5", "comment": "SSH dari IP saya" },
      { "action": "accept", "direction": "in", "family": "IPv4", "protocol": "tcp", "destination_port_start": "3389", "destination_port_end": "3389", "source_address_start": "203.0.113.5", "source_address_end": "203.0.113.5", "comment": "RDP dari IP saya" },
      { "action": "accept", "direction": "in", "family": "IPv4", "protocol": "tcp", "destination_port_start": "80", "destination_port_end": "80", "comment": "Web" },
      { "action": "accept", "direction": "in", "family": "IPv4", "protocol": "tcp", "destination_port_start": "443", "destination_port_end": "443", "comment": "Web TLS" }
    ]
  }
}
```

## Pengujian

```bash
npm test
# atau
node tests/run.js
```

Tes mencakup:
- Validator IP/CIDR/username/password/SSH key, shellEscape, redactSecrets, cidrToRange.
- Password generate & pilihan owner vs user.
- Vault encrypt/decrypt AAD isolation, multi-akun, kepemilikan, /hapusdata.
- Quota reset harian, owner unlimited.
- Jobs: 1 per user & max concurrent.
- Callback_data ≤64 byte & stateless.
- Payload emas buat VPS, rebuild, firewall.
- Translate error 401/403/429 ramah.
- Cek API expiring ≤7 hari.
- Keygen ED25519 + ssh2 parse (opsional jika modul ada).
- Mock UpCloud API (HTTP lokal) untuk GET /account sukses, 401, 403.

Mock SSH: sesi palsu menjalankan perintah di bash lokal dengan curl & reboot palsu (reboot sungguhan dilarang).

## Struktur Folder

```
.
├── config.js
├── index.js (2506 baris, semua menu)
├── lib/
│   ├── validators.js, password.js, vault.js, keygen.js
│   ├── sshClient.js, sshdConfig.js, setupFlow.js, reinstallFlow.js
│   ├── quota.js, jobs.js, progress.js, osDetect.js, guide.js, stats.js
├── providers/upcloud.js
├── data/
│   ├── keys/upcloud_ed25519 (0600) + .pub
│   ├── accounts.json (terenkripsi)
│   ├── vault.key (0600, auto)
│   ├── quota.json, logs/
├── tests/run.js
├── package.json
└── README.md
```

## Risiko & Batasan (WAJIB DIBACA)

1. **Password Default Berbagi Risiko Tinggi:** Jika `DEFAULT_PASSWORD_FOR_EVERYONE=true`, semua user bot bisa pakai password sama. Penyerang bisa brute-force VPS yang dibuat dengan password default. **Rekomendasi:** biarkan `false`, hanya owner yang boleh pakai default.

2. **Token UpCloud Bocor = Akses Penuh Akun UpCloud:** Bot menyimpan token terenkripsi, tapi jika server panel diretas, penyerang bisa dekripsi token. **Mitigasi:** gunakan `ENCRYPTION_KEY` kuat (64 hex), batasi Allowed IP di panel UpCloud ke IP bot, rotasi token berkala, jangan share `data/` folder.

3. **Firewall Lockout:** Fitur Firewall kunci SSH/RDP ke IP user. Jika user salah input IP atau IP berubah (dinamis), mereka bisa terkunci dari VPS sendiri. Bot menampilkan konfirmasi anti-terkunci, tapi tetap risiko. **Mitigasi:** pastikan IP benar, punya akses VNC sebagai backup, jangan kunci 22/3389 tanpa whitelist yang benar.

4. **Reinstall.sh Data Hilang Total:** `reinstall.sh` menghapus semua data di disk (format ulang). Tidak ada backup otomatis. Salah pilih VPS target = data hilang permanen. **Mitigasi:** bot wajib konfirmasi ulang dengan nama VPS, cek OS target, dan user harus backup manual dulu.

5. **Link ISO Windows & imageName Belum Terverifikasi:** Preset ISO di `windows.katsuvip.eu.cc` dan `imageName` adalah tebakan, belum diuji di semua region. ISO bisa kedaluwarsa, link 404, atau `imageName` salah menyebabkan instalasi gagal di tengah jalan (VPS tidak boot). **Mitigasi:** owner harus uji manual satu per satu, sediakan fallback ISO, dan tampilkan peringatan di bot bahwa preset belum terverifikasi.

6. **Biaya UpCloud:** Buat VPS dikenakan biaya per jam. Jika user lupa hapus VPS, tagihan terus jalan. Bot menampilkan estimasi biaya per jam, tapi tidak memblokir pembuatan VPS mahal. **Mitigasi:** cek Tagihan di bot, set alert di panel UpCloud, hapus VPS yang tidak dipakai.

7. **Rate Limit & 429:** UpCloud API punya rate limit. Bot sudah handle retry 1x dengan `Retry-After`, tapi jika banyak user bersamaan, bisa kena 429 dan operasi gagal. **Mitigasi:** `MAX_CONCURRENT_JOBS=8`, jangan spam buat/hapus VPS.

8. **SSH & Sudo:** Setup password butuh root/sudo + akses SSH. Jika VPS memakai konfigurasi sshd kustom, bot bisa gagal parse atau rollback tidak sempurna. **Mitigasi:** backup `sshd_config` selalu dibuat, tapi user tetap harus cek manual jika gagal.

9. **Bot Public IP Deteksi Gagal:** Auto-detect IP via ipify bisa gagal (timeout 5s). Jika gagal, bot tampilkan placeholder dan user harus cek IP manual di panel. Jika token dibatasi IP tapi IP bot salah, token akan 403.

10. **Tidak Ada Backup Bot:** Bot tidak backup otomatis `accounts.json`. Jika file rusak/hilang, semua akun harus tambah ulang. **Mitigasi:** backup `data/` folder secara berkala di luar bot.

11. **Multi-User Isolasi Bukan Multi-Tenant Sempurna:** Bot isolasi via `isOwner` check, tapi semua data di satu file `accounts.json`. Jika ada bug di check kepemilikan, ada risiko cross-user access. **Mitigasi:** selalu update bot dari sumber terpercaya, jangan modifikasi `vault.js` tanpa tes.

## Di Luar Cakupan

- Provider selain UpCloud
- Windows template bawaan UpCloud
- Backup & snapshot
- Ubah plan / resize
- Billing detail per VPS
- IPv6 firewall
- 2FA UpCloud

## Lisensi

MIT — untuk keperluan pribadi & edukasi. Owner bertanggung jawab atas penggunaan token & biaya UpCloud.

## Catatan Owner (Pterodactyl)

- Jangan commit `config.js` dengan token asli ke git.
- `data/` masuk `.gitignore` (kecuali `.gitkeep`).
- Untuk update bot, upload zip baru tanpa `node_modules`, `npm install` lagi.
- Jika bot tidak start, cek `data/logs/` dan console panel untuk pesan placeholder.
