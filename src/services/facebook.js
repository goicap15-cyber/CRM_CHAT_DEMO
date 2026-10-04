// Service đăng nhập Facebook:
// 1) Mở cửa sổ Chrome thật → người dùng tự đăng nhập tay → tool theo dõi và
//    bắt cookie khi phiên xuất hiện, xác nhận cookie live rồi lưu vào hệ thống.
// 2) Nhận cookie dán tay (dự phòng) — xác nhận trước khi lưu.
//
// Nguyên tắc xác nhận cookie:
// - Ưu tiên xác thực NGAY TRONG cửa sổ Chrome vừa đăng nhập (fetch same-origin
//   mang phiên thật) — đây là chuẩn xác nhất.
// - Kiểm tra qua server (node fetch) chỉ là dự phòng. Facebook đôi khi trả 400 /
//   trang bất thường cho request không phải trình duyệt → coi là "unknown",
//   KHÔNG coi là hết hạn. Chỉ tính "dead" khi Facebook chủ động đá về login
//   hoặc trả USER_ID = 0.
const crypto = require('crypto');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const store = require('../store/db');

puppeteer.use(StealthPlugin());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const WAIT_TIMEOUT = 10 * 60 * 1000; // chờ người dùng tự đăng nhập tối đa 10 phút

const jobs = new Map();
let activeJobId = null;

/* ---------- Mở Chrome để người dùng tự đăng nhập, tool bắt cookie ---------- */

function startBrowserLogin() {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'opening_browser',
    message: 'Đang mở cửa sổ Chrome…',
    error: null,
    browser: null,
    page: null,
    sessionToken: null,
    account: null,
    captureAnnounced: false,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  activeJobId = id;
  runBrowserLogin(job).catch((e) => fail(job, (e && e.message) || 'Lỗi không xác định'));
  return job;
}

function getJob(id) {
  gc();
  return jobs.get(id) || null;
}

// Phiên đang chờ người dùng đăng nhập (dùng để khôi phục khi F5 trang)
function getActiveBrowserJob() {
  gc();
  const job = activeJobId ? jobs.get(activeJobId) : null;
  if (job && !['success', 'error'].includes(job.status)) return job;
  return null;
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || ['success', 'error'].includes(job.status)) return false;
  fail(job, 'Đã hủy đăng nhập.');
  return true;
}

function gc() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (['success', 'error'].includes(job.status) && now - job.createdAt > 30 * 60 * 1000) jobs.delete(id);
  }
}

function setStatus(job, status, message) {
  job.status = status;
  job.message = message || '';
}

function fail(job, error) {
  job.error = String(error);
  setStatus(job, 'error', job.error);
  closeBrowser(job);
}

function closeBrowser(job) {
  if (job.browser) {
    const b = job.browser;
    job.browser = null;
    b.close().catch(() => {});
  }
}

async function launchBrowser() {
  const args = ['--no-sandbox', '--lang=vi-VN', '--window-size=1200,860'];
  const base = { headless: false, args, defaultViewport: null };
  try {
    return await puppeteer.launch(base);
  } catch (e) {
    // Fallback: dùng Chrome cài sẵn trên máy nếu Chrome for Testing chưa tải xong
    try {
      return await puppeteer.launch({ ...base, channel: 'chrome' });
    } catch {
      return await puppeteer.launch({
        ...base,
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      });
    }
  }
}

async function runBrowserLogin(job) {
  const browser = await launchBrowser();
  job.browser = browser;
  browser.on('disconnected', () => {
    job.browser = null;
    if (!['success', 'error'].includes(job.status)) {
      fail(job, 'Cửa sổ Chrome đã bị đóng trước khi đăng nhập xong.');
    }
  });

  const page = await browser.newPage();
  job.page = page;
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7' });

  await page
    .goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch(() => {});
  setStatus(job, 'waiting',
    'Chrome đã mở — hãy tự đăng nhập Facebook trong cửa sổ đó (kể cả 2FA, xác minh). ' +
    'Ngay khi vào được tài khoản, hệ thống sẽ tự bắt cookie và xác nhận.');

  // Theo dõi thụ động: chỉ cần c_user + xs xuất hiện là bắt cookie
  const deadline = Date.now() + WAIT_TIMEOUT;
  while (Date.now() < deadline) {
    if (!job.browser) throw new Error('Đã hủy phiên đăng nhập.');

    let cookies = [];
    try { cookies = await page.cookies(); } catch { /* đang điều hướng */ }
    const hasUid = cookies.some((c) => c.name === 'c_user' && c.value);
    const hasXs = cookies.some((c) => c.name === 'xs' && c.value);

    if (hasUid && hasXs) {
      if (!job.captureAnnounced) {
        job.captureAnnounced = true;
        setStatus(job, 'capturing', 'Phát hiện phiên đăng nhập — đang xác nhận cookie live…');
      }
      const verdict = await verifyCapture(page, cookies);
      if (verdict.state === 'dead') {
        // Chưa xác thực được: có thể FB đang checkpoint hoặc phiên chưa ổn định.
        // KHÔNG đóng Chrome — người dùng có thể đang cần hoàn tất xác minh trong cửa sổ.
        setStatus(job, 'capturing',
          'Đã thấy phiên đăng nhập nhưng Facebook chưa xác nhận (có thể đang yêu cầu xác minh). ' +
          'Hãy hoàn tất trong cửa sổ Chrome nếu được hỏi — tool sẽ tự ghi nhận khi phiên hợp lệ.');
        await sleep(5000);
        continue;
      }
      return finishCapture(job, cookies, verdict);
    } else {
      job.captureAnnounced = false;
    }
    await sleep(1500);
  }
  closeBrowser(job);
  throw new Error('Hết thời gian chờ đăng nhập (10 phút). Hãy thử lại.');
}

// Xác nhận phiên sống: ưu tiên fetch same-origin trong Chrome; fallback hỏi qua server
async function verifyCapture(page, cookies) {
  // 1) Xác thực trong chính trình duyệt vừa đăng nhập (chuẩn xác nhất)
  const inBrowser = await verifyInBrowser(page);
  if (inBrowser.state !== 'unknown') return inBrowser;

  // 2) Fallback: hỏi qua server. Facebook hay trả lời bất thường với request
  //    không phải trình duyệt → unknown vẫn được chấp nhận (cookie vừa lấy từ
  //    trình duyệt thật thì gần như chắc chắn live).
  const header = cookieHeaderOf(cookies);
  let state = 'unknown';
  try { state = await probeCookie(header); } catch { state = 'unknown'; }
  if (state === 'dead') return { state: 'dead' };
  let uid = inBrowser.uid || null;
  let name = inBrowser.name || null;
  if (!uid) {
    const info = await fetchAccountInfo(header).catch(() => ({ userId: null, name: null }));
    uid = info.userId;
    name = name || info.name;
  }
  return { state: 'alive', uid, name };
}

async function verifyInBrowser(page) {
  return page
    .evaluate(async () => {
      try {
        const r = await fetch('https://www.facebook.com/me', { credentials: 'include' });
        const html = await r.text();
        const m = html.match(/CurrentUserInitialData",\s*\[\s*\]\s*,\s*(\{[^{}]*\})/);
        if (!m) return { state: 'unknown' };
        const d = JSON.parse(m[1]);
        if (d.USER_ID && d.USER_ID !== '0') {
          return { state: 'alive', uid: d.USER_ID, name: d.NAME || null };
        }
        return { state: 'dead' };
      } catch {
        return { state: 'unknown' };
      }
    })
    .catch(() => ({ state: 'unknown' }));
}

async function finishCapture(job, cookies, verdict) {
  const header = cookieHeaderOf(cookies);
  const uid = verdict.uid || cookies.find((c) => c.name === 'c_user').value;
  const name = verdict.name || 'Tài khoản Facebook';
  const token = crypto.randomUUID();
  persistLogin({ uid, name, username: null, cookies, token });
  job.sessionToken = token;
  job.account = publicAccount(store.getAccount(uid));
  setStatus(job, 'success', 'Đăng nhập thành công! Cookie live đã được lưu vào hệ thống.');
  setTimeout(() => closeBrowser(job), 2000); // để cửa sổ đóng nhẹ sau khi báo thành công
}

/* ---------- Đăng nhập bằng cookie dán tay ---------- */

async function establishFromCookie(cookieStr) {
  const cookies = parseCookieString(cookieStr);
  if (!cookies.length) throw new Error('Cookie rỗng hoặc sai định dạng (đúng dạng: name=value; name=value; …).');
  if (!cookies.some((c) => c.name === 'c_user') || !cookies.some((c) => c.name === 'xs')) {
    throw new Error('Cookie thiếu c_user hoặc xs — hãy copy TOÀN BỘ cookie từ trình duyệt đã đăng nhập Facebook.');
  }
  const header = cookieHeaderOf(cookies);
  let state = 'unknown';
  try { state = await probeCookie(header); } catch (e) { throw new Error(e.message); }
  if (state === 'dead') throw new Error('Cookie không hợp lệ hoặc đã hết hạn.');
  const info = await fetchAccountInfo(header).catch(() => ({ userId: null, name: null }));
  const uid = info.userId || cookies.find((c) => c.name === 'c_user').value;
  const name = info.name || 'Tài khoản Facebook';
  const token = crypto.randomUUID();
  persistLogin({ uid, name, username: null, cookies, token });
  return { account: publicAccount(store.getAccount(uid)), token };
}

/* ---------- Kiểm tra cookie còn sống (qua server) ---------- */

// Trả về 'alive' | 'dead' | 'unknown'
// - dead  : Facebook chủ động đá về login/checkpoint, hoặc USER_ID = 0
// - alive : trang trả về CurrentUserInitialData với USER_ID thật
// - unknown: 400 / trang bất thường / lỗi mạng — KHÔNG kết luận
async function probeCookie(cookieHeader) {
  // Bước 1: www.facebook.com/me với headers giống trình duyệt
  let res;
  try {
    res = await fetch('https://www.facebook.com/me', {
      headers: htmlHeaders(UA, cookieHeader),
      redirect: 'follow',
    });
  } catch {
    return 'unknown';
  }
  if (/login|checkpoint/.test(res.url || '')) return 'dead';
  const html = await res.text().catch(() => '');
  const d = extractInitialData(html);
  if (d.saw) return d.userId ? 'alive' : 'dead';

  // Bước 2: fallback m.facebook (server-rendered, redirect rõ ràng khi hết phiên)
  try {
    const r2 = await fetch('https://m.facebook.com/home.php', {
      headers: htmlHeaders(MOBILE_UA, cookieHeader),
      redirect: 'manual',
    });
    if (r2.status >= 300 && r2.status < 400) {
      const loc = r2.headers.get('location') || '';
      return /login/.test(loc) ? 'dead' : 'unknown';
    }
    if (r2.status === 200) {
      const body = await r2.text().catch(() => '');
      if (/name="login"|id="login_form"/i.test(body)) return 'dead';
      return 'alive';
    }
  } catch { /* bỏ qua */ }
  return 'unknown';
}

// Kiểm tra tài khoản đã lưu: trả về true/false theo nghĩa "giữ phiên hay không"
// (unknown → giữ phiên cũ, không tự đăng xuất người dùng vì lỗi bất thường)
async function checkAccount(acc) {
  if (!acc || !acc.cookies) return false;
  let state = 'unknown';
  try { state = await probeCookie(cookieHeaderOf(acc.cookies)); } catch { state = 'unknown'; }
  const alive = state !== 'dead';
  store.setAccountCheck(acc.uid, alive, Date.now());
  return alive;
}

// Đọc khối CurrentUserInitialData khỏi HTML — khối này là JSON hợp lệ.
// saw = có tìm thấy khối (để phân biệt "trang lạ" với "chưa đăng nhập")
function extractInitialData(html) {
  const m = (html || '').match(/CurrentUserInitialData",\s*\[\s*\]\s*,\s*(\{[^{}]*\})/);
  if (!m) return { userId: null, name: null, saw: false };
  try {
    const data = JSON.parse(m[1]);
    return {
      userId: data.USER_ID && data.USER_ID !== '0' ? data.USER_ID : null,
      name: data.NAME || null,
      saw: true,
    };
  } catch {
    return { userId: null, name: null, saw: true };
  }
}

async function fetchAccountInfo(cookieHeader) {
  try {
    const res = await fetch('https://www.facebook.com/me', {
      headers: htmlHeaders(UA, cookieHeader),
      redirect: 'follow',
    });
    return extractInitialData(await res.text().catch(() => ''));
  } catch {
    return { userId: null, name: null, saw: false };
  }
}

function htmlHeaders(ua, cookieHeader) {
  return {
    'user-agent': ua,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    'upgrade-insecure-requests': '1',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': ua === MOBILE_UA ? '"iOS"' : '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'cookie': cookieHeader,
  };
}

/* ---------- Tiện ích chung ---------- */

function persistLogin({ uid, name, username, cookies, token }) {
  store.upsertAccount({ uid, name, username, cookies, alive: true, lastCheckAt: Date.now() });
  store.createSession(token, uid);
}

function parseCookieString(str) {
  return String(str || '')
    .split(/;\s*/)
    .map((p) => {
      const i = p.indexOf('=');
      if (i < 0) return null;
      return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: '.facebook.com', path: '/' };
    })
    .filter((c) => c && c.name && c.value);
}

function cookieHeaderOf(cookies) {
  return (cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
}

function maskUsername(u) {
  if (!u) return null;
  if (u.includes('@')) {
    const [a, b] = u.split('@');
    return a.slice(0, 2) + '•••@' + b;
  }
  return u.slice(0, 3) + '••••' + u.slice(-2);
}

function publicAccount(acc) {
  if (!acc) return null;
  const names = (acc.cookies || []).map((c) => c.name);
  const keep = ['c_user', 'xs', 'datr', 'fr', 'sb'].filter((k) => names.includes(k));
  const preview = keep.map((k) => k + '=••••••').join('; ')
    + (names.length > keep.length ? `; +${names.length - keep.length} cookie khác` : '');
  return {
    uid: acc.uid,
    name: acc.name,
    avatar: `https://graph.facebook.com/${acc.uid}/picture?width=256&height=256`,
    username: maskUsername(acc.username),
    cookieCount: (acc.cookies || []).length,
    cookiePreview: preview,
    lastCheckAt: acc.lastCheckAt || null,
    alive: acc.alive !== false,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  startBrowserLogin,
  getJob,
  getActiveBrowserJob,
  cancelJob,
  establishFromCookie,
  probeCookie,
  checkAccount,
  cookieHeaderOf,
  publicAccount,
  launchChrome: launchBrowser,
  UA,
};
