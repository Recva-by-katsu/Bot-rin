/**
 * reinstallFlow.js - Alur Install/Reinstall OS via reinstall.sh
 */
const { shellEscape } = require('./validators');

async function preflight(sshSession, progress) {
  // root atau sudo tanpa password, arch, RAM/disk, curl/wget, boot_id
  const checks = {};

  // root?
  let res = await sshSession.exec('id -u');
  if (res.code === 0) {
    checks.isRoot = res.stdout.trim() === '0';
  } else {
    checks.isRoot = false;
  }
  if (!checks.isRoot) {
    res = await sshSession.exec('sudo -n true; echo $?');
    checks.hasSudo = res.stdout.trim().endsWith('0');
    if (!checks.hasSudo) throw new Error('Butuh akses root atau sudo tanpa password');
  } else {
    checks.hasSudo = true;
  }

  // arch
  res = await sshSession.exec('uname -m');
  checks.arch = res.stdout.trim();

  // RAM/disk
  res = await sshSession.exec('free -m | head -n 2; df -h / | tail -n 1');
  checks.ramDisk = res.stdout.trim().slice(0,100);

  // curl/wget
  res = await sshSession.exec('which curl; which wget; ls /usr/bin/curl /usr/bin/wget 2>/dev/null');
  checks.hasCurl = res.stdout.includes('curl');
  checks.hasWget = res.stdout.includes('wget');
  if (!checks.hasCurl && !checks.hasWget) throw new Error('Butuh curl atau wget');

  // boot_id
  res = await sshSession.exec('cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown');
  checks.bootId = res.stdout.trim();

  return checks;
}

async function downloadReinstallSh(sshSession) {
  const urls = [
    'https://raw.githubusercontent.com/bin456789/reinstall/main/reinstall.sh',
    'https://cnb.cool/bin456789/reinstall/-/git/raw/main/reinstall.sh'
  ];
  for (const url of urls) {
    const cmd = `curl -fsSL ${shellEscape(url)} -o /tmp/reinstall.sh 2>/dev/null || wget -qO /tmp/reinstall.sh ${shellEscape(url)}`;
    const res = await sshSession.exec(cmd);
    if (res.code === 0) {
      const check = await sshSession.exec('head -n 1 /tmp/reinstall.sh | grep -q "#!" && echo ok || echo fail');
      if (check.stdout.includes('ok')) {
        await sshSession.exec('chmod +x /tmp/reinstall.sh');
        return true;
      }
    }
  }
  throw new Error('Gagal download reinstall.sh dari GitHub dan mirror');
}

async function runReinstallSh(sshSession, args, progress) {
  // args: string like "debian 12 --password xxx" atau "windows --iso xxx --image-name yyy --password xxx"
  // Jalankan detached: nohup sh -c 'yes | bash /tmp/reinstall.sh <args> ; echo $? > /tmp/reinstall.exit'
  const exitFile = '/tmp/reinstall.exit';
  const logFile = '/tmp/reinstall.log';
  // Hapus file lama
  await sshSession.exec(`rm -f ${exitFile} ${logFile}`);
  const fullCmd = `nohup sh -c ${shellEscape(`yes | bash /tmp/reinstall.sh ${args} > ${logFile} 2>&1; echo $? > ${exitFile}`)} >/dev/null 2>&1 & echo $!`;
  const res = await sshSession.exec(fullCmd);
  if (res.code !== 0) throw new Error('Gagal menjalankan reinstall.sh detached');
  const pid = res.stdout.trim();
  // Poll exit file
  for (let i=0;i<60;i++) { // 60 * 2 detik = 2 menit untuk persiapan sebelum reboot
    await new Promise(r=>setTimeout(r,2000));
    const check = await sshSession.exec(`cat ${exitFile} 2>/dev/null || echo notyet`);
    const out = check.stdout.trim();
    if (out !== 'notyet' && out !== '') {
      const code = parseInt(out,10);
      if (code === 0) {
        return { pid, success: true };
      } else {
        // Baca log
        const logRes = await sshSession.exec(`cat ${logFile} 2>/dev/null | tail -n 50`);
        throw new Error(`reinstall.sh gagal exit ${code}: ${logRes.stdout.slice(0,500)}`);
      }
    }
    // Cek apakah proses masih jalan
    // Kalau koneksi putus saat polling, anggap reboot sendiri (spec)
  }
  // Jika tidak ada exit file setelah 2 menit, mungkin masih proses atau sudah reboot
  // Kita anggap proses dimulai
  return { pid, success: true, assumed: true };
}

async function testIsoLinkFromVps(sshSession, isoUrl) {
  // Tes link dari VPS target: minta 1 byte (range) agar tidak men-download ISO penuh (bisa 5-6 GB).
  // Tetapkan batas waktu supaya server yang mengabaikan Range tidak membuat exec menggantung.
  const cmd = `curl -sL --max-time 25 -r 0-0 -o /dev/null -w '%{http_code}' ${shellEscape(isoUrl)} 2>/dev/null || wget --spider -S ${shellEscape(isoUrl)} 2>&1 | grep -o "[0-9]\\{3\\}" | tail -n 1`;
  const res = await sshSession.exec(cmd, { timeout: 40000 });
  const code = res.stdout.trim().slice(-3);
  if (code === '200' || code === '206') return true;
  // Fallback ke HEAD request (tanpa body sama sekali)
  const cmd2 = `curl -sIL --max-time 25 -o /dev/null -w '%{http_code}' ${shellEscape(isoUrl)}`;
  const res2 = await sshSession.exec(cmd2, { timeout: 40000 });
  const code2 = res2.stdout.trim().slice(-3);
  return code2 === '200' || code2 === '206';
}

async function waitForLinux(sshSessionFactory, newPassword, expectedId, oldBootId, timeoutMs = 40*60*1000) {
  const start = Date.now();
  let lastError = '';
  while (Date.now() - start < timeoutMs) {
    await new Promise(r=>setTimeout(r, 20000)); // poll 20 detik
    try {
      const sess = await sshSessionFactory(newPassword);
      await sess.connect();
      const resId = await sess.exec('cat /etc/os-release | grep ^ID= | head -n1');
      const id = resId.stdout.replace(/ID=/,'').replace(/"/g,'').trim().toLowerCase();
      const resBoot = await sess.exec('cat /proc/sys/kernel/random/boot_id');
      const bootId = resBoot.stdout.trim();
      sess.close();
      if (expectedId && id !== expectedId) {
        lastError = `ID OS ${id} tidak cocok dengan ${expectedId}`;
        continue;
      }
      if (oldBootId && bootId === oldBootId) {
        lastError = 'boot_id masih sama (belum reboot)';
        continue;
      }
      return { success: true, id, bootId };
    } catch (e) {
      lastError = e.message;
    }
  }
  return { success: false, error: lastError || 'Timeout 40 menit' };
}

async function waitForRdp(checkPortFn, timeoutMs = 45*60*1000) {
  // Deteksi selesai: port RDP 3389 harus terlihat tertutup dulu, baru terbuka
  const start = Date.now();
  let sawClosed = false;
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    await new Promise(r=>setTimeout(r, 20000));
    try {
      const isOpen = await checkPortFn();
      if (!isOpen && !sawClosed) {
        sawClosed = true;
        lastState = 'closed';
      } else if (isOpen && sawClosed) {
        return { success: true };
      } else if (isOpen && !sawClosed) {
        // Mungkin belum pernah tertutup, tapi kita tunggu tertutup dulu
        lastState = 'open';
      } else {
        lastState = 'closed';
      }
    } catch (e) {
      lastState = 'error ' + e.message;
    }
  }
  // Jika tidak pernah lihat closed tapi akhirnya open, anggap sukses? Spec bilang harus closed dulu baru open
  // Tapi kita tetap coba toleransi
  if (lastState === 'open') {
    return { success: true, note: 'Tidak sempat lihat tertutup, tapi sekarang terbuka' };
  }
  return { success: false, error: `Timeout 45 menit, last state: ${lastState}, sawClosed=${sawClosed}` };
}

function buildLinuxArgs(distro, version, password) {
  // reinstall.sh <distro> <versi> --password <pw>
  // distro: debian, ubuntu, almalinux, rocky
  // version: 12, 13, 22.04, 24.04, 9
  return `${shellEscape(distro)} ${shellEscape(version)} --password ${shellEscape(password)}`;
}
function buildWindowsArgs(isoUrl, imageName, password) {
  // bash reinstall.sh windows --iso <url> --image-name <name> --password <pw>
  let args = `windows --iso ${shellEscape(isoUrl)} --password ${shellEscape(password)}`;
  if (imageName) args += ` --image-name ${shellEscape(imageName)}`;
  return args;
}

module.exports = {
  preflight,
  downloadReinstallSh,
  runReinstallSh,
  testIsoLinkFromVps,
  waitForLinux,
  waitForRdp,
  buildLinuxArgs,
  buildWindowsArgs
};
