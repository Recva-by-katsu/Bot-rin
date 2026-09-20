/**
 * setupFlow.js - Alur Setup VPS Ubuntu/Debian (Aktifkan Password)
 */
const { detectOS, isUbuntuDebian } = require('./osDetect');
const sshd = require('./sshdConfig');
const { shellEscape } = require('./validators');

async function setupVpsFlow({ sshSession, targetUsername, password, isRootUser, progress }) {
  const steps = [
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
  // progress sudah disiapkan di luar, tapi kita update di sini
  let current = 0;
  function setRunning(detail='') { progress.setRunning(current, detail); }
  function setDone(detail='') { progress.setDone(current, detail); progress.setRunning(current+1); current++; }
  function setFail(detail='') { progress.setFail(current, detail); }

  let backupDir = `/tmp/sshd_backup_${Date.now()}`;
  let backupDone = false;
  let rollbackStatus = 'tidak diperlukan';

  try {
    // Step 0: Koneksi SSH (sudah terhubung sebelum masuk sini, tapi kita anggap done)
    if (progress.steps.length === 0) {
      for (const s of steps) progress.addStep(s);
    }
    progress.setRunning(0, 'terhubung');
    await progress.tickNow();
    progress.setDone(0, 'ok');
    current = 1;

    // Step 1: Deteksi OS
    progress.setRunning(1, 'baca /etc/os-release');
    await progress.tickNow();
    const os = await detectOS(sshSession);
    if (!isUbuntuDebian(os.id)) {
      progress.setFail(1, `OS ${os.id} tidak didukung`);
      throw new Error(`OS ${os.id} (${os.name}) tidak didukung. Hanya Ubuntu/Debian.`);
    }
    progress.setDone(1, `${os.id} ${os.versionId}`);
    current = 2;

    // Step 2: Backup
    progress.setRunning(2, 'backup config');
    await progress.tickNow();
    const isRoot = isRootUser || sshSession.username === 'root';
    const backupCmds = sshd.getBackupCommands(backupDir, isRoot);
    for (const cmd of backupCmds) {
      const res = await sshSession.exec(cmd);
      // ignore fail for cp
    }
    backupDone = true;
    rollbackStatus = 'siap rollback';
    progress.setDone(2, 'disimpan');
    current = 3;

    // Step 3: Perbaikan konfigurasi
    progress.setRunning(3, 'set PasswordAuthentication yes');
    await progress.tickNow();
    const fixScript = sshd.getFixCommands(isRoot);
    const resFix = await sshSession.exec(fixScript);
    if (resFix.code !== 0) {
      throw new Error(`Gagal perbaiki config: ${resFix.stderr.slice(0,200)}`);
    }
    progress.setDone(3, 'diperbaiki');
    current = 4;

    // Step 4: Validasi sshd -t
    progress.setRunning(4, 'sshd -t');
    await progress.tickNow();
    const validateCmd = sshd.getValidateCommand(isRoot);
    const resValidate = await sshSession.exec(validateCmd);
    if (resValidate.code !== 0) {
      // rollback
      progress.updateDetail(4, 'gagal, rollback');
      await progress.tickNow();
      const rollbackCmd = `${isRoot ? '' : 'sudo -n '}sh -c 'cp ${backupDir}/sshd_config /etc/ssh/sshd_config 2>/dev/null; cp ${backupDir}/*.conf /etc/ssh/sshd_config.d/ 2>/dev/null || true'`;
      await sshSession.exec(rollbackCmd);
      rollbackStatus = 'berhasil dipulihkan';
      throw new Error(`Validasi sshd -t gagal: ${resValidate.stderr.slice(0,200)}`);
    }
    progress.setDone(4, 'ok');
    current = 5;

    // Step 5: Restart
    progress.setRunning(5, 'restart ssh');
    await progress.tickNow();
    const restartScript = sshd.getRestartCommands(isRoot);
    const resRestart = await sshSession.exec(restartScript);
    if (resRestart.code !== 0) {
      // rollback
      const rollbackCmd = `${isRoot ? '' : 'sudo -n '}sh -c 'cp ${backupDir}/sshd_config /etc/ssh/sshd_config 2>/dev/null; cp ${backupDir}/*.conf /etc/ssh/sshd_config.d/ 2>/dev/null || true'`;
      await sshSession.exec(rollbackCmd);
      // coba restart lagi setelah rollback
      await sshSession.exec(restartScript);
      rollbackStatus = 'berhasil dipulihkan';
      throw new Error(`Gagal restart SSH: ${resRestart.stderr.slice(0,200)}`);
    }
    progress.setDone(5, 'restart ok');
    current = 6;

    // Step 6: Verifikasi efektif
    progress.setRunning(6, 'sshd -T');
    await progress.tickNow();
    const checkCmd = sshd.getCheckEffectiveCommand(isRoot);
    const resCheck = await sshSession.exec(checkCmd);
    if (resCheck.code !== 0) {
      const rollbackCmd = `${isRoot ? '' : 'sudo -n '}sh -c 'cp ${backupDir}/sshd_config /etc/ssh/sshd_config 2>/dev/null; cp ${backupDir}/*.conf /etc/ssh/sshd_config.d/ 2>/dev/null || true'`;
      await sshSession.exec(rollbackCmd);
      await sshSession.exec(restartScript);
      rollbackStatus = 'berhasil dipulihkan';
      throw new Error(`Gagal cek config efektif: ${resCheck.stderr.slice(0,200)}`);
    }
    const effective = resCheck.stdout.toLowerCase();
    if (!effective.includes('passwordauthentication yes')) {
      const rollbackCmd = `${isRoot ? '' : 'sudo -n '}sh -c 'cp ${backupDir}/sshd_config /etc/ssh/sshd_config 2>/dev/null; cp ${backupDir}/*.conf /etc/ssh/sshd_config.d/ 2>/dev/null || true'`;
      await sshSession.exec(rollbackCmd);
      await sshSession.exec(restartScript);
      rollbackStatus = 'berhasil dipulihkan';
      throw new Error('Konfigurasi efektif masih PasswordAuthentication no');
    }
    if (isRoot && !effective.includes('permitrootlogin yes')) {
      // Tidak fatal, tapi warning
    }
    progress.setDone(6, 'efektif ok');
    current = 7;

    // Step 7: Set password
    progress.setRunning(7, 'set password');
    await progress.tickNow();
    const userPass = `${targetUsername}:${password}`;
    const b64 = Buffer.from(userPass).toString('base64');
    const sudo = isRoot ? '' : 'sudo -n ';
    const setPassCmd = `echo ${shellEscape(b64)} | base64 -d | ${sudo}chpasswd`;
    const resPass = await sshSession.exec(setPassCmd);
    if (resPass.code !== 0) {
      throw new Error(`Gagal set password: ${resPass.stderr.slice(0,200)}`);
    }
    progress.setDone(7, 'password ok');
    current = 8;

    // Step 8: Tes ulang koneksi SSH
    progress.setRunning(8, 'tes koneksi');
    await progress.tickNow();
    const resTest = await sshSession.exec('whoami');
    if (resTest.code !== 0) {
      throw new Error(`Tes koneksi gagal: ${resTest.stderr.slice(0,200)}`);
    }
    progress.setDone(8, `login sebagai ${resTest.stdout.trim()}`);
    rollbackStatus = 'tidak diperlukan';

    return { success: true, os, backupDir, rollbackStatus };

  } catch (err) {
    if (current < steps.length) {
      progress.setFail(current, err.message.slice(0,42));
    }
    return { success: false, error: err.message, backupDir, rollbackStatus, backupDone };
  }
}

module.exports = { setupVpsFlow };
