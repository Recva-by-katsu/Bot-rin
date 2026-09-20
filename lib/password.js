/**
 * password.js - Generate dan validasi password
 */
const crypto = require('crypto');
const { isValidPasswordCustom, isValidWindowsPassword } = require('./validators');

function generateRandom(length = 16, windowsSafe = false) {
  // Untuk Linux: campur huruf besar kecil angka simbol aman
  // Untuk Windows: hanya A-Za-z0-9@_+=.-
  const charsNormal = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#$%+=.-';
  const charsWindows = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@_+=.-';
  const charset = windowsSafe ? charsWindows : charsNormal;
  let pw = '';
  // Pastikan ada huruf dan angka
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const numbers = '23456789';
  // Generate random
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    pw += charset[bytes[i] % charset.length];
  }
  // Pastikan ada huruf dan angka, kalau tidak ada, paksa
  if (!/[A-Za-z]/.test(pw)) {
    pw = letters[bytes[0] % letters.length] + pw.slice(1);
  }
  if (!/[0-9]/.test(pw)) {
    pw = pw[0] + numbers[bytes[1] % numbers.length] + pw.slice(2);
  }
  // Untuk Windows, kalau charset sudah windows safe, oke
  if (windowsSafe) {
    // Pastikan sesuai regex windows
    if (!isValidWindowsPassword(pw)) {
      // fallback generate ulang dengan charset windows strict
      return generateRandom(length, true);
    }
  } else {
    if (!isValidPasswordCustom(pw)) {
      // Jika mengandung karakter terlarang (kutip, backslash, spasi) tidak mungkin karena charset aman
      // Tapi pastikan
      pw = pw.replace(/['"`\\\s]/g, 'A');
    }
  }
  return pw;
}

function validateCustomPassword(pw) {
  if (!isValidPasswordCustom(pw)) {
    return {
      valid: false,
      reason: 'Password harus 10-64 karakter, ada huruf dan angka, tanpa spasi/kutip/backslash.'
    };
  }
  return { valid: true };
}

function validateWindowsPassword(pw) {
  if (!isValidWindowsPassword(pw)) {
    return {
      valid: false,
      reason: 'Password Windows hanya boleh A-Z a-z 0-9 @ _ + = . - , 10-64 karakter, ada huruf dan angka.'
    };
  }
  return { valid: true };
}

function getPasswordChoices(isOwner, config) {
  const choices = [];
  choices.push({ id: 'random', label: '🎲 Acak (disarankan)' });
  choices.push({ id: 'custom', label: '✏️ Ketik sendiri' });
  if (isOwner || config.DEFAULT_PASSWORD_FOR_EVERYONE) {
    choices.push({ id: 'default', label: '🔁 Password Default' });
  }
  return choices;
}

module.exports = {
  generateRandom,
  validateCustomPassword,
  validateWindowsPassword,
  getPasswordChoices
};
