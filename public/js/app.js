/* ChatCRM — logic giao diện Giai đoạn 1
 * - Vào thẳng trang CRM. Nếu có phiên hợp lệ (token + cookie live) thì hiển thị tài khoản.
 * - Nút "Đăng nhập bằng Chrome": mở Chrome facebook.com → người dùng tự đăng nhập tay →
 *   tool theo dõi, bắt cookie, xác nhận live → tự cập nhật giao diện.
 * - Dự phòng: nhập cookie thủ công.
 */
const $ = (s, el = document) => el.querySelector(s);

const TOKEN_KEY = 'crmfb_token';
let token = localStorage.getItem(TOKEN_KEY) || '';
let loginId = null;
let pollTimer = null;
let lastStatus = '';

const STATUS_TEXT = {
  opening_browser: 'Đang mở cửa sổ Chrome…',
  waiting: 'Chờ bạn đăng nhập trong Chrome…',
  capturing: 'Đang bắt và xác nhận cookie…',
  success: 'Đăng nhập thành công!',
};

/* ---------- Tiện ích ---------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-session-token': token } : {}),
      ...(opts.headers || {}),
    },
  });
  try { return await res.json(); } catch { return { ok: false, error: 'Phản hồi không hợp lệ từ máy chủ.' }; }
}

function show(el, on = true) { el.classList.toggle('hidden', !on); }

function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  const glyph = type === 'success' ? '✓' : type === 'error' ? '!' : 'i';
  t.innerHTML = `<span class="t-icon">${glyph}</span><span></span>`;
  t.lastElementChild.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 4200);
}

function showError(msg) {
  const box = $('#login-error');
  if (!msg) { show(box, false); return; }
  box.textContent = msg;
  show(box, true);
}

function setProgress(title, detail) {
  show($('#login-progress'), true);
  $('#progress-title').textContent = title;
  $('#progress-detail').textContent = detail || '';
}

function setSyncProgress(title, detail) {
  show($('#sync-progress'), true);
  $('#sync-status-title').textContent = title;
  $('#sync-status-detail').textContent = detail || '';
}

function setLoading(btn, on, label) {
  const span = btn.querySelector('span:not(.spinner)');
  if (on) {
    btn.dataset.label = span.textContent;
    btn.disabled = true;
    btn.querySelector('.spinner')?.remove();
    const sp = document.createElement('span');
    sp.className = 'spinner';
    btn.prepend(sp);
    span.textContent = label || 'Đang xử lý…';
  } else {
    btn.disabled = false;
    btn.querySelector('.spinner')?.remove();
    span.textContent = btn.dataset.label || span.textContent;
  }
}

function setPill(state) {
  const pill = $('#status-pill');
  pill.classList.toggle('ok', state === 'ok');
  pill.classList.toggle('bad', state === 'bad');
  $('#status-text').textContent =
    state === 'ok' ? 'Cookie hoạt động' : state === 'bad' ? 'Cookie hết hạn' : 'Chưa đăng nhập';
}

function fmtTime(t) {
  if (!t) return '—';
  return new Date(t).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ---------- Hai trạng thái: đã / chưa đăng nhập ---------- */

function renderLoggedOut() {
  setPill('neutral');
  $('#acc-card-title').textContent = 'Kết nối tài khoản Facebook';
  $('#acc-card-sub').textContent = 'Chưa kết nối với hệ thống';
  show($('#acc-row'), false);
  show($('#connect-box'), true);
  show($('#login-progress'), false);
  show($('#cookie-actions'), false);
  $('#cookie-preview').textContent = 'Chưa có cookie — hãy đăng nhập để hệ thống tự bắt cookie.';
  $('#cookie-preview').classList.remove('blurred');
  $('#cookie-count').textContent = 'Chưa có';
  $('#cookie-check').textContent = '—';
  $('#side-name').textContent = 'Chưa đăng nhập';
  $('#side-uid').textContent = '—';
  $('#side-avatar').style.display = 'none';
  $('#side-initials').style.display = 'flex';
  $('#side-initials').textContent = '?';
  show($('#btn-logout'), false);
}

function renderLoggedIn(acc) {
  setPill(acc.alive !== false ? 'ok' : 'bad');
  $('#acc-card-title').textContent = 'Tài khoản Facebook';
  $('#acc-card-sub').textContent = 'Đã kết nối với hệ thống';
  show($('#connect-box'), false);
  show($('#acc-row'), true);

  $('#acc-name').textContent = acc.name || '—';
  $('#side-name').textContent = acc.name || '—';
  $('#acc-uid').textContent = 'UID: ' + (acc.uid || '—');
  $('#side-uid').textContent = 'UID: ' + (acc.uid || '—');
  $('#acc-username').textContent = acc.username ? 'Đăng nhập: ' + acc.username : 'Đăng nhập qua Chrome / cookie';

  const initials = (acc.name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  for (const [img, init] of [[$('#acc-avatar'), $('#acc-initials')], [$('#side-avatar'), $('#side-initials')]]) {
    img.style.display = '';
    init.style.display = 'none';
    img.onerror = () => { img.style.display = 'none'; init.style.display = 'flex'; init.textContent = initials; };
    img.src = acc.avatar || '';
  }

  $('#cookie-preview').textContent = acc.cookiePreview || '—';
  $('#cookie-preview').classList.add('blurred');
  $('#btn-reveal span').textContent = 'Hiện cookie';
  $('#cookie-count').textContent = (acc.cookieCount ?? 0) + ' cookie';
  $('#cookie-check').textContent = 'Kiểm tra lúc ' + fmtTime(acc.lastCheckAt);
  show($('#cookie-actions'), true);
  show($('#btn-logout'), true);
}

/* ---------- Khởi động: hệ thống tự nhận diện phiên đăng nhập ---------- */

async function init() {
  renderLoggedOut();

  if (token) {
    const r = await api('/api/session');
    if (r.ok && r.authenticated) {
      renderLoggedIn(r.account);
      // Có tác vụ đồng bộ đang chạy (vd: đang chờ mật khẩu) → tự mở modal
      const attached = await attachActiveSync();
      if (attached) show($('#sync-modal'), true);
      return;
    }
    token = '';
    localStorage.removeItem(TOKEN_KEY);
    if (r.reason === 'cookie_expired') toast('Phiên đăng nhập cũ đã hết hạn — hãy đăng nhập lại.', 'error');
  }

  // Có phiên "mở Chrome chờ đăng nhập" đang dang dở (sau F5) → tiếp tục theo dõi
  const a = await api('/api/auth/browser');
  if (a.ok && a.active) {
    resumeBrowserLogin(a.loginId, a.status, a.message);
  }
}

/* ---------- Đăng nhập bằng Chrome (mở cửa sổ, người dùng tự điền) ---------- */

$('#btn-browser-login').addEventListener('click', async () => {
  showError(null);
  setLoading($('#btn-browser-login'), true, 'Đang mở Chrome…');
  const r = await api('/api/auth/browser', { method: 'POST' });
  if (!r.ok) { setLoading($('#btn-browser-login'), false); showError(r.error); return; }
  loginId = r.loginId;
  lastStatus = '';
  setProgress(STATUS_TEXT.opening_browser, '');
  startPoll();
});

function resumeBrowserLogin(id, status, message) {
  loginId = id;
  lastStatus = status;
  setLoading($('#btn-browser-login'), true, 'Đang đăng nhập…');
  setProgress(STATUS_TEXT[status] || status, message || '');
  startPoll();
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(poll, 1500);
}

function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function poll() {
  if (!loginId) return;
  const r = await api('/api/auth/status/' + loginId);
  if (!r.ok) { finishBrowserLogin(); showError(r.error || 'Mất kết nối với máy chủ.'); return; }

  if (r.status !== lastStatus) {
    lastStatus = r.status;
    $('#progress-title').textContent = STATUS_TEXT[r.status] || r.status;
  }
  $('#progress-detail').textContent = r.message || '';

  if (r.status === 'success') {
    stopPoll();
    token = r.token;
    localStorage.setItem(TOKEN_KEY, token);
    loginId = null;
    renderLoggedIn(r.account);
    setLoading($('#btn-browser-login'), false);
    toast('Đăng nhập thành công! Cookie live đã được lưu vào hệ thống.', 'success');
    return;
  }

  if (r.status === 'error') {
    finishBrowserLogin();
    showError(r.error || 'Đăng nhập thất bại.');
    return;
  }
}

function finishBrowserLogin() {
  stopPoll();
  loginId = null;
  setLoading($('#btn-browser-login'), false);
  show($('#login-progress'), false);
}

$('#btn-cancel-login').addEventListener('click', async () => {
  if (!loginId) return;
  await api('/api/auth/browser/cancel', { method: 'POST', body: JSON.stringify({ loginId }) });
  finishBrowserLogin();
  toast('Đã hủy và đóng cửa sổ Chrome.', 'info');
});

/* ---------- Dự phòng: đăng nhập bằng cookie dán tay ---------- */

$('#btn-toggle-cookie').addEventListener('click', () => {
  const f = $('#form-cookie');
  const opening = f.classList.contains('hidden');
  show(f, opening);
  $('#btn-toggle-cookie').textContent = opening ? 'Đóng khung nhập cookie ↑' : 'Không mở được Chrome? Nhập cookie thủ công ↓';
  if (opening) $('#cookie-input').focus();
});

$('#form-cookie').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cookie = $('#cookie-input').value.trim();
  if (!cookie) { showError('Vui lòng dán cookie vào ô trống.'); return; }
  showError(null);
  setLoading($('#btn-cookie'), true, 'Đang kiểm tra cookie…');
  const r = await api('/api/auth/cookie', { method: 'POST', body: JSON.stringify({ cookie }) });
  setLoading($('#btn-cookie'), false);
  if (r.ok) {
    token = r.token;
    localStorage.setItem(TOKEN_KEY, token);
    $('#form-cookie').reset();
    show($('#form-cookie'), false);
    $('#btn-toggle-cookie').textContent = 'Không mở được Chrome? Nhập cookie thủ công ↓';
    renderLoggedIn(r.account);
    toast('Đăng nhập bằng cookie thành công!', 'success');
  } else {
    showError(r.error);
  }
});

/* ---------- Dashboard ---------- */

$('#btn-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  token = '';
  localStorage.removeItem(TOKEN_KEY);
  renderLoggedOut();
  toast('Đã đăng xuất. Cookie vẫn được giữ trong máy chủ để lần sau xác thực nhanh.', 'info');
});

$('#btn-copy').addEventListener('click', async () => {
  const r = await api('/api/session/cookie');
  if (!r.ok) { toast(r.error || 'Không lấy được cookie.', 'error'); return; }
  try {
    await navigator.clipboard.writeText(r.cookie);
    toast('Đã sao chép toàn bộ cookie vào clipboard.', 'success');
  } catch {
    toast('Trình duyệt chặn clipboard — hãy bôi đen và copy thủ công.', 'error');
  }
});

$('#btn-reveal').addEventListener('click', async () => {
  const box = $('#cookie-preview');
  if (!box.classList.contains('blurred')) {
    box.classList.add('blurred');
    $('#btn-reveal span').textContent = 'Hiện cookie';
    return;
  }
  const r = await api('/api/session/cookie');
  if (!r.ok) { toast(r.error || 'Không lấy được cookie.', 'error'); return; }
  box.textContent = r.cookie;
  box.classList.remove('blurred');
  $('#btn-reveal span').textContent = 'Ẩn cookie';
});

$('#btn-refresh').addEventListener('click', async () => {
  setLoading($('#btn-refresh'), true, 'Đang kiểm tra…');
  const r = await api('/api/session/refresh', { method: 'POST' });
  setLoading($('#btn-refresh'), false);
  if (!r.ok) { toast(r.error || 'Không kiểm tra được cookie.', 'error'); return; }
  if (r.account) $('#cookie-check').textContent = 'Kiểm tra lúc ' + fmtTime(r.account.lastCheckAt);
  if (r.state === 'alive') {
    setPill('ok');
    toast('Cookie vẫn còn hoạt động ✓', 'success');
  } else if (r.state === 'dead') {
    setPill('bad');
    toast('Cookie đã hết hạn — hãy đăng nhập lại!', 'error');
  } else {
    toast('Facebook trả lời bất thường nên chưa xác định được — thử lại sau ít phút.', 'info');
  }
});

/* ---------- Chuyển màn hình giữa các mục menu ---------- */

const VIEW_TITLES = { overview: 'Tổng quan', inbox: 'Tin nhắn', pages: 'Trang / Fanpage' };

document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach((x) => x.classList.toggle('active', x === b));
  const nav = b.dataset.nav;
  if (nav === 'overview' || nav === 'inbox' || nav === 'pages') {
    $('#page-title').textContent = VIEW_TITLES[nav];
    show($('#view-overview'), nav === 'overview');
    show($('#view-messages'), nav === 'inbox');
    show($('#view-pages'), nav === 'pages');
    if (nav === 'inbox') initMessages();
    if (nav === 'pages') renderPagesView();
  } else {
    toast('Chức năng "' + b.querySelector('span').textContent + '" sẽ ra mắt ở giai đoạn tiếp theo.', 'info');
  }
}));

$('#card-inbox').addEventListener('click', () => {
  document.querySelector('.nav-item[data-nav="inbox"]').click();
});

/* ---------- Màn Tin nhắn ----------
 * Hiện đang chạy với DỮ LIỆU MẪU để xem trước giao diện.
 * Bước tiếp theo: thay loadConversations() bằng API thật
 * (GET /api/conversations + /api/conversations/:id/messages) lấy từ Facebook.
 */

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#f472b6,#a855f7)',
  'linear-gradient(135deg,#38bdf8,#6366f1)',
  'linear-gradient(135deg,#34d399,#0ea5e9)',
  'linear-gradient(135deg,#fbbf24,#f97316)',
  'linear-gradient(135deg,#f87171,#ec4899)',
  'linear-gradient(135deg,#a3e635,#14b8a6)',
  'linear-gradient(135deg,#818cf8,#c084fc)',
  'linear-gradient(135deg,#2dd4bf,#3b82f6)',
];


let messagesInitDone = false;
let conversations = [];
let activeConvId = null;
let realInbox = false; // true khi đang hiển thị hội thoại thật từ Facebook

function fmtConvTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

async function initMessages() {
  if (messagesInitDone) return;
  messagesInitDone = true;
  bindMessageEvents();

  // Hội thoại thật từ các trang đã có token (Graph API) — không còn dữ liệu mẫu
  const r = await api('/api/conversations');
  realInbox = !!r.ok;
  conversations = (r.ok && r.conversations)
    ? r.conversations.map((c) => ({
        id: c.convId,
        pageId: c.pageId,
        pageName: c.pageName,
        name: c.name || 'Khách',
        online: false,
        unread: 0,
        time: fmtConvTime(c.updatedTime),
        preview: c.snippet || '',
        thread: [],
      }))
    : [];
  renderConvList($('#conv-search').value.trim());
  if (r.errors && r.errors.length) toast('Lỗi khi tải hội thoại: ' + r.errors[0], 'error');

  // Realtime: khách nhắn → webhook → SSE đẩy lệnh → cập nhật ngay (kèm poll dự phòng)
  setInterval(refreshInbox, 15000);
  setInterval(pollOpenMessages, 6000);
  try {
    const es = new EventSource('/api/events?token=' + encodeURIComponent(token));
    es.addEventListener('refresh', () => { refreshInbox(); pollOpenMessages(); });
    es.addEventListener('refreshed', () => { refreshInbox(); pollOpenMessages(); });
  } catch { /* không có SSE thì dự phòng bằng poll */ }
}

// Làm mới danh sách hội thoại (giữ trạng thái đang mở + tin đã tải)
async function refreshInbox() {
  if (!realInbox || !messagesInitDone) return;
  if ($('#view-messages').classList.contains('hidden')) return;
  const r = await api('/api/conversations');
  if (!r.ok || !r.conversations) return;
  const byId = new Map(conversations.map((c) => [c.id, c]));
  conversations = r.conversations.map((c) => {
    const old = byId.get(c.convId);
    return {
      id: c.convId,
      pageId: c.pageId,
      pageName: c.pageName,
      name: c.name || 'Khách',
      online: false,
      unread: old ? old.unread : 0,
      time: fmtConvTime(c.updatedTime),
      preview: c.snippet || '',
      thread: old ? old.thread : [],
    };
  });
  renderConvList($('#conv-search').value.trim());
}

// Hội thoại đang mở: poll tin mới từ khách
async function pollOpenMessages() {
  if (!realInbox || !activeConvId) return;
  if ($('#view-messages').classList.contains('hidden')) return;
  const conv = conversations.find((c) => c.id === activeConvId);
  if (!conv || !conv.pageId) return;
  const r = await api(`/api/conversations/${encodeURIComponent(conv.pageId)}/${encodeURIComponent(conv.id)}/messages`);
  if (!r.ok || !r.messages) return;
  const newThread = r.messages.map((m) => ({
    me: m.fromMe,
    sender: m.sender,
    text: m.text,
    time: new Date(m.time).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }),
  }));
  const sig = JSON.stringify(newThread.map((m) => [m.me, m.text, m.time]));
  const oldSig = JSON.stringify((conv.thread || []).map((m) => [m.me, m.text, m.time]));
  if (sig === oldSig) return;
  conv.thread = newThread;
  if (conv.thread.length) conv.preview = (conv.thread[conv.thread.length - 1].me ? 'Bạn: ' : '') + conv.thread[conv.thread.length - 1].text;
  renderThread(conv);
  renderConvList($('#conv-search').value.trim());
}

function gradientFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function renderConvList(filter) {
  const box = $('#conv-items');
  const list = conversations.filter((c) => c.name.toLowerCase().includes((filter || '').toLowerCase()));
  $('#conv-count').textContent = list.length;
  if (!list.length) {
    box.innerHTML = '<div style="text-align:center; padding: 24px 10px; color: var(--muted); font-size: 13px; line-height: 1.7;">Chưa có hội thoại nào.<br>Tin nhắn mới từ khách sẽ tự hiện ở đây.</div>';
    return;
  }
  box.innerHTML = list.map((c) => {
    const last = c.thread && c.thread.length ? c.thread[c.thread.length - 1] : null;
    const preview = last ? (last.me ? 'Bạn: ' : '') + last.text : (c.preview || 'Nhấn để tải tin nhắn…');
    const initials = c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    const pageTag = c.pageName ? `<span class="conv-page">${escapeHtml(c.pageName)}</span>` : '';
    return `
      <div class="conv-item${c.id === activeConvId ? ' active' : ''}" data-id="${escapeHtml(c.id)}">
        <div class="conv-avatar" style="background:${gradientFor(c.name)}">${escapeHtml(initials)}
          ${c.online ? '<span class="conv-online"></span>' : ''}
        </div>
        <div class="conv-meta">
          <div class="conv-top">
            <span class="conv-name">${escapeHtml(c.name)} ${pageTag}</span>
            <span class="conv-time">${escapeHtml(c.time)}</span>
          </div>
          <div class="conv-bottom">
            <span class="conv-preview">${escapeHtml(preview)}</span>
            ${c.unread ? `<span class="unread-badge">${c.unread}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  box.querySelectorAll('.conv-item').forEach((el) =>
    el.addEventListener('click', () => openConversation(el.dataset.id)));
}

async function openConversation(id) {
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  activeConvId = id;
  conv.unread = 0;
  renderConvList($('#conv-search').value.trim());

  $('#chat-empty').classList.add('hidden');
  show($('#chat-active'), true);
  $('#chat-name').textContent = conv.name;
  $('#chat-status').textContent = conv.group
    ? 'Nhóm · ' + conv.thread.length + ' tin nhắn mẫu'
    : (conv.pageName ? 'Trang: ' + conv.pageName : (conv.online ? 'Đang hoạt động' : 'Hoạt động gần đây'));

  const initials = conv.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const img = $('#chat-avatar'), init = $('#chat-initials');
  img.style.display = 'none';
  init.style.display = 'flex';
  init.textContent = initials;

  if (conv.pageId && !conv.thread.length) {
    // Hội thoại thật — tải tin nhắn bằng page token
    const box = $('#chat-thread');
    box.innerHTML = '<div class="muted" style="text-align:center; padding: 20px; font-size: 13px;">Đang tải tin nhắn…</div>';
    const r = await api(`/api/conversations/${encodeURIComponent(conv.pageId)}/${encodeURIComponent(id)}/messages`);
    if (r.ok && r.messages) {
      conv.thread = r.messages.map((m) => ({
        me: m.fromMe,
        sender: m.sender,
        text: m.text,
        time: new Date(m.time).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }),
      }));
      if (conv.thread.length) conv.preview = (conv.thread[conv.thread.length - 1].me ? 'Bạn: ' : '') + conv.thread[conv.thread.length - 1].text;
      renderThread(conv);
      renderConvList($('#conv-search').value.trim());
    } else {
      box.innerHTML = `<div class="muted" style="text-align:center; padding: 20px; font-size: 13px;">Không tải được tin nhắn: ${escapeHtml(r.error || 'lỗi không rõ')}</div>`;
    }
  } else {
    renderThread(conv);
  }

  if (window.innerWidth <= 900) $('.messages-layout').classList.add('mobile-chat');
}

function renderThread(conv) {
  const box = $('#chat-thread');
  const dayLabel = conv.time === 'Hôm qua' || conv.time === 'Thứ 2' ? conv.time : 'Hôm nay';
  let html = `<div class="day-sep">${escapeHtml(dayLabel)}</div>`;
  let prevMe = null;
  html += conv.thread.map((m) => {
    const cls = 'msg-row ' + (m.me ? 'me' : 'them');
    const gap = prevMe !== null && prevMe !== m.me ? ' gap' : '';
    const senderTag = (!m.me && m.sender && conv.group) ? `<div class="msg-sender">${escapeHtml(m.sender)}</div>` : '';
    prevMe = m.me;
    return `<div class="${cls}${gap}">${senderTag}<div class="bubble">${escapeHtml(m.text)}</div></div>`;
  }).join('');
  html += `<div class="msg-time tail">${escapeHtml(conv.thread[conv.thread.length - 1].time)}</div>`;
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

function bindMessageEvents() {
  $('#conv-search').addEventListener('input', (e) => renderConvList(e.target.value.trim()));

  $('#btn-back-list').addEventListener('click', () => {
    $('.messages-layout').classList.remove('mobile-chat');
    activeConvId = null;
    show($('#chat-active'), false);
    $('#chat-empty').classList.remove('hidden');
    renderConvList($('#conv-search').value.trim());
  });

  const input = $('#composer-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $('#btn-send').addEventListener('click', sendMessage);

  document.querySelectorAll('.demo-action').forEach((b) =>
    b.addEventListener('click', () =>
      toast('Chức năng này sẽ kết nối ở bước lấy tin nhắn thật từ Facebook.', 'info')));
}

async function sendMessage() {
  const input = $('#composer-input');
  const text = input.value.trim();
  if (!text || !activeConvId) return;
  const conv = conversations.find((c) => c.id === activeConvId);
  if (!conv) return;

  if (conv.pageId) {
    // Hội thoại thật — gửi qua Graph API
    input.value = '';
    input.style.height = 'auto';
    const r = await api(`/api/conversations/${encodeURIComponent(conv.pageId)}/${encodeURIComponent(conv.id)}/send`, { method: 'POST', body: JSON.stringify({ text }) });
    if (!r.ok) { toast(r.error || 'Không gửi được tin nhắn.', 'error'); return; }
    conv.thread.push({ me: true, text, time: 'Bây giờ' });
    renderThread(conv);
    renderConvList($('#conv-search').value.trim());
    return;
  }

  // Hội thoại không gắn với page thật
  toast('Hội thoại này chưa kết nối page — không gửi được tin thật.', 'error');
}

/* ---------- Đồng bộ — Tạo ứng dụng Facebook Developers ---------- */

const SYNC_STATUS_TEXT = {
  opening_browser: 'Đang mở cửa sổ Chrome…',
  restoring: 'Đang khôi phục phiên đăng nhập Facebook…',
  loading_apps: 'Đang mở Developers Facebook…',
  finding_create: 'Đang tìm nút "Tạo ứng dụng"…',
  filling: 'Đang điền Tên ứng dụng & Email liên hệ…',
  wizard: 'Đang thực hiện các bước tạo ứng dụng…',
  need_password: 'Cần mật khẩu xác nhận',
  verifying: 'Đang xác nhận tạo ứng dụng…',
  adding_messenger: 'Đang thêm sản phẩm Messenger…',
  filling_webhook: 'Đang điền URL gọi lại & mã xác minh…',
  saving_webhook: 'Đang bấm "Xác minh và lưu"…',
  connecting_pages: 'Đang kết nối trang Facebook…',
  syncing_pages: 'Đang đồng bộ danh sách trang…',
  success: 'Hoàn tất!',
};

let syncId = null;
let syncPollTimer = null;
let lastErroredSyncId = null;

function stopSyncPoll() {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
}

$('#btn-sync').addEventListener('click', async () => {
  if (!token) { toast('Hãy đăng nhập Facebook trước khi đồng bộ.', 'error'); return; }
  show($('#sync-modal'), true);
  resetSyncModal();
  // Có tác vụ đồng bộ đang chạy (sau F5 / đóng modal) → gắn lại theo dõi
  await attachActiveSync();
});

// Gắn lại theo dõi tác vụ đồng bộ đang chạy (sau F5 / đóng modal / load trang)
async function attachActiveSync() {
  const a = await api('/api/sync');
  if (a.ok && a.active) {
    syncId = a.syncId;
    show($('#sync-form'), false);
    setSyncProgress(SYNC_STATUS_TEXT[a.status] || a.status, a.message || '');
    syncPollTimer = setInterval(pollSync, 1500);
    return true;
  }
  return false;
}

function closeSyncModal() {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
  syncId = null;
  show($('#sync-modal'), false);
}

function resetSyncModal() {
  show($('#sync-form'), true);
  show($('#sync-progress'), false);
  show($('#sync-success'), false);
  show($('#sync-error'), false);
  show($('#sync-password'), false);
  show($('#btn-sync-retry'), false);
  $('#sync-pwd').value = '';
  $('#sync-form').reset();
  setLoading($('#btn-sync-start'), false);
}

$('#btn-sync-close').addEventListener('click', closeSyncModal);
$('#sync-modal').addEventListener('click', (e) => {
  if (e.target === $('#sync-modal') && !syncPollTimer) closeSyncModal();
});

$('#sync-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const appName = $('#sync-app-name').value.trim();
  const email = $('#sync-email').value.trim();
  if (!appName) { showSyncError('Vui lòng nhập tên ứng dụng.'); return; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showSyncError('Email liên hệ không hợp lệ.'); return; }
  showSyncError(null);

  setLoading($('#btn-sync-start'), true, 'Đang mở Chrome…');
  const r = await api('/api/sync/app', { method: 'POST', body: JSON.stringify({ appName, email }) });
  if (!r.ok) { setLoading($('#btn-sync-start'), false); showSyncError(r.error); return; }

  syncId = r.syncId;
  show($('#sync-form'), false);
  setSyncProgress(SYNC_STATUS_TEXT.opening_browser, '');
  syncPollTimer = setInterval(pollSync, 1500);
});

async function pollSync() {
  if (!syncId) return;
  const r = await api('/api/sync/status/' + syncId);
  if (!r.ok) { finishSync(); showSyncError(r.error || 'Mất kết nối với máy chủ.'); return; }

  $('#sync-status-title').textContent = SYNC_STATUS_TEXT[r.status] || r.status;
  $('#sync-status-detail').textContent = r.message || '';

  if (r.status === 'need_password') {
    show($('#sync-password'), true);
    if (document.activeElement !== $('#sync-pwd')) $('#sync-pwd').focus();
    return;
  }
  show($('#sync-password'), false);

  if (r.status === 'success') {
    finishSync(true);
    $('#sync-success-detail').textContent = r.message || '';
    show($('#sync-success'), true);
    toast('Hoàn tất — kiểm tra trong cửa sổ Chrome!', 'success');
    return;
  }
  if (r.status === 'error') {
    const err = r.error || 'Đồng bộ thất bại.';
    lastErroredSyncId = syncId;
    finishSync();
    show($('#sync-form'), true);
    showSyncError(err);
    show($('#btn-sync-retry'), true);
    return;
  }
}

// Bấm lại "Tạo ứng dụng" trên cửa sổ Chrome còn sống (khi re-auth hủy action)
$('#btn-sync-retry').addEventListener('click', async () => {
  const id = syncId || lastErroredSyncId;
  if (!id) { toast('Không còn tác vụ nào — hãy chạy Đồng bộ lại.', 'info'); return; }
  const r = await api('/api/sync/retry', { method: 'POST', body: JSON.stringify({ syncId: id }) });
  if (!r.ok) { toast(r.error, 'error'); return; }
  showSyncError(null);
  show($('#btn-sync-retry'), false);
  show($('#sync-form'), false);
  syncId = r.syncId;
  setSyncProgress(SYNC_STATUS_TEXT.wizard, 'Đang bấm lại "Tạo ứng dụng"…');
  stopSyncPoll();
  syncPollTimer = setInterval(pollSync, 1500);
});

/* ---------- Mật khẩu xác nhận (re-auth) ---------- */

$('#btn-sync-pwd').addEventListener('click', submitSyncPassword);
$('#sync-pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitSyncPassword(); });

async function submitSyncPassword() {
  const pwd = $('#sync-pwd').value;
  if (!pwd || !syncId) { $('#sync-pwd').focus(); return; }
  setLoading($('#btn-sync-pwd'), true, 'Đang gửi…');
  const r = await api('/api/sync/password', { method: 'POST', body: JSON.stringify({ syncId, password: pwd }) });
  setLoading($('#btn-sync-pwd'), false);
  if (!r.ok) { toast(r.error || 'Không gửi được mật khẩu.', 'error'); return; }
  $('#sync-pwd').value = '';
  show($('#sync-password'), false);
  $('#sync-status-title').textContent = SYNC_STATUS_TEXT.verifying;
}

function finishSync(keepModal = false) {
  if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
  syncId = null;
  show($('#sync-progress'), false);
  if (!keepModal) show($('#sync-form'), true);
  setLoading($('#btn-sync-start'), false);
}

function showSyncError(msg) {
  const box = $('#sync-error');
  if (!msg) { show(box, false); return; }
  box.textContent = msg;
  show(box, true);
}

$('#btn-sync-cancel').addEventListener('click', async () => {
  if (!syncId) return;
  await api('/api/sync/cancel', { method: 'POST', body: JSON.stringify({ syncId }) });
  finishSync();
  toast('Đã hủy và đóng cửa sổ Chrome.', 'info');
});

/* ---------- Màn Trang / Fanpage: mỗi app một card — config + trang của app đó ---------- */

async function renderPagesView() {
  const cfg = await api('/api/webhook/config');
  const h = await api('/api/apps');
  const apps = (h.ok && h.apps) ? h.apps : [];
  const el = $('#apps-config-list');
  const tunnelCard = (cfg.ok && cfg.tunnelUrl)
    ? `<section class="card glass" style="padding: 14px 22px; margin-bottom: 14px;">
        <div class="cfg-row"><span class="cfg-label">Tunnel public (webhook)</span><code class="cfg-value">${escapeHtml(cfg.tunnelUrl)}</code></div>
      </section>`
    : '';

  if (!apps.length) {
    el.innerHTML = tunnelCard + `
      <section class="card glass" style="padding: 28px; text-align: center;">
        <p class="muted" style="font-size: 13.5px; line-height: 1.6;">Chưa có app nào.<br>Dùng nút <strong>"Tạo app &amp; Webhook"</strong> để tạo app và kết nối trang.</p>
      </section>`;
    return;
  }

  const shieldSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
  const pagesSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6z"/></svg>`;

  el.innerHTML = tunnelCard + apps.map((a, idx) => {
    const when = a.createdAt ? new Date(a.createdAt).toLocaleString('vi-VN') : '—';
    const chip = a.status === 'success'
      ? '<span class="chip">Thành công</span>'
      : '<span class="chip soon">Lỗi</span>';
    const pages = (a.pages || []);
    const pagesHtml = pages.map((p) => {
      const initials = (p.name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
      const key = a.appId + ':' + p.pageId;
      return `
        <div class="page-row">
          <input type="checkbox" class="page-check" data-appid="${escapeHtml(a.appId)}" data-pageid="${escapeHtml(p.pageId)}" ${selectedPages.has(key) ? 'checked' : ''}>
          <div class="conv-avatar" style="background:${gradientFor(p.name)}">${escapeHtml(initials)}</div>
          <div class="conv-meta">
            <div class="conv-name">${escapeHtml(p.name)}</div>
            <div class="muted tiny">Page ID: ${escapeHtml(p.pageId)} • Kết nối ${fmtTime(p.connectedAt)}</div>
          </div>
          <span class="chip ${p.token ? '' : 'soon'}">${p.token ? 'Đã có token' : 'Chưa có token'}</span>
        </div>`;
    }).join('') || '<p class="muted" style="font-size: 13px; padding: 4px 0;">Không cào được trang nào trong lần này.</p>';
    const lastRunLine = (idx === 0 && cfg.ok && cfg.lastRun)
      ? `<div class="cfg-row"><span class="cfg-label">Lần chạy cuối</span><span class="cfg-value text">${cfg.lastRun.status === 'success' ? '✓ Thành công' : '✗ Lỗi'} — ${new Date(cfg.lastRun.at).toLocaleString('vi-VN')}</span></div>`
      : '';
    const selCount = pages.filter((p) => selectedPages.has(a.appId + ':' + p.pageId)).length;
    return `
      <section class="card glass" style="padding: 22px;">
        <div class="card-head">
          <div class="card-icon">${shieldSvg}</div>
          <div>
            <h3>${escapeHtml(a.name || '—')}</h3>
            <div class="muted tiny">App ID: ${escapeHtml(a.appId)} • Tạo lúc ${when}</div>
          </div>
          <button class="btn-ghost del-btn" data-appid="${escapeHtml(a.appId)}" data-name="${escapeHtml(a.name || '')}" type="button">Xóa app</button>
          ${chip}
        </div>
        <div class="cfg-rows">
          <div class="cfg-row"><span class="cfg-label">Webhook URL</span><code class="cfg-value">${escapeHtml(a.webhookUrl || '—')}</code></div>
          <div class="cfg-row">
            <span class="cfg-label">Mã xác minh</span>
            <span class="cfg-value-wrap">
              <code class="cfg-value blurred cfg-token">${escapeHtml((cfg.ok && cfg.verifyToken) || '—')}</code>
              <button class="link-btn cfg-reveal-btn" type="button">Hiện</button>
            </span>
          </div>
          ${lastRunLine}
        </div>
        <div class="card-head" style="margin: 16px 0 10px;">
          <div class="card-icon">${pagesSvg}</div>
          <div>
            <h3>Trang đã kết nối</h3>
            <div class="muted tiny">${pages.length} trang thuộc app này — tích chọn để đăng ký webhook &amp; lấy token</div>
          </div>
        </div>
        <div class="pages-toolbar">
          <label class="page-check-all-wrap">
            <input type="checkbox" class="page-check-all" data-appid="${escapeHtml(a.appId)}" ${pages.length && selCount === pages.length ? 'checked' : ''}>
            <span>Chọn tất cả</span>
          </label>
          <button class="btn-primary btn-page-setup" data-appid="${escapeHtml(a.appId)}" type="button" ${selCount ? '' : 'disabled'}>
            <span>Lấy token &amp; Đăng ký${selCount ? ' (' + selCount + ')' : ''}</span>
          </button>
        </div>
        <div class="page-setup-progress hidden" data-appid="${escapeHtml(a.appId)}">
          <div class="spinner"></div>
          <div class="progress-text">
            <div class="pgsetup-title">Đang xử lý…</div>
            <div class="pgsetup-detail muted"></div>
          </div>
        </div>
        <div class="page-setup-password hidden" data-appid="${escapeHtml(a.appId)}">
          <div class="pwd-note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
            <div><strong>Facebook cần xác nhận lại mật khẩu</strong><br>
            <span class="muted">Điền mật khẩu để tiếp tục — chỉ gửi tới Facebook, không lưu ra file.</span></div>
          </div>
          <div class="twofa-row">
            <input type="password" class="page-setup-pwd" placeholder="Mật khẩu Facebook" autocomplete="off">
            <button class="btn-primary page-setup-pwd-btn" data-appid="${escapeHtml(a.appId)}" type="button"><span>Gửi mật khẩu</span></button>
          </div>
        </div>
        <div>${pagesHtml}</div>
      </section>`;
  }).join('');
}

/* ---------- Chọn trang: đăng ký webhook + lấy token cho các trang được tích ---------- */

const selectedPages = new Set(); // khóa: appId:pageId
const pgSetupTimers = {}; // appId -> poll timer
const pgSetupSyncIds = {}; // appId -> syncId (để gửi mật khẩu)
const PGSETUP_STATUS_TEXT = {
  opening_browser: 'Đang mở cửa sổ Chrome…',
  restoring: 'Đang khôi phục phiên đăng nhập…',
  loading_apps: 'Đang mở cấu hình Messenger…',
  subscribing: 'Đang đăng ký webhook cho trang…',
  generating_token: 'Đang tạo Page Access Token…',
  need_password: 'Cần mật khẩu xác nhận',
  verifying: 'Đang xác nhận…',
  success: 'Hoàn tất!',
};

function pgSetupCard(appId, sel) {
  return document.querySelector(`.page-setup-progress[data-appid="${CSS.escape(appId)}"]`);
}

function updatePgSetupButton(appId) {
  const card = document.querySelector(`.btn-page-setup[data-appid="${CSS.escape(appId)}"]`);
  if (!card) return;
  const n = [...selectedPages].filter((k) => k.startsWith(appId + ':')).length;
  card.disabled = n === 0;
  card.querySelector('span').textContent = 'Lấy token & Đăng ký' + (n ? ' (' + n + ')' : '');
}

$('#apps-config-list').addEventListener('change', (e) => {
  const one = e.target.closest('.page-check');
  const all = e.target.closest('.page-check-all');
  if (one) {
    const key = one.dataset.appid + ':' + one.dataset.pageid;
    if (one.checked) selectedPages.add(key); else selectedPages.delete(key);
    updatePgSetupButton(one.dataset.appid);
  }
  if (all) {
    const appId = all.dataset.appid;
    document.querySelectorAll(`.page-check[data-appid="${CSS.escape(appId)}"]`).forEach((cb) => {
      cb.checked = all.checked;
      const key = appId + ':' + cb.dataset.pageid;
      if (all.checked) selectedPages.add(key); else selectedPages.delete(key);
    });
    updatePgSetupButton(appId);
  }
});

$('#apps-config-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-page-setup');
  if (!btn || btn.disabled) return;
  const appId = btn.dataset.appid;
  const pageIds = [...selectedPages].filter((k) => k.startsWith(appId + ':')).map((k) => k.split(':')[1]);
  if (!pageIds.length) return;
  btn.disabled = true;
  const prog = document.querySelector(`.page-setup-progress[data-appid="${CSS.escape(appId)}"]`);
  if (prog) { prog.classList.remove('hidden'); prog.querySelector('.pgsetup-title').textContent = 'Đang xử lý…'; }
  const r = await api('/api/pages/setup', { method: 'POST', body: JSON.stringify({ appId, pageIds }) });
  if (!r.ok) {
    btn.disabled = false;
    if (prog) { prog.querySelector('.pgsetup-title').textContent = 'Lỗi'; prog.querySelector('.pgsetup-detail').textContent = r.error || ''; }
    return;
  }
  pgSetupSyncIds[appId] = r.syncId;
  pgSetupTimers[appId] = setInterval(async () => {
    const st = await api('/api/sync/status/' + r.syncId);
    if (!st.ok) {
      clearInterval(pgSetupTimers[appId]);
      if (prog) { prog.querySelector('.pgsetup-title').textContent = 'Lỗi'; prog.querySelector('.pgsetup-detail').textContent = st.error || ''; }
      btn.disabled = false;
      return;
    }
    if (prog) {
      prog.querySelector('.pgsetup-title').textContent = PGSETUP_STATUS_TEXT[st.status] || st.status;
      prog.querySelector('.pgsetup-detail').textContent = st.message || '';
    }
    if (st.status === 'need_password') {
      const pw = document.querySelector(`.page-setup-password[data-appid="${CSS.escape(appId)}"]`);
      if (pw) { pw.classList.remove('hidden'); const i = pw.querySelector('.page-setup-pwd'); if (document.activeElement !== i) i.focus(); }
      return;
    }
    const pw = document.querySelector(`.page-setup-password[data-appid="${CSS.escape(appId)}"]`);
    if (pw) pw.classList.add('hidden');
    if (st.status === 'success') {
      clearInterval(pgSetupTimers[appId]);
      delete pgSetupTimers[appId];
      [...selectedPages].filter((k) => k.startsWith(appId + ':')).forEach((k) => selectedPages.delete(k));
      if (prog) prog.classList.add('hidden');
      toast('Đã cấu hình trang — token đã lưu (nếu lấy được).', 'success');
      renderPagesView();
    }
    if (st.status === 'error') {
      clearInterval(pgSetupTimers[appId]);
      delete pgSetupTimers[appId];
      if (prog) { prog.querySelector('.pgsetup-title').textContent = 'Lỗi'; prog.querySelector('.pgsetup-detail').textContent = st.error || ''; }
      btn.disabled = false;
    }
  }, 1500);
});

$('#apps-config-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.page-setup-pwd-btn');
  if (!btn) return;
  const appId = btn.dataset.appid;
  const input = document.querySelector(`.page-setup-password[data-appid="${CSS.escape(appId)}"] .page-setup-pwd`);
  const pwd = input ? input.value : '';
  if (!pwd || !pgSetupTimers[appId]) { if (input) input.focus(); return; }
  setLoading(btn, true, 'Đang gửi…');
  const r = await api('/api/sync/password', { method: 'POST', body: JSON.stringify({ syncId: pgSetupSyncIds[appId], password: pwd }) });
  setLoading(btn, false);
  if (!r.ok) { toast(r.error || 'Không gửi được mật khẩu.', 'error'); return; }
  input.value = '';
  const pw = document.querySelector(`.page-setup-password[data-appid="${CSS.escape(appId)}"]`);
  if (pw) pw.classList.add('hidden');
});

// Bật/tắt hiển thị mã xác minh trên từng card (uỷ quyền sự kiện vì card render động)
$('#apps-config-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.cfg-reveal-btn');
  if (!btn) return;
  const code = btn.parentElement.querySelector('.cfg-token');
  if (!code) return;
  code.classList.toggle('blurred');
  btn.textContent = code.classList.contains('blurred') ? 'Hiện' : 'Ẩn';
});

/* ---------- Xóa ứng dụng: xác nhận → tool tự gỡ trên Facebook + dọn dữ liệu ---------- */

const DELETE_STATUS_TEXT = {
  opening_browser: 'Đang mở cửa sổ Chrome…',
  restoring: 'Đang khôi phục phiên đăng nhập Facebook…',
  loading_apps: 'Đang mở ứng dụng…',
  finding_menu: 'Đang mở menu ⋯ của ứng dụng…',
  removing: 'Đang gỡ ứng dụng…',
  need_password: 'Cần mật khẩu xác nhận',
  verifying: 'Đang xác nhận xóa ứng dụng…',
  success: 'Đã xóa xong!',
};

let deleteId = null;
let deletePollTimer = null;

$('#apps-config-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.del-btn');
  if (!btn) return;
  openDeleteModal(btn.dataset.appid, btn.dataset.name);
});

function openDeleteModal(appId, name) {
  $('#delete-name').textContent = `${name || '—'} (App ID: ${appId})`;
  show($('#delete-confirm'), true);
  show($('#delete-progress'), false);
  show($('#delete-password'), false);
  show($('#delete-error'), false);
  $('#delete-modal').dataset.appid = appId;
  show($('#delete-modal'), true);
}

function closeDeleteModal() {
  if (deletePollTimer) { clearInterval(deletePollTimer); deletePollTimer = null; }
  deleteId = null;
  show($('#delete-modal'), false);
}

$('#btn-delete-close').addEventListener('click', closeDeleteModal);
$('#btn-delete-cancel').addEventListener('click', closeDeleteModal);
$('#delete-modal').addEventListener('click', (e) => {
  if (e.target === $('#delete-modal') && !deletePollTimer) closeDeleteModal();
});

$('#btn-delete-agree').addEventListener('click', async () => {
  const appId = $('#delete-modal').dataset.appid;
  show($('#delete-confirm'), false);
  show($('#delete-error'), false);
  setDeleteProgress(DELETE_STATUS_TEXT.opening_browser, '');
  setLoading($('#btn-delete-agree'), true, 'Đang mở…');
  const r = await api('/api/sync/delete', { method: 'POST', body: JSON.stringify({ appId }) });
  setLoading($('#btn-delete-agree'), false);
  if (!r.ok) { show($('#delete-confirm'), true); showDeleteError(r.error); return; }
  deleteId = r.syncId;
  show($('#delete-progress'), true);
  deletePollTimer = setInterval(pollDelete, 1500);
});

function setDeleteProgress(title, detail) {
  show($('#delete-progress'), true);
  $('#del-status-title').textContent = title;
  $('#del-status-detail').textContent = detail || '';
}

async function pollDelete() {
  if (!deleteId) return;
  const r = await api('/api/sync/status/' + deleteId);
  if (!r.ok) { stopDeletePoll(); showDeleteError(r.error || 'Mất kết nối với máy chủ.'); return; }

  $('#del-status-title').textContent = DELETE_STATUS_TEXT[r.status] || r.status;
  $('#del-status-detail').textContent = r.message || '';

  if (r.status === 'need_password') {
    show($('#delete-password'), true);
    if (document.activeElement !== $('#del-pwd')) $('#del-pwd').focus();
    return;
  }
  show($('#delete-password'), false);

  if (r.status === 'success') {
    stopDeletePoll();
    deleteId = null;
    show($('#delete-modal'), false);
    toast('Đã xóa ứng dụng khỏi Facebook và CRM.', 'success');
    renderPagesView();
    return;
  }
  if (r.status === 'error') {
    stopDeletePoll();
    deleteId = null;
    showDeleteError(r.error || 'Xóa thất bại.');
    return;
  }
}

$('#btn-del-pwd').addEventListener('click', submitDeletePassword);
$('#del-pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitDeletePassword(); });

async function submitDeletePassword() {
  const pwd = $('#del-pwd').value;
  if (!pwd || !deleteId) { $('#del-pwd').focus(); return; }
  setLoading($('#btn-del-pwd'), true, 'Đang gửi…');
  const r = await api('/api/sync/password', { method: 'POST', body: JSON.stringify({ syncId: deleteId, password: pwd }) });
  setLoading($('#btn-del-pwd'), false);
  if (!r.ok) { toast(r.error || 'Không gửi được mật khẩu.', 'error'); return; }
  $('#del-pwd').value = '';
  show($('#delete-password'), false);
  $('#del-status-title').textContent = DELETE_STATUS_TEXT.verifying;
}

function stopDeletePoll() {
  if (deletePollTimer) { clearInterval(deletePollTimer); deletePollTimer = null; }
  deleteId = null;
}

function showDeleteError(msg) {
  const box = $('#delete-error');
  if (!msg) { show(box, false); return; }
  box.textContent = msg;
  show(box, true);
}

/* ---------- Chạy ---------- */
init();
