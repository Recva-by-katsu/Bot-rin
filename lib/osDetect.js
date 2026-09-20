/**
 * osDetect.js - Deteksi OS dari /etc/os-release
 */
async function detectOS(sshSession) {
  const res = await sshSession.exec('cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null');
  if (res.code !== 0) throw new Error('Gagal membaca /etc/os-release');
  const txt = res.stdout;
  const lines = txt.split('\n');
  let id = '';
  let versionId = '';
  let name = '';
  for (const line of lines) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (!m) continue;
    let k = m[1];
    let v = m[2].replace(/^"/, '').replace(/"$/, '');
    if (k === 'ID') id = v.toLowerCase();
    if (k === 'VERSION_ID') versionId = v;
    if (k === 'NAME') name = v;
  }
  return { id, versionId, name, raw: txt };
}

function isUbuntuDebian(id) {
  return ['ubuntu','debian'].includes(id);
}

module.exports = { detectOS, isUbuntuDebian };
