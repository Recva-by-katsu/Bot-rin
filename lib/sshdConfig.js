/**
 * sshdConfig.js - Helper untuk perbaikan sshd_config
 *
 * Logika perbaikan dijalankan di VPS target lewat SSH, bukan di sini.
 * File ini menghasilkan script POSIX sh yang idempotent.
 *
 * ⚠️ ATURAN PENTING SAAT MENGEDIT FILE INI
 * 1. Script shell di bawah dibangun dari string JavaScript. Variabel shell
 *    (`$file`, `$1`, `$?`, ...) TIDAK BOLEH kena interpolasi JavaScript:
 *    pakai string biasa '...' (bukan backtick), atau escape jadi \${nama}.
 *    Melanggar ini bikin Node melempar `ReferenceError: <nama> is not defined`
 *    dan alur "Aktifkan Password" / "Buat VPS (mode password)" gagal SETELAH
 *    server jadi — VPS terlanjur ada dan ditagih. (Inilah bug yang dulu
 *    memunculkan error "Setup password gagal: key is not defined".)
 * 2. Jangan pakai exit code awk sebagai sinyal "sudah ada/belum": mawk (awk
 *    default Ubuntu/Debian) keluar dengan code 2 untuk error fatal, dan `exit`
 *    di dalam rule tetap menjalankan blok END sehingga exit code-nya ditimpa.
 * 3. Jangan menaruh literal ber-awalan "#" di tengah konkatenasi string awk:
 *    mawk 1.3.4 salah me-lex dan "\n" di sebelahnya ikut hilang.
 * Ketiganya ada regression test-nya di tests/run.js.
 *
 * Dasar desain (perilaku sshd sungguhan):
 * - Keyword yang dibaca PERTAMA yang menang (first-obtained wins), termasuk
 *   dari `Include /etc/ssh/sshd_config.d/*.conf` di baris atas. Jadi
 *   memperbaiki satu tempat saja tidak cukup: config utama DAN semua drop-in
 *   harus konsisten, plus bot menulis drop-in sendiri ber-awalan 00-.
 * - Keyword di dalam blok `Match` hanya berlaku untuk match itu, jadi baris di
 *   dalam blok Match sengaja tidak disentuh.
 */

const { shellEscape } = require('./validators');

const MAIN_CONFIG = '/etc/ssh/sshd_config';
const DROPIN_DIR = '/etc/ssh/sshd_config.d';
// Drop-in milik bot: awalan 00- membuatnya di-load paling awal sehingga menang
// atas drop-in bawaan image (50-cloud-init.conf, 60-cloudimg-settings.conf, ...).
const DROPIN_NAME = '00-bot-allow-password.conf';

/**
 * Normalisasi opsi path. Dipakai test agar script yang sama bisa dijalankan
 * terhadap fixture lokal (bukan /etc/ssh sungguhan).
 */
function resolveOpts(opts) {
  opts = opts || {};
  const cfgDir = opts.configDir || '/etc/ssh';
  const dropinDir = opts.dropinDir || (cfgDir + '/sshd_config.d');
  return {
    cfgDir: cfgDir,
    main: opts.mainConfig || (cfgDir + '/sshd_config'),
    dropinDir: dropinDir,
    dropin: opts.dropinFile || (dropinDir + '/' + DROPIN_NAME),
    // sshd -t / -T butuh minimal satu HostKey saat diuji di luar server nyata
    hostKeyArgs: opts.hostKey ? (' -h ' + opts.hostKey) : ''
  };
}

function sudoPrefix(isRoot) {
  return isRoot ? '' : 'sudo -n ';
}

function getBackupCommands(backupDir, isRoot, opts) {
  const o = resolveOpts(opts);
  const sudo = sudoPrefix(isRoot);
  return [
    sudo + 'mkdir -p ' + backupDir,
    sudo + 'cp ' + o.main + ' ' + backupDir + '/sshd_config 2>/dev/null || true',
    sudo + "sh -c 'cp " + o.dropinDir + '/*.conf ' + backupDir + "/ 2>/dev/null || true'"
  ];
}

/**
 * Perintah rollback: buang drop-in milik bot, pulihkan config utama + drop-in
 * dari backup. Dipakai saat `sshd -t` gagal atau hasil `sshd -T` masih
 * `passwordauthentication no`.
 */
function getRollbackCommands(backupDir, isRoot, opts) {
  const o = resolveOpts(opts);
  const sudo = sudoPrefix(isRoot);
  return sudo + "sh -c 'rm -f " + o.dropin + ' 2>/dev/null || true; cp ' + backupDir + '/sshd_config ' + o.main + ' 2>/dev/null || true; mkdir -p ' + o.dropinDir + ' 2>/dev/null || true; cp ' + backupDir + '/*.conf ' + o.dropinDir + "/ 2>/dev/null || true'";
}

/**
 * Program awk #1 - cek apakah file sudah punya baris keyword di scope global
 * (sebelum blok Match pertama).
 * exit 3 = ada, exit 0 = tidak ada. Code 3 dipilih karena beda dari code error
 * fatal awk (mawk memakai 2), jadi tidak mungkin salah tafsir.
 */
function awkHasGlobalProgram() {
  // `exit` di dalam rule TETAP menjalankan blok END, dan exit code dari END-lah
  // yang dipakai. Jadi statusnya disimpan di variabel `found` dulu; kalau
  // langsung `exit 3` di rule, `END { exit 0 }` menimpanya sehingga hasilnya
  // selalu "belum ada" -> baris disisipkan lagi tiap dijalankan (tidak
  // idempotent, sshd_config makin panjang setiap retry).
  return [
    'BEGIN { k = KEY; inmatch = 0; found = 0 }',
    '{',
    '  line = $0',
    '  if (line ~ /^[ \t]*[Mm][Aa][Tt][Cc][Hh]([ \t]|$)/) inmatch = 1',
    '  if (!inmatch) {',
    '    t = line',
    '    sub(/^[ \t]+/, "", t)',
    '    if (t == k || t ~ ("^" k "[ \t]+")) { found = 1; exit }',
    '  }',
    '}',
    'END { exit (found ? 3 : 0) }'
  ].join('\n');
}

/**
 * Program awk #2 - tulis ulang file dengan keyword global yang sudah
 * dinormalkan:
 *   - occurrence global pertama  -> jadi "Key value"
 *   - occurrence global berikut  -> dihapus (duplikat bikin hasil ambigu)
 *   - baris di dalam blok Match  -> dibiarkan apa adanya
 * Output murni isi file baru, tanpa exit code khusus dan tanpa baris penanda.
 */
function awkFixProgram() {
  return [
    'BEGIN { k = KEY; v = VALUE; done = 0; inmatch = 0 }',
    '{',
    '  line = $0',
    '  if (line ~ /^[ \t]*[Mm][Aa][Tt][Cc][Hh]([ \t]|$)/) inmatch = 1',
    '  if (!inmatch) {',
    '    t = line',
    '    sub(/^[ \t]+/, "", t)',
    '    if (t == k || t ~ ("^" k "[ \t]+")) {',
    '      if (done == 0) {',
    '        print k " " v',
    '        done = 1',
    '      }',
    '      next',
    '    }',
    '  }',
    '  print line',
    '}'
  ].join('\n');
}

/**
 * Fungsi shell `ensure_global <file> <Key> <value>`: pastikan keyword bernilai
 * `value` di scope global file. Kalau belum ada, barisnya disisipkan tepat
 * setelah baris `Include` terakhir (agar tetap menang atas drop-in), atau di
 * baris 1 kalau file tidak punya Include.
 *
 * Semua operasi yang butuh privilese memakai `$SUDO` (kosong saat root) supaya
 * alur "Aktifkan Password" juga jalan untuk user non-root seperti ubuntu/debian.
 */
function shFnEnsureGlobal() {
  return [
    'ensure_global() {',
    '  eg_file="$1"',
    '  eg_key="$2"',
    '  eg_value="$3"',
    '  [ -f "$eg_file" ] || return 0',
    '  case "$eg_key" in',
    '    *[!A-Za-z0-9]*|"") echo "keyword tidak valid: $eg_key" >&2; return 2 ;;',
    '  esac',
    '  $SUDO awk -v KEY="$eg_key" "$AWK_HAS_PROG" "$eg_file"',
    '  eg_has=$?',
    // Hanya 0 dan 3 yang sah; selain itu awk-nya error (mis. file tidak terbaca)
    '  if [ "$eg_has" -ne 3 ] && [ "$eg_has" -ne 0 ]; then',
    '    echo "cek keyword $eg_key gagal (rc=$eg_has) di $eg_file" >&2',
    '    return 1',
    '  fi',
    '  if [ "$eg_has" -eq 3 ]; then',
    '    if ! $SUDO awk -v KEY="$eg_key" -v VALUE="$eg_value" "$AWK_FIX_PROG" "$eg_file" > "$BOT_TMP"; then',
    '      echo "awk gagal menormalkan $eg_file" >&2',
    '      return 1',
    '    fi',
    '    if [ ! -s "$BOT_TMP" ]; then',
    '      echo "hasil awk kosong untuk $eg_file, dibatalkan" >&2',
    '      return 1',
    '    fi',
    // cp (bukan mv/redirect) supaya owner & mode file tujuan tetap, dan tetap
    // bisa jalan lewat sudo.
    '    $SUDO cp "$BOT_TMP" "$eg_file" || return 1',
    '    return 0',
    '  fi',
    '  eg_last=$(grep -n "^[[:space:]]*[Ii]nclude" "$eg_file" 2>/dev/null | tail -n 1 | cut -d: -f1)',
    '  if [ -n "$eg_last" ]; then',
    '    $SUDO sed -i "${eg_last}a\\',
    '$eg_key $eg_value" "$eg_file" || return 1',
    '  else',
    '    $SUDO sed -i "1i\\',
    '$eg_key $eg_value" "$eg_file" || return 1',
    '  fi',
    '}'
  ].join('\n');
}

/**
 * Script idempotent untuk mengaktifkan login password (dan root login kalau
 * sesinya root).
 * @param {boolean} isRoot - true kalau sesi SSH adalah root (tanpa sudo)
 * @param {object} [opts] - override path, dipakai test
 * @returns {string} script POSIX sh
 */
function getFixCommands(isRoot, opts) {
  const o = resolveOpts(opts);

  const dropinLines = ['PasswordAuthentication yes'];
  if (isRoot) dropinLines.push('PermitRootLogin yes');
  // printf '%s\n' 'a' 'b' -> tiap argumen jadi satu baris
  const printfArgs = dropinLines.map(function (l) { return shellEscape(l); }).join(' ');

  // Program awk ditempel inline sebagai literal single-quote shell (lewat
  // shellEscape) sehingga tidak perlu file sementara di /tmp: tidak ada risiko
  // symlink attack saat script jalan sebagai root, dan tidak ada yang perlu
  // dibersihkan.
  const awkHasLit = shellEscape(awkHasGlobalProgram());
  const awkFixLit = shellEscape(awkFixProgram());

  const L = [];
  L.push('# === Script perbaikan sshd (dibuat bot, idempotent) ===');
  L.push('SUDO=' + shellEscape(sudoPrefix(isRoot).trim()));
  L.push('AWK_HAS_PROG=' + awkHasLit);
  L.push('AWK_FIX_PROG=' + awkFixLit);
  // File sementara untuk hasil tulis ulang config. mktemp membuat file 0600
  // milik pemanggil dengan nama acak (aman dari symlink attack), dan trap
  // membersihkannya apa pun hasil scriptnya.
  L.push('BOT_TMP=$(mktemp "${TMPDIR:-/tmp}/bot_sshd_XXXXXX" 2>/dev/null) || BOT_TMP=""');
  L.push('if [ -z "$BOT_TMP" ]; then');
  L.push('  echo "gagal membuat file sementara" >&2');
  L.push('  exit 1');
  L.push('fi');
  L.push('trap \'rm -f "$BOT_TMP"\' EXIT HUP INT TERM');
  L.push('');
  L.push(shFnEnsureGlobal());
  L.push('');
  L.push('# 1) Drop-in milik bot (paling awal di-load, jadi nilai ini yang menang)');
  L.push('$SUDO mkdir -p ' + o.dropinDir + ' 2>/dev/null || true');
  L.push('if [ -d ' + o.dropinDir + ' ]; then');
  L.push('  printf \'%s\\n\' ' + printfArgs + ' > "$BOT_TMP" || { echo "gagal siapkan drop-in bot" >&2; exit 1; }');
  L.push('  $SUDO cp "$BOT_TMP" ' + o.dropin + ' || { echo "gagal tulis ' + o.dropin + '" >&2; exit 1; }');
  L.push('  $SUDO chmod 0644 ' + o.dropin + ' 2>/dev/null || true');
  L.push('fi');
  L.push('');
  L.push('# 2) Config utama');
  L.push('ensure_global ' + o.main + ' PasswordAuthentication yes');
  if (isRoot) L.push('ensure_global ' + o.main + ' PermitRootLogin yes');
  L.push('');
  L.push('# 3) Semua drop-in lain: nilai pertama yang dibaca sshd yang menang,');
  L.push('#    jadi "PasswordAuthentication no" bawaan image wajib ikut dibetulkan.');
  L.push('for f in ' + o.dropinDir + '/*.conf; do');
  L.push('  [ -f "$f" ] || continue');
  L.push('  [ "$f" = "' + o.dropin + '" ] && continue');
  L.push('  if grep -qiE "^[[:space:]]*#?[[:space:]]*PasswordAuthentication([[:space:]]|$)" "$f"; then');
  L.push('    ensure_global "$f" PasswordAuthentication yes');
  L.push('  fi');
  if (isRoot) {
    L.push('  if grep -qiE "^[[:space:]]*#?[[:space:]]*PermitRootLogin([[:space:]]|$)" "$f"; then');
    L.push('    ensure_global "$f" PermitRootLogin yes');
    L.push('  fi');
  }
  L.push('done');
  L.push('');
  L.push('# 4) Tandai sukses');
  L.push('echo "sshd config diperbaiki"');
  L.push('exit 0');
  return L.join('\n') + '\n';
}

function getValidateCommand(isRoot, opts) {
  const o = resolveOpts(opts);
  const sudo = sudoPrefix(isRoot);
  const target = (opts && (opts.mainConfig || opts.configDir)) ? (' -f ' + o.main + o.hostKeyArgs) : '';
  return sudo + 'sshd -t' + target;
}

function getRestartCommands(isRoot) {
  const sudo = sudoPrefix(isRoot);
  return [
    'if ' + sudo + 'systemctl restart ssh 2>/dev/null; then',
    '  echo "restarted ssh via systemctl"',
    'elif ' + sudo + 'systemctl restart sshd 2>/dev/null; then',
    '  echo "restarted sshd via systemctl"',
    'elif ' + sudo + 'service ssh restart 2>/dev/null; then',
    '  echo "restarted ssh via service"',
    'elif ' + sudo + 'service sshd restart 2>/dev/null; then',
    '  echo "restarted sshd via service"',
    'else',
    '  echo "gagal restart" >&2',
    '  exit 1',
    'fi'
  ].join('\n') + '\n';
}

function getCheckEffectiveCommand(isRoot, opts) {
  const o = resolveOpts(opts);
  const sudo = sudoPrefix(isRoot);
  const target = (opts && (opts.mainConfig || opts.configDir)) ? (' -f ' + o.main + o.hostKeyArgs) : '';
  return sudo + 'sshd -T' + target;
}

module.exports = {
  MAIN_CONFIG: MAIN_CONFIG,
  DROPIN_DIR: DROPIN_DIR,
  DROPIN_NAME: DROPIN_NAME,
  DROPIN_FILE: DROPIN_DIR + '/' + DROPIN_NAME,
  resolveOpts: resolveOpts,
  awkHasGlobalProgram: awkHasGlobalProgram,
  awkFixProgram: awkFixProgram,
  getBackupCommands: getBackupCommands,
  getRollbackCommands: getRollbackCommands,
  getFixCommands: getFixCommands,
  getValidateCommand: getValidateCommand,
  getRestartCommands: getRestartCommands,
  getCheckEffectiveCommand: getCheckEffectiveCommand
};
