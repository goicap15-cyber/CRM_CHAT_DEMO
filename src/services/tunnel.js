// Quản lý cloudflared quick tunnel để webhook có URL public:
// - Nếu máy đang chạy sẵn cloudflared → đọc hostname từ metrics (127.0.0.1:20241) và dùng lại.
// - Nếu chưa có → tự bật cloudflared.exe (quick tunnel), đọc URL trycloudflare.com từ log.
const { spawn } = require('child_process');
const path = require('path');

const EXE = path.join(__dirname, '..', '..', 'cloudflared.exe');
const METRICS_URL = 'http://127.0.0.1:20241/metrics';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

let cachedUrl = null;
let starting = null;

function getUrl() { return cachedUrl; }

// Đọc hostname tunnel từ cloudflared đang chạy sẵn trên máy
async function probeExisting() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(METRICS_URL, { signal: ctrl.signal });
    clearTimeout(t);
    const text = await res.text();
    const m = text.match(URL_RE);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

// Tự bật cloudflared quick tunnel — process sống độc lập với server (unref)
// nên khi tắt CRM thì tunnel vẫn chạy, lần mở sau sẽ tái sử dụng được ngay
function spawnOwn(port) {
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const done = (url) => { if (!settled) { settled = true; resolve(url); } };
    let child;
    try {
      child = spawn(EXE, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return done(null);
    }
    const onData = (d) => {
      buf += String(d);
      const m = buf.match(URL_RE);
      if (m) done(m[0]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => done(null));
    child.on('exit', () => done(null));
    child.unref();
    setTimeout(() => done(null), 30000);
  });
}

function ensureTunnel(port) {
  if (cachedUrl) return Promise.resolve(cachedUrl);
  if (starting) return starting;
  starting = (async () => {
    const existing = await probeExisting();
    if (existing) {
      cachedUrl = existing;
      console.log('  🌐 Tunnel có sẵn trên máy: ' + existing);
      return existing;
    }
    const url = await spawnOwn(port);
    if (url) {
      cachedUrl = url;
      console.log('  🌐 Tunnel mới đã bật: ' + url);
      return url;
    }
    starting = null; // cho phép thử lại lần sau
    return null;
  })();
  return starting;
}

// Chờ tunnel sẵn sàng — dùng ngay trước khi điền webhook vào form Facebook
function ready(timeoutMs = 20000) {
  if (cachedUrl) return Promise.resolve(cachedUrl);
  const p = starting || ensureTunnel();
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(cachedUrl), timeoutMs);
    p.then(() => { clearTimeout(t); resolve(cachedUrl); });
  });
}

module.exports = { ensureTunnel, ready, getUrl };
