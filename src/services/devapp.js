// Service "Đồng bộ — Tạo ứng dụng Facebook":
// 1) Dùng phiên cookie đã lưu để mở Developers Facebook trong cửa sổ Chrome thật.
// 2) Bấm "Tạo ứng dụng" (bắt theo href — không phụ thuộc ngôn ngữ).
// 3) Điền "Tên ứng dụng" + "Email liên hệ" rồi chạy hết wizard:
//    Tiếp → chọn "Khác (5)" → chọn "Khác" (trải nghiệm cũ) → Tiếp →
//    chọn "Kinh doanh" → Tiếp → "Tạo ứng dụng".
// 4) Nếu Facebook bắt nhập lại mật khẩu (re-auth): dừng, báo CRM hiện ô nhập
//    mật khẩu → điền vào form xác nhận và bấm "Gửi". Mật khẩu KHÔNG lưu lại.
// Mọi nút bấm bắt theo text đa ngôn ngữ + role, không dùng class tự sinh của FB.
const crypto = require('crypto');
const path = require('path');
const store = require('../store/db');
const webhookStore = require('../store/webhook-store');
const pagesStore = require('../store/pages-store');
const appsStore = require('../store/apps-store');
const fb = require('./facebook');

const jobs = new Map();
let activeId = null;
// Mật khẩu user nhập lần gần nhất — chỉ giữ trong RAM của phiên làm việc,
// khởi động lại server là mất. Dùng để tự điền khi Facebook hỏi lại.
let lastPassword = null;

const APPS_URL = 'https://developers.facebook.com/apps/';

// Regex nguồn (chuỗi) dùng trong page context — đa ngôn ngữ
const CONTINUE_RE = '^(?:tiếp|tiếp tục|next|continue|siguiente|continuar|avançar|continuer|weiter)$';
const OTHER_RADIO_RE = '^(?:khác|other|otro|outro|autre)\\b';
const BUSINESS_RE = '^(?:kinh doanh|business|negocios|negócios?|affaires)\\b';
const CREATE_RE = '^(?:tạo ứng dụng|create app|crear aplicaci[oó]n|criar aplicativo|créer une application)$';
const SAVE_WEBHOOK_RE = '^(?:xác minh và lưu|verify and save|verificar y guardar)$';

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

/* ---------- Khởi động tác vụ ---------- */

function startAppCreation(appName, email, webhookUrl) {
  const accounts = store.allAccounts();
  const uid = Object.keys(accounts)[0];
  const acc = uid ? accounts[uid] : null;
  if (!acc || !acc.cookies || !acc.cookies.length) {
    return { error: 'Chưa có phiên Facebook nào. Hãy đăng nhập trước.' };
  }
  if (getActive()) return { error: 'Đã có tác vụ đồng bộ đang chạy. Hãy hủy hoặc chờ xong.' };

  // Đóng cửa sổ Chrome của các tác vụ cũ đã xong để không dồn cửa sổ
  for (const [, j] of jobs) {
    if (['success', 'error'].includes(j.status)) closeBrowser(j);
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'opening_browser',
    message: 'Đang mở cửa sổ Chrome…',
    error: null,
    browser: null,
    page: null,
    waitPwd: null,
    webhookUrl: webhookUrl || null,
    appId: null,
    appName,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  activeId = id;
  run(job, acc, appName, email).catch((e) => failSoft(job, (e && e.message) || 'Lỗi không xác định'));
  return { job };
}

function getJob(id) {
  gc();
  return jobs.get(id) || null;
}

function getActive() {
  gc();
  const job = activeId ? jobs.get(activeId) : null;
  if (job && !['success', 'error'].includes(job.status)) return job;
  return null;
}

function cancelSync(id) {
  const job = jobs.get(id);
  if (!job || ['success', 'error'].includes(job.status)) return false;
  job.status = 'error';
  job.error = 'Đã hủy đồng bộ.';
  job.message = 'Đã hủy đồng bộ.';
  if (job.waitPwd) { const w = job.waitPwd; job.waitPwd = null; w.reject(new Error('Đã hủy.')); }
  closeBrowser(job);
  return true;
}

function submitPassword(id, password) {
  const job = jobs.get(id);
  if (!job || !job.waitPwd) return false;
  job.waitPwd.resolve(String(password));
  return true;
}

function gc() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (['success', 'error'].includes(job.status) && now - job.createdAt > 60 * 60 * 1000) jobs.delete(id);
  }
}

function setStatus(job, status, message) {
  job.status = status;
  job.message = message || '';
}

// Lỗi: đóng Chrome luôn — mọi kết quả đã chụp lại tại data/sync-error.png
function failSoft(job, error) {
  job.error = String(error);
  job.status = 'error';
  job.message = job.error;
  closeBrowser(job);
  webhookStore.recordRun('error', job.error);
}

function closeBrowser(job) {
  if (job.browser) {
    const b = job.browser;
    job.browser = null;
    b.close().catch(() => {});
  }
}

function errorShot(page, name) {
  return page.screenshot({ path: path.join(DATA_DIR, name) }).catch(() => {});
}

/* ---------- Luồng chính ---------- */

async function run(job, acc, appName, email) {
  const browser = await fb.launchChrome();
  job.browser = browser;
  job.popups = []; // các popup OAuth (Kết nối trang) sẽ được thu vào đây
  browser.on('targetcreated', (target) => {
    if (target.type() === 'page') {
      target.page().then((p) => { if (p && job.popups) job.popups.push(p); }).catch(() => {});
    }
  });
  browser.on('disconnected', () => {
    job.browser = null;
    if (job.waitPwd) { const w = job.waitPwd; job.waitPwd = null; w.reject(new Error('Cửa sổ Chrome đã bị đóng.')); }
    if (!['success', 'error'].includes(job.status)) {
      failSoft(job, 'Cửa sổ Chrome đã bị đóng.');
    }
  });

  const page = await browser.newPage();
  job.page = page;
  await page.setUserAgent(fb.UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7' });

  setStatus(job, 'restoring', 'Đang khôi phục phiên đăng nhập Facebook…');
  await injectSession(page, acc);

  // MỖI LẦN CHẠY = TẠO MỘT APP MỚI (không tái sử dụng app cũ — lịch sử lưu ở data/apps.json)
  let appId = null;

  setStatus(job, 'loading_apps', 'Đang mở Developers Facebook…');
  await page.goto(APPS_URL, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
  if (/log_in|login\.php/.test(page.url() || '')) {
    throw new Error('Phiên Facebook đã hết hạn — hãy đăng nhập lại trong CRM rồi đồng bộ lại.');
  }

  setStatus(job, 'finding_create', 'Đang tìm nút "Tạo ứng dụng"…');
  const link = await page
    .waitForSelector('a[href*="/apps/creation"]', { timeout: 60000 })
    .catch(() => null);
  if (!link) {
    throw new Error('Không thấy nút "Tạo ứng dụng" trên trang Ứng dụng. Bạn có thể tự bấm trong Chrome.');
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {}),
    link.click().catch(() => page.evaluate((el) => el.click(), link)),
  ]);

  setStatus(job, 'filling', 'Đang điền Tên ứng dụng & Email liên hệ…');
  const result = await pollAndFill(page, appName, email);
  if (!result.done) {
    throw new Error(result.reason === 'timeout'
      ? 'Không tìm thấy form "Tên ứng dụng" trong 90 giây — hãy kiểm tra cửa sổ Chrome.'
      : 'Không điền được form: ' + (result.reason || 'lỗi không rõ'));
  }

  /* ---- Wizard ---- */
  setStatus(job, 'wizard', 'Đang bấm "Tiếp" (Chi tiết ứng dụng)…');
  await clickWhenAvailable(job, page, CONTINUE_RE, '[role="button"], button', 60000, 'Tiếp (bước 1)');

  setStatus(job, 'wizard', 'Đang chọn "Khác" (trường hợp sử dụng)…');
  await clickWhenAvailable(job, page, OTHER_RADIO_RE, '[role="gridcell"]', 60000, 'Khác (trường hợp sử dụng)');

  setStatus(job, 'wizard', 'Đang chọn "Khác" — trải nghiệm cũ…');
  await clickWhenAvailable(job, page, OTHER_RADIO_RE, '[role="button"]', 60000, 'Khác (trải nghiệm cũ)');

  setStatus(job, 'wizard', 'Đang bấm "Tiếp"…');
  await clickWhenAvailable(job, page, CONTINUE_RE, '[role="button"], button', 60000, 'Tiếp (bước 2)');

  setStatus(job, 'wizard', 'Đang chọn "Kinh doanh"…');
  await clickWhenAvailable(job, page, BUSINESS_RE, '[role="button"]', 60000, 'Kinh doanh');

  setStatus(job, 'wizard', 'Đang bấm "Tiếp"…');
  await clickWhenAvailable(job, page, CONTINUE_RE, '[role="button"], button', 60000, 'Tiếp (bước 3)');

  setStatus(job, 'wizard', 'Đang bấm "Tạo ứng dụng"…');
  await clickWhenAvailable(job, page, CREATE_RE, '[role="button"], button', 60000, 'Tạo ứng dụng (xác nhận)');

  /* ---- Chờ kết quả / mật khẩu xác nhận ----
   * Facebook có thể chen xác thực mật khẩu và HỦY action vừa bấm — vì vậy nếu
   * nút "Tạo ứng dụng" vẫn còn trên màn hình thì bấm lại (tối đa mỗi 8s). */
  const deadline = Date.now() + 180000;
  let lastReclick = 0;
  while (Date.now() < deadline) {
    const url = page.url() || '';
    const m = url.match(/\/apps\/(\d+)/);
    if (m) {
      appId = m[1];
      break;
    }
    if (await passwordVisible(page)) {
      await askPassword(job, page);
      continue; // sau khi gửi mật khẩu, tiếp tục chờ chuyển trang
    }
    if (Date.now() - lastReclick > 8000) {
      if (await clickMatching(page, CREATE_RE, '[role="button"], button')) lastReclick = Date.now();
    }
    await sleep(1500);
  }
  if (!appId) {
    await errorShot(page, 'sync-error.png');
    throw new Error('Đã bấm "Tạo ứng dụng" nhưng 3 phút không thấy chuyển trang. Hãy kiểm tra cửa sổ Chrome — có thể còn một bước xác nhận.');
  }
  setStatus(job, 'wizard', `Đã tạo ứng dụng (App ID: ${appId}) — chuyển sang cấu hình Messenger…`);

  // Cấu hình Messenger/webhook/trang; lỗi vẫn ghi lịch sử app trước khi báo lỗi
  let pages = [];
  let setupNote = '';
  let setupErr = null;
  try {
    const result = await setupMessenger(job, page, appId);
    pages = result.pages;
    setupNote = result.note;
  } catch (e) {
    setupErr = e;
  }
  appsStore.add({
    appId,
    name: appName,
    email,
    webhookUrl: job.webhookUrl || null,
    createdAt: new Date().toISOString(),
    status: setupErr ? 'error' : 'success',
    note: setupErr ? String(setupErr.message || setupErr).slice(0, 300) : setupNote,
    pages,
  });
  if (setupErr) throw setupErr;

  const successMsg =
    (pages.length
      ? `Đã tạo app mới (App ID: ${appId}) và đồng bộ ${pages.length} trang: ${pages.map((p) => p.name).join(', ')}. `
      : `Đã tạo app mới (App ID: ${appId}) nhưng chưa cào được trang nào. `) +
    `Webhook: ${job.webhookUrl}`;
  setStatus(job, 'success', successMsg);
  webhookStore.recordRun('success', successMsg);
  closeBrowser(job); // xong việc là tự đóng Chrome
}

/* Bấm lại "Tạo ứng dụng" trên cửa sổ Chrome của job cũ (khi re-auth làm hủy action) */
async function resumeSync(syncId) {
  const job = jobs.get(syncId);
  if (!job) return { error: 'Không tìm thấy tác vụ.' };
  if (!job.browser || !job.page) return { error: 'Cửa sổ Chrome đã đóng — hãy chạy Đồng bộ lại từ đầu.' };
  job.status = 'wizard';
  job.error = null;
  job.message = 'Đang bấm lại "Tạo ứng dụng"…';
  finishResume(job).catch((e) => failSoft(job, (e && e.message) || 'Lỗi không xác định'));
  return { job };
}

async function finishResume(job) {
  const page = job.page;
  const deadline = Date.now() + 180000;
  let lastReclick = 0;
  let appId = null;
  while (Date.now() < deadline) {
    if (!job.browser) throw new Error('Cửa sổ Chrome đã bị đóng.');
    const url = page.url() || '';
    const m = url.match(/\/apps\/(\d+)/);
    if (m) {
      appId = m[1];
      break;
    }
    if (await passwordVisible(page)) {
      await askPassword(job, page);
      continue;
    }
    if (Date.now() - lastReclick > 8000) {
      if (await clickMatching(page, CREATE_RE, '[role="button"], button')) lastReclick = Date.now();
    }
    await sleep(1500);
  }
  if (!appId) {
    await errorShot(page, 'sync-error.png');
    throw new Error('Vẫn không thấy chuyển trang — hãy bấm tay nút "Tạo ứng dụng" trong Chrome.');
  }
  let pages = [];
  let setupErr = null;
  try {
    const result = await setupMessenger(job, page, appId);
    pages = result.pages;
  } catch (e) {
    setupErr = e;
  }
  appsStore.add({
    appId,
    name: job.appName || 'CRM app',
    email: null,
    webhookUrl: job.webhookUrl || null,
    createdAt: new Date().toISOString(),
    status: setupErr ? 'error' : 'success',
    note: setupErr ? String(setupErr.message || setupErr).slice(0, 300) : (job.message || ''),
    pages,
  });
  if (setupErr) throw setupErr;

  const successMsg = `Đã tạo app mới (App ID: ${appId})` +
    (pages.length ? ` và đồng bộ ${pages.length} trang: ${pages.map((p) => p.name).join(', ')}.` : '.');
  setStatus(job, 'success', successMsg);
  webhookStore.recordRun('success', successMsg);
  closeBrowser(job); // xong việc là tự đóng Chrome
}

/* ---------- Các bước tiện ích ---------- */

// Bấm nút có text khớp regex. Ưu tiên nút cuối cùng trong DOM (footer của dialog).
async function clickMatching(page, source, selector) {
  return page.evaluate((source, selector) => {
    const re = new RegExp(source, 'i');
    const els = [...document.querySelectorAll(selector)];
    const matches = els.filter((el) => {
      const visible = el.offsetParent !== null || el.getClientRects().length > 0;
      if (!visible) return false;
      const t = (el.innerText || el.textContent || '').trim();
      return t && re.test(t);
    });
    if (!matches.length) return false;
    const el = matches[matches.length - 1];
    el.scrollIntoView({ block: 'center' });
    const opts = { bubbles: true, cancelable: true, view: window };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, opts));
    }
    return true;
  }, source, selector).catch(() => false);
}

async function passwordVisible(page) {
  return page
    .evaluate(() => {
      const i = document.querySelector('#ajax_password, input[data-testid="reauth_password_field"]');
      return !!(i && i.offsetParent);
    })
    .catch(() => false);
}

// Chờ phần tử xuất hiện rồi bấm; nếu Facebook chặn bằng form mật khẩu thì xử lý
// mật khẩu trước (gia hạn thời gian chờ) rồi bấm lại
async function clickWhenAvailable(job, page, source, selector, timeoutMs, label) {
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await passwordVisible(page)) {
      await askPassword(job, page);
      deadline = Date.now() + timeoutMs;
      continue;
    }
    if (await clickMatching(page, source, selector)) return true;
    await sleep(1000);
  }
  await errorShot(page, 'sync-error.png');
  throw new Error(`Không tìm thấy bước "${label}" trong ${Math.round(timeoutMs / 1000)}s — Facebook có thể đã đổi luồng. Hãy kiểm tra cửa sổ Chrome.`);
}

function askPassword(job, page) {
  return (async () => {
    // Ưu tiên mật khẩu user đã nhập trong phiên này (chỉ giữ trong RAM)
    if (lastPassword) {
      setStatus(job, 'verifying', 'Đang dùng mật khẩu đã lưu trong phiên để xác nhận…');
      await fillPassword(page, lastPassword);
      await sleep(3000);
      if (!(await passwordVisible(page))) return 'handled';
      lastPassword = null; // sai — phải hỏi lại user
    }
    setStatus(job, 'need_password',
      'Facebook yêu cầu nhập mật khẩu để xác nhận. Vui lòng nhập trong CRM rồi bấm "Gửi mật khẩu".');
    const pwd = await waitUserPassword(job);
    lastPassword = pwd;
    setStatus(job, 'verifying', 'Đang gửi mật khẩu xác nhận tới Facebook…');
    const ok = await fillPassword(page, pwd);
    if (!ok) throw new Error('Không điền được mật khẩu vào form xác nhận của Facebook.');
    await sleep(3500);
    const still = await passwordVisible(page);
    if (still) {
      setStatus(job, 'need_password', 'Facebook chưa chấp nhận mật khẩu (có thể sai). Vui lòng nhập lại.');
      const pwd2 = await waitUserPassword(job);
      lastPassword = pwd2;
      setStatus(job, 'verifying', 'Đang gửi lại mật khẩu…');
      await fillPassword(page, pwd2);
      await sleep(3500);
    }
    return 'handled';
  })();
}

async function fillPassword(page, pwd) {
  const input = await page
    .waitForSelector('#ajax_password, input[data-testid="reauth_password_field"], input[type="password"]',
      { timeout: 15000, visible: true })
    .catch(() => null);
  if (!input) return false;
  await input.click({ clickCount: 3 }).catch(() => {}); // chọn sẵn text cũ để thay thế
  await input.type(pwd, { delay: 15 }).catch(() => {});
  await sleep(300);
  // Gửi bằng Enter ngay trên ô mật khẩu — form submit gốc của trình duyệt
  await page.keyboard.press('Enter').catch(() => {});
  await sleep(2000);
  return true;
}

function waitUserPassword(job) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      job.waitPwd = null;
      reject(new Error('Không nhận được mật khẩu trong 10 phút. Hãy chạy lại Đồng bộ.'));
    }, 600000);
    job.waitPwd = {
      resolve: (v) => { clearTimeout(t); job.waitPwd = null; resolve(v); },
      reject: (e) => { clearTimeout(t); job.waitPwd = null; reject(e); },
    };
  });
}

/* ---------- Điền form Tên + Email (giữ nguyên từ phiên bản trước) ---------- */

async function pollAndFill(page, appName, email) {
  const attempt = () => page.evaluate((appName, email) => {
    const visible = (el) => el && el.offsetParent !== null && !el.disabled;
    const byLabel = (re) => {
      for (const lb of [...document.querySelectorAll('label')]) {
        const t = ((lb.innerText || lb.textContent) || '').trim().toLowerCase();
        if (re.test(t)) {
          const forId = lb.getAttribute('for');
          let el = forId ? document.getElementById(forId) : null;
          if (!el) el = lb.querySelector('input');
          if (visible(el)) return el;
        }
      }
      return null;
    };
    const findInputs = () => {
      let name = byLabel(/tên ứng dụng|app name|nombre de la aplicaci|nome do aplicativo|nom de l'application/);
      let emailEl = byLabel(/email liên hệ|contact email|correo electr|e-mail de contato|e-mail de contact|contact e-mail/);
      if (!visible(name) || !visible(emailEl)) {
        const inputs = [...document.querySelectorAll('input[type="text"]')].filter(visible);
        if (!name && inputs.length >= 2) { name = inputs[0]; emailEl = emailEl || inputs[1]; }
        else if (!name && inputs.length === 1) { name = inputs[0]; }
      }
      return { name: visible(name) ? name : null, email: visible(emailEl) ? emailEl : null };
    };
    const setVal = (el, v) => {
      el.focus();
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      proto.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    };
    return new Promise((resolve) => {
      const deadline = Date.now() + 90000;
      const tick = () => {
        try {
          const { name, email: emailEl } = findInputs();
          if (name) {
            setVal(name, appName);
            if (emailEl) {
              setVal(emailEl, email);
              return resolve({ done: true, emailFilled: true });
            }
            setTimeout(() => {
              const again = findInputs();
              if (again.email) { setVal(again.email, email); resolve({ done: true, emailFilled: true }); }
              else resolve({ done: true, emailFilled: false });
            }, 1500);
            return;
          }
        } catch (e) {
          return resolve({ done: false, reason: String(e && e.message || e) });
        }
        if (Date.now() > deadline) return resolve({ done: false, reason: 'timeout' });
        setTimeout(tick, 800);
      };
      tick();
    });
  }, appName, email).catch((e) => ({ done: false, reason: String(e && e.message || e) }));

  let r = await attempt();
  if (!r.done && r.reason && /execution context|destroyed|target closed/i.test(r.reason)) {
    await new Promise((res) => setTimeout(res, 2000));
    r = await attempt();
  }
  return r;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------- Giai đoạn 2: Messenger product + webhook ---------- */

async function setupMessenger(job, page, appId) {
  const webhookUrl = job.webhookUrl || 'http://localhost:3000/webhook';
  const verifyToken = webhookStore.getOrCreateVerifyToken();

  setStatus(job, 'adding_messenger', 'Đang mở dashboard và thêm sản phẩm Messenger…');
  await page.goto(`https://developers.facebook.com/apps/${appId}/dashboard/`, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});

  // Bấm "Thiết lập" của Messenger nếu chưa thêm (href chứa product_route=messenger)
  const link = await page.waitForSelector('a[href*="product_route=messenger"]', { timeout: 45000 }).catch(() => null);
  if (link) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {}),
      link.click().catch(() => page.evaluate((el) => el.click(), link)),
    ]);
  }

  // Đảm bảo đang ở trang cấu hình Messenger (URL thật: messenger_api_settings)
  if (!/\/messenger/.test(page.url() || '')) {
    await page.goto(`https://developers.facebook.com/apps/${appId}/messenger/messenger_api_settings/`, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
  }

  setStatus(job, 'filling_webhook', 'Đang điền URL gọi lại & mã xác minh webhook…');
  const r = await pollAndFillWebhook(page, webhookUrl, verifyToken);
  if (!r.done) {
    await errorShot(page, 'sync-error.png');
    throw new Error('Không điền được webhook: ' + (r.reason || 'không rõ') + '. Hãy kiểm tra cửa sổ Chrome.');
  }

  // Nếu URL trùng giá trị cũ, nút "Xác minh và lưu" sẽ bị khóa — webhook đã lưu từ trước
  const canSave = await page
    .evaluate(() => {
      const btns = [...document.querySelectorAll('[role="button"], button')]
        .filter((b) => /^(xác minh và lưu|verify and save)$/i.test((b.innerText || '').trim()));
      const b = btns[btns.length - 1];
      return !!b && b.getAttribute('aria-disabled') !== 'true'
        && (b.offsetParent !== null || b.getClientRects().length > 0);
    })
    .catch(() => false);

  let saveNote = 'Webhook đã được lưu từ trước (URL trùng khớp) — không cần lưu lại. ';
  let errDialog = null;
  if (canSave) {
    setStatus(job, 'saving_webhook', 'Đang bấm "Xác minh và lưu"…');
    const saved = await clickWhenEnabled(page, SAVE_WEBHOOK_RE, 30000);
    if (!saved) {
      await errorShot(page, 'sync-error.png');
      throw new Error('Nút "Xác minh và lưu" không bật được — Facebook có thể yêu cầu URL https public. Hãy kiểm tra Chrome.');
    }

    // Facebook gọi webhook để xác minh — đợi kết quả / dialog lỗi
    await sleep(20000);
    errDialog = await page
      .evaluate(() => {
        const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => x.offsetParent);
        const t = d ? d.innerText || '' : '';
        return /không thể|could not|unable to|failed|không xác minh/i.test(t) ? t.slice(0, 150) : null;
      })
      .catch(() => null);
    saveNote = errDialog
      ? `Facebook chưa xác minh được webhook (${errDialog.replace(/\n/g, ' ').slice(0, 120)}…) — kiểm tra URL public. `
      : 'Đã bấm "Xác minh và lưu" — Facebook xác minh thành công. ';
  }
  await page.screenshot({ path: path.join(DATA_DIR, 'sync-last.png') }).catch(() => {});

  /* ---- Giai đoạn 3: kết nối trang & đồng bộ danh sách fanpage ---- */
  setStatus(job, 'connecting_pages', 'Đang kết nối trang Facebook (mục "Tạo mã truy cập")…');
  // Mở rộng card "Tạo mã truy cập" nếu đang thu gọn (nút "Xem thêm")
  for (let i = 0; i < 5; i++) {
    const st = await expandCard(page, 'tạo mã truy cập|generate access token');
    if (st !== 'no-heading') break;
    await sleep(1500);
  }
  await connectPagesFlow(job, page);

  setStatus(job, 'syncing_pages', 'Đang đồng bộ danh sách trang về CRM…');
  const pages = await syncPageTable(job, page);
  const pageSummary = pages.map((p) => `${p.name} (${p.pageId})`).join(', ');

  const successMsg =
    saveNote +
    (pages.length
      ? `Đã đồng bộ ${pages.length} trang: ${pageSummary}. `
      : 'Không có trang nào được kết nối. ') +
    `Webhook: ${webhookUrl} • Mã xác minh ${verifyToken}.`;
  webhookStore.recordRun('success', successMsg);
  return { pages, note: saveNote };
}

/* ---------- Giai đoạn 3a: bấm "Kết nối" và chạy hết popup OAuth ---------- */

const OAUTH_STEP_RES = [
  '^(?:tiếp tục|continue)$',
  '^(?:cho phép|allow|ok|đồng ý)$',
  '^(?:lưu|save)$',
  '^(?:đã hiểu|got it|done|understood)$',
];

async function connectPagesFlow(job, page) {
  // Bảng trang đã hiện → đã kết nối từ trước, bỏ qua OAuth
  const hasTable = await page
    .evaluate(() => !!document.querySelector('tbody tr[role="row"] span[label]'))
    .catch(() => false);
  if (hasTable) return;

  // Bấm "Kết nối" (mục 2. Tạo mã truy cập) — có thể cần cuộn xuống nên poll
  const deadline = Date.now() + 45000;
  let clicked = false;
  while (Date.now() < deadline && !clicked) {
    clicked = await clickMatching(page, '^(?:kết nối|connect)$', '[role="button"], button');
    if (!clicked) await sleep(1500);
  }
  if (!clicked) {
    await errorShot(page, 'sync-error.png');
    throw new Error('Không thấy nút "Kết nối" trong mục "Tạo mã truy cập". Hãy kiểm tra Chrome.');
  }

  // Chờ popup OAuth (thường mở cửa sổ mới; nếu điều hướng tại chỗ thì dùng chính trang đó)
  const popup = await waitOAuthPopup(job, page, 25000);
  const dlg = popup || page;
  await driveOAuthSteps(job, dlg);

  // Popup có thể hiện "Đã hiểu" trên trang chính sau khi đóng — bấm nếu còn
  await clickMatching(page, '^(?:đã hiểu|got it)$', '[role="button"], button');
  await sleep(2000);
}

async function waitOAuthPopup(job, mainPage, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = (job.popups || []).find(
      (x) => !x.isClosed() && /dialog\/oauth|facebook\.com\/v\d+\.\d+\/dialog|dialog\/oauth/.test(x.url() || ''),
    );
    if (p) return p;
    if (/dialog\/oauth/.test(mainPage.url() || '')) return null; // dialog mở ngay trên trang chính
    await sleep(800);
  }
  return null;
}

// Bấm lần lượt các nút xuất hiện trong dialog OAuth: Tiếp tục → Tiếp tục → Lưu → Đã hiểu
async function driveOAuthSteps(job, dlg) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (dlg.isClosed()) return; // popup tự đóng khi xong
    if (await passwordVisible(dlg)) {
      await askPassword(job, dlg);
      continue;
    }
    let clicked = false;
    for (const re of OAUTH_STEP_RES) {
      if (await clickMatching(dlg, re, '[role="button"], button')) { clicked = true; break; }
    }
    if (clicked) { await sleep(2500); continue; }
    await sleep(1500);
  }
}

/* ---------- Giai đoạn 3b: đọc bảng trang, bấm "Tạo" lấy token, lưu về CRM ---------- */

async function extractPageRows(page) {
  return page
    .evaluate(() => {
      const rows = [...document.querySelectorAll('tbody tr[role="row"]')];
      return rows.map((r) => {
        const idEl = r.querySelector('span[label]');
        const pageId = idEl ? idEl.getAttribute('label') : null;
        const firstCell = r.querySelector('td');
        let name = null;
        if (firstCell) {
          for (const d of firstCell.querySelectorAll('div')) {
            const t = (d.innerText || '').trim().split('\n')[0];
            if (t && !/^\d+$/.test(t)) { name = t; break; }
          }
        }
        const tokenMatch = (r.innerText || '').match(/EA[A-Za-z0-9_-]{30,}/);
        return { pageId, name, token: tokenMatch ? tokenMatch[0] : null };
      }).filter((p) => p.pageId);
    })
    .catch(() => []);
}

async function syncPageTable(job, page) {
  // Chờ bảng trang xuất hiện (card đã mở rộng từ trước)
  const deadline = Date.now() + 90000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await extractPageRows(page);
    if (rows.length) break;
    // có thể card lại thu gọn sau khi tải lại — mở lại nếu cần
    await expandCard(page, 'tạo mã truy cập|generate access token');
    await sleep(2500);
  }
  if (!rows.length) {
    await errorShot(page, 'sync-error.png');
    throw new Error('Không thấy danh sách trang sau khi kết nối. Hãy kiểm tra Chrome.');
  }

  // Chỉ cào danh sách: pageId + tên trang (token sẽ làm ở bước sau)
  const clean = rows.map((r) => ({
    pageId: r.pageId,
    name: r.name || ('Trang ' + r.pageId),
    token: null,
    connectedAt: new Date().toISOString(),
  }));
  pagesStore.upsertMany(clean);
  return clean;
}

// Mở rộng card thu gọn: tìm heading → đi lên tìm [role=button][aria-controls]
// có aria-expanded=false (nút "Xem thêm") rồi bấm
async function expandCard(page, headingSource) {
  return page
    .evaluate((headingSource) => {
      const re = new RegExp(headingSource, 'i');
      const h = [...document.querySelectorAll('[role="heading"], h1, h2, h3')]
        .find((x) => re.test((x.innerText || '').trim()));
      if (!h) return 'no-heading';
      let node = h;
      for (let i = 0; i < 10 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const btn = [...node.querySelectorAll('[role="button"][aria-controls]')]
          .find((b) => b.getAttribute('aria-expanded') === 'false');
        if (btn) {
          btn.scrollIntoView({ block: 'center' });
          const o = { bubbles: true, cancelable: true, view: window };
          for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            btn.dispatchEvent(new MouseEvent(t, o));
          }
          return 'expanded';
        }
      }
      return 'already-expanded';
    }, headingSource)
    .catch(() => 'error');
}

// Điền URL gọi lại + mã xác minh trong card "Đặt cấu hình webhook" (poll ngay trong trang)
async function pollAndFillWebhook(page, cbUrl, vToken) {
  return page
    .evaluate((cbUrl, vToken) => {
      const visible = (el) => el && el.offsetParent !== null && !el.disabled;
      const setVal = (el, v) => {
        el.focus();
        const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        proto.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
      };
      const byLabel = (re) => {
        for (const lb of [...document.querySelectorAll('label')]) {
          const t = ((lb.innerText || lb.textContent) || '').trim().toLowerCase();
          if (re.test(t)) {
            const forId = lb.getAttribute('for');
            let el = forId ? document.getElementById(forId) : null;
            if (!el) el = lb.querySelector('input');
            if (visible(el)) return el;
          }
        }
        return null;
      };
      return new Promise((resolve) => {
        const deadline = Date.now() + 60000;
        const tick = () => {
          try {
            let urlEl = byLabel(/url gọi lại|callback url/i)
              || [...document.querySelectorAll('input[type="url"]')].find(visible);
            if (!urlEl) {
              // card đang thu gọn — bấm nút "Xem thêm" của card webhook
              const heads = [...document.querySelectorAll('[role="heading"], h1, h2, h3')];
              const h = heads.find((x) => /đặt cấu hình webhook|configure webhooks/i.test((x.innerText || '').trim()));
              if (h) {
                let node = h;
                for (let i = 0; i < 10 && node; i++) {
                  node = node.parentElement;
                  if (!node) break;
                  const btn = [...node.querySelectorAll('[role="button"][aria-controls]')]
                    .find((b) => b.getAttribute('aria-expanded') === 'false');
                  if (btn) { btn.click(); break; }
                }
              }
              if (Date.now() > deadline) return resolve({ done: false, reason: 'timeout — không thấy ô URL gọi lại' });
              return setTimeout(tick, 1500);
            }
            const original = urlEl.value;
            setVal(urlEl, cbUrl);

            let tokenEl = byLabel(/xác minh mã|verify token/i);
            if (!tokenEl) {
              tokenEl = [...document.querySelectorAll('input[type="text"]')].find((i) => visible(i) && i !== urlEl) || null;
            }
            if (tokenEl) setVal(tokenEl, vToken);
            // URL trùng giá trị cũ → nút Lưu sẽ bị khóa vì không có gì thay đổi
            return resolve({ done: true, tokenFilled: !!tokenEl, unchanged: original === cbUrl });
          } catch (e) {
            return resolve({ done: false, reason: String(e && e.message || e) });
          }
        };
        tick();
      });
    }, cbUrl, vToken)
    .catch((e) => ({ done: false, reason: String(e && e.message || e) }));
}

// Chờ nút (theo text) bật Enabled rồi bấm
async function clickWhenEnabled(page, source, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page
      .evaluate((source) => {
        const re = new RegExp(source, 'i');
        const els = [...document.querySelectorAll('[role="button"], button')].filter((el) => {
          if (el.getAttribute('aria-disabled') === 'true') return false;
          const visible = el.offsetParent !== null || el.getClientRects().length > 0;
          if (!visible) return false;
          const t = (el.innerText || '').trim();
          return t && re.test(t);
        });
        if (!els.length) return false;
        const el = els[els.length - 1];
        el.scrollIntoView({ block: 'center' });
        const opts = { bubbles: true, cancelable: true, view: window };
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          el.dispatchEvent(new MouseEvent(type, opts));
        }
        return true;
      }, source)
      .catch(() => false);
    if (ok) return true;
    await sleep(1200);
  }
  return false;
}

/* ---------- Xóa ứng dụng: vào Developers Facebook, menu ⋯ → Gỡ ứng dụng ---------- */

// Nạp cookie phiên đã lưu vào trang Chrome (dùng chung cho tạo app & xóa app)
async function injectSession(page, acc) {
  for (const c of acc.cookies) {
    await page.setCookie({
      name: c.name,
      value: c.value,
      domain: c.domain && c.domain.includes('facebook') ? c.domain : '.facebook.com',
      path: c.path || '/',
      ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
      ...(typeof c.secure === 'boolean' ? { secure: c.secure } : {}),
      ...(typeof c.httpOnly === 'boolean' ? { httpOnly: c.httpOnly } : {}),
    }).catch(() => {});
  }
}

function startDeleteApp(appId) {
  const accounts = store.allAccounts();
  const uid = Object.keys(accounts)[0];
  const acc = uid ? accounts[uid] : null;
  if (!acc || !acc.cookies || !acc.cookies.length) {
    return { error: 'Chưa có phiên Facebook nào. Hãy đăng nhập trước.' };
  }
  if (getActive()) return { error: 'Đã có tác vụ đang chạy. Hãy hủy hoặc chờ xong.' };

  const id = crypto.randomUUID();
  const job = {
    id,
    kind: 'delete',
    status: 'opening_browser',
    message: 'Đang mở cửa sổ Chrome…',
    error: null,
    browser: null,
    page: null,
    waitPwd: null,
    appId: String(appId),
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  activeId = id;
  runDelete(job, acc, String(appId)).catch((e) => failSoft(job, (e && e.message) || 'Lỗi không xác định'));
  return { job };
}

async function runDelete(job, acc, appId) {
  const browser = await fb.launchChrome();
  job.browser = browser;
  browser.on('disconnected', () => {
    job.browser = null;
    if (job.waitPwd) { const w = job.waitPwd; job.waitPwd = null; w.reject(new Error('Cửa sổ Chrome đã bị đóng.')); }
    if (!['success', 'error'].includes(job.status)) failSoft(job, 'Cửa sổ Chrome đã bị đóng.');
  });

  const page = await browser.newPage();
  job.page = page;
  await page.setUserAgent(fb.UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7' });

  setStatus(job, 'restoring', 'Đang khôi phục phiên đăng nhập Facebook…');
  await injectSession(page, acc);

  // Vào trang DANH SÁCH ứng dụng — mỗi app có menu ⋯ riêng ở đó
  setStatus(job, 'loading_apps', 'Đang mở danh sách ứng dụng…');
  await page.goto('https://developers.facebook.com/apps/', { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
  if (/log_in|login.php/.test(page.url() || '')) {
    throw new Error('Phiên Facebook đã hết hạn — hãy đăng nhập lại trong CRM.');
  }

  // Tìm đúng card chứa App ID rồi lấy menu ⋯ của app đó
  setStatus(job, 'finding_menu', `Đang tìm ứng dụng ${appId} và mở menu ⋯…`);
  const menuIdx = await findMenuIndexForApp(page, appId, 60000);
  if (menuIdx < 0) {
    // Không thấy app trong danh sách → coi như đã xóa, dọn dữ liệu trong CRM
    appsStore.remove(appId);
    const latest = appsStore.getLatest();
    pagesStore.save(latest ? (latest.pages || []) : []);
    setStatus(job, 'success', `Ứng dụng ${appId} không có trong danh sách (đã xóa trước đó) — đã dọn dữ liệu trong CRM.`);
    closeBrowser(job);
    return;
  }

  await clickMenuByIndex(page, menuIdx);
  await sleep(1300);
  const opened = await clickMatching(page, '^(?:gỡ ứng dụng|remove app)$', '[role="menuitem"], [role="button"]');
  if (!opened) {
    await page.keyboard.press('Escape').catch(() => {});
    await errorShot(page, 'sync-error.png');
    throw new Error('Không tìm thấy mục "Gỡ ứng dụng" trong menu. Hãy kiểm tra Chrome.');
  }

  // An toàn: CHỜ hộp xác nhận chứa đúng TÊN app (poll tới 10 giây, không vội)
  const rec = appsStore.list().find((x) => x.appId === appId);
  const delName = rec ? rec.name : '';
  await sleep(1000);
  let dlgMatch = false;
  const verifyDeadline = Date.now() + 10000;
  while (Date.now() < verifyDeadline) {
    dlgMatch = await page
      .evaluate((name) => {
        const nameL = (name || '').toLowerCase();
        const overlays = [...document.querySelectorAll('[role="dialog"], div[aria-modal="true"]')]
          .filter((x) => x.offsetParent !== null || x.getClientRects().length > 0);
        for (const d of overlays) {
          const t = (d.innerText || '').toLowerCase();
          if (t.includes('gỡ') && nameL && t.includes(nameL)) return true;
        }
        return false;
      }, delName)
      .catch(() => false);
    if (dlgMatch) break;
    await sleep(1000);
  }
  if (!dlgMatch && delName) {
    await page.keyboard.press('Escape').catch(() => {});
    await errorShot(page, 'sync-error.png');
    throw new Error(`Không thấy hộp xác nhận cho "${delName}" sau 10 giây — đã hủy để an toàn. Kiểm tra Chrome.`);
  }

  // Hộp xác nhận → bấm Gỡ
  setStatus(job, 'removing', 'Đang xác nhận gỡ ứng dụng…');
  await sleep(1500);
  const confirmed = await clickMatching(page, '^(?:gỡ|remove)$', '[role="button"], button');
  if (!confirmed) {
    await errorShot(page, 'sync-error.png');
    throw new Error('Không thấy nút "Gỡ" trong hộp xác nhận. Hãy kiểm tra Chrome.');
  }

  // Có thể hỏi mật khẩu — dùng mật khẩu đã lưu trong phiên hoặc hỏi user
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    if (!job.browser) throw new Error('Cửa sổ Chrome đã bị đóng.');
    if (await passwordVisible(page)) { await askPassword(job, page); continue; }
    // Bấm Đã hiểu nếu FB hiện thông báo
    await clickMatching(page, '^(?:đã hiểu|got it|ok)$', '[role="button"], button');
    // App biến mất khỏi danh sách = xóa xong
    const gone = await page
      .evaluate((id) => !(document.body.innerText || '').replace(/\s/g, '').includes(id), appId)
      .catch(() => false);
    if (gone) {
      appsStore.remove(appId);
      const latest = appsStore.getLatest();
      pagesStore.save(latest ? (latest.pages || []) : []);
      await page.screenshot({ path: path.join(DATA_DIR, 'delete-last.png') }).catch(() => {});
      setStatus(job, 'success', `Đã gỡ ứng dụng ${appId} khỏi Facebook và xóa dữ liệu trong CRM.`);
      closeBrowser(job);
      return;
    }
    await sleep(1500);
  }
  await errorShot(page, 'sync-error.png');
  throw new Error('Đã gỡ nhưng 2,5 phút không thấy app biến mất khỏi danh sách. Hãy kiểm tra thủ công.');
}

// Tìm index của nút menu ⋯ thuộc đúng card chứa App ID:
// từ phần tử nhỏ nhất chứa text App ID, đi lên tới container đầu tiên có nút menu
// trong subtree — đó chính là card của app (chứa cả ID lẫn menu của nó)
async function findMenuIndexForApp(page, appId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const idx = await page
      .evaluate((appId) => {
        const all = [...document.querySelectorAll('[role="button"][aria-haspopup="menu"]')]
          .filter((b) => b.offsetParent !== null || b.getClientRects().length > 0);
        if (!all.length) return -1;
        // phần tử nhỏ nhất (sâu nhất) chứa đúng text App ID
        const els = [...document.querySelectorAll('div, span, td, a')]
          .filter((el) => (el.textContent || '').replace(/\s/g, '').includes(appId))
          .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
        if (!els.length) return -1;
        // đi lên: container đầu tiên có nút menu trong subtree = card của app này
        let node = els[0];
        for (let k = 0; k < 15 && node; k++) {
          node = node.parentElement;
          if (!node) break;
          const menus = [...node.querySelectorAll('[role="button"][aria-haspopup="menu"]')]
            .filter((b) => b.offsetParent !== null || b.getClientRects().length > 0);
          if (menus.length) return all.indexOf(menus[0]);
        }
        return -1;
      }, appId)
      .catch(() => -1);
    if (idx >= 0) return idx;
    await sleep(2000);
  }
  return -1;
}

async function clickMenuByIndex(page, idx) {
  return page
    .evaluate((idx) => {
      const btns = [...document.querySelectorAll('[role="button"][aria-haspopup="menu"]')]
        .filter((b) => b.offsetParent !== null || b.getClientRects().length > 0);
      const b = btns[idx];
      if (!b) return false;
      b.scrollIntoView({ block: 'center' });
      const o = { bubbles: true, cancelable: true, view: window };
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        b.dispatchEvent(new MouseEvent(t, o));
      }
      return true;
    }, idx)
    .catch(() => false);
}


/* ---------- Cấu hình trang: đăng ký field webhook + tạo Page Access Token ---------- */

const PAGE_FIELDS = ['message_reads', 'messages', 'messaging_postbacks'];

function startPageSetup(appId, pageIds) {
  const accounts = store.allAccounts();
  const uid = Object.keys(accounts)[0];
  const acc = uid ? accounts[uid] : null;
  if (!acc || !acc.cookies || !acc.cookies.length) {
    return { error: 'Chưa có phiên Facebook nào. Hãy đăng nhập trước.' };
  }
  if (getActive()) return { error: 'Đã có tác vụ đang chạy. Hãy hủy hoặc chờ xong.' };

  const id = crypto.randomUUID();
  const job = {
    id,
    kind: 'pages',
    status: 'opening_browser',
    message: 'Đang mở cửa sổ Chrome…',
    error: null,
    browser: null,
    page: null,
    waitPwd: null,
    appId: String(appId),
    pageIds: pageIds.map(String),
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  activeId = id;
  runPageSetup(job, acc).catch((e) => failSoft(job, (e && e.message) || 'Lỗi không xác định'));
  return { job };
}

async function runPageSetup(job, acc) {
  const browser = await fb.launchChrome();
  job.browser = browser;
  browser.on('disconnected', () => {
    job.browser = null;
    if (job.waitPwd) { const w = job.waitPwd; job.waitPwd = null; w.reject(new Error('Cửa sổ Chrome đã bị đóng.')); }
    if (!['success', 'error'].includes(job.status)) failSoft(job, 'Cửa sổ Chrome đã bị đóng.');
  });

  const page = await browser.newPage();
  job.page = page;
  await page.setUserAgent(fb.UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7' });

  setStatus(job, 'restoring', 'Đang khôi phục phiên đăng nhập Facebook…');
  await injectSession(page, acc);

  setStatus(job, 'loading_apps', 'Đang mở cấu hình Messenger…');
  await page.goto(`https://developers.facebook.com/apps/${job.appId}/messenger/messenger_api_settings/`, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
  if (/log_in|login\.php/.test(page.url() || '')) {
    throw new Error('Phiên Facebook đã hết hạn — hãy đăng nhập lại trong CRM.');
  }

  // Mở rộng card "Tạo mã truy cập" nếu đang thu gọn
  for (let i = 0; i < 5; i++) {
    const st = await expandCard(page, 'tạo mã truy cập|generate access token');
    if (st !== 'no-heading') break;
    await sleep(1500);
  }

  const results = [];
  for (const pageId of job.pageIds) {
    setStatus(job, 'subscribing', `Đang đăng ký webhook cho trang ${pageId}…`);
    await subscribePageFields(job, page, pageId);

    setStatus(job, 'generating_token', `Đang tạo Page Access Token cho trang ${pageId}…`);
    const token = await generatePageToken(job, page, pageId);
    results.push({ pageId, token: token || null });
  }

  // Cập nhật token vào pages.json + bản ghi app mới nhất
  const allPages = pagesStore.list();
  for (const r of results) {
    if (!r.token) continue;
    const p = allPages.find((x) => x.pageId === r.pageId);
    if (p) p.token = r.token;
    else allPages.push({ pageId: r.pageId, name: 'Trang ' + r.pageId, token: r.token, connectedAt: new Date().toISOString() });
  }
  pagesStore.save(allPages);
  const latest = appsStore.getLatest();
  if (latest && latest.appId === job.appId) {
    appsStore.update(job.appId, { pages: allPages });
  }

  const okCount = results.filter((r) => r.token).length;
  const summary = results.map((r) => {
    const p = allPages.find((x) => x.pageId === r.pageId);
    const nm = p ? p.name : r.pageId;
    return `${nm}${r.token ? ' ✓' : ' (không lấy được token)'}`;
  }).join(', ');
  const successMsg = `Đã cấu hình ${job.pageIds.length} trang — lấy được token cho ${okCount}/${job.pageIds.length}: ${summary}.`;
  setStatus(job, 'success', successMsg);
  webhookStore.recordRun('success', successMsg);
  closeBrowser(job);
}

// Trong hàng của trang: bấm "Thêm đăng ký" → tick 3 field → Confirm
async function subscribePageFields(job, page, pageId) {
  const clicked = await page
    .evaluate((pageId) => {
      const visible = (el) => el && el.offsetParent !== null;
      const rows = [...document.querySelectorAll('tbody tr[role="row"]')];
      const row = rows.find((r) => {
        const s = r.querySelector('span[label]');
        return s && s.getAttribute('label') === pageId;
      });
      if (!row) return false;
      const btn = [...row.querySelectorAll('[role="button"], button')]
        .find((b) => /^(thêm đăng ký|add subscription)$/i.test((b.innerText || '').trim()));
      if (!btn) return 'no-button'; // đã đăng ký hết hoặc nút không còn
      btn.scrollIntoView({ block: 'center' });
      const o = { bubbles: true, cancelable: true, view: window };
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(t, o));
      }
      return true;
    }, pageId)
    .catch(() => false);
  if (clicked !== true) return; // không có nút → có thể đã đăng ký, bỏ qua

  await sleep(2500);
  // Tick lần lượt 3 field (chỉ tick ô chưa chọn)
  for (const f of PAGE_FIELDS) {
    await page
      .evaluate((f) => {
        const visible = (el) => el && el.offsetParent !== null;
        const labels = [...document.querySelectorAll('label')]
          .filter((l) => (l.innerText || '').trim() === f && visible(l));
        for (const lb of labels) {
          const input = lb.querySelector('input[type="checkbox"]')
            || document.getElementById(lb.getAttribute('for') || '');
          if (input && visible(input)) {
            if (input.getAttribute('aria-checked') === 'true' || input.checked) return 'already';
            lb.scrollIntoView({ block: 'center' });
            const o = { bubbles: true, cancelable: true, view: window };
            for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              input.dispatchEvent(new MouseEvent(t, o));
            }
            return 'checked';
          }
        }
        return 'not-found';
      }, f)
      .catch(() => {});
    await sleep(700);
  }

  // Bấm Confirm
  await clickWhenEnabled(job, page, '^(?:confirm|xác nhận)$', '[role="button"], button', 20000, 'Confirm');
  await sleep(2500);
  // Đóng dialog nếu còn
  await clickMatching(page, '^(?:đóng|close|x)$', '[role="button"], button');
  await sleep(1000);
}

// Bấm "Tạo" → tick "Tôi hiểu" → bấm "Sao chép" → chụp token (hook clipboard + DOM)
const TOKEN_LIKE = /^[A-Za-z0-9_-]{40,}$/;

async function generatePageToken(job, page, pageId) {
  const clicked = await page
    .evaluate((pageId) => {
      const rows = [...document.querySelectorAll('tbody tr[role="row"]')];
      const row = rows.find((r) => {
        const s = r.querySelector('span[label]');
        return s && s.getAttribute('label') === pageId;
      });
      if (!row) return false;
      const btn = [...row.querySelectorAll('[role="button"], button')]
        .find((b) => /^(tạo|generate|create)$/i.test((b.innerText || '').trim()));
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      const o = { bubbles: true, cancelable: true, view: window };
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(t, o));
      }
      return true;
    }, pageId)
    .catch(() => false);
  if (!clicked) return null;
  await sleep(2500);

  // Cài bẫy: clipboard API + sự kiện copy — bắt MỌI text được copy (trim sẵn)
  await page
    .evaluate(() => {
      window.__capturedToken = null;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText = async (t) => {
            window.__capturedToken = (t || '').trim();
          };
          if (navigator.clipboard.write) {
            navigator.clipboard.write = async (data) => {
              try {
                const blob = data && data[0];
                if (blob) window.__capturedToken = (await blob.text()).trim();
              } catch { /* bỏ qua */ }
            };
          }
        }
      } catch { /* bỏ qua */ }
      document.addEventListener('copy', (e) => {
        try {
          const t = e.clipboardData ? e.clipboardData.getData('text') : '';
          if (t && t.trim().length > 20) window.__capturedToken = t.trim();
        } catch { /* bỏ qua */ }
      });
    })
    .catch(() => {});

  // Tick "Tôi hiểu" nếu dialog yêu cầu
  await page
    .evaluate(() => {
      const visible = (el) => el && el.offsetParent !== null;
      const labels = [...document.querySelectorAll('label')]
        .filter((l) => /^tôi hiểu$/i.test((l.innerText || '').trim()) && visible(l));
      for (const lb of labels) {
        const input = lb.querySelector('input[type="checkbox"]')
          || document.getElementById(lb.getAttribute('for') || '');
        if (input && visible(input) && input.getAttribute('aria-checked') !== 'true' && !input.checked) {
          input.click();
          return true;
        }
      }
      return false;
    })
    .catch(() => {});
  await sleep(1000);

  // Bấm "Sao chép" (thử 2 lần)
  await clickMatching(page, '^(?:sao chép|copy)$', '[role="button"], button');
  await sleep(1200);
  await clickMatching(page, '^(?:sao chép|copy)$', '[role="button"], button');
  await sleep(1000);

  // Đọc token: bẫy clipboard → quét input/textarea TOÀN TRANG (có thể nhiều dialog chồng nhau)
  let token = await page.evaluate(() => window.__capturedToken || null).catch(() => null);
  const valid = (t) => !!t && TOKEN_LIKE.test((t || '').trim());
  if (!valid(token)) {
    token = await page
      .evaluate(() => {
        // ưu tiên dialog trên cùng, rồi quét cả trang
        const dlgs = [...document.querySelectorAll('[role="dialog"]')].filter((x) => x.offsetParent);
        const scopes = dlgs.length ? [...dlgs.reverse(), document.body] : [document.body];
        for (const scope of scopes) {
          const inputs = [...scope.querySelectorAll('input, textarea')]
            .map((i) => (i.value || '').trim())
            .filter((v) => v.length > 40 && /^[A-Za-z0-9_-]+$/.test(v));
          if (inputs.length) return inputs[0];
          const m = (scope.innerText || '').match(/EA[A-Za-z0-9_-]{80,}/);
          if (m) return m[0];
        }
        return null;
      })
      .catch(() => null);
  }
  if (valid(token)) token = token.trim();

  // Chụp lại màn hình dialog token để đối chiếu nếu cần debug
  await page.screenshot({ path: path.join(DATA_DIR, 'token-debug.png') }).catch(() => {});

  // Đóng dialog
  await clickMatching(page, '^(?:đóng|close|đã hiểu|got it|ok|x)$', '[role="button"], button');
  await sleep(800);
  return valid(token) ? token.trim() : null;
}

module.exports = { startAppCreation, startDeleteApp, startPageSetup, getJob, getActive, cancelSync, submitPassword, resumeSync };
