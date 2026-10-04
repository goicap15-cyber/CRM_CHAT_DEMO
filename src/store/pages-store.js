// Danh sách trang Facebook đã kết nối với app (data/pages.json)
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'data', 'pages.json');

function list() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}

function save(pages) {
  fs.writeFileSync(FILE, JSON.stringify(pages, null, 2), 'utf8');
}

// Gộp theo pageId — giữ token cũ nếu bản mới không có
function upsertMany(newPages) {
  const cur = list();
  for (const p of newPages) {
    const i = cur.findIndex((x) => x.pageId === p.pageId);
    if (i >= 0) cur[i] = { ...cur[i], ...p, token: p.token || cur[i].token };
    else cur.push(p);
  }
  save(cur);
  return cur;
}

module.exports = { list, save, upsertMany };
