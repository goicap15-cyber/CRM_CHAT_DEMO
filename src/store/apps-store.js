// Lịch sử các app đã tạo: mỗi lần chạy "Tạo app & Webhook" = 1 bản ghi mới
// (data/apps.json — mới nhất đứng đầu)
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'data', 'apps.json');

function list() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}

function save(apps) {
  fs.writeFileSync(FILE, JSON.stringify(apps, null, 2), 'utf8');
}

function add(rec) {
  const apps = list();
  apps.unshift({ ...rec, pages: rec.pages || [] });
  save(apps);
  return apps[0];
}

function update(appId, patch) {
  const apps = list();
  const i = apps.findIndex((x) => x.appId === String(appId));
  if (i >= 0) {
    apps[i] = { ...apps[i], ...patch };
    save(apps);
  }
  return apps;
}

function getLatest() {
  return list()[0] || null;
}

function remove(appId) {
  const apps = list().filter((x) => x.appId !== String(appId));
  save(apps);
  return apps;
}

module.exports = { list, add, update, getLatest, remove };
