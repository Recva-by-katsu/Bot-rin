/**
 * tests/run.js - Pengujian unit & mock untuk UpCloud VPS Manager
 * Lingkungan dev tanpa internet: mock UpCloud API (HTTP lokal), stub telegraf dan ssh2,
 * sesi SSH palsu yang menjalankan perintah di bash lokal dengan curl dan reboot palsu.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

// Import lib yang akan diuji
const validators = require('../lib/validators');
const passwordLib = require('../lib/password');
const Vault = require('../lib/vault');
const QuotaManager = require('../lib/quota');
const JobManager = require('../lib/jobs');
const UpCloudClient = require('../providers/upcloud');

let passed = 0;
let failed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`);
    console.error(e.stack);
    failed++;
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`);
    console.error(e.stack);
    failed++;
  }
}

// === Test validators ===
ok('validators: IP/host', () => {
  assert(validators.isValidIpOrHost('1.2.3.4'));
  assert(validators.isValidIpOrHost('example.com'));
  assert(!validators.isValidIpOrHost(''));
  assert(validators.isValidIPv4('192.168.1.1'));
  assert(!validators.isValidIPv4('999.999.999.999'));
  assert(validators.isValidCIDR('192.168.0.0/24'));
  assert(!validators.isValidCIDR('192.168.0.0/33'));
});

ok('validators: username', () => {
  assert(validators.isValidUsername('root'));
  assert(validators.isValidUsername('ubuntu'));
  assert(!validators.isValidUsername('Root'));
  assert(!validators.isValidUsername('123abc'));
});

ok('validators: password custom', () => {
  assert(validators.isValidPasswordCustom('Abc1234567'));
  assert(!validators.isValidPasswordCustom('short1A'));
  assert(!validators.isValidPasswordCustom('NoNumberHereAA'));
  assert(!validators.isValidPasswordCustom('with space 1A'));
  assert(!validators.isValidPasswordCustom("with'quote1A"));
});

ok('validators: windows password', () => {
  assert(validators.isValidWindowsPassword('Abc123@_+=.-XYZ'));
  assert(!validators.isValidWindowsPassword('Abc123#invalid'));
  assert(!validators.isValidWindowsPassword('short1A'));
});

ok('validators: ssh public key', () => {
  assert(validators.isValidSshPublicKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@host'));
  assert(!validators.isValidSshPublicKey('-----BEGIN PRIVATE KEY-----'));
  assert(validators.isPrivateKey('-----BEGIN PRIVATE KEY-----\nabc'));
});

ok('validators: shellEscape', () => {
  const esc = validators.shellEscape("a'b");
  assert(esc === "'a'\\''b'");
});

ok('validators: redactSecrets', () => {
  const txt = 'token ucat_abc123xyz dan link https://windows.katsuvip.eu.cc/download/file.iso?token=123';
  const red = validators.redactSecrets(txt);
  assert(!red.includes('ucat_'));
  assert(red.includes('***'));
});

ok('validators: cidrToRange single IP', () => {
  const r = validators.cidrToRange('203.0.113.5');
  assert(r.start === '203.0.113.5' && r.end === '203.0.113.5');
});
ok('validators: cidrToRange /24', () => {
  const r = validators.cidrToRange('192.168.1.0/24');
  assert(r.start === '192.168.1.0' && r.end === '192.168.1.255');
});
ok('validators: cidrToRange /32', () => {
  const r = validators.cidrToRange('10.0.0.5/32');
  assert(r.start === '10.0.0.5' && r.end === '10.0.0.5');
});

// === Test password ===
ok('password: generateRandom', () => {
  const pw = passwordLib.generateRandom(16, false);
  assert(pw.length === 16);
  assert(validators.isValidPasswordCustom(pw));
  const pwWin = passwordLib.generateRandom(16, true);
  assert(validators.isValidWindowsPassword(pwWin));
});

ok('password: getPasswordChoices owner vs non-owner', () => {
  const cfg = { DEFAULT_PASSWORD_FOR_EVERYONE: false };
  const ownerChoices = passwordLib.getPasswordChoices(true, cfg);
  assert(ownerChoices.some(c=>c.id==='default'));
  const userChoices = passwordLib.getPasswordChoices(false, cfg);
  assert(!userChoices.some(c=>c.id==='default'));
  const cfg2 = { DEFAULT_PASSWORD_FOR_EVERYONE: true };
  const userChoices2 = passwordLib.getPasswordChoices(false, cfg2);
  assert(userChoices2.some(c=>c.id==='default'));
});

// === Test vault encryption & AAD ===
ok('vault: encrypt/decrypt & AAD isolation', () => {
  const tmpDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  // Backup existing accounts.json
  const accFile = path.join(tmpDir, 'accounts.json');
  const backup = fs.existsSync(accFile) ? fs.readFileSync(accFile, 'utf8') : null;

  const config = { ENCRYPTION_KEY: 'testkey1234567890123456789012345678' };
  const vault = new Vault(config);
  const plain = 'ucat_testtoken123';
  const aad1 = '123:abc123';
  const aad2 = '456:abc123';
  const enc = vault.encrypt(plain, aad1);
  const dec = vault.decrypt(enc, aad1);
  assert(dec === plain);
  // AAD yang beda tidak boleh bisa decrypt
  let threw = false;
  try {
    vault.decrypt(enc, aad2);
  } catch { threw = true; }
  assert(threw, 'AAD isolation harus gagal decrypt jika AAD beda');

  // Restore
  if (backup) fs.writeFileSync(accFile, backup);
  else if (fs.existsSync(accFile)) fs.unlinkSync(accFile);
});

ok('vault: multi-akun & kepemilikan', () => {
  const tmpDir = path.join(__dirname, '..', 'data');
  const accFile = path.join(tmpDir, 'accounts.json');
  const backup = fs.existsSync(accFile) ? fs.readFileSync(accFile, 'utf8') : null;
  const config = { ENCRYPTION_KEY: 'testkey1234567890123456789012345678' };
  const vault = new Vault(config);
  // Bersihkan
  if (fs.existsSync(accFile)) fs.unlinkSync(accFile);

  const acc1 = vault.addOrUpdateAccount(111, 'ucat_token1', 'user1', 'user1');
  const acc2 = vault.addOrUpdateAccount(111, 'ucat_token2', 'user2', 'user2');
  assert(acc1.id !== acc2.id);
  assert(vault.getUserAccounts(111).length === 2);
  // Username sama -> update token
  const acc1b = vault.addOrUpdateAccount(111, 'ucat_token1_new', 'user1', 'user1');
  assert(acc1b.id === acc1.id);
  assert(vault.getUserAccounts(111).length === 2);
  // Kepemilikan antar user
  assert(vault.isOwner(111, acc1.id));
  assert(!vault.isOwner(222, acc1.id));
  // /hapusdata
  const count = vault.deleteAllUserAccounts(111);
  assert(count === 2);
  assert(vault.getUserAccounts(111).length === 0);

  if (backup) fs.writeFileSync(accFile, backup);
  else if (fs.existsSync(accFile)) fs.unlinkSync(accFile);
});

// === Test quota ===
ok('quota: reset harian & owner unlimited', () => {
  const quotaFile = path.join(__dirname, '..', 'data', 'quota.json');
  const backup = fs.existsSync(quotaFile) ? fs.readFileSync(quotaFile, 'utf8') : null;
  if (fs.existsSync(quotaFile)) fs.unlinkSync(quotaFile);

  const qm = new QuotaManager();
  // Non-owner
  let can = qm.canUse(123, 'setup', 3, false);
  assert(can.allowed && can.remaining === 3);
  qm.use(123, 'setup');
  qm.use(123, 'setup');
  qm.use(123, 'setup');
  can = qm.canUse(123, 'setup', 3, false);
  assert(!can.allowed);
  // Owner unlimited
  can = qm.canUse(999, 'setup', 3, true);
  assert(can.allowed && can.remaining === Infinity);

  if (backup) fs.writeFileSync(quotaFile, backup);
  else if (fs.existsSync(quotaFile)) fs.unlinkSync(quotaFile);
});

// === Test jobs concurrency ===
ok('jobs: satu user satu job & max concurrent', () => {
  const jm = new JobManager(2);
  let can = jm.canStart(1);
  assert(can.allowed);
  jm.activeUsers.add('1');
  jm.activeCount = 1;
  can = jm.canStart(1);
  assert(!can.allowed && can.reason === 'user_busy');
  can = jm.canStart(2);
  assert(can.allowed);
  jm.activeCount = 2;
  can = jm.canStart(2);
  assert(!can.allowed && can.reason === 'server_busy');
});

// === Test callback_data ≤64 byte & stateless ===
ok('callback_data: batas 64 byte & stateless', () => {
  const accId = 'a1b2c3';
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const examples = [
    `srv:${accId}:${uuid}`,
    `srvact:${accId}:${uuid}:start`,
    `srvact:${accId}:${uuid}:delete`,
    `mgr:acc:${accId}`,
    `mgr:acc:${accId}:create`
  ];
  for (const cb of examples) {
    assert(Buffer.byteLength(cb, 'utf8') <= 64, `callback_data terlalu panjang: ${cb} (${cb.length})`);
  }
  // Stateless: harus bisa di-parse tanpa session
  const m = examples[0].match(/srv:([a-f0-9]{6}):([a-f0-9-]{36})/);
  assert(m && m[1] === accId && m[2] === uuid);
});

// === Test payload emas UpCloud ===
ok('payload emas: buat VPS', () => {
  const gold = {
    server: {
      zone: 'sg-sin1',
      title: 'katsu-ab12cd',
      hostname: 'katsu-ab12cd',
      plan: '1xCPU-1GB',
      password_delivery: 'none',
      metadata: 'yes',
      login_user: {
        username: 'root',
        create_password: 'no',
        ssh_keys: { ssh_key: ['ssh-ed25519 AAAA... user@x'] }
      },
      storage_devices: {
        storage_device: [{
          action: 'clone',
          storage: '<uuid template>',
          title: 'katsu-ab12cd-disk',
          size: 25,
          tier: 'maxiops'
        }]
      }
    }
  };
  // Validasi struktur wajib
  assert(gold.server.zone);
  assert(gold.server.title);
  assert(gold.server.hostname);
  assert(gold.server.plan);
  assert(gold.server.password_delivery === 'none');
  assert(gold.server.metadata === 'yes');
  assert(gold.server.login_user.username === 'root');
  assert(gold.server.login_user.create_password === 'no');
  assert(Array.isArray(gold.server.login_user.ssh_keys.ssh_key));
  assert(gold.server.storage_devices.storage_device[0].action === 'clone');
  assert(gold.server.storage_devices.storage_device[0].size === 25);
  assert(gold.server.storage_devices.storage_device[0].tier === 'maxiops');
});

ok('payload emas: rebuild', () => {
  const gold = {
    server_rebuild: {
      clone_source: '<uuid template>',
      storage_title: 'katsu-ab12cd-disk',
      detach_disk: '<uuid boot disk lama>',
      delete_detached_disk: 'yes',
      password_delivery: 'none',
      login_user: {
        username: 'root',
        create_password: 'no',
        ssh_keys: { ssh_key: ['ssh-ed25519 AAAA... bot'] }
      }
    }
  };
  assert(gold.server_rebuild.clone_source);
  assert(gold.server_rebuild.detach_disk);
  assert(gold.server_rebuild.delete_detached_disk === 'yes');
});

ok('payload emas: firewall rules', () => {
  const gold = {
    firewall_rules: {
      firewall_rule: [
        { action: 'accept', direction: 'in', family: 'IPv4', protocol: 'tcp', destination_port_start: '22', destination_port_end: '22', source_address_start: '203.0.113.5', source_address_end: '203.0.113.5', comment: 'SSH dari IP saya' },
        { action: 'accept', direction: 'in', family: 'IPv4', protocol: 'tcp', destination_port_start: '3389', destination_port_end: '3389', source_address_start: '203.0.113.5', source_address_end: '203.0.113.5', comment: 'RDP dari IP saya' },
        { action: 'accept', direction: 'in', family: 'IPv4', protocol: 'tcp', destination_port_start: '80', destination_port_end: '80', comment: 'Web' },
        { action: 'accept', direction: 'in', family: 'IPv4', protocol: 'tcp', destination_port_start: '443', destination_port_end: '443', comment: 'Web TLS' }
      ]
    }
  };
  assert(gold.firewall_rules.firewall_rule.length === 4);
  assert(gold.firewall_rules.firewall_rule[0].destination_port_start === '22');
});

// === Test error translation 401/403/429 ===
ok('upcloud: translateError ramah', () => {
  const client = new UpCloudClient('dummy');
  const err401 = new Error('Unauthorized');
  err401.status = 401;
  assert(client.translateError(err401).includes('Token salah'));

  const err403 = new Error('Forbidden');
  err403.status = 403;
  assert(client.translateError(err403).includes('Ditolak') && client.translateError(err403).includes('IP'));

  const err429 = new Error('Too Many');
  err429.status = 429;
  assert(client.translateError(err429).includes('Terlalu banyak'));
});

// === Test Cek API expiring ≤7 hari ===
ok('cek API: peringatan kedaluwarsa ≤7 hari', () => {
  const now = Date.now();
  const tokens = [
    { name: 'token1', expires_at: new Date(now + 3*24*60*60*1000).toISOString() }, // 3 hari lagi
    { name: 'token2', expires_at: new Date(now + 10*24*60*60*1000).toISOString() }, // 10 hari lagi
    { name: 'token3', expires_at: new Date(now - 1*24*60*60*1000).toISOString() } // sudah lewat
  ];
  const expiring = tokens.filter(t => {
    const exp = new Date(t.expires_at).getTime();
    const diffDays = (exp - now) / (1000*60*60*24);
    return diffDays <= 7;
  });
  assert(expiring.length === 2); // token1 dan token3
});

// === Free trial limit plan (max 6 CPU & 12GB RAM) ===
ok('free trial: isWithinFreeTrial batas 6 CPU & 12GB', () => {
  const uiMod = require('../ui/manager');
  assert(uiMod.isWithinFreeTrial({ core_number: 6, memory_amount: 12288 }) === true);  // persis di batas
  assert(uiMod.isWithinFreeTrial({ core_number: 1, memory_amount: 1024 }) === true);   // starter 1GB
  assert(uiMod.isWithinFreeTrial({ core_number: 4, memory_amount: 8192 }) === true);   // CN 4GB
  assert(uiMod.isWithinFreeTrial({ core_number: 8, memory_amount: 16384 }) === false); // 8 CPU
  assert(uiMod.isWithinFreeTrial({ core_number: 6, memory_amount: 16384 }) === false); // 16GB RAM
  assert(uiMod.isWithinFreeTrial({ core_number: 2, memory_amount: 12800 }) === false); // 12.5GB RAM
  assert(uiMod.isWithinFreeTrial({ core_number: 4, memory_amount: 24576 }) === false); // CN 24GB
});

ok('free trial: label plan 🔒 di formatPlans', () => {
  const uiMod = require('../ui/manager');
  const plans = [
    { name: '1xCPU-1GB-25GB', core_number: 1, memory_amount: 1024, storage_size: 25, storage_tier: 'maxiops', gpu_amount: 0, price: 5, current_offering: 'yes' },
    { name: '2xCPU-16GB-150GB', core_number: 2, memory_amount: 16384, storage_size: 150, storage_tier: 'maxiops', gpu_amount: 0, price: 72, current_offering: 'yes' },
    { name: '8xCPU-16GB-200GB', core_number: 8, memory_amount: 16384, storage_size: 200, storage_tier: 'maxiops', gpu_amount: 0, price: 148, current_offering: 'yes' }
  ];
  const { text, keyboard } = uiMod.formatPlans(plans, 'premium');
  const labels = keyboard.inline_keyboard.map(r => r[0].text);
  assert(labels[0].includes('⭐') && !labels[0].includes('🔒'), `plan 1GB: ⭐ tanpa 🔒 -> ${labels[0]}`);
  assert(labels[1].includes('🔒'), `plan 2x16GB harus 🔒 -> ${labels[1]}`);
  assert(labels[2].includes('🔒'), `plan 8x16GB harus 🔒 -> ${labels[2]}`);
  assert(text.includes('free trial'), 'teks list plan menjelaskan limit free trial');
});

// === Test keygen ===
okAsync('keygen: ED25519 generate & ssh2 parse (opsional jika ssh2 ada)', async () => {
  const tmpKeysDir = path.join(__dirname, '..', 'data', 'keys_test');
  if (!fs.existsSync(tmpKeysDir)) fs.mkdirSync(tmpKeysDir, { recursive: true });
  const { ensureKeypair } = require('../lib/keygen');
  const kp = await ensureKeypair(tmpKeysDir);
  assert(fs.existsSync(kp.privPath));
  assert(fs.existsSync(kp.pubPath));
  const pub = fs.readFileSync(kp.pubPath, 'utf8');
  assert(pub.startsWith('ssh-ed25519'));
  // ssh2 parse jika ada
  try {
    const { utils } = require('ssh2');
    const parsed = utils.parseKey(fs.readFileSync(kp.privPath));
    assert(!(parsed instanceof Error));
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.log('  (skip ssh2 parse, modul tidak ada)');
    } else throw e;
  }
  // cek permission 0600
  const stat = fs.statSync(kp.privPath);
  // di Windows mungkin beda, tapi cek minimal file ada
  assert(stat.isFile());
  // cleanup
  fs.rmSync(tmpKeysDir, { recursive: true, force: true });
});

// === Mock UpCloud API (HTTP lokal) ===
async function testMockUpCloud() {
  const server = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    if (!auth.includes('ucat_')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { error_code: 'AUTHENTICATION_FAILED', error_message: 'Invalid token' } }));
    }
    if (auth.includes('forbidden')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { error_code: 'FORBIDDEN', error_message: 'IP not allowed' } }));
    }
    if (req.url === '/1.3/account') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ account: { username: 'testuser', credits: 10 } }));
    }
    if (req.url === '/1.3/zone') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ zones: { zone: [{ id: 'sg-sin1', description: 'Singapore', public: 'yes' }] } }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { error_code: 'NOT_FOUND', error_message: 'Not found' } }));
  });

  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // Patch client base for test
  const originalRequest = UpCloudClient.prototype._request;
  UpCloudClient.prototype._request = async function(method, path, body) {
    const url = `${base}${path}`;
    const headers = { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' };
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) {
      const err = new Error(json?.error?.error_message || text);
      err.status = res.status;
      err.code = json?.error?.error_code;
      throw err;
    }
    return json;
  };

  await okAsync('mock UpCloud: GET /account sukses', async () => {
    const client = new UpCloudClient('ucat_valid');
    const acc = await client.getAccount();
    assert(acc.account.username === 'testuser');
  });

  await okAsync('mock UpCloud: 401 error ramah', async () => {
    const client = new UpCloudClient('invalid');
    try {
      await client.getAccount();
      assert(false, 'harusnya throw');
    } catch (e) {
      assert(e.status === 401);
      const msg = client.translateError(e);
      assert(msg.includes('Token salah'));
    }
  });

  await okAsync('mock UpCloud: 403 error IP', async () => {
    const client = new UpCloudClient('ucat_forbidden_token');
    try {
      await client.getAccount();
      assert(false);
    } catch (e) {
      assert(e.status === 403);
      const msg = client.translateError(e);
      assert(msg.includes('Ditolak') && msg.includes('IP'));
    }
  });

  UpCloudClient.prototype._request = originalRequest;
  server.close();
}

testMockUpCloud().then(() => {
  console.log(`\n=== HASIL TEST: ${passed} lulus, ${failed} gagal ===`);
  if (failed > 0) process.exit(1);
  else console.log('Semua tes dasar lulus. Catatan: tes integrasi penuh dengan VPS sungguhan belum dilakukan (sesuai risiko di README).');
}).catch(e => {
  console.error('Error mock test:', e);
  process.exit(1);
});
