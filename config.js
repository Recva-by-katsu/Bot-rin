/**
 * config.js - Semua konfigurasi bot UpCloud VPS Manager
 * Semua opsi ada komentar Bahasa Indonesia.
 * Isi file ini sebelum menjalankan bot.
 */

module.exports = {
  // Token bot Telegram dari @BotFather (WAJIB)
  BOT_TOKEN: "ISI_TOKEN_BOT_DISINI",

  // ID Telegram owner (angka, WAJIB). Dapatkan dari @userinfobot
  OWNER_ID: 0,

  // IP publik server bot (opsional). Kalau kosong, bot akan coba deteksi otomatis lewat api.ipify.org
  // IP ini ditampilkan ke user saat mereka membuat API token dengan batasan IP.
  BOT_PUBLIC_IP: "",

  // Kunci enkripsi untuk token API user (opsional).
  // Kalau kosong, bot akan buat otomatis di data/vault.key (mode 0600).
  // Format: 64 karakter hex (32 byte) atau string acak. Kalau string biasa, akan di-hash SHA256.
  ENCRYPTION_KEY: "",

  // Password default yang diinginkan owner. HANYA berlaku untuk owner, kecuali DEFAULT_PASSWORD_FOR_EVERYONE=true
  // Contoh: "KatsuAja@55"
  DEFAULT_PASSWORD: "KatsuAja@55",

  // Apakah password default boleh dipakai semua orang? Default false (AMAN).
  // Kalau true, semua user akan melihat tombol "Password Default" dan bisa pakai password yang sama.
  // RISIKO: Siapa pun bisa coba login ke VPS orang lain yang dibuat bot dengan password default!
  DEFAULT_PASSWORD_FOR_EVERYONE: false,

  // Apakah Manajer Akun hanya untuk owner? Default false (semua orang bisa pakai)
  MANAGER_OWNER_ONLY: false,

  // Maksimal akun UpCloud yang bisa disimpan per user Telegram
  MAX_ACCOUNTS_PER_USER: 5,

  // Maksimal job panjang yang berjalan bersamaan (semua user)
  MAX_CONCURRENT_JOBS: 8,

  // Apakah Install/Reinstall OS (reinstall.sh) hanya untuk owner?
  REINSTALL_OWNER_ONLY: false,

  // Batas harian reinstall via reinstall.sh per user (owner unlimited). Reset 00:00 UTC
  REINSTALL_DAILY_LIMIT: 1,

  // Preset ISO Windows (maks 6). Host permanen milik owner, tanpa token.
  // imageName adalah TEBAKAN, belum terverifikasi! Harus diuji manual.
  WINDOWS_PRESETS: [
    {
      label: "Server 2022",
      iso: "https://windows.katsuvip.eu.cc/download/en-us_windows_server_2022_updated_sep_2026_x64_dvd_33eb6921.iso",
      imageName: "Windows Server 2022 SERVERSTANDARD"
    },
    {
      label: "Server 2025",
      iso: "https://windows.katsuvip.eu.cc/download/en-us_windows_server_2025_updated_sep_2026_x64_dvd_f69d8ae5.iso",
      imageName: "Windows Server 2025 SERVERSTANDARD"
    },
    {
      label: "Server 2012 R2",
      iso: "https://windows.katsuvip.eu.cc/download/en_windows_server_2012_r2_vl_with_update_x64_dvd_6052766.iso",
      imageName: "Windows Server 2012 R2 SERVERSTANDARD"
    },
    {
      label: "Windows 11 IoT Ent 24H2",
      iso: "https://windows.katsuvip.eu.cc/download/en-us_windows_11_iot_enterprise_version_24h2_x64_dvd_3a99b72b.iso",
      imageName: "Windows 11 IoT Enterprise"
    },
    {
      label: "Windows 10 IoT Ent 22H2",
      iso: "https://windows.katsuvip.eu.cc/download/en-us_windows_10_iot_enterprise_version_22h2_x64_dvd_51cc370f.iso",
      imageName: "Windows 10 IoT Enterprise"
    }
  ]
};
