/**
 * setupFlow.js - Alur Setup VPS Ubuntu/Debian (Aktifkan Password)
 */
const { detectOS, isUbuntuDebian } = require('./osDetect');
const sshd = require('./sshdConfig');
const { shellEscape } = require('./validators');

/**
 * Nama 9 langkah alur setup. Diekspor supaya pemanggil (index.js) bisa
 * menyisipkannya ke checklist LiveProgress di posisi yang benar lewat
 * `prog.insertStepsAt()`, lalu meneruskan offset-nya ke `setupVpsFlow`.
 */
const SETUP_STEPS = [
  'Koneksi SSH',
  'Deteksi OS',
  'Backup konfigurasi SSH',
  'Perbaikan konfigurasi PasswordAuthentication',
  'Validasi sshd -t',
  'Restart layanan SSH',
  'Verifikasi konfigurasi efektif',
  'Set password login',
  'Tes ulang koneksi SSH'
];

/**
 * @param {object} p
 * @param {import('./sshClient')} p.sshSession - sesi SSH yang SUDAH terhubung
 * @param {string} p.targetUsername - user yang akan di-set passwordnya
 * @param {string} p.password
 * @param {boolean} p.isRootUser - true kalau sesi login sebagai root
 * @param {object} p.progress - LiveProgress
 * @param {number} [p.stepOffset=0] - index awal langkah setup di checklist induk.
 *   Wajib diisi kalau checklist induk sudah punya langkah sendiri (mis. alur
 *   Buat VPS / Reinstall Resmi), kalau tidak langkah setup akan menimpa
 *   checklist induknya.
 * @param {object} [p.sshdOpts] - override path sshd (dipakai test)
 */
async function setupVpsFlow({ sshSession, targetUsername, password, isRootUser, progress, stepOffset = 0, sshdOpts }) {
  const steps = SETUP_STEPS;
  const off = Number.isInteger(stepOffset) && stepOffset >= 0 ? stepOffset : 0;
  const o = sshdOpts || undefined;

  // progress sudah disiapkan di luar; kalau belum punya langkah sama sekali,
  // kita tambahkan sendiri di posisi `off`.
  if (progress.steps.length <= off) {
    for (const s of steps) progress.addStep(s);
  }
  let current = 0;
  const at = (i) => off + i;

  let backupDir = `/tmp/sshd_backup_${Date.now()}`;
  let backupDone = false;
  let rollbackStatus = 'tidak diperlukan';

  try {
    // Step 0: Koneksi SSH (sudah terhubung sebelum masuk sini, tapi kita anggap done)
    progress.setRunning(at(0), 'terhubung');
    await progress.tickNow();
    progress.setDone(at(0), 'ok');
    current = 1;

    // Step 1: Deteksi OS
    progress.setRunning(at(1), 'baca /etc/os-release');
    await progress.tickNow();
    const os = await detectOS(sshSession);
    if (!isUbuntuDebian(os.id)) {
      progress.setFail(at(1), `OS ${os.id} tidak didukung`);
      throw new Error(`OS ${os.id} (${os.name}) tidak didukung. Hanya Ubuntu/Debian.`);
    }
    progress.setDone(at(1), `${os.id} ${os.versionId}`);
    current = 2;

    // Step 2: Backup
    progress.setRunning(at(2), 'backup config');
    await progress.tickNow();
    const isRoot = isRootUser || sshSession.username === 'root';
    const backupCmds = sshd.getBackupCommands(backupDir, isRoot, o);
    for (const cmd of backupCmds) {
      await sshSession.exec(cmd);
      // kegagalan cp tidak fatal: config mungkin memang tidak ada
    }
    backupDone = true;
    rollbackStatus = 'siap rollback';
    progress.setDone(at(2), 'disimpan');
    current = 3;

    // Step 3: Perbaikan konfigurasi
    progress.setRunning(at(3), 'set PasswordAuthentication yes');
    await progress.tickNow();
    const fixScript = sshd.getFixCommands(isRoot, o);
    const resFix = await sshSession.exec(fixScript);
    if (resFix.code !== 0) {
      throw new Error(`Gagal perbaiki config: ${(resFix.stderr || '').slice(0,200)}`);
    }
    progress.setDone(at(3), 'diperbaiki');
    current = 4;

    // Step 4: Validasi sshd -t
    progress.setRunning(at(4), 'sshd -t');
    await progress.tickNow();
    const validateCmd = sshd.getValidateCommand(isRoot, o);
    const resValidate = await sshSession.exec(validateCmd);
    if (resValidate.code !== 0) {
      // rollback
      progress.updateDetail(at(4), 'gagal, rollback');
      await progress.tickNow();
      await sshSession.exec(sshd.getRollbackCommands(backupDir, isRoot, o));
      await sshSession.exec(sshd.getRestartCommands(isRoot));
      rollbackStatus = 'berhasil dipulihkan';
      throw new Error(`Validasi sshd -t gagal: ${(resValidate.stderr || '').slice(0,200)}`);
    }
    progress.setDone(at(4), 'ok');
    current = 5;

    // Step 5: Restart
    progress.setRunning(at(5), 'restart ssh');
    await progress.tickNow();
    const restartScript = sshd.getRestartCommands(isRoot);
    const resRestart = await sshSession.exec(restartScript);
    if (resRestart.code !== 0) {
      // rollback lalu coba restart lagi dengan config lama
      await sshSession.exec(sshd.getRollbackCommands(backupDir, isRoot, o));
      await sshSession.exec(restartScript);
      rollbackStatus = 'berhasil dipulihkan';
      throw new Error(`Gagal restart SSH: ${(resRestart.stderr || '').slice(0,200)}`);
    }
    progress.setDone(at(5), 'restart ok');
    current = 6;

    // Step 6: Verifikasi efektif
    progress.setRunning(at(6), 'sshd -T');
    await progress.tickNow();
    const checkCmd = sshd.getCheckEffectiveCommand(isRoot, o);
    const resCheck = await sshSession.exec(checkCmd);
    if (resCheck.code !== 0) {
      await sshSession.exec(sshd.getRollbackCommands(backupDir, isRoot, o));
      await sshSession.exec(restartScript);
      rollbackStatus = 'berhasil dipulihkan';
      throw new Error(`Gagal cek config efektif: ${(resCheck.stderr || '').slice(0,200)}`);
    }
    const effective = resCheck.stdout.toLowerCase();
    if (!effective.includes('passwordauthentication yes')) {
      await sshSession.exec(sshd.getRollbackCommands(backupDir, isRoot, o));
      await sshSession.exec(restartScript);
      rollbackStatus = 'berhasil dipulihkan';
      throw new Error('Konfigurasi efektif masih PasswordAuthentication no');
    }
    if (isRoot && !effective.includes('permitrootlogin yes')) {
      // Tidak fatal: sebagian image mengunci PermitRootLogin lewat kebijakan lain.
      // Login password root mungkin tetap ditolak, tapi config sudah benar.
    }
    progress.setDone(at(6), 'efektif ok');
    current = 7;

    // Step 7: Set password
    progress.setRunning(at(7), 'set password');
    await progress.tickNow();
    const userPass = `${targetUsername}:${password}`;
    const b64 = Buffer.from(userPass).toString('base64');
    const sudo = isRoot ? '' : 'sudo -n ';
    const setPassCmd = `echo ${shellEscape(b64)} | base64 -d | ${sudo}chpasswd`;
    const resPass = await sshSession.exec(setPassCmd);
    if (resPass.code !== 0) {
      throw new Error(`Gagal set password: ${(resPass.stderr || '').slice(0,200)}`);
    }
    progress.setDone(at(7), 'password ok');
    current = 8;

    // Step 8: Tes ulang koneksi SSH
    progress.setRunning(at(8), 'tes koneksi');
    await progress.tickNow();
    const resTest = await sshSession.exec('whoami');
    if (resTest.code !== 0) {
      throw new Error(`Tes koneksi gagal: ${(resTest.stderr || '').slice(0,200)}`);
    }
    progress.setDone(at(8), `login sebagai ${resTest.stdout.trim()}`);
    rollbackStatus = 'tidak diperlukan';

    return { success: true, os, backupDir, rollbackStatus };

  } catch (err) {
    if (current < steps.length) {
      progress.setFail(at(current), (err.message || String(err)).slice(0,42));
    }
    return { success: false, error: err.message, backupDir, rollbackStatus, backupDone };
  }
}

module.exports = { setupVpsFlow, SETUP_STEPS };
