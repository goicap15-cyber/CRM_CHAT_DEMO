// Gọi Graph API Messenger bằng Page Access Token:
// - listConversations(): hội thoại của các trang đã có token
// - getMessages(pageId, convId): tin nhắn trong một hội thoại
// - sendMessage(pageId, convId, text): gửi tin nhắn (dùng PSID của người kia)
const pagesStore = require('../store/pages-store');

const GRAPH = 'https://graph.facebook.com/v21.0';
const cache = new Map(); // pageId -> { at, data } — at:0 nghĩa là đã bị đánh dấu stale
const CACHE_TTL = 45 * 1000;
let notifier = null; // server gắn vào để bắn sự kiện realtime xuống giao diện
let kickBusy = false;

function onNotify(cb) { notifier = cb; }
function notify(data) { try { if (notifier) notifier(data); } catch { /* bỏ qua */ } }

// Webhook báo có tin mới: giữ dữ liệu cũ nhưng đánh dấu stale — lần đọc sau
// phục vụ ngay lập tức, nền tự lấy dữ liệu mới rồi thông báo xuống giao diện
function invalidateCache(pageId) {
  const key = 'convs:' + pageId;
  const hit = cache.get(key);
  cache.set(key, { at: 0, data: hit ? hit.data : [] });
}

// Làm mới nền các trang đang stale — xong thì thông báo xuống giao diện
async function kickRefresh() {
  if (kickBusy) return;
  kickBusy = true;
  try {
    const pages = pagesStore.list().filter((p) => p.token);
    for (const p of pages) {
      const key = 'convs:' + p.pageId;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL) continue; // còn tươi, bỏ qua
      try {
        const convs = await fetchPageConvs(p);
        cache.set(key, { at: Date.now(), data: convs });
      } catch { /* bỏ qua trang lỗi */ }
    }
    notify({ type: 'refreshed' });
  } finally {
    kickBusy = false;
  }
}

async function fetchPageConvs(p) {
  const j = await fetchJson(
    `${GRAPH}/${p.pageId}/conversations?platform=messenger&fields=participants,updated_time,message_count&limit=25&access_token=${encodeURIComponent(p.token)}`,
  );
  const convs = [];
  for (const c of j.data || []) {
    const other = ((c.participants && c.participants.data) || []).find((x) => x.id !== p.pageId);
    let snippet = '';
    try {
      const m = await fetchJson(
        `${GRAPH}/${c.id}/messages?fields=from,message,created_time&limit=1&access_token=${encodeURIComponent(p.token)}`,
      );
      const last = (m.data || [])[0];
      if (last) snippet = last.message || '[đính kèm]';
    } catch { /* bỏ qua preview */ }
    convs.push({
      convId: c.id,
      pageId: p.pageId,
      pageName: p.name,
      name: other ? (other.name || 'Khách') : 'Khách',
      userId: other ? other.id : null,
      updatedTime: c.updated_time,
      messageCount: c.message_count || 0,
      snippet,
    });
  }
  return convs;
}

// Danh sách hội thoại: trả ngay từ cache (kể cả stale) + tự làm mới nền nếu stale
async function listConversations() {
  const pages = pagesStore.list().filter((p) => p.token);
  const out = [];
  const errors = [];
  let anyStale = false;
  for (const p of pages) {
    const key = 'convs:' + p.pageId;
    const hit = cache.get(key);
    if (hit && hit.at > 0) {
      out.push(...hit.data);
      if (Date.now() - hit.at > CACHE_TTL) anyStale = true;
      continue;
    }
    if (hit && hit.at === 0 && hit.data.length) {
      out.push(...hit.data); // stale nhưng có dữ liệu cũ — phục vụ ngay
      anyStale = true;
      continue;
    }
    try {
      const convs = await fetchPageConvs(p);
      cache.set(key, { at: Date.now(), data: convs });
      out.push(...convs);
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
    }
  }
  if (anyStale) kickRefresh(); // nền — không await, xong sẽ notify
  return { conversations: out, errors };
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error('Không kết nối được tới Graph API. Kiểm tra mạng.');
  }
  const j = await res.json().catch(() => ({}));
  if (j && j.error) throw new Error(j.error.message || 'Graph API trả về lỗi.');
  return j;
}

function pageWithToken(pageId) {
  const p = pagesStore.list().find((x) => x.pageId === String(pageId));
  if (!p || !p.token) return null;
  return p;
}

function otherParticipant(conv) {
  const arr = (conv.participants && conv.participants.data) || [];
  return arr.find((x) => x.id) || null;
}

// Tin nhắn trong hội thoại (cũ → mới)
async function getMessages(pageId, convId) {
  const p = pageWithToken(pageId);
  if (!p) throw new Error('Trang chưa có token — hãy lấy token ở mục Trang / Fanpage.');
  const j = await fetchJson(
    `${GRAPH}/${encodeURIComponent(convId)}/messages?fields=from,message,created_time&limit=50&access_token=${encodeURIComponent(p.token)}`,
  );
  return (j.data || [])
    .reverse()
    .map((m) => ({
      fromMe: !!(m.from && m.from.id === pageId),
      sender: m.from ? (m.from.name || m.from.id) : 'Khách',
      text: m.message || '[đính kèm / không phải văn bản]',
      time: m.created_time,
    }));
}

// Gửi tin nhắn vào hội thoại (cần quyền pages_messaging)
async function sendMessage(pageId, convId, text) {
  const p = pageWithToken(pageId);
  if (!p) throw new Error('Trang chưa có token — hãy lấy token ở mục Trang / Fanpage.');
  const c = await fetchJson(
    `${GRAPH}/${encodeURIComponent(convId)}?fields=participants&access_token=${encodeURIComponent(p.token)}`,
  );
  const other = otherParticipant(c);
  if (!other) throw new Error('Không xác định được người nhận trong hội thoại.');
  const res = await fetch(
    `${GRAPH}/${p.pageId}/messages?access_token=${encodeURIComponent(p.token)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: { id: other.id }, message: { text } }),
    },
  );
  const j = await res.json().catch(() => ({}));
  if (j && j.error) throw new Error(j.error.message || 'Gửi tin nhắn thất bại.');
  return true;
}

// Khi webhook báo có tin mới → hủy cache để lần poll sau lấy dữ liệu tươi
function invalidateCache(pageId) {
  if (pageId) cache.delete('convs:' + pageId);
  else cache.clear();
}

module.exports = { listConversations, getMessages, sendMessage, invalidateCache, kickRefresh, onNotify };
