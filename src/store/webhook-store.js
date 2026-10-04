// Lưu cấu hình webhook Messenger: appId, verifyToken (data/webhook.json)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', '..', 'data', 'webhook.json');

function get() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; }
}

function write(cfg) {
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function getOrCreateVerifyToken() {
  const cfg = get() || {};
  if (cfg.verifyToken) return cfg.verifyToken;
  const token = 'crmwb_' + crypto.randomBytes(9).toString('hex');
  write({ ...cfg, verifyToken: token, updatedAt: new Date().toISOString() });
  return token;
}

function getAppId() {
  return (get() || {}).appId || null;
}

function setAppId(appId) {
  write({ ...(get() || {}), appId: String(appId), updatedAt: new Date().toISOString() });
}

function clearAppId() {
  const cfg = get() || {};
  delete cfg.appId;
  write(cfg);
}

function recordRun(status, note) {
  const cfg = get() || {};
  write({ ...cfg, lastRun: { status, note: String(note || '').slice(0, 300), at: new Date().toISOString() } });
}

function getLastRun() {
  return (get() || {}).lastRun || null;
}

module.exports = { get, getOrCreateVerifyToken, getAppId, setAppId, clearAppId, recordRun, getLastRun };
