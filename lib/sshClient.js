/**
 * sshClient.js - Wrapper ssh2 dengan auth key dan password
 */
const { Client } = require('ssh2');
const fs = require('fs');

class SshSession {
  constructor({ host, port = 22, username = 'root', privateKey = null, privateKeyPath = null, password = null, connectTimeout = 15000, readyTimeout = 20000 }) {
    this.host = host;
    this.port = port;
    this.username = username;
    this.privateKey = privateKey;
    this.privateKeyPath = privateKeyPath;
    this.password = password;
    this.connectTimeout = connectTimeout;
    this.readyTimeout = readyTimeout;
    this.client = null;
    this.connected = false;
  }
  _getPrivateKey() {
    if (this.privateKey) return this.privateKey;
    if (this.privateKeyPath) {
      return fs.readFileSync(this.privateKeyPath, 'utf8');
    }
    return null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let finished = false;
      const timerConnect = setTimeout(() => {
        if (!finished) {
          finished = true;
          try { conn.end(); } catch {}
          reject(new Error('Timeout koneksi SSH (15 dtk)'));
        }
      }, this.connectTimeout);
      const timerReady = setTimeout(() => {
        if (!finished) {
          finished = true;
          try { conn.end(); } catch {}
          reject(new Error('Timeout menunggu ready SSH (20 dtk)'));
        }
      }, this.connectTimeout + this.readyTimeout);

      conn.on('ready', () => {
        if (finished) return;
        finished = true;
        clearTimeout(timerConnect);
        clearTimeout(timerReady);
        this.client = conn;
        this.connected = true;
        resolve(this);
      }).on('error', (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timerConnect);
        clearTimeout(timerReady);
        reject(err);
      }).connect({
        host: this.host,
        port: this.port,
        username: this.username,
        privateKey: this._getPrivateKey() || undefined,
        password: this.password || undefined,
        readyTimeout: this.readyTimeout,
        keepaliveInterval: 10000
      });
    });
  }
  exec(command, opts = {}) {
    const timeout = opts.timeout || 30000;
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('SSH belum terhubung'));
      let stdout = '';
      let stderr = '';
      let timer = setTimeout(() => {
        reject(new Error(`Timeout perintah SSH (${timeout}ms): ${command.slice(0,100)}`));
      }, timeout);
      this.client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }
        stream.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        }).on('data', (data) => {
          stdout += data.toString();
        }).stderr.on('data', (data) => {
          stderr += data.toString();
        });
      });
    });
  }
  close() {
    if (this.client) {
      try { this.client.end(); } catch {}
      this.client = null;
      this.connected = false;
    }
  }
}

module.exports = SshSession;
