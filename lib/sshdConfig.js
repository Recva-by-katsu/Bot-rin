/**
 * sshdConfig.js - Helper untuk perbaikan sshd_config
 * Logika perbaikan dijalankan via SSH, bukan di sini.
 * File ini menyediakan script bash yang idempotent.
 */

function getBackupCommands(backupDir, isRoot) {
  const sudo = isRoot ? '' : 'sudo -n ';
  return [
    `${sudo}mkdir -p ${backupDir}`,
    `${sudo}cp /etc/ssh/sshd_config ${backupDir}/sshd_config 2>/dev/null || true`,
    `${sudo}sh -c 'cp /etc/ssh/sshd_config.d/*.conf ${backupDir}/ 2>/dev/null || true'`
  ];
}

function getFixCommands(isRoot) {
  const sudo = isRoot ? '' : 'sudo -n ';
  // Fungsi bash untuk set config
  const script = `
set -e
fix_config() {
  file="$1"
  key="$2"
  value="$3"
  if [ ! -f "$file" ]; then return 0; fi
  # Jika ada baris yang mengandung key (baik komentar atau tidak), ganti yang tidak dikomentar terakhir, atau uncomment
  if grep -qE "^[[:space:]]*${key}[[:space:]]+" "$file"; then
    ${sudo}sed -i -E "s/^[[:space:]]*${key}[[:space:]]+.*/${key} ${value}/g" "$file"
  elif grep -qE "^[[:space:]]*#.*${key}[[:space:]]+" "$file"; then
    ${sudo}sed -i -E "s/^[[:space:]]*#.*${key}[[:space:]]+.*/${key} ${value}/" "$file"
  else
    echo "${key} ${value}" | ${sudo}tee -a "$file" >/dev/null
  fi
  # Hapus duplikat, simpan yang terakhir
  # Untuk sederhana, kita biarkan, karena sshd pakai yang pertama? Sebenarnya terakhir menang di beberapa versi.
  # Kita akan pastikan hanya satu: hapus semua lalu tambah satu di akhir jika duplikat >1
  count=$(grep -cE "^[[:space:]]*${key}[[:space:]]+" "$file" || true)
  if [ "$count" -gt 1 ]; then
    ${sudo}awk -v k="${key}" -v v="${value}" '
      BEGIN { found=0 }
      $1==k { if (found==0) {print k" "v; found=1} next }
      {print}
    ' "$file" > /tmp/sshd_tmp && ${sudo}mv /tmp/sshd_tmp "$file"
    # Jika tidak ada yang terprint karena semua duplikat dihapus, tambah lagi
    if ! grep -qE "^[[:space:]]*${key}[[:space:]]+" "$file"; then
      echo "${key} ${value}" | ${sudo}tee -a "$file" >/dev/null
    fi
  fi
}

# Fix main config
fix_config /etc/ssh/sshd_config PasswordAuthentication yes
${isRoot ? 'fix_config /etc/ssh/sshd_config PermitRootLogin yes' : ''}

# Fix drop-in yang mengandung PasswordAuthentication
for f in /etc/ssh/sshd_config.d/*.conf; do
  [ -e "$f" ] || continue
  if grep -qE "PasswordAuthentication" "$f"; then
    fix_config "$f" PasswordAuthentication yes
  fi
  ${isRoot ? 'if grep -qE "PermitRootLogin" "$f"; then fix_config "$f" PermitRootLogin yes; fi' : ''}
done
`;
  return script;
}

function getValidateCommand(isRoot) {
  const sudo = isRoot ? '' : 'sudo -n ';
  return `${sudo}sshd -t`;
}

function getRestartCommands(isRoot) {
  const sudo = isRoot ? '' : 'sudo -n ';
  return `
if ${sudo}systemctl restart ssh 2>/dev/null; then
  echo "restarted ssh via systemctl"
elif ${sudo}systemctl restart sshd 2>/dev/null; then
  echo "restarted sshd via systemctl"
elif ${sudo}service ssh restart 2>/dev/null; then
  echo "restarted ssh via service"
elif ${sudo}service sshd restart 2>/dev/null; then
  echo "restarted sshd via service"
else
  echo "gagal restart" >&2
  exit 1
fi
`;
}

function getCheckEffectiveCommand(isRoot) {
  const sudo = isRoot ? '' : 'sudo -n ';
  return `${sudo}sshd -T`;
}

module.exports = {
  getBackupCommands,
  getFixCommands,
  getValidateCommand,
  getRestartCommands,
  getCheckEffectiveCommand
};
