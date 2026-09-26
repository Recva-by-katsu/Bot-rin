/**
 * tests/run.js - Pengujian unit & mock untuk UpCloud VPS Manager
 * Lingkungan dev tanpa internet: mock UpCloud API (HTTP lokal), stub telegraf dan ssh2,
 * sesi SSH palsu yang menjalankan perintah di bash lokal dengan curl dan reboot palsu.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const { execFileSync } = require('child_process');

// Import lib yang akan diuji
const validators = require('../lib/validators');
const sshdConfig = require('../lib/sshdConfig');
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
// Test async dipanggil tanpa await di badan file, jadi promise-nya dicatat dan
// ditunggu sebelum ringkasan dicetak. Tanpa ini, kegagalan test async bisa
// terjadi SETELAH "HASIL TEST" terpampang dan suite tetap lapor 0 gagal.
const pendingAsync = [];
function okAsync(name, fn) {
  const p = (async () => {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (e) {
      console.error(`❌ ${name}: ${e.message}`);
      console.error(e.stack);
      failed++;
    }
  })();
  pendingAsync.push(p);
  return p;
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

ok('free trial: isTrialAccount membaca trial_mode (tri-state)', () => {
  const uiMod = require('../ui/manager');
  assert(uiMod.isTrialAccount({ trial_mode: '1' }) === true, 'string "1" = trial');
  assert(uiMod.isTrialAccount({ trial_mode: '0' }) === false, 'string "0" = bukan');
  assert(uiMod.isTrialAccount({ trial_mode: 1 }) === true, 'number 1 = trial');
  assert(uiMod.isTrialAccount({ trial_mode: 0 }) === false, 'number 0 = bukan');
  assert(uiMod.isTrialAccount({}) === undefined, 'tanpa field = unknown');
  assert(uiMod.isTrialAccount(null) === undefined, 'null = unknown');
});

ok('free trial: formatPlanCategories sesuai status trial akun', () => {
  const uiMod = require('../ui/manager');
  const plans = [
    { name: '1xCPU-1GB-10GB', core_number: 1, memory_amount: 1024, storage_size: 10, storage_tier: 'hdd', price: 3, current_offering: 'yes' },
    { name: '2xCPU-16GB-150GB', core_number: 2, memory_amount: 16384, storage_size: 150, storage_tier: 'maxiops', price: 72, current_offering: 'yes' }
  ];
  const t = uiMod.formatPlanCategories(plans, true).text;
  assert(t.includes('MASIH FREE TRIAL'), 'akun trial -> peringatan khusus');
  const f = uiMod.formatPlanCategories(plans, false).text;
  assert(f.includes('bukan free trial'), 'akun reguler -> info bisa pilih 🔒');
  const u = uiMod.formatPlanCategories(plans).text;
  assert(!u.includes('MASIH FREE TRIAL') && !u.includes('bukan free trial'), 'status unknown -> tanpa tambahan');
});

ok('vault: trial_mode tersimpan di akun + updateAccountMeta', () => {
  const accFile = path.join(__dirname, '..', 'data', 'accounts.json');
  const backup = fs.existsSync(accFile) ? fs.readFileSync(accFile, 'utf8') : null;
  const config = { ENCRYPTION_KEY: 'testkey1234567890123456789012345678' };
  const vault = new Vault(config);
  try {
    if (fs.existsSync(accFile)) fs.unlinkSync(accFile);
    // Add dengan meta trial_mode
    const acc = vault.addOrUpdateAccount(222, 'ucat_t', 'trialuser', 'trialuser', { trial_mode: '1' });
    assert(acc.trial_mode === '1', 'trial_mode tersimpan saat add');
    // Update meta tanpa menyentuh token
    const before = vault.getDecryptedToken(222, acc.id);
    const updated = vault.updateAccountMeta(222, acc.id, { trial_mode: '0' });
    assert(updated.trial_mode === '0', 'trial_mode diupdate');
    assert(vault.getDecryptedToken(222, acc.id) === before, 'token tidak berubah');
    // Meta undefined tidak menimpa nilai lama
    const u2 = vault.updateAccountMeta(222, acc.id, { trial_mode: undefined });
    assert(u2.trial_mode === '0', 'undefined tidak menimpa');
    assert(vault.updateAccountMeta(222, 'aaaaaa', { trial_mode: '1' }) === null, 'akun tidak ada -> null');
  } finally {
    if (backup) fs.writeFileSync(accFile, backup);
    else if (fs.existsSync(accFile)) fs.unlinkSync(accFile);
  }
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

// ============================================================
// REGRESI — bug yang ditemukan & diperbaiki (jangan sampai kembali)
// ============================================================

// --- Regresi: helper validators baru ---
ok('validators: escapeHtml', () => {
  assert(validators.escapeHtml('<b>x</b> & "y"') === '&lt;b&gt;x&lt;/b&gt; &amp; "y"');
  assert(validators.escapeHtml('') === '');
  assert(validators.escapeHtml(null) === '');
  assert(validators.escapeHtml(123) === '123');
});

ok('validators: sanitizeHostname', () => {
  assert(validators.sanitizeHostname('My VPS_01!') === 'my-vps-01');
  assert(validators.sanitizeHostname('--abc--') === 'abc');
  assert(validators.sanitizeHostname('a-b-c') === 'a-b-c');
  assert(validators.sanitizeHostname('Nama Sangat Panjang Sekali Banget').length <= 20);
  assert(validators.sanitizeHostname('!!!') === '');
  assert(/^[a-z0-9][a-z0-9-]*$/.test(validators.sanitizeHostname('  Test.OK 123 ')));
});

// --- Regresi: routing callback_data (bug regex prefix swallowing) ---
ok('routing: semua regex bot.action ter-anchor (^...$)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const bodies = [...src.matchAll(/bot\.action\(\/(.+?)\/[a-z]*,/gs)].map(m => m[1]);
  assert(bodies.length >= 50, `handler terlalu sedikit: ${bodies.length}`);
  for (const b of bodies) {
    assert(b.startsWith('^'), `regex tidak diawali ^: ${b}`);
    assert(b.endsWith('$'), `regex tidak diakhiri $: ${b}`);
  }
});

ok('routing: first-match callback mengarah ke handler yang benar', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const handlers = [...src.matchAll(/bot\.action\(\/(.+?)\/[a-z]*,/gs)].map(m => new RegExp(m[1]));
  function firstMatch(data) {
    for (const h of handlers) if (data.match(h)) return h.source;
    return null;
  }
  const uuid = '00aa11bb-22cc-33dd-44ee-55ff66778899';
  const acc = 'a1b2c3';
  const MAIN = ':(start|stop|restart|delete|vnc|ssh|os|rebuild|fw|fwlock)$';
  const cases = [
    [`srv:${acc}:${uuid}`, '^srv:([a-f0-9]{6}):([a-f0-9-]{36})$'],
    [`srvact:${acc}:${uuid}:start`, MAIN],
    [`srvact:${acc}:${uuid}:delete`, MAIN],
    [`srvact:${acc}:${uuid}:delc`, ':delc$'],              // BUG: dulu 65-byte ':delete:confirm' + ketelan regex utama
    [`srvact:${acc}:${uuid}:vnc`, MAIN],
    [`srvact:${acc}:${uuid}:vnc:enable`, ':vnc:enable$'], // BUG: dulu ketelan handler utama (vnc)
    [`srvact:${acc}:${uuid}:fw`, MAIN],
    [`srvact:${acc}:${uuid}:fwlock`, MAIN],
    [`srvact:${acc}:${uuid}:fw:off`, ':fw:off$'],         // BUG: dulu ketelan handler utama (fw)
    [`srvact:${acc}:${uuid}:fw off`, ':fw off$'],         // legacy tetap didukung
    [`mgr:upcloud:deleteall`, '^mgr:upcloud:deleteall$'],
    [`mgr:upcloud:deleteall:confirm`, '^mgr:upcloud:deleteall:confirm$'], // BUG: dulu ketelan deleteall
    [`mgr:acc:${acc}:delete`, '^mgr:acc:([a-f0-9]{6}):delete$'],
    [`mgr:acc:${acc}:delete:confirm`, '^mgr:acc:([a-f0-9]{6}):delete:confirm$'], // BUG: dulu ketelan delete
    [`mgr:acc:${acc}`, '^mgr:acc:([a-f0-9]{6})$'],
    [`mgr:upcloud`, '^mgr:upcloud$'],
    [`wiz:pw:random`, '^wiz:pw:(random|custom|default)$'],
    [`reinstall:win:customiso`, '^reinstall:win:customiso$'],
    [`reinstall:ostype:linux`, '^reinstall:ostype:(linux|windows)$'],
    [`reinstall:ostype:windows`, '^reinstall:ostype:(linux|windows)$'],
    [`reinstall:image:Windows 11 Pro`, '^reinstall:image:(.+)$'],
    [`reinstall:linux:ubuntu:22.04`, '^reinstall:linux:(.+):(.+)$'],
    [`guide:3`, '^guide:(\\d+)$']
  ];
  for (const [data, expectedPart] of cases) {
    const matched = firstMatch(data);
    assert(matched, `tidak ada handler untuk ${data}`);
    assert(matched.includes(expectedPart), `${data} -> ${matched}, seharusnya mengandung ${expectedPart}`);
  }
});

ok('callback_data: semua literal ≤64 byte setelah substitusi', () => {
  const files = [path.join(__dirname, '..', 'index.js'), path.join(__dirname, '..', 'ui', 'manager.js')];
  const uuid = '00aa11bb-22cc-33dd-44ee-55ff66778899';
  const seen = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/callback_data:\s*'([^']+)'/g)) seen.add(m[1]);
    for (const m of src.matchAll(/callback_data:\s*`([^`]+)`/g)) {
      const t = m[1].replace(/\$\{[^}]*\}/g, (s) => {
        const e = s.slice(2, -1);
        if (/uuid/i.test(e)) return uuid;
        if (/acc(Id|ountId)|acc\.id/i.test(e)) return 'a1b2c3';
        if (/z\.id/.test(e)) return 'sg-sin1';
        if (/p\.name/.test(e)) return '1xCPU-1GB';
        if (/p\.label/.test(e)) return 'Windows 11 IoT Ent 24H2';
        if (/index/.test(e)) return '9';
        return 'X';
      });
      seen.add(t);
    }
  }
  assert(seen.size > 30, `callback literal terlalu sedikit: ${seen.size}`);
  for (const cb of seen) {
    const len = Buffer.byteLength(cb, 'utf8');
    assert(len <= 64, `callback_data >64 byte: "${cb}" (${len})`);
  }
});

// --- Regresi: progress HTML escape + timer ---
ok('progress: checklist meng-escape HTML (anti edit gagal 400)', () => {
  const LiveProgress = require('../lib/progress');
  const fakeBot = { telegram: { async editMessageText() {} } };
  const prog = new LiveProgress(fakeBot, 1, 2, 'Judul <x>', 900);
  prog.addStep('Perbaikan <b>config</b>', 'err & <detail>');
  const txt = prog._render();
  assert(txt.includes('&lt;b&gt;'), 'tag harus di-escape: ' + txt);
  assert(txt.includes('&amp;'), '& harus di-escape');
  assert(!txt.includes('<b>') && !txt.includes('<x>'), 'HTML mentah tidak boleh lolos');
});

okAsync('progress: start idempotent & setTickMs merestart interval', async () => {
  const LiveProgress = require('../lib/progress');
  const fakeBot = { telegram: { async editMessageText() {} } };
  const prog = new LiveProgress(fakeBot, 1, 2, 'T', 50);
  prog.addStep('a');
  prog.start();
  const t1 = prog.timer;
  prog.start(); // no-op dengan tick sama
  assert(prog.timer === t1, 'start kedua tidak boleh mengganti timer');
  prog.setTickMs(500); // harus restart (sebelumnya no-op -> bug polling 900ms selama 40 menit)
  assert(prog.timer && prog.timer !== t1, 'setTickMs harus restart timer');
  assert(prog._timerTickMs === 500);
  const t2 = prog.timer;
  prog.start();
  assert(prog.timer === t2, 'start dengan tick sama no-op');
  prog.stop();
  assert(prog.timer === null);
});

// --- Regresi: larangan pola lama yang terbukti salah ---
ok('regresi: pola API lama yang salah tidak muncul lagi di kode', () => {
  const prov = fs.readFileSync(path.join(__dirname, '..', 'providers', 'upcloud.js'), 'utf8');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // endpoint palsu /vnc_details tidak boleh dipakai dalam pemanggilan request (komentar dokumentasi boleh)
  const provCodeOnly = prov.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert(!provCodeOnly.includes('vnc_details'), 'endpoint palsu /vnc_details masih dipakai di kode non-komentar');
  assert(!provCodeOnly.includes('firewall_public_default_incoming_action'), 'atribut server palsu firewall masih dipakai');
  assert(!/srvact:[^'`]*:delete:confirm/.test(idx), 'callback 65-byte srvact ...:delete:confirm masih dipakai (ganti :delc)');
  // Default Rule wajib ada di akhir chain saat kunci firewall
  assert(idx.includes("action: 'drop', direction: 'in'"), 'aturan Default drop terakhir hilang dari flow kunci firewall');
});

// === Regresi: script sshd (bug "key is not defined" yang bikin VPS terlanjur ditagih) ===

function haveBin(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name} >/dev/null 2>&1`], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}
function shRun(script, opts = {}) {
  // Jalankan script lewat `sh` (bukan bash) karena di VPS dijalankan via ssh exec
  return execFileSync('sh', ['-c', script], { encoding: 'utf8', timeout: 30000, ...opts });
}

/**
 * Bikin fixture sshd_config khas image Ubuntu/Debian cloud di dir sementara.
 * `mode`:
 *  - ubuntu        : Include di atas + drop-in "PasswordAuthentication no" + Match block
 *  - debian-simple : tanpa Include, tanpa dir drop-in, semua masih dikomentar
 *  - match-first   : Include, lalu blok Match lebih dulu daripada keyword global
 *  - already-ok    : sudah benar sejak awal (uji idempotent)
 */
function makeSshdFixture(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sshd-${mode}-`));
  const cfgDir = path.join(dir, 'etc', 'ssh');
  const dropinDir = path.join(cfgDir, 'sshd_config.d');
  fs.mkdirSync(dropinDir, { recursive: true });
  const main = path.join(cfgDir, 'sshd_config');
  if (mode === 'ubuntu') {
    fs.writeFileSync(main, [
      '#\t$OpenBSD: sshd_config,v 1.104 2021/07/02 05:11:21 dtucker Exp $',
      `Include ${dropinDir}/*.conf`,
      '',
      'Port 22',
      'PermitRootLogin prohibit-password',
      'PubkeyAuthentication yes',
      '',
      '# To disable tunneled clear text passwords, change to no here!',
      '#PasswordAuthentication yes',
      'PasswordAuthentication no',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      '',
      'UsePAM yes',
      'Subsystem\tsftp\t/usr/lib/openssh/sftp-server',
      '',
      'Match User sftponly',
      '  PasswordAuthentication no',
      '  ForceCommand internal-sftp',
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(dropinDir, '60-cloudimg-settings.conf'), 'PasswordAuthentication no\n');
    fs.writeFileSync(path.join(dropinDir, '50-no-root.conf'), '#PermitRootLogin no\n#PasswordAuthentication yes\n');
  } else if (mode === 'debian-simple') {
    fs.writeFileSync(main, 'Port 22\n#PasswordAuthentication yes\nPermitRootLogin prohibit-password\nUsePAM yes\n');
    fs.rmSync(dropinDir, { recursive: true, force: true });
  } else if (mode === 'match-first') {
    // `PermitRootLogin no` di SINI masih scope global (sebelum Match), sedangkan
    // semua baris setelah `Match User deploy` adalah scope match dan tidak boleh
    // disentuh bot. PasswordAuthentication belum ada di scope global sama sekali.
    fs.writeFileSync(main, [
      `Include ${dropinDir}/*.conf`,
      'PermitRootLogin no',
      'UsePAM yes',
      'Match User deploy',
      '  X11Forwarding no',
      '  PasswordAuthentication no',
      '  ForceCommand internal-sftp',
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(dropinDir, '10-off.conf'), 'PasswordAuthentication no\n');
  } else if (mode === 'already-ok') {
    fs.writeFileSync(main, [
      `Include ${dropinDir}/*.conf`,
      'PasswordAuthentication yes',
      'PermitRootLogin yes',
      'UsePAM yes',
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(dropinDir, '10-on.conf'), 'PasswordAuthentication yes\n');
  }
  return { dir, cfgDir, dropinDir, main };
}

function fixtureOpts(fx) {
  let hostKeyArgs = '';
  if (haveBin('ssh-keygen')) {
    const hk = path.join(fx.dir, 'hostkey');
    try {
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hk], { stdio: 'ignore', input: '' });
      hostKeyArgs = hk;
    } catch { hostKeyArgs = ''; }
  }
  const opts = {
    configDir: fx.cfgDir,
    dropinDir: fx.dropinDir
  };
  if (hostKeyArgs) opts.hostKey = hostKeyArgs;
  return opts;
}

/** Jalankan script fix lalu kembalikan {rc, stdout, stderr}. */
function runFixScript(isRoot, opts) {
  const script = sshdConfig.getFixCommands(isRoot, opts);
  const before = script; // pastikan generator tidak melempar (dulu: ReferenceError)
  assert(typeof before === 'string' && before.length > 50, 'script kosong');
  const res = require('child_process').spawnSync('sh', ['-c', script], { encoding: 'utf8', timeout: 30000 });
  return { rc: res.status, stdout: res.stdout || '', stderr: res.stderr || '', script };
}

ok('regresi: generator script sshd tidak melempar ReferenceError (bug "key is not defined")', () => {
  // Bug asli: template literal JS berisi `${key}`/`${value}` milik shell ->
  // ReferenceError: key is not defined, dan VPS sudah terlanjur dibuat & ditagih.
  for (const isRoot of [true, false]) {
    const script = sshdConfig.getFixCommands(isRoot);
    assert(script.includes('PasswordAuthentication'), 'script root=' + isRoot + ' kehilangan keyword');
    // Hasil interpolasi JS yang gagal akan muncul sebagai undefined/[object Object].
    // Catatan: `${eg_last}` di dalam script adalah syntax SHELL yang sah (dipakai
    // sed), jadi yang dilarang hanya jejak interpolasi JS yang tidak terisi.
    assert(!/undefined|\[object Object\]|NaN/.test(script), 'ada jejak interpolasi JS gagal di script:\n' + script);
    // Variabel shell milik script harus tetap utuh
    assert(script.includes('${eg_last}'), 'variabel shell ${eg_last} hilang dari script');
    // sudo hanya untuk non-root
    assert(isRoot ? !script.includes('sudo') : script.includes('sudo -n'), 'prefix sudo salah untuk root=' + isRoot);
  }
  // Semua generator lain juga harus bisa dipanggil tanpa opts
  assert(typeof sshdConfig.getValidateCommand(true) === 'string');
  assert(typeof sshdConfig.getRestartCommands(false) === 'string');
  assert(typeof sshdConfig.getCheckEffectiveCommand(true) === 'string');
  assert(Array.isArray(sshdConfig.getBackupCommands('/tmp/b', true)));
  assert(typeof sshdConfig.getRollbackCommands('/tmp/b', true) === 'string');
  assert(typeof sshdConfig.awkFixProgram() === 'string');
  assert(typeof sshdConfig.awkHasGlobalProgram() === 'string');
});

ok('regresi: script sshd lolos cek syntax sh (POSIX, bukan bash-only)', () => {
  if (!haveBin('sh')) return;
  for (const isRoot of [true, false]) {
    const script = sshdConfig.getFixCommands(isRoot);
    const tmp = path.join(os.tmpdir(), `sshd-syntax-${isRoot ? 'root' : 'user'}.sh`);
    fs.writeFileSync(tmp, script);
    const res = require('child_process').spawnSync('sh', ['-n', tmp], { encoding: 'utf8' });
    fs.rmSync(tmp, { force: true });
    assert.strictEqual(res.status, 0, `sh -n gagal (root=${isRoot}): ${res.stderr}`);
  }
});

ok('regresi: program awk tidak bergantung exit code 2 (mawk pakai 2 untuk error fatal)', () => {
  const prog = sshdConfig.awkFixProgram();
  const progHas = sshdConfig.awkHasGlobalProgram();
  // Tidak boleh ada `exit 2` / `exit (done ? 2 : 0)` di program awk
  assert(!/exit\s*\(\s*done/.test(prog), 'awkFixProgram masih memakai exit code berbasis done');
  assert(!/exit 2/.test(prog), 'awkFixProgram memakai exit 2 (bentrok dengan error fatal mawk)');
  // hasglobal pakai code 3 yang bebas bentrok, dan statusnya harus lewat variabel:
  // `exit` di dalam rule tetap menjalankan blok END, jadi `exit 3` langsung di rule
  // akan ditimpa oleh END.
  assert(/exit\s*\(\s*found\s*\?\s*3\s*:\s*0\s*\)/.test(progHas),
    'awkHasGlobalProgram harus menutup dengan exit (found ? 3 : 0):\n' + progHas);
  assert(!/\)\s*exit 3/.test(progHas), 'jangan exit 3 langsung di dalam rule (akan ditimpa blok END)');
  // Tidak boleh ada baris penanda ber-# (mawk salah lex literal "#" dalam konkatenasi)
  assert(!prog.includes('#BOT#'), 'penanda #BOT# masih dipakai di awk');
  assert(!progHas.includes('#BOT#'), 'penanda #BOT# masih dipakai di awk hasglobal');
});

ok('regresi: awkHasGlobalProgram benar-benar mengembalikan 3 saat keyword ada (bukan selalu 0)', () => {
  // Inilah bug yang bikin fix tidak idempotent: exit 3 di rule ditimpa END { exit 0 }.
  if (!haveBin('awk')) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awk-has-'));
  const progFile = path.join(dir, 'has.awk');
  fs.writeFileSync(progFile, sshdConfig.awkHasGlobalProgram());
  const run = (content, key) => {
    const f = path.join(dir, 'c.conf');
    fs.writeFileSync(f, content);
    const r = require('child_process').spawnSync('awk', ['-v', `KEY=${key}`, '-f', progFile, f], { encoding: 'utf8' });
    return r.status;
  };
  assert.strictEqual(run('PasswordAuthentication no\nUsePAM yes\n', 'PasswordAuthentication'), 3, 'keyword ada -> harus 3');
  assert.strictEqual(run('PasswordAuthentication yes\n', 'PasswordAuthentication'), 3, 'keyword ada (yes) -> harus 3');
  assert.strictEqual(run('  PasswordAuthentication no\n', 'PasswordAuthentication'), 3, 'keyword dengan indentasi -> harus 3');
  assert.strictEqual(run('#PasswordAuthentication yes\nUsePAM yes\n', 'PasswordAuthentication'), 0, 'masih dikomentar -> harus 0');
  assert.strictEqual(run('UsePAM yes\n', 'PasswordAuthentication'), 0, 'tidak ada -> harus 0');
  assert.strictEqual(run('Match User x\n  PasswordAuthentication no\n', 'PasswordAuthentication'), 0,
    'di dalam blok Match bukan scope global -> harus 0');
  // Keyword mirip tidak boleh ketuker (PasswordAuthentication vs KbdInteractiveAuthentication)
  assert.strictEqual(run('KbdInteractiveAuthentication no\n', 'PasswordAuthentication'), 0, 'keyword mirip tidak boleh cocok');
  fs.rmSync(dir, { recursive: true, force: true });
});

const SSHD_AVAILABLE = haveBin('sshd') || fs.existsSync('/usr/sbin/sshd');
const SSHD_BIN = haveBin('sshd') ? 'sshd' : '/usr/sbin/sshd';

function sshdRun(args) {
  const res = require('child_process').spawnSync(SSHD_BIN, args, { encoding: 'utf8', timeout: 20000 });
  return { rc: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

/** Jalankan fix 2x, pastikan hasil identik (idempotent). */
function assertIdempotent(mode) {
  const fx = makeSshdFixture(mode);
  const opts = fixtureOpts(fx);
  const r1 = runFixScript(true, opts);
  assert.strictEqual(r1.rc, 0, `[${mode}] run1 rc=${r1.rc} stderr=${r1.stderr}`);
  const mainAfter1 = fs.readFileSync(fx.main, 'utf8');
  const dropinsAfter1 = fs.existsSync(fx.dropinDir)
    ? fs.readdirSync(fx.dropinDir).sort().map(f => f + ':' + fs.readFileSync(path.join(fx.dropinDir, f), 'utf8')).join('|')
    : '';
  const r2 = runFixScript(true, opts);
  assert.strictEqual(r2.rc, 0, `[${mode}] run2 rc=${r2.rc} stderr=${r2.stderr}`);
  const mainAfter2 = fs.readFileSync(fx.main, 'utf8');
  const dropinsAfter2 = fs.existsSync(fx.dropinDir)
    ? fs.readdirSync(fx.dropinDir).sort().map(f => f + ':' + fs.readFileSync(path.join(fx.dropinDir, f), 'utf8')).join('|')
    : '';
  assert.strictEqual(mainAfter2, mainAfter1, `[${mode}] config utama berubah saat dijalankan ulang:\n${mainAfter1}\n---\n${mainAfter2}`);
  assert.strictEqual(dropinsAfter2, dropinsAfter1, `[${mode}] drop-in berubah saat dijalankan ulang`);
  return { fx, opts };
}

/** Pastikan nilai efektif sshd adalah passwordauthentication yes (+ permitrootlogin yes utk root). */
function assertEffectiveYes(fx, opts, label) {
  if (!SSHD_AVAILABLE || !opts.hostKey) return; // tidak bisa uji efektif tanpa sshd/hostkey
  // sshd sering tidak ada di PATH (ada di /usr/sbin), jadi pakai path absolut
  const withBin = (cmd) => cmd.replace(/(^|\s)sshd(\s)/, `$1${SSHD_BIN}$2`);
  const eff = shRun(withBin(sshdConfig.getCheckEffectiveCommand(true, opts)));
  const low = eff.toLowerCase();
  assert(low.includes('passwordauthentication yes'), `[${label}] efektif masih bukan 'passwordauthentication yes':\n${eff.slice(0, 500)}`);
  assert(low.includes('permitrootlogin yes'), `[${label}] efektif masih bukan 'permitrootlogin yes':\n${eff.slice(0, 500)}`);
  // validasi config juga harus lolos
  const val = require('child_process').spawnSync('sh', ['-c', withBin(sshdConfig.getValidateCommand(true, opts))], { encoding: 'utf8' });
  assert.strictEqual(val.status, 0, `[${label}] sshd -t gagal: ${(val.stderr || '').slice(0, 300)}`);
}

ok('sshd fix: image Ubuntu cloud (drop-in "no", duplikat, blok Match) -> password auth yes', () => {
  if (!haveBin('sh')) return;
  const { fx, opts } = assertIdempotent('ubuntu');
  const main = fs.readFileSync(fx.main, 'utf8');
  // tidak boleh ada penanda/jejak internal yang lolos ke config
  assert(!main.includes('#BOT#'), 'penanda internal bocor ke sshd_config:\n' + main);
  assert(!main.includes('.bot-tmp'), 'nama file sementara bocor ke sshd_config');
  // duplikat global dibuang, sisanya tepat satu baris "PasswordAuthentication yes"
  const pwLines = main.split('\n').filter(l => /^PasswordAuthentication\b/.test(l));
  assert.strictEqual(pwLines.length, 1, 'baris global PasswordAuthentication harus tepat satu, dapat: ' + JSON.stringify(pwLines));
  assert.strictEqual(pwLines[0], 'PasswordAuthentication yes');
  const rootLines = main.split('\n').filter(l => /^PermitRootLogin\b/.test(l));
  assert.strictEqual(rootLines.length, 1, 'baris global PermitRootLogin harus tepat satu: ' + JSON.stringify(rootLines));
  assert.strictEqual(rootLines[0], 'PermitRootLogin yes');
  // Baris yang dikomentar tidak boleh ikut "dihidupkan" jadi duplikat
  assert(main.includes('#PasswordAuthentication yes'), 'baris komentar harus tetap ada');
  // Isi blok Match tidak boleh disentuh
  const matchIdx = main.indexOf('Match User sftponly');
  assert(matchIdx > -1, 'blok Match hilang dari config');
  assert(main.slice(matchIdx).includes('PasswordAuthentication no'), 'isi blok Match ikut diubah (harusnya dibiarkan)');
  // Baris lain utuh
  assert(main.includes('Subsystem'), 'baris Subsystem hilang');
  assert(main.includes('UsePAM yes'), 'baris UsePAM hilang');
  // Drop-in bawaan image ikut dibetulkan + drop-in bot dibuat paling awal
  const cloud = fs.readFileSync(path.join(fx.dropinDir, '60-cloudimg-settings.conf'), 'utf8');
  assert(/^PasswordAuthentication yes$/m.test(cloud), 'drop-in 60-cloudimg masih "no":\n' + cloud);
  const noRoot = fs.readFileSync(path.join(fx.dropinDir, '50-no-root.conf'), 'utf8');
  assert(!/^PermitRootLogin no$/m.test(noRoot), 'drop-in 50-no-root masih melarang root:\n' + noRoot);
  const botDropin = path.join(fx.dropinDir, sshdConfig.DROPIN_NAME);
  assert(fs.existsSync(botDropin), 'drop-in bot tidak dibuat: ' + botDropin);
  const botContent = fs.readFileSync(botDropin, 'utf8');
  assert(botContent.includes('PasswordAuthentication yes') && botContent.includes('PermitRootLogin yes'),
    'isi drop-in bot salah: ' + botContent);
  assert(botDropin.includes('00-'), 'drop-in bot harus ber-awalan 00- agar menang di load order');
  // Tidak boleh ada file sementara yang tertinggal di sekitar config
  const leftovers = fs.readdirSync(fx.cfgDir).filter(f => f.includes('bot-tmp') || f.endsWith('.awk'));
  assert.deepStrictEqual(leftovers, [], 'ada file sementara tertinggal: ' + JSON.stringify(leftovers));
  // Script wajib pakai mktemp + trap, bukan nama file tetap di /tmp (symlink attack saat root)
  const script = sshdConfig.getFixCommands(true, opts);
  assert(script.includes('mktemp'), 'script harus membuat file sementara lewat mktemp');
  assert(/trap .*rm -f "\$BOT_TMP"/.test(script), 'script harus membersihkan file sementara lewat trap');
  assert(!/\/tmp\/sshd_fix_config\.awk/.test(script), 'jangan pakai nama file tetap di /tmp untuk program awk');
  assertEffectiveYes(fx, opts, 'ubuntu');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

ok('sshd fix: Debian tanpa Include & tanpa dir drop-in -> keyword disisipkan', () => {
  if (!haveBin('sh')) return;
  const { fx, opts } = assertIdempotent('debian-simple');
  const main = fs.readFileSync(fx.main, 'utf8');
  assert(!main.includes('#BOT#'), 'penanda internal bocor:\n' + main);
  const pwLines = main.split('\n').filter(l => /^PasswordAuthentication\b/.test(l));
  assert.strictEqual(pwLines.length, 1, 'harus tepat satu baris global: ' + JSON.stringify(pwLines) + '\n' + main);
  assert.strictEqual(pwLines[0], 'PasswordAuthentication yes');
  assert(main.includes('Port 22') && main.includes('UsePAM yes'), 'baris lain hilang:\n' + main);
  assertEffectiveYes(fx, opts, 'debian-simple');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

ok('sshd fix: blok Match muncul sebelum keyword global -> sisip di scope global', () => {
  if (!haveBin('sh')) return;
  const { fx, opts } = assertIdempotent('match-first');
  const main = fs.readFileSync(fx.main, 'utf8');
  assert(!main.includes('#BOT#'), 'penanda internal bocor:\n' + main);
  const matchIdx = main.indexOf('Match User deploy');
  assert(matchIdx > -1, 'blok Match hilang dari config:\n' + main);
  // PasswordAuthentication belum ada di scope global -> harus disisipkan SEBELUM blok Match
  const pwIdx = main.search(/^PasswordAuthentication yes$/m);
  assert(pwIdx > -1, 'PasswordAuthentication yes tidak disisipkan:\n' + main);
  assert(pwIdx < matchIdx, 'baris disisipkan setelah blok Match (jadi ikut scope Match):\n' + main);
  // PermitRootLogin no di fixture ini ada SEBELUM Match (scope global) -> wajib jadi yes
  assert(!/^PermitRootLogin no$/m.test(main.split('\n').slice(0, main.split('\n').findIndex(l => l.startsWith('Match'))).join('\n')),
    'PermitRootLogin no di scope global tidak dibetulkan:\n' + main);
  // Isi scope Match wajib dibiarkan apa adanya
  const matchPart = main.slice(matchIdx);
  assert(matchPart.includes('PasswordAuthentication no'), 'baris di dalam blok Match ikut diubah:\n' + main);
  assert(matchPart.includes('ForceCommand internal-sftp'), 'isi blok Match hilang:\n' + main);
  assertEffectiveYes(fx, opts, 'match-first');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

ok('sshd fix: config yang sudah benar tidak diubah jadi rusak (idempotent penuh)', () => {
  if (!haveBin('sh')) return;
  const { fx, opts } = assertIdempotent('already-ok');
  const main = fs.readFileSync(fx.main, 'utf8');
  assert(!main.includes('#BOT#'), 'penanda internal bocor:\n' + main);
  const pwLines = main.split('\n').filter(l => /^PasswordAuthentication\b/.test(l));
  assert.strictEqual(pwLines.length, 1, 'harus tetap satu baris: ' + JSON.stringify(pwLines) + '\n' + main);
  assertEffectiveYes(fx, opts, 'already-ok');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

ok('sshd fix: mode non-root (sudo) tetap menghasilkan script valid & tidak menyentuh PermitRootLogin', () => {
  if (!haveBin('sh')) return;
  const fx = makeSshdFixture('ubuntu');
  const opts = fixtureOpts(fx);
  const script = sshdConfig.getFixCommands(false, opts);
  assert(!/PermitRootLogin/.test(script.replace(/^#.*$/gm, '')), 'script non-root tidak boleh memaksa PermitRootLogin');
  // Jalankan tanpa sudo sungguhan: di lingkungan test user bisa tulis fixture-nya sendiri,
  // jadi ganti 'sudo -n ' jadi '' agar bisa dieksekusi.
  const runnable = script.replace(/sudo -n /g, '');
  const res = require('child_process').spawnSync('sh', ['-c', runnable], { encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(res.status, 0, `script non-root gagal rc=${res.status}: ${res.stderr}`);
  const main = fs.readFileSync(fx.main, 'utf8');
  assert(!main.includes('#BOT#'), 'penanda internal bocor:\n' + main);
  assert(/^PasswordAuthentication yes$/m.test(main), 'PasswordAuthentication tidak dibetulkan:\n' + main);
  // PermitRootLogin tidak boleh dipaksa yes saat bukan root
  assert(!/^PermitRootLogin yes$/m.test(main), 'PermitRootLogin ikut diubah pada mode non-root:\n' + main);
  const botDropin = path.join(fx.dropinDir, sshdConfig.DROPIN_NAME);
  const botContent = fs.readFileSync(botDropin, 'utf8');
  assert(botContent.includes('PasswordAuthentication yes'), 'drop-in bot salah (non-root): ' + botContent);
  assert(!botContent.includes('PermitRootLogin'), 'drop-in bot non-root tidak boleh set PermitRootLogin: ' + botContent);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

ok('sshd fix: backup & rollback memulihkan config asli', () => {
  if (!haveBin('sh')) return;
  const fx = makeSshdFixture('ubuntu');
  const opts = fixtureOpts(fx);
  const original = fs.readFileSync(fx.main, 'utf8');
  const backupDir = path.join(fx.dir, 'backup');
  // backup
  for (const cmd of sshdConfig.getBackupCommands(backupDir, true, opts)) shRun(cmd);
  assert(fs.existsSync(path.join(backupDir, 'sshd_config')), 'backup config utama tidak ada');
  assert(fs.existsSync(path.join(backupDir, '60-cloudimg-settings.conf')), 'backup drop-in tidak ada');
  // ubah
  const r = runFixScript(true, opts);
  assert.strictEqual(r.rc, 0, r.stderr);
  assert(fs.readFileSync(fx.main, 'utf8') !== original, 'fix tidak mengubah apa pun');
  // rollback
  shRun(sshdConfig.getRollbackCommands(backupDir, true, opts));
  assert.strictEqual(fs.readFileSync(fx.main, 'utf8'), original, 'rollback tidak memulihkan config utama');
  const restoredDropin = fs.readFileSync(path.join(fx.dropinDir, '60-cloudimg-settings.conf'), 'utf8');
  assert(restoredDropin.includes('PasswordAuthentication no'), 'rollback tidak memulihkan drop-in');
  assert(!fs.existsSync(path.join(fx.dropinDir, sshdConfig.DROPIN_NAME)), 'drop-in bot harus dibuang saat rollback');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

ok('sshd fix: keyword tidak valid ditolak (anti injeksi ke sshd_config)', () => {
  if (!haveBin('sh')) return;
  const fx = makeSshdFixture('ubuntu');
  const opts = fixtureOpts(fx);
  const before = fs.readFileSync(fx.main, 'utf8');
  // siapkan program awk seperti script asli, lalu panggil ensure_global dengan keyword jahat
  const script = sshdConfig.getFixCommands(true, opts);
  const head = script.slice(0, script.indexOf('# 1) Drop-in milik bot'));
  const probe = head + '\nensure_global ' + fx.main + ' "PasswordAuthentication; rm -rf /tmp/x" yes; echo "rc=$?"\n';
  const res = require('child_process').spawnSync('sh', ['-c', probe], { encoding: 'utf8', timeout: 30000 });
  assert(/rc=2/.test(res.stdout), 'keyword tidak valid harus ditolak (rc=2), dapat: ' + res.stdout + res.stderr);
  assert.strictEqual(fs.readFileSync(fx.main, 'utf8'), before, 'config berubah walau keyword ditolak');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

ok('sshd fix: awk error -> ensure_global gagal terang-terangan (bukan diam-diam "sukses")', () => {
  if (!haveBin('sh')) return;
  const fx = makeSshdFixture('ubuntu');
  const opts = fixtureOpts(fx);
  const before = fs.readFileSync(fx.main, 'utf8');
  const script = sshdConfig.getFixCommands(true, opts);
  const head = script.slice(0, script.indexOf('# 1) Drop-in milik bot'));
  // Rusak program awk: pastikan kegagalan terdeteksi, bukan dianggap "sudah ada".
  // (Dulu exit code 2 dari mawk bentrok dengan penanda "sudah ada", jadi error
  //  fatal awk bisa terbaca sebagai sukses.)
  const probe = head + '\nAWK_HAS_PROG=\'BEGIN { syntax error ((("\'\n'
    + `ensure_global ${fx.main} PasswordAuthentication yes; echo "rc=$?"\n`;
  const res = require('child_process').spawnSync('sh', ['-c', probe], { encoding: 'utf8', timeout: 30000 });
  assert(/rc=1/.test(res.stdout), 'harus gagal rc=1 saat awk error, dapat: ' + res.stdout + res.stderr);
  assert.strictEqual(fs.readFileSync(fx.main, 'utf8'), before, 'config berubah walau awk error');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

ok('sshd fix: file config tidak boleh dikosongkan saat awk gagal di tengah jalan', () => {
  if (!haveBin('sh')) return;
  const fx = makeSshdFixture('ubuntu');
  const opts = fixtureOpts(fx);
  const before = fs.readFileSync(fx.main, 'utf8');
  const script = sshdConfig.getFixCommands(true, opts);
  const head = script.slice(0, script.indexOf('# 1) Drop-in milik bot'));
  // Program fix rusak (hasil kosong) -> guard `[ ! -s "$BOT_TMP" ]` harus menolak menulis
  const probe = head + '\nAWK_FIX_PROG=\'BEGIN { exit 0 }\'\nAWK_HAS_PROG=\'BEGIN { exit 3 }\'\n'
    + `ensure_global ${fx.main} PasswordAuthentication yes; echo "rc=$?"\n`;
  const res = require('child_process').spawnSync('sh', ['-c', probe], { encoding: 'utf8', timeout: 30000 });
  assert(/rc=1/.test(res.stdout), 'harus gagal rc=1 saat hasil awk kosong: ' + res.stdout + res.stderr);
  assert.strictEqual(fs.readFileSync(fx.main, 'utf8'), before, 'sshd_config ikut kosong/rusak');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

// === Regresi: setupFlow end-to-end dengan sesi SSH palsu ===
// Perintah SSH yang "berbahaya"/tidak tersedia di sandbox (restart layanan,
// chpasswd) dijawab sendiri; sisanya (script fix sshd, backup) benar-benar
// dijalankan lewat `sh` terhadap fixture, jadi bug script ikut ketahuan.

function makeFakeSshSession(overrides = {}) {
  const log = [];
  const sess = {
    username: 'root',
    log,
    closed: false,
    async exec(cmd) {
      log.push(cmd);
      const answer = (code, stdout = '', stderr = '') => ({ code, stdout, stderr });
      if (cmd.includes('/etc/os-release')) {
        return answer(0, overrides.osRelease !== undefined ? overrides.osRelease
          : 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n');
      }
      if (/^\s*(sudo -n\s+)?sshd\s/.test(cmd)) {
        if (overrides.sshd) return overrides.sshd(cmd);
        if (!SSHD_AVAILABLE) {
          return cmd.includes('-T') ? answer(0, 'passwordauthentication yes\npermitrootlogin yes\n') : answer(0, '');
        }
        const full = cmd.replace(/(^|\s)sshd(\s)/, `$1${SSHD_BIN}$2`);
        const r = require('child_process').spawnSync('sh', ['-c', full], { encoding: 'utf8', timeout: 20000 });
        return answer(r.status, r.stdout || '', r.stderr || '');
      }
      if (cmd.includes('systemctl restart') || cmd.includes('service ssh')) {
        return overrides.restart ? overrides.restart(cmd) : answer(0, 'restarted ssh via systemctl\n');
      }
      if (cmd.includes('chpasswd')) {
        return overrides.chpasswd ? overrides.chpasswd(cmd) : answer(0, '');
      }
      if (cmd.trim() === 'whoami') return answer(0, overrides.whoami || 'root\n');
      const r = require('child_process').spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 30000 });
      return answer(r.status, r.stdout || '', r.stderr || '');
    },
    close() { this.closed = true; }
  };
  return sess;
}

function makeProgress() {
  const LiveProgress = require('../lib/progress');
  const sent = [];
  const prog = new LiveProgress({ telegram: { async editMessageText(a, b, c, text) { sent.push(text); } } }, 1, 2, 'T', 900);
  prog.sent = sent;
  return prog;
}

okAsync('setupFlow: 9 langkah sukses end-to-end (regresi error "key is not defined")', async () => {
  const { setupVpsFlow, SETUP_STEPS } = require('../lib/setupFlow');
  const fx = makeSshdFixture('ubuntu');
  const opts = fixtureOpts(fx);
  const prog = makeProgress();
  const ssh = makeFakeSshSession();
  const res = await setupVpsFlow({
    sshSession: ssh, targetUsername: 'root', password: 'Abc1234567',
    isRootUser: true, progress: prog, sshdOpts: opts
  });
  // Inilah asersi utamanya: dengan bug lama, getFixCommands melempar
  // ReferenceError di dalam try -> success:false dengan error "key is not defined"
  assert.strictEqual(res.success, true, 'setup harus sukses, tapi gagal: ' + res.error);
  assert(!/is not defined/.test(res.error || ''), 'masih ada ReferenceError: ' + res.error);
  assert.strictEqual(prog.steps.length, SETUP_STEPS.length, 'jumlah langkah harus 9');
  const bad = prog.steps.filter(s => s.status !== 'done');
  assert.deepStrictEqual(bad, [], 'semua langkah harus done: ' + JSON.stringify(prog.steps));
  assert.strictEqual(res.os.id, 'ubuntu');
  assert.strictEqual(res.os.versionId, '24.04');
  // Efek nyata ke config fixture
  const main = fs.readFileSync(fx.main, 'utf8');
  assert(/^PasswordAuthentication yes$/m.test(main), 'config tidak berubah:\n' + main);
  // Password dikirim base64, tidak pernah plaintext di command line
  const chp = ssh.log.find(c => c.includes('chpasswd'));
  assert(chp, 'chpasswd tidak pernah dipanggil');
  assert(!chp.includes('Abc1234567'), 'password bocor plaintext ke perintah: ' + chp);
  assert(chp.includes(Buffer.from('root:Abc1234567').toString('base64')), 'harus lewat base64: ' + chp);
  // Backup dibuat sebelum config disentuh
  assert(ssh.log.some(c => c.includes('mkdir -p /tmp/sshd_backup_')), 'tidak ada langkah backup');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

okAsync('setupFlow: stepOffset menjaga checklist induk (Buat VPS / Reinstall Resmi)', async () => {
  const { setupVpsFlow, SETUP_STEPS } = require('../lib/setupFlow');
  const fx = makeSshdFixture('ubuntu');
  const opts = fixtureOpts(fx);
  const prog = makeProgress();
  // Checklist induk persis seperti alur "Buat VPS" di index.js
  ['Buat server di UpCloud', 'Tunggu state started', 'Tunggu port 22',
   'Setup password (jika mode password)', 'Tes login password', 'Hapus key bot'].forEach(s => prog.addStep(s));
  prog.setDone(0, 'UUID 001799d1');
  prog.setDone(1, 'started');
  prog.setDone(2, '22 terbuka');
  prog.setRunning(3, 'setup password');
  const off = prog.insertStepsAt(4, SETUP_STEPS);
  assert.strictEqual(off, 4, 'offset harus 4');
  assert.strictEqual(prog.steps.length, 15, 'total langkah harus 6 + 9');

  const res = await setupVpsFlow({
    sshSession: makeFakeSshSession(), targetUsername: 'root', password: 'Abc1234567',
    isRootUser: true, progress: prog, stepOffset: off, sshdOpts: opts
  });
  assert.strictEqual(res.success, true, 'setup harus sukses: ' + res.error);
  // Langkah induk TIDAK boleh tertimpa oleh sub-langkah setup (bug lama)
  assert.strictEqual(prog.steps[0].name, 'Buat server di UpCloud');
  assert.strictEqual(prog.steps[0].detail, 'UUID 001799d1', 'detail langkah 0 tertimpa');
  assert.strictEqual(prog.steps[0].status, 'done');
  assert.strictEqual(prog.steps[1].detail, 'started', 'detail langkah 1 tertimpa');
  assert.strictEqual(prog.steps[2].detail, '22 terbuka', 'detail langkah 2 tertimpa');
  assert.strictEqual(prog.steps[3].status, 'running', 'langkah induk "Setup password" ikut diubah');
  // 9 sub-langkah setup semuanya done
  for (let i = off; i < off + SETUP_STEPS.length; i++) {
    assert.strictEqual(prog.steps[i].status, 'done', `sub-langkah ${i} belum done: ` + JSON.stringify(prog.steps[i]));
  }
  // Langkah setelah sub-langkah tetap di tempatnya, siap dipakai index.js
  assert.strictEqual(prog.steps[13].name, 'Tes login password');
  assert.strictEqual(prog.steps[13].status, 'pending');
  assert.strictEqual(prog.steps[14].name, 'Hapus key bot');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

okAsync('setupFlow: OS non-Ubuntu/Debian ditolak sebelum config disentuh', async () => {
  const { setupVpsFlow } = require('../lib/setupFlow');
  const fx = makeSshdFixture('ubuntu');
  const opts = fixtureOpts(fx);
  const before = fs.readFileSync(fx.main, 'utf8');
  const prog = makeProgress();
  const ssh = makeFakeSshSession({ osRelease: 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID="3.19"\n' });
  const res = await setupVpsFlow({
    sshSession: ssh, targetUsername: 'root', password: 'Abc1234567',
    isRootUser: true, progress: prog, sshdOpts: opts
  });
  assert.strictEqual(res.success, false, 'harus gagal untuk Alpine');
  assert(/alpine/i.test(res.error), 'pesan error harus menyebut OS-nya: ' + res.error);
  assert.strictEqual(fs.readFileSync(fx.main, 'utf8'), before, 'config terlanjur diubah walau OS ditolak');
  assert.strictEqual(prog.steps[1].status, 'fail', 'langkah Deteksi OS harus ditandai gagal');
  assert(!ssh.log.some(c => c.includes('chpasswd')), 'tidak boleh sampai set password');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

okAsync('setupFlow: sshd -t gagal -> rollback config & lapor gagal', async () => {
  const { setupVpsFlow } = require('../lib/setupFlow');
  const fx = makeSshdFixture('ubuntu');
  const opts = fixtureOpts(fx);
  const original = fs.readFileSync(fx.main, 'utf8');
  const prog = makeProgress();
  // backup tetap jalan nyata supaya rollback punya bahan
  const ssh = makeFakeSshSession({
    sshd: (cmd) => cmd.includes('-t') ? { code: 255, stdout: '', stderr: 'Bad configuration option: bogus\n' }
      : { code: 0, stdout: 'passwordauthentication yes\npermitrootlogin yes\n', stderr: '' }
  });
  const res = await setupVpsFlow({
    sshSession: ssh, targetUsername: 'root', password: 'Abc1234567',
    isRootUser: true, progress: prog, sshdOpts: opts
  });
  assert.strictEqual(res.success, false, 'harus gagal saat sshd -t gagal');
  assert(/sshd -t/.test(res.error), 'pesan error harus menyebut sshd -t: ' + res.error);
  assert(/Bad configuration option/.test(res.error), 'stderr sshd harus ikut dilaporkan: ' + res.error);
  assert.strictEqual(res.rollbackStatus, 'berhasil dipulihkan');
  assert.strictEqual(fs.readFileSync(fx.main, 'utf8'), original, 'rollback tidak memulihkan config');
  assert(!fs.existsSync(path.join(fx.dropinDir, sshdConfig.DROPIN_NAME)), 'drop-in bot harus dibuang saat rollback');
  assert(!ssh.log.some(c => c.includes('chpasswd')), 'tidak boleh set password setelah rollback');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

okAsync('setupFlow: hasil sshd -T masih "no" -> rollback & lapor gagal', async () => {
  const { setupVpsFlow } = require('../lib/setupFlow');
  const fx = makeSshdFixture('ubuntu');
  const opts = fixtureOpts(fx);
  const original = fs.readFileSync(fx.main, 'utf8');
  const prog = makeProgress();
  const ssh = makeFakeSshSession({
    sshd: (cmd) => cmd.includes('-T') ? { code: 0, stdout: 'passwordauthentication no\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' }
  });
  const res = await setupVpsFlow({
    sshSession: ssh, targetUsername: 'root', password: 'Abc1234567',
    isRootUser: true, progress: prog, sshdOpts: opts
  });
  assert.strictEqual(res.success, false);
  assert(/PasswordAuthentication no/.test(res.error), 'error harus jelas: ' + res.error);
  assert.strictEqual(fs.readFileSync(fx.main, 'utf8'), original, 'rollback tidak memulihkan config');
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

ok('progress: insertStepsAt menyisip di posisi benar, clamp index, dan return offset', () => {
  const LiveProgress = require('../lib/progress');
  const prog = new LiveProgress({ telegram: { async editMessageText() {} } }, 1, 2, 'T', 900);
  prog.addStep('a'); prog.addStep('b'); prog.addStep('c');
  assert.strictEqual(prog.addStep('d'), 3, 'addStep harus mengembalikan indexnya');
  assert.strictEqual(prog.insertStepsAt(2, ['x', 'y']), 2);
  assert.deepStrictEqual(prog.steps.map(s => s.name), ['a', 'b', 'x', 'y', 'c', 'd']);
  assert.strictEqual(prog.steps[2].status, 'pending');
  // clamp: index melebihi panjang -> append di akhir; index negatif -> awal
  assert.strictEqual(prog.insertStepsAt(99, ['z']), 6);
  assert.strictEqual(prog.steps[prog.steps.length - 1].name, 'z');
  assert.strictEqual(prog.insertStepsAt(-5, ['first']), 0);
  assert.strictEqual(prog.steps[0].name, 'first');
  prog.stop();
});

ok('progress: failRunning menandai langkah yang benar walau index bergeser', () => {
  const LiveProgress = require('../lib/progress');
  const prog = new LiveProgress({ telegram: { async editMessageText() {} } }, 1, 2, 'T', 900);
  ['a', 'b', 'c'].forEach(s => prog.addStep(s));
  prog.setDone(0, 'ok');
  prog.setDone(1, 'ok');
  prog.setRunning(2, 'jalan');
  // Sisipkan sub-langkah SEBELUM langkah yang sedang jalan: index-nya bergeser 2 -> 4
  prog.insertStepsAt(1, ['x', 'y']);
  assert.deepStrictEqual(prog.steps.map(s => s.name), ['a', 'x', 'y', 'b', 'c']);
  assert.strictEqual(prog.steps.findIndex(s => s.status === 'running'), 4, 'precondition: running harus bergeser ke index 4');
  // setFail(2) yang di-hardcode akan menandai 'y' (langkah salah); failRunning tidak
  assert.strictEqual(prog.failRunning('error di tengah jalan'), 4);
  assert.strictEqual(prog.steps[4].name, 'c');
  assert.strictEqual(prog.steps[4].status, 'fail');
  assert.strictEqual(prog.steps[4].detail, 'error di tengah jalan');
  assert.strictEqual(prog.steps[2].status, 'pending', 'langkah lain tidak boleh ikut ditandai gagal');
  assert.strictEqual(prog.steps[0].status, 'done');

  // Fallback: tidak ada yang running -> pakai pending pertama
  const p2 = new LiveProgress({ telegram: { async editMessageText() {} } }, 1, 2, 'T', 900);
  p2.addStep('a'); p2.addStep('b');
  p2.setDone(0);
  assert.strictEqual(p2.failRunning('x'), 1);
  // Fallback terakhir: semua sudah done -> langkah terakhir
  const p3 = new LiveProgress({ telegram: { async editMessageText() {} } }, 1, 2, 'T', 900);
  p3.addStep('a'); p3.setDone(0);
  assert.strictEqual(p3.failRunning('x'), 0);
  // Tanpa langkah sama sekali -> -1, tidak melempar
  const p4 = new LiveProgress({ telegram: { async editMessageText() {} } }, 1, 2, 'T', 900);
  assert.strictEqual(p4.failRunning('x'), -1);
  p4.stop(); p3.stop(); p2.stop(); prog.stop();
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

  // === Regresi provider: endpoint & payload yang benar (tangkap argumen _request) ===
  const mockRequest = UpCloudClient.prototype._request;

  await okAsync('upcloud: getVncDetails pakai GET /server/{uuid} (API 1.3 remote_access_*)', async () => {
    const calls = [];
    UpCloudClient.prototype._request = async function(method, path) {
      calls.push({ method, path });
      assert(!path.includes('vnc_details'), 'masih memanggil endpoint palsu /vnc_details (404 di API 1.3)');
      return { server: { remote_access_enabled: 'yes', remote_access_host: 'console.upcloud.com', remote_access_port: '5900', remote_access_password: 'abcd1234', remote_access_type: 'vnc' } };
    };
    try {
      const c = new UpCloudClient('ucat_x');
      const vnc = await c.getVncDetails('u1');
      assert(calls.length === 1 && calls[0].method === 'GET' && calls[0].path === '/1.3/server/u1', 'calls: ' + JSON.stringify(calls));
      // alias legacy untuk UI tetap terisi
      assert(vnc.vnc_host === 'console.upcloud.com' && vnc.vnc_port === '5900' && vnc.vnc_password === 'abcd1234');
      assert(vnc.remote_access_enabled === 'yes');
    } finally {
      UpCloudClient.prototype._request = mockRequest;
    }
  });

  await okAsync('upcloud: setFirewallStatus hanya mengirim atribut firewall on/off', async () => {
    const bodies = [];
    UpCloudClient.prototype._request = async function(method, path, body) {
      bodies.push({ method, path, body });
      return { server: {} };
    };
    try {
      const c = new UpCloudClient('ucat_x');
      await c.setFirewallStatus('u1', true);
      await c.setFirewallStatus('u1', false);
      assert(bodies.length === 2 && bodies[0].method === 'PUT');
      assert(bodies[0].path === '/1.3/server/u1');
      assert.deepStrictEqual(bodies[0].body, { server: { firewall: 'on' } }, 'payload on: ' + JSON.stringify(bodies[0].body));
      assert.deepStrictEqual(bodies[1].body, { server: { firewall: 'off' } }, 'payload off');
    } finally {
      UpCloudClient.prototype._request = mockRequest;
    }
  });

  await okAsync('upcloud: billing summary coba endpoint baru lalu fallback deprecated saat 404', async () => {
    const paths = [];
    UpCloudClient.prototype._request = async function(method, path) {
      paths.push(path);
      if (path.includes('/billing/summary/')) {
        const e = new Error('not found'); e.status = 404; throw e;
      }
      if (path.includes('/billing_summary/')) return { billing: { total_amount: '12.34', currency: 'EUR' } };
      throw new Error('unexpected path ' + path);
    };
    try {
      const c = new UpCloudClient('ucat_x');
      const res = await c.getBillingSummary('2026-09');
      assert(paths.length === 2, 'harus coba 2 endpoint: ' + paths.join(','));
      assert(paths[0] === '/1.3/account/billing/summary/2026-09', 'endpoint baru dulu: ' + paths[0]);
      assert(paths[1] === '/1.3/account/billing_summary/2026-09', 'fallback deprecated: ' + paths[1]);
      assert(res.billing.total_amount === '12.34');
    } finally {
      UpCloudClient.prototype._request = mockRequest;
    }
  });

  ok('upcloud: parseBillingTotal & parseBillingCurrency defensif', () => {
    assert(UpCloudClient.parseBillingTotal({ billing: { total_amount: '12.34' } }) === '12.34');
    assert(UpCloudClient.parseBillingTotal({ billing_summary: { total: 9.5 } }) === '9.5');
    assert(UpCloudClient.parseBillingTotal({ total: 7 }) === '7');
    assert(UpCloudClient.parseBillingTotal({ lines: [{ amount: '2.00' }, { amount: '3.50' }] }) === '5.50');
    assert(UpCloudClient.parseBillingTotal({}) === null);
    assert(UpCloudClient.parseBillingCurrency({ billing_summary: { currency: 'EUR' } }) === 'EUR');
    assert(UpCloudClient.parseBillingCurrency({}) === '');
  });

  UpCloudClient.prototype._request = originalRequest;
  server.close();
}

Promise.all(pendingAsync)
  .then(() => testMockUpCloud())
  .then(() => Promise.all(pendingAsync))
  .then(() => {
    console.log(`\n=== HASIL TEST: ${passed} lulus, ${failed} gagal ===`);
    if (failed > 0) process.exit(1);
    else console.log('Semua tes dasar lulus. Catatan: tes integrasi penuh dengan VPS sungguhan belum dilakukan (sesuai risiko di README).');
  }).catch(e => {
    console.error('Error saat menjalankan test:', e);
    process.exit(1);
  });
