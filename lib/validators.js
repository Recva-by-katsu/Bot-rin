/**
 * validators.js - Validasi input user
 */
const net = require('net');

function isIPv4(str) {
  return net.isIPv4(str);
}
function isIPv6(str) {
  return net.isIPv6(str);
}
function isValidIPv4(str) {
  return isIPv4(str);
}
function isValidCIDR(str) {
  // IPv4 CIDR saja sesuai spec firewall
  const parts = str.split('/');
  if (parts.length !== 2) return false;
  const [ip, prefix] = parts;
  if (!isIPv4(ip)) return false;
  const p = parseInt(prefix, 10);
  return p >= 0 && p <= 32;
}
function isValidIpOrHost(input) {
  if (!input) return false;
  const s = input.trim();
  if (s.length === 0 || s.length > 253) return false;
  if (isIPv4(s) || isIPv6(s)) return true;
  // hostname regex sederhana
  const hostnameRegex = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/;
  if (hostnameRegex.test(s)) {
    // Tolak kalau hanya angka dan titik (sudah ditangani IPv4)
    return true;
  }
  return false;
}
function isValidUsername(name) {
  if (!name) return false;
  return /^[a-z_][a-z0-9_-]{0,31}$/.test(name);
}
function isValidPasswordCustom(pw) {
  if (!pw) return false;
  if (pw.length < 10 || pw.length > 64) return false;
  if (/\s/.test(pw)) return false; // tanpa spasi
  if (/['"`\\]/.test(pw)) return false; // tanpa kutip/backslash
  if (!/[A-Za-z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  return true;
}
function isValidWindowsPassword(pw) {
  // A-Za-z0-9@_+=.- saja
  if (!pw) return false;
  return /^[A-Za-z0-9@_+=.\-]{10,64}$/.test(pw) && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}
function isValidSshPublicKey(key) {
  if (!key) return false;
  const trimmed = key.trim();
  // Harus diawali ssh-ed25519, ssh-rsa, ecdsa-sha2-*
  return /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/=]+\s*.*$/.test(trimmed);
}
function isPrivateKey(text) {
  if (!text) return false;
  return /-----BEGIN.*PRIVATE KEY-----/.test(text);
}
function isValidIsoLink(url) {
  if (!url) return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
function isValidImageName(name) {
  if (!name) return false;
  return /^[A-Za-z0-9][A-Za-z0-9 .()_+-]{2,79}$/.test(name);
}
function shellEscape(str) {
  if (typeof str !== 'string') str = String(str);
  // Escape untuk shell single quote: ' -> '\'' 
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
function redactSecrets(text) {
  if (!text) return text;
  let out = String(text);
  // Redaksi token ucat_
  out = out.replace(/ucat_[A-Za-z0-9_-]+/g, '***');
  // Redaksi link ISO dengan token/query
  out = out.replace(/https:\/\/[^\s]*\.iso[^\s]*/gi, '***.iso');
  out = out.replace(/https:\/\/windows\.katsuvip\.eu\.cc\/[^\s]+/gi, '***');
  // Redaksi password di log: cari pola password, tapi jangan terlalu agresif
  // Kita tidak redact semua, hanya yang jelas token
  return out;
}
function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}
function intToIp(int) {
  return [
    (int >>> 24) & 255,
    (int >>> 16) & 255,
    (int >>> 8) & 255,
    int & 255
  ].join('.');
}
function cidrToRange(cidr) {
  // Input: "203.0.113.5" atau "203.0.113.0/24"
  // Output: {start, end}
  cidr = cidr.trim();
  if (isIPv4(cidr)) {
    return { start: cidr, end: cidr };
  }
  if (!isValidCIDR(cidr)) throw new Error('CIDR tidak valid');
  const [ip, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const ipInt = ipToInt(ip);
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { start: intToIp(network), end: intToIp(broadcast) };
}

module.exports = {
  isIPv4,
  isIPv6,
  isValidIPv4,
  isValidCIDR,
  isValidIpOrHost,
  isValidUsername,
  isValidPasswordCustom,
  isValidWindowsPassword,
  isValidSshPublicKey,
  isPrivateKey,
  isValidIsoLink,
  isValidImageName,
  shellEscape,
  redactSecrets,
  ipToInt,
  intToIp,
  cidrToRange
};
