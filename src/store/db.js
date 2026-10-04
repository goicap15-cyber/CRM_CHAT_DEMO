// Lưu trữ dữ liệu dạng JSON trong thư mục data/ — dễ thay bằng SQLite ở giai đoạn sau
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

const accounts = readJson(ACCOUNTS_FILE, {});
const sessions = readJson(SESSIONS_FILE, {});

module.exports = {
  getAccount(uid) { return accounts[uid] || null; },
  allAccounts() { return accounts; },
  upsertAccount(acc) {
    accounts[acc.uid] = { ...accounts[acc.uid], ...acc };
    writeJson(ACCOUNTS_FILE, accounts);
  },
  setAccountCheck(uid, alive, lastCheckAt) {
    const a = accounts[uid];
    if (!a) return;
    a.alive = alive;
    a.lastCheckAt = lastCheckAt;
    writeJson(ACCOUNTS_FILE, accounts);
  },
  getSession(token) { return sessions[token] || null; },
  createSession(token, uid) {
    sessions[token] = { uid, createdAt: new Date().toISOString() };
    writeJson(SESSIONS_FILE, sessions);
  },
  deleteSession(token) {
    if (sessions[token]) { delete sessions[token]; writeJson(SESSIONS_FILE, sessions); }
  },
};
