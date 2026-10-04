// ChatCRM — máy chủ API giai đoạn 1: đăng nhập Facebook, lấy cookie, nhận diện phiên
const express = require('express');
const fs = require('fs');
const path = require('path');
const store = require('./src/store/db');
const fb = require('./src/services/facebook');
const tunnel = require('./src/services/tunnel');
const devapp = require('./src/services/devapp');
const webhookStore = require('./src/store/webhook-store');
const pagesStore = require('./src/store/pages-store');
const appsStore = require('./src/store/apps-store');
const messenger = require('./src/services/messenger');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const CHECK_TTL = 5 * 60 * 1000; // kiểm tra lại cookie sau 5 phút
let ACTUAL_PORT = PORT; // cổng thật sau khi tự tránh cổng bận

function getAuth(req) {
  const token = req.headers['x-session-token'] || req.query.token; // query cho SSE
  if (!token) return null;
  const s = store.getSession(token);
  if (!s) return null;
  const acc = store.getAccount(s.uid);
  if (!acc) return null;
  return { token, account: acc };
}

// URL webhook ưu tiên: biến môi trường → tunnel cloudflared (public https) → localhost
function webhookUrlOf() {
  return process.env.WEBHOOK_URL
    || (tunnel.getUrl() ? tunnel.getUrl() + '/webhook' : `http://localhost:${ACTUAL_PORT}/webhook`);
}

// Chờ tunnel có URL public rồi mới trả về (dùng khi bắt đầu tác vụ tạo app)
async function resolveWebhookUrl() {
  if (process.env.WEBHOOK_URL) return process.env.WEBHOOK_URL;
  await tunnel.ready(20000);
  return webhookUrlOf();
}

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'ChatCRM', phase: 1 }));

/* ---------- Đăng nhập: mở Chrome cho người dùng tự đăng nhập, tool bắt cookie ---------- */

// Bắt đầu phiên đăng nhập (nếu đang có phiên chờ thì trả về phiên đó)
app.post('/api/auth/browser', (req, res) => {
  const active = fb.getActiveBrowserJob();
  if (active) return res.json({ ok: true, loginId: active.id, resumed: true });
  const job = fb.startBrowserLogin();
  res.json({ ok: true, loginId: job.id, resumed: false });
});

// Khi F5 trang, hỏi xem có phiên chờ nào để tiếp tục theo dõi không
app.get('/api/auth/browser', (req, res) => {
  const active = fb.getActiveBrowserJob();
  if (!active) return res.json({ ok: true, active: false });
  res.json({ ok: true, active: true, loginId: active.id, status: active.status, message: active.message });
});

app.post('/api/auth/browser/cancel', (req, res) => {
  const { loginId } = req.body || {};
  const done = loginId ? fb.cancelJob(loginId) : false;
  res.json(done ? { ok: true } : { ok: false, error: 'Không có phiên đăng nhập nào để hủy.' });
});

// Trạng thái phiên: opening_browser → waiting → capturing → success | error
app.get('/api/auth/status/:id', (req, res) => {
  const job = fb.getJob(req.params.id);
  if (!job) return res.json({ ok: false, error: 'Không tìm thấy phiên đăng nhập. Hãy thử lại.' });
  const out = { ok: true, status: job.status, message: job.message || '', error: job.error || null };
  if (job.status === 'success') {
    out.token = job.sessionToken;
    out.account = job.account;
  }
  res.json(out);
});

/* ---------- Đăng nhập bằng cookie dán tay (phương án dự phòng) ---------- */

app.post('/api/auth/cookie', async (req, res) => {
  try {
    const r = await fb.establishFromCookie(String((req.body || {}).cookie || ''));
    res.json({ ok: true, token: r.token, account: r.account });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

/* ---------- Phiên đăng nhập: hệ thống tự nhận diện đã login ---------- */

app.get('/api/session', async (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.json({ ok: true, authenticated: false });

  const acc = auth.account;
  const stale = Date.now() - (acc.lastCheckAt || 0) > CHECK_TTL;
  if (stale) {
    const alive = await fb.checkAccount(acc); // lỗi mạng -> giữ trạng thái cũ
    if (!alive) {
      store.deleteSession(auth.token);
      return res.json({ ok: true, authenticated: false, reason: 'cookie_expired' });
    }
  } else if (acc.alive === false) {
    store.deleteSession(auth.token);
    return res.json({ ok: true, authenticated: false, reason: 'cookie_expired' });
  }
  res.json({ ok: true, authenticated: true, account: fb.publicAccount(store.getAccount(acc.uid)) });
});

// Kiểm tra lại cookie thủ công (nút "Kiểm tra lại") — state: alive | dead | unknown
app.post('/api/session/refresh', async (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.json({ ok: false, error: 'Chưa đăng nhập.' });
  let state = 'unknown';
  try { state = await fb.probeCookie(fb.cookieHeaderOf(auth.account.cookies)); } catch { state = 'unknown'; }
  store.setAccountCheck(auth.account.uid, state !== 'dead', Date.now());
  res.json({ ok: true, state, account: fb.publicAccount(store.getAccount(auth.account.uid)) });
});

// Lấy toàn bộ cookie (để copy sang công cụ khác) — công cụ chạy local, dữ liệu của chính người dùng
app.get('/api/session/cookie', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.json({ ok: false, error: 'Chưa đăng nhập.' });
  res.json({ ok: true, cookie: fb.cookieHeaderOf(auth.account.cookies) });
});

/* ---------- Webhook Messenger (dùng cho URL gọi lại khi cấu hình app) ---------- */

const sseClients = new Set();
function sseBroadcast(type, data) {
  for (const c of sseClients) {
    try { c.write(`event: ${type}\ndata: ${JSON.stringify(data || {})}\n\n`); } catch { /* bỏ qua */ }
  }
}
messenger.onNotify((data) => sseBroadcast('refreshed', data));

// SSE: đẩy lệnh "refresh" xuống giao diện realtime khi khách nhắn tin
app.get('/api/events', (req, res) => {
  if (!getAuth(req)) return res.status(403).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('event: hello\ndata: {}\n\n');
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* bỏ qua */ } }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// GET: Facebook gọi để xác minh webhook (hub.challenge handshake)
app.get('/webhook', (req, res) => {
  try {
    fs.appendFileSync(
      path.join(__dirname, 'data', 'webhook-events.log'),
      JSON.stringify({ at: new Date().toISOString(), type: 'verification', mode: req.query['hub.mode'], token: req.query['hub.verify_token'] }) + '\n',
    );
  } catch { /* bỏ qua lỗi log */ }
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const cfg = webhookStore.get();
  if (mode === 'subscribe' && token && cfg && token === cfg.verifyToken) {
    return res.status(200).send(challenge || '');
  }
  return res.sendStatus(403);
});

// POST: nhận sự kiện Messenger (tin nhắn mới từ khách) — hủy cache để inbox đồng bộ ngay
app.post('/webhook', (req, res) => {
  try {
    const body = req.body || {};
    fs.appendFileSync(
      path.join(__dirname, 'data', 'webhook-events.log'),
      JSON.stringify({ at: new Date().toISOString(), body }) + '\n',
    );
    if (body.object === 'page' && Array.isArray(body.entry)) {
      for (const en of body.entry) {
        if (en.messaging || en.standby || en.changes) {
          messenger.invalidateCache(en.id);       // đánh dấu stale (giữ dữ liệu cũ phục vụ ngay)
          sseBroadcast('refresh', { pageId: en.id }); // bảo giao diện cập nhật ngay
          messenger.kickRefresh();                // nền lấy dữ liệu mới → báo tiếp khi xong
        }
      }
    }
  } catch { /* không chặn webhook vì lỗi log */ }
  res.sendStatus(200);
});

// Danh sách trang đã đồng bộ về CRM (tên, pageId, page access token)
app.get('/api/pages', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.json({ ok: false, error: 'Chưa đăng nhập.' });
  const pages = pagesStore.list().map((p) => ({
    pageId: p.pageId,
    name: p.name,
    hasToken: !!p.token,
    connectedAt: p.connectedAt,
  }));
  res.json({ ok: true, pages });
});

// Cấu hình trang đã chọn: đăng ký field webhook (messages…) + tạo Page Access Token
app.post('/api/pages/setup', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.json({ ok: false, error: 'Hãy đăng nhập Facebook trước.' });
  const latest = appsStore.getLatest();
  const appId = String((req.body || {}).appId || (latest ? latest.appId : '') || '').trim();
  const pageIds = Array.isArray((req.body || {}).pageIds) ? (req.body || {}).pageIds.map(String) : [];
  if (!/^\d+$/.test(appId)) return res.json({ ok: false, error: 'Chưa có ứng dụng nào — hãy chạy "Tạo app & Webhook" trước.' });
  if (!pageIds.length) return res.json({ ok: false, error: 'Hãy tích chọn ít nhất một trang.' });
  const r = devapp.startPageSetup(appId, pageIds);
  if (r.error) return res.json({ ok: false, error: r.error });
  res.json({ ok: true, syncId: r.job.id });
});

/* ---------- Hội thoại & tin nhắn thật (Graph API bằng page token) ---------- */

app.get('/api/conversations', async (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.json({ ok: false, error: 'Chưa đăng nhập.' });
  try {
    const r = await messenger.listConversations();
    res.json({ ok: true, conversations: r.conversations, errors: r.errors });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/conversations/:pageId/:convId/messages', async (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.json({ ok: false, error: 'Chưa đăng nhập.' });
  try {
    const msgs = await messenger.getMessages(req.params.pageId, req.params.convId);
    res.json({ ok: true, messages: msgs });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/conversations/:pageId/:convId/send', async (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.json({ ok: false, error: 'Chưa đăng nhập.' });
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.json({ ok: false, error: 'Tin nhắn trống.' });
  try {
    await messenger.sendMessage(req.params.pageId, req.params.convId, text);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) store.deleteSession(token);
  res.json({ ok: true });
});

/* ---------- Đồng bộ: tạo ứng dụng Facebook Developers tự động ---------- */

app.post('/api/sync/app', async (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.json({ ok: false, error: 'Hãy đăng nhập Facebook trước khi đồng bộ.' });
  // Mỗi lần chạy = tạo một app MỚI, nên luôn cần tên + email
  const appName = String((req.body || {}).appName || '').trim();
  const email = String((req.body || {}).email || '').trim();
  if (!appName) return res.json({ ok: false, error: 'Vui lòng nhập tên ứng dụng.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.json({ ok: false, error: 'Email liên hệ không hợp lệ.' });
  }
  // Chờ tunnel có URL public https — Facebook chỉ xác minh được webhook public
  const webhookUrl = await resolveWebhookUrl();
  const r = devapp.startAppCreation(appName, email, webhookUrl);
  if (r.error) return res.json({ ok: false, error: r.error });
  res.json({ ok: true, syncId: r.job.id });
});

// Lịch sử các app đã tạo (mới nhất trước) — mỗi app kèm danh sách trang đã cào
app.get('/api/apps', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.json({ ok: false, error: 'Chưa đăng nhập.' });
  res.json({ ok: true, apps: appsStore.list() });
});

// Xem cấu hình webhook hiện tại (app mới nhất) để điền thủ công khi cần
app.get('/api/webhook/config', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.json({ ok: false, error: 'Chưa đăng nhập.' });
  const latest = appsStore.getLatest();
  const cfg = webhookStore.get() || {};
  res.json({
    ok: true,
    callbackUrl: webhookUrlOf(),
    tunnelUrl: tunnel.getUrl() || null,
    verifyToken: cfg.verifyToken || null,
    appId: latest ? latest.appId : null,
    appName: latest ? latest.name : null,
    lastRun: cfg.lastRun || null,
  });
});

// Khi F5/đóng modal, hỏi xem có tác vụ đồng bộ đang chạy để gắn lại không
app.get('/api/sync', (req, res) => {
  const active = devapp.getActive();
  if (!active) return res.json({ ok: true, active: false });
  res.json({ ok: true, active: true, syncId: active.id, status: active.status, message: active.message });
});

// status: opening_browser → restoring → loading_apps → finding_create → filling → wizard → need_password → verifying → success | error
app.get('/api/sync/status/:id', (req, res) => {
  const job = devapp.getJob(req.params.id);
  if (!job) return res.json({ ok: false, error: 'Không tìm thấy tác vụ đồng bộ.' });
  res.json({ ok: true, status: job.status, message: job.message || '', error: job.error || null });
});

app.post('/api/sync/cancel', (req, res) => {
  const { syncId } = req.body || {};
  const done = syncId ? devapp.cancelSync(syncId) : false;
  res.json(done ? { ok: true } : { ok: false, error: 'Không có tác vụ nào để hủy.' });
});

// Facebook bắt xác nhận mật khẩu (re-auth): nhận mật khẩu từ CRM rồi điền vào form
app.post('/api/sync/password', (req, res) => {
  const { syncId, password } = req.body || {};
  if (!syncId || !password) return res.json({ ok: false, error: 'Thiếu mật khẩu xác nhận.' });
  const done = devapp.submitPassword(syncId, String(password));
  res.json(done ? { ok: true } : { ok: false, error: 'Không có yêu cầu mật khẩu nào đang chờ.' });
});

// Bấm lại "Tạo ứng dụng" trên cửa sổ Chrome còn sống (re-auth từng làm hủy action)
app.post('/api/sync/retry', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.json({ ok: false, error: 'Hãy đăng nhập Facebook trước.' });
  const { syncId } = req.body || {};
  const r = devapp.resumeSync(syncId);
  if (r.error) return res.json({ ok: false, error: r.error });
  res.json({ ok: true, syncId: r.job.id });
});

// Xóa ứng dụng: tự vào Developers Facebook gỡ app + dọn dữ liệu trong CRM
app.post('/api/sync/delete', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.json({ ok: false, error: 'Hãy đăng nhập Facebook trước.' });
  const appId = String((req.body || {}).appId || '').trim();
  if (!/^\d+$/.test(appId)) return res.json({ ok: false, error: 'App ID không hợp lệ.' });
  const r = devapp.startDeleteApp(appId);
  if (r.error) return res.json({ ok: false, error: r.error });
  res.json({ ok: true, syncId: r.job.id });
});

/* ---------- Khởi động ---------- */

function listen(port, tries = 10) {
  const srv = app.listen(port, () => {
    ACTUAL_PORT = port;
    const url = `http://localhost:${port}`;
    console.log('');
    console.log('  🚀 ChatCRM đang chạy tại:  ' + url);
    console.log('     Dữ liệu lưu tại:       ' + require('path').join(__dirname, 'data'));
    console.log('');
    if (!process.env.WEBHOOK_URL) tunnel.ensureTunnel(port); // tự bật/reuse tunnel cho webhook public
    if (process.env.FB_AUTO_OPEN !== 'false') {
      try {
        require('child_process').spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      } catch { /* bỏ qua nếu không mở được trình duyệt */ }
    }
  });
  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) listen(port + 1, tries - 1);
    else { console.error(e); process.exit(1); }
  });
}

listen(PORT);
