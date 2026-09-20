/**
 * keygen.js - Generate ED25519 keypair OpenSSH tanpa dependensi tambahan
 * Disimpan di data/keys/upcloud_ed25519 (private, 0600) dan .pub
 * Verifikasi dengan ssh2 utils.parseKey
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function encodeString(bufOrStr) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(bufOrStr);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}
function encodeUint32(num) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(num >>> 0, 0);
  return b;
}
function base64UrlDecode(str) {
  // JWK base64url
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function generateEd25519Keypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const jwkPriv = privateKey.export({ format: 'jwk' });
  const jwkPub = publicKey.export({ format: 'jwk' });
  const seed = base64UrlDecode(jwkPriv.d); // 32 bytes
  const pub = base64UrlDecode(jwkPub.x); // 32 bytes
  if (seed.length !== 32 || pub.length !== 32) {
    throw new Error('Gagal export ED25519 key');
  }
  const priv64 = Buffer.concat([seed, pub]); // 64 bytes
  return { seed, pub, priv64 };
}

function buildPublicKeyBlob(pub) {
  // blob = string "ssh-ed25519" + string pub(32)
  return Buffer.concat([encodeString('ssh-ed25519'), encodeString(pub)]);
}
function buildPublicKeyOpenSSH(pub, comment = 'upcloud-ssh-bot') {
  const blob = buildPublicKeyBlob(pub);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

function buildPrivateKeyOpenSSH(pub, priv64, comment = 'upcloud-ssh-bot') {
  const check = crypto.randomBytes(4).readUInt32BE(0);
  const pubBlob = buildPublicKeyBlob(pub);

  // Inner structure
  let inner = Buffer.concat([
    encodeUint32(check),
    encodeUint32(check),
    encodeString('ssh-ed25519'),
    encodeString(pub),
    encodeString(priv64),
    encodeString(comment)
  ]);
  // Padding to blocksize 8
  const blockSize = 8;
  let padLen = blockSize - (inner.length % blockSize);
  if (padLen === 0) padLen = blockSize;
  // Actually padding bytes 1,2,3... padLen
  const pad = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) pad[i] = i + 1;
  inner = Buffer.concat([inner, pad]);

  const magic = Buffer.from('openssh-key-v1\0', 'utf8');
  const outer = Buffer.concat([
    magic,
    encodeString('none'), // cipher
    encodeString('none'), // kdf
    encodeString(Buffer.alloc(0)), // kdf options empty string
    encodeUint32(1), // number of keys
    encodeString(pubBlob), // public key blob
    encodeString(inner) // encrypted private
  ]);

  const b64 = outer.toString('base64');
  // Split into 70 char lines
  const lines = b64.match(/.{1,70}/g) || [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

async function ensureKeypair(baseDir = path.join(__dirname, '..', 'data', 'keys')) {
  const privPath = path.join(baseDir, 'upcloud_ed25519');
  const pubPath = privPath + '.pub';

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    const priv = fs.readFileSync(privPath, 'utf8');
    const pub = fs.readFileSync(pubPath, 'utf8').trim();
    return { privPath, pubPath, privateKey: priv, publicKey: pub };
  }

  // Generate new
  const { pub, priv64 } = generateEd25519Keypair();
  const pubOpenSSH = buildPublicKeyOpenSSH(pub);
  const privOpenSSH = buildPrivateKeyOpenSSH(pub, priv64);

  // Write atomik
  const tmpPriv = privPath + '.tmp';
  const tmpPub = pubPath + '.tmp';
  fs.writeFileSync(tmpPriv, privOpenSSH, { mode: 0o600 });
  fs.writeFileSync(tmpPub, pubOpenSSH + '\n', { mode: 0o644 });
  try {
    fs.chmodSync(tmpPriv, 0o600);
  } catch {}
  fs.renameSync(tmpPriv, privPath);
  fs.renameSync(tmpPub, pubPath);
  try {
    fs.chmodSync(privPath, 0o600);
  } catch {}

  // Verifikasi dengan ssh2 (opsional jika modul tidak ada di test)
  try {
    const { utils } = require('ssh2');
    const parsed = utils.parseKey(fs.readFileSync(privPath));
    if (parsed instanceof Error) throw parsed;
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && e.message.includes('ssh2')) {
      // di lingkungan test tanpa node_modules, lewati verifikasi
      console.warn('[keygen] ssh2 tidak ada, verifikasi dilewati');
    } else {
      // Jika gagal verifikasi, hapus dan throw
      try { fs.unlinkSync(privPath); } catch {}
      try { fs.unlinkSync(pubPath); } catch {}
      throw new Error('Key yang dihasilkan tidak terbaca oleh ssh2: ' + e.message);
    }
  }

  return { privPath, pubPath, privateKey: privOpenSSH, publicKey: pubOpenSSH };
}

module.exports = {
  ensureKeypair,
  buildPublicKeyOpenSSH,
  buildPrivateKeyOpenSSH,
  generateEd25519Keypair
};
