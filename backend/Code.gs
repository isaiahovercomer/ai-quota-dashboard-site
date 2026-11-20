/**
 * AI額度即時儀表板 — 網頁版後端（Google Apps Script 網頁應用程式）
 *
 * 部署：執行身分「我」、存取權「所有人」。第一次部署前，函式選 setup 按執行並授權。
 * 前端用 Content-Type: text/plain POST JSON（避免 CORS 預檢），依 action 分派。
 *
 * 資料（指令碼屬性，只有這個指令碼讀得到）：
 *   c_<sub>  使用者設定（金鑰加密保存）      r_<sub>  最近一次查詢結果
 *   m_<sub>  最後使用時間                    s_<token> 登入通行證（60 天）
 *   users    使用者清單
 *
 * 網頁版、Android、iPhone 都用同一個 Google 帳號登入，看到同一份設定。
 */

// 接受的 Google 用戶端：網頁版（Android 也用這個當 serverClientId）、iPhone 版
const GOOGLE_CLIENT_IDS = [
  '377002864625-2ao3us8jdfa1luak4djov1fpdtc6rbt2.apps.googleusercontent.com',
  '377002864625-bdstrhhfmd8ut1vkgvis022hig537kaq.apps.googleusercontent.com',
];
const SESSION_DAYS = 60;
const STALE_DAYS = 30;          // 超過 30 天沒打開，暫停背景更新（省額度）
const DAY = 86400000;

const TYPES = ['OPENAI_COST', 'ANTHROPIC_COST', 'DEEPSEEK_BALANCE', 'XAI_BALANCE', 'KIMI_BALANCE',
  'OPENROUTER_CREDITS', 'JSON_URL', 'MANUAL'];
const NEEDS_KEY = ['OPENAI_COST', 'ANTHROPIC_COST', 'DEEPSEEK_BALANCE', 'XAI_BALANCE', 'KIMI_BALANCE', 'OPENROUTER_CREDITS'];

// ====================== 安裝 ======================

/** 第一次部署前執行一次：建立加密密鑰、安裝每 15 分鐘的背景更新排程。 */
function setup() {
  const p = props();
  if (!p.getProperty('ENC_SECRET')) {
    p.setProperty('ENC_SECRET', Utilities.base64Encode(randomBytes()));
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshAllUsers') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshAllUsers').timeBased().everyMinutes(15).create();
  UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true }); // 觸發對外連線授權
  Logger.log('完成：已建立加密密鑰與每 15 分鐘排程。使用者數：' + users().length);
}

function mr(l, p, r, per) { return { l: l, p: p, r: r, at: 0, per: per }; }
const EMPTY = mr('', 100, true, 0);

/** 預設服務目錄（與 Android／iOS 版相同順序）。 */
function catalog() {
  const C = [
    ['MANUAL', 'ChatGPT', mr('週', 100, true, 168), mr('5h', 100, true, 5), true],
    ['MANUAL', 'Gemini', mr('週', 100, true, 168), mr('段', 100, true, 0), true],
    ['MANUAL', 'Grok', mr('每週', 0, false, 168), EMPTY, true],
    ['OPENAI_COST', 'OpenAI API', EMPTY, EMPTY, true, 100],
    ['MANUAL', 'Muse', mr('週', 100, true, 168), EMPTY, true],
    ['DEEPSEEK_BALANCE', 'DeepSeek', EMPTY, EMPTY, true],
    ['MANUAL', 'Claude', mr('5h', 100, true, 5), mr('週', 100, true, 168), false],
    ['ANTHROPIC_COST', 'Claude API', EMPTY, EMPTY, false, 100],
    ['MANUAL', 'Copilot', mr('每日', 100, true, 24), EMPTY, false],
    ['MANUAL', 'Perplexity', mr('每日', 100, true, 24), EMPTY, false],
    ['KIMI_BALANCE', 'Kimi', EMPTY, EMPTY, false],
    ['OPENROUTER_CREDITS', 'OpenRouter', EMPTY, EMPTY, false],
    ['XAI_BALANCE', 'xAI API', EMPTY, EMPTY, false],
    ['MANUAL', 'Mistral', mr('每日', 100, true, 24), EMPTY, false],
    ['MANUAL', '通義千問', mr('每日', 100, true, 24), EMPTY, false],
    ['MANUAL', '豆包', mr('每日', 100, true, 24), EMPTY, false],
    ['MANUAL', '自訂 1', mr('週', 100, true, 168), EMPTY, false],
    ['MANUAL', '自訂 2', mr('週', 100, true, 168), EMPTY, false],
  ];
  return C.map(function (c, i) {
    return { id: i, t: c[0], n: c[1], k: '', a: '', b: c[5] || 0, u: '', m1: Object.assign({}, c[2]), m2: Object.assign({}, c[3]), e: c[4] };
  });
}

// ====================== 進入點 ======================

function doGet() {
  return out({ ok: true, app: 'AI額度即時儀表板', version: 1 });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (_) { return out({ ok: false, error: 'BAD_REQUEST' }); }
  try {
    return out(handle(req));
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handle(req) {
  switch (req.action) {
    case 'login': return login(req.idToken);
  }
  const sub = auth(req.session);
  switch (req.action) {
    case 'state': return state(sub);
    case 'save': return saveService(sub, req.service || {});
    case 'toggle': return toggle(sub, req.id, !!req.on);
    case 'refresh': return refreshUser(sub, req.id);
    case 'import': return importLocal(sub, req.services || []);
    case 'logout': props().deleteProperty('s_' + req.session); return { ok: true };
    case 'deleteMe': return deleteMe(sub);
  }
  throw new Error('UNKNOWN_ACTION');
}

// ====================== 登入 ======================

function props() { return PropertiesService.getScriptProperties(); }

function newToken() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }

/** 驗證 Google ID token（Google Identity Services 給前端的 credential）。 */
function verifyGoogle(idToken) {
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken || ''),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('INVALID_TOKEN');
  const p = JSON.parse(res.getContentText());
  const issOk = p.iss === 'accounts.google.com' || p.iss === 'https://accounts.google.com';
  if (GOOGLE_CLIENT_IDS.indexOf(p.aud) < 0 || !issOk) throw new Error('INVALID_TOKEN');
  if (String(p.email_verified) !== 'true') throw new Error('EMAIL_NOT_VERIFIED');
  if (Number(p.exp) * 1000 < Date.now()) throw new Error('TOKEN_EXPIRED');
  return { sub: String(p.sub), email: String(p.email || '') };
}

function login(idToken) {
  const g = verifyGoogle(idToken);
  ensureUser(g.sub, g.email);
  return Object.assign(issueSession(g.sub), state(g.sub));
}

function issueSession(sub) {
  const token = newToken();
  props().setProperty('s_' + token, sub + '|' + (Date.now() + SESSION_DAYS * DAY));
  return { session: token };
}

function auth(session) {
  if (!session) throw new Error('SESSION_EXPIRED');
  const v = props().getProperty('s_' + session);
  if (!v) throw new Error('SESSION_EXPIRED');
  const parts = v.split('|');
  if (Date.now() > Number(parts[1])) { props().deleteProperty('s_' + session); throw new Error('SESSION_EXPIRED'); }
  const sub = parts[0];
  const m = getJSON('m_' + sub) || {};
  if (!m.seen || Date.now() - m.seen > 3600000) { m.seen = Date.now(); setJSON('m_' + sub, m); }
  return sub;
}

// ====================== 使用者資料 ======================

function getJSON(key) { const v = props().getProperty(key); return v ? JSON.parse(v) : null; }
function setJSON(key, obj) { props().setProperty(key, JSON.stringify(obj)); }

/** 設定只存跟預設目錄不同的欄位，節省指令碼屬性空間（總上限 500KB）。 */
const FIELDS = ['t', 'n', 'k', 'a', 'b', 'u', 'e', 'm1', 'm2'];
function getCfg(sub) {
  const raw = getJSON('c_' + sub);
  if (!raw) return null;
  const def = catalog();
  return { email: raw.email, lastRefresh: raw.lr || 0, slots: def.map(function (d, i) { return Object.assign(d, (raw.s || [])[i] || {}); }) };
}
function setCfg(sub, cfg) {
  const def = catalog();
  const s = cfg.slots.map(function (slot, i) {
    const o = {};
    FIELDS.forEach(function (f) { if (JSON.stringify(slot[f]) !== JSON.stringify(def[i][f])) o[f] = slot[f]; });
    return o;
  });
  while (s.length && !Object.keys(s[s.length - 1]).length) s.pop();
  setJSON('c_' + sub, { email: cfg.email, lr: cfg.lastRefresh || 0, s: s });
}

function users() { const v = props().getProperty('users'); return v ? v.split(',').filter(String) : []; }

function ensureUser(sub, email) {
  withLock(function () {
    let cfg = getCfg(sub);
    if (!cfg) {
      cfg = { email: email, slots: catalog(), lastRefresh: 0 };
      const res = {};
      cfg.slots.forEach(function (s) { if (s.t === 'MANUAL') res[s.id] = manualResult(s); });
      setJSON('r_' + sub, res);
      const list = users(); list.push(sub); props().setProperty('users', list.join(','));
    } else if (email) {
      cfg.email = email;
    }
    setCfg(sub, cfg);
    setJSON('m_' + sub, { seen: Date.now() });
  });
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function publicSlot(s) {
  const o = { id: s.id, t: s.t, n: s.n, a: s.a, b: s.b, u: s.u, m1: s.m1, m2: s.m2, e: s.e, hasKey: !!s.k, keyHint: '' };
  if (s.k) { try { const k = dec(s.k); o.keyHint = '…' + k.slice(-4); } catch (_) { o.keyHint = '（無法讀取，請重新貼上）'; } }
  return o;
}

function state(sub) {
  const cfg = getCfg(sub);
  if (!cfg) throw new Error('SESSION_EXPIRED');
  // 手動輸入到期自動重置
  let changed = false;
  const res = getJSON('r_' + sub) || {};
  cfg.slots.forEach(function (s) {
    if (s.t === 'MANUAL' && (rollOver(s.m1) | rollOver(s.m2))) { changed = true; res[s.id] = manualResult(s); }
  });
  if (changed) withLock(function () { setCfg(sub, cfg); setJSON('r_' + sub, res); });
  return { ok: true, email: cfg.email, slots: cfg.slots.map(publicSlot), results: res, lastRefresh: cfg.lastRefresh || 0 };
}

function num(v, d) { const n = Number(v); return isFinite(n) ? n : (d || 0); }
function clampPct(v) { return Math.min(100, Math.max(0, num(v, 100))); }
function cleanRow(m) {
  m = m || {};
  return { l: String(m.l || '').slice(0, 10), p: clampPct(m.p), r: m.r !== false, at: Math.max(0, num(m.at)), per: Math.max(0, num(m.per)) };
}

function saveService(sub, s) {
  withLock(function () {
    const cfg = getCfg(sub);
    const slot = cfg.slots[Number(s.id)];
    if (!slot) throw new Error('BAD_SLOT');
    const res = getJSON('r_' + sub) || {};
    const oldType = slot.t;
    if (TYPES.indexOf(s.t) >= 0) slot.t = s.t;
    if (s.n !== undefined) slot.n = String(s.n).trim().slice(0, 30);
    if (s.a !== undefined) slot.a = String(s.a).trim().slice(0, 100);
    if (s.b !== undefined) slot.b = Math.max(0, num(s.b));
    if (s.u !== undefined) slot.u = String(s.u).trim().slice(0, 500);
    if (s.m1) slot.m1 = cleanRow(s.m1);
    if (s.m2) slot.m2 = cleanRow(s.m2);
    if (s.e !== undefined) slot.e = !!s.e;
    if (s.clearKey) slot.k = '';
    else if (s.key && String(s.key).trim()) slot.k = enc(String(s.key).trim().slice(0, 500));
    if (oldType !== slot.t) delete res[slot.id];
    if (slot.t === 'MANUAL') res[slot.id] = manualResult(slot);
    setCfg(sub, cfg);
    setJSON('r_' + sub, res);
  });
  return state(sub);
}

function toggle(sub, id, on) {
  withLock(function () {
    const cfg = getCfg(sub);
    if (!cfg.slots[id]) throw new Error('BAD_SLOT');
    cfg.slots[id].e = on;
    setCfg(sub, cfg);
  });
  return state(sub);
}

/**
 * App 第一次登入時上傳手機上的設定：只補帳號裡「還沒設定過」的服務（跟預設一樣的才會被取代），
 * 金鑰只在帳號裡還沒有金鑰時才存。帳號裡已經有的設定一律為主，不會被覆蓋。
 */
function importLocal(sub, list) {
  withLock(function () {
    const cfg = getCfg(sub);
    const def = catalog();
    const res = getJSON('r_' + sub) || {};
    (Array.isArray(list) ? list : []).slice(0, def.length).forEach(function (s) {
      const id = Number(s && s.id);
      const slot = cfg.slots[id];
      if (!slot || TYPES.indexOf(s.t) < 0) return;
      const untouched = FIELDS.every(function (f) { return JSON.stringify(slot[f]) === JSON.stringify(def[id][f]); });
      if (untouched) {
        if (slot.t !== s.t) delete res[id];
        slot.t = s.t;
        if (s.n !== undefined) slot.n = String(s.n).trim().slice(0, 30);
        if (s.a !== undefined) slot.a = String(s.a).trim().slice(0, 100);
        if (s.b !== undefined) slot.b = Math.max(0, num(s.b));
        if (s.u !== undefined) slot.u = String(s.u).trim().slice(0, 500);
        if (s.m1) slot.m1 = cleanRow(s.m1);
        if (s.m2) slot.m2 = cleanRow(s.m2);
        if (s.e !== undefined) slot.e = !!s.e;
      }
      if (!slot.k && s.key && String(s.key).trim() && slot.t === s.t) slot.k = enc(String(s.key).trim().slice(0, 500));
      if (slot.t === 'MANUAL') { rollOver(slot.m1); rollOver(slot.m2); res[id] = manualResult(slot); }
    });
    setCfg(sub, cfg);
    setJSON('r_' + sub, res);
  });
  return state(sub);
}

function deleteMe(sub) {
  withLock(function () {
    const p = props();
    ['c_', 'r_', 'm_'].forEach(function (k) { p.deleteProperty(k + sub); });
    const all = p.getProperties();
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('s_') === 0 && all[k].split('|')[0] === sub) p.deleteProperty(k);
    });
    p.setProperty('users', users().filter(function (u) { return u !== sub; }).join(','));
  });
  return { ok: true };
}

// ====================== 手動輸入 ======================

function rollOver(m) {
  const now = Date.now();
  if (m.at > 0 && m.at <= now && m.per > 0) {
    const p = m.per * 3600000;
    while (m.at <= now) m.at += p;
    m.p = m.r ? 100 : 0;
    return true;
  }
  return false;
}

function manualResult(s) {
  const rows = [{ label: s.m1.l, percent: s.m1.p, remaining: s.m1.r, resetAt: s.m1.at }];
  if (s.m2 && String(s.m2.l).trim()) rows.push({ label: s.m2.l, percent: s.m2.p, remaining: s.m2.r, resetAt: s.m2.at });
  return { rows: rows, fetchedAt: Date.now() };
}

// ====================== 查詢各家 API ======================

function monthStartUTC(now) { const d = new Date(now); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }

/** 建立這個服務要發的請求。回傳 null 表示不用查（手動）或缺設定（以錯誤表示）。 */
function buildRequest(slot, key, now) {
  const bearer = { Authorization: 'Bearer ' + key };
  const start = monthStartUTC(now);
  switch (slot.t) {
    case 'OPENAI_COST':
      return { url: 'https://api.openai.com/v1/organization/costs?start_time=' + Math.floor(start.getTime() / 1000) + '&bucket_width=1d&limit=31', headers: bearer };
    case 'ANTHROPIC_COST':
      return { url: 'https://api.anthropic.com/v1/organizations/cost_report?starting_at=' + encodeURIComponent(start.toISOString().replace('.000Z', 'Z')) + '&bucket_width=1d&limit=31',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } };
    case 'DEEPSEEK_BALANCE': return { url: 'https://api.deepseek.com/user/balance', headers: bearer };
    case 'XAI_BALANCE':
      if (!slot.a) return { error: '尚未設定 Team ID' };
      return { url: 'https://management-api.x.ai/v1/billing/teams/' + encodeURIComponent(slot.a) + '/prepaid/balance', headers: bearer };
    case 'KIMI_BALANCE': return { url: 'https://api.moonshot.ai/v1/users/me/balance', headers: bearer, currency: 'USD' };
    case 'OPENROUTER_CREDITS': return { url: 'https://openrouter.ai/api/v1/credits', headers: bearer };
    case 'JSON_URL':
      if (!slot.u) return { error: '尚未設定網址' };
      return { url: slot.u, headers: key ? bearer : {} };
  }
  return null;
}

function friendlyHttp(code) {
  return code === 401 ? '金鑰無效或已過期 (401)' : code === 403 ? '沒有權限，需 Admin 金鑰 (403)'
    : code === 404 ? '網址不存在 (404)' : code === 429 ? '查詢太頻繁 (429)' : '伺服器錯誤 (' + code + ')';
}

function nums(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }

function parseResponse(slot, body, currency) {
  const j = JSON.parse(body);
  switch (slot.t) {
    case 'OPENAI_COST': {
      let sum = 0;
      (j.data || []).forEach(function (b) { (b.results || []).forEach(function (r) { sum += nums(r.amount && r.amount.value); }); });
      return { amount: sum, budget: slot.b };
    }
    case 'ANTHROPIC_COST': {
      let cents = 0;
      (j.data || []).forEach(function (b) { (b.results || []).forEach(function (r) { cents += nums(r.amount); }); });
      return { amount: cents / 100, budget: slot.b };
    }
    case 'DEEPSEEK_BALANCE': {
      const infos = j.balance_infos || [];
      if (!infos.length) return { balance: 0, currency: 'CNY', available: false, budget: slot.b || null };
      const best = infos.reduce(function (a, b) { return nums(b.total_balance) > nums(a.total_balance) ? b : a; });
      return { balance: nums(best.total_balance), currency: best.currency || 'CNY', available: j.is_available !== false, budget: slot.b || null };
    }
    case 'XAI_BALANCE': {
      if (!j.total) throw new Error('format');
      const usd = Math.abs(nums(j.total.val)) / 100;
      return { balance: usd, currency: 'USD', available: usd > 0, budget: slot.b || null };
    }
    case 'KIMI_BALANCE': {
      if (!j.data) throw new Error('format');
      const bal = nums(j.data.available_balance);
      return { balance: bal, currency: currency || 'USD', available: bal > 0, budget: slot.b || null };
    }
    case 'OPENROUTER_CREDITS': {
      if (!j.data) throw new Error('format');
      const total = nums(j.data.total_credits), left = total - nums(j.data.total_usage);
      return { balance: left, currency: 'USD', available: left > 0, budget: slot.b > 0 ? slot.b : (total > 0 ? total : null) };
    }
    case 'JSON_URL': {
      const rows = (j.rows || []).map(function (o) {
        return { label: String(o.label || ''), percent: nums(o.percent), remaining: String(o.mode || 'remaining').toLowerCase() !== 'used', resetAt: toEpochMs(o.resetAt) };
      });
      if (!rows.length && j.amount === undefined) throw new Error('format');
      return { rows: rows, amount: j.amount !== undefined ? nums(j.amount) : undefined, budget: j.budget !== undefined ? nums(j.budget) : undefined };
    }
  }
  throw new Error('format');
}

function toEpochMs(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) { const n = Number(v); return n < 1e11 ? n * 1000 : n; }
  const t = Date.parse(String(v)); return isFinite(t) ? t : 0;
}

/**
 * 一次平行查詢多位使用者的多個服務。jobs: [{sub, slot}]，回傳 {sub: {id: result}}。
 * Kimi 國際版失敗（401/403）會再試中國版。
 */
function runJobs(jobs, now) {
  const results = {};
  function put(job, r) { (results[job.sub] = results[job.sub] || {})[job.slot.id] = r; }
  let pending = [];
  jobs.forEach(function (job) {
    if (NEEDS_KEY.indexOf(job.slot.t) >= 0 && !job.slot.k) { put(job, { error: '尚未設定金鑰' }); return; }
    let key = '';
    try { key = job.slot.k ? dec(job.slot.k) : ''; } catch (_) { put(job, { error: '金鑰無法讀取，請重新貼上' }); return; }
    const rq = buildRequest(job.slot, key, now);
    if (!rq) return;
    if (rq.error) { put(job, { error: rq.error }); return; }
    pending.push({ job: job, rq: rq, key: key });
  });
  for (let round = 0; round < 2 && pending.length; round++) {
    const retry = [];
    for (let i = 0; i < pending.length; i += 50) {
      const chunk = pending.slice(i, i + 50);
      let responses;
      try {
        responses = UrlFetchApp.fetchAll(chunk.map(function (p) {
          return { url: p.rq.url, method: 'get', headers: p.rq.headers, muteHttpExceptions: true };
        }));
      } catch (err) {
        chunk.forEach(function (p) { put(p.job, { error: '連線失敗' }); });
        continue;
      }
      chunk.forEach(function (p, idx) {
        const res = responses[idx];
        const code = res.getResponseCode();
        if ((code === 401 || code === 403) && p.job.slot.t === 'KIMI_BALANCE' && p.rq.currency === 'USD') {
          retry.push({ job: p.job, key: p.key, rq: { url: 'https://api.moonshot.cn/v1/users/me/balance', headers: p.rq.headers, currency: 'CNY' } });
          return;
        }
        if (code < 200 || code >= 300) { put(p.job, { error: friendlyHttp(code) }); return; }
        try { put(p.job, parseResponse(p.job.slot, res.getContentText(), p.rq.currency)); }
        catch (_) { put(p.job, { error: '回傳格式看不懂' }); }
      });
    }
    pending = retry;
  }
  return results;
}

/** 合併新結果：失敗時保留上一次的數字，只標示錯誤。 */
function mergeResult(old, fresh, now) {
  if (fresh.error) {
    const r = Object.assign({}, old || {}, { error: fresh.error });
    if (!old) r.fetchedAt = 0;
    return r;
  }
  const r = Object.assign({ rows: [] }, fresh, { fetchedAt: now });
  delete r.error;
  return r;
}

function refreshUser(sub, onlyId) {
  const cfg = getCfg(sub);
  const now = Date.now();
  const jobs = cfg.slots
    .filter(function (s) { return s.t !== 'MANUAL' && (onlyId === undefined || onlyId === null ? s.e : s.id === Number(onlyId)); })
    .map(function (s) { return { sub: sub, slot: s }; });
  const fresh = runJobs(jobs, now)[sub] || {};
  withLock(function () {
    const res = getJSON('r_' + sub) || {};
    Object.keys(fresh).forEach(function (id) { res[id] = mergeResult(res[id], fresh[id], now); });
    const c2 = getCfg(sub);
    if (onlyId === undefined || onlyId === null) c2.lastRefresh = now;
    setJSON('r_' + sub, res);
    setCfg(sub, c2);
  });
  return state(sub);
}

/** 每 15 分鐘的排程：一次平行查詢所有最近有使用的人。 */
function refreshAllUsers() {
  const now = Date.now();
  const jobs = [];
  users().forEach(function (sub) {
    const m = getJSON('m_' + sub) || {};
    if (!m.seen || now - m.seen > STALE_DAYS * DAY) return;
    const cfg = getCfg(sub);
    if (!cfg) return;
    cfg.slots.forEach(function (s) { if (s.e && s.t !== 'MANUAL') jobs.push({ sub: sub, slot: s }); });
  });
  const fresh = runJobs(jobs, now);
  withLock(function () {
    users().forEach(function (sub) {
      const m = getJSON('m_' + sub) || {};
      if (!m.seen || now - m.seen > STALE_DAYS * DAY) return;
      const cfg = getCfg(sub);
      if (!cfg) return;
      const res = getJSON('r_' + sub) || {};
      const f = fresh[sub] || {};
      Object.keys(f).forEach(function (id) { res[id] = mergeResult(res[id], f[id], now); });
      cfg.slots.forEach(function (s) {
        if (s.t === 'MANUAL' && (rollOver(s.m1) | rollOver(s.m2))) res[s.id] = manualResult(s);
      });
      cfg.lastRefresh = now;
      setCfg(sub, cfg);
      setJSON('r_' + sub, res);
    });
    // 清掉過期的通行證（p_ 是舊版連結碼）
    const all = props().getProperties();
    Object.keys(all).forEach(function (k) {
      if ((k.indexOf('s_') === 0 || k.indexOf('p_') === 0) && now > Number(all[k].split('|')[1])) props().deleteProperty(k);
    });
  });
}

// ====================== 加密（金鑰不以明文保存） ======================
// HMAC-SHA256 計數器模式產生金鑰流 XOR，再加 HMAC 驗證；密鑰存在指令碼屬性 ENC_SECRET。

/** 32 個隨機位元組（由多個 UUID v4 雜湊而來；Apps Script 沒有直接的安全亂數 API）。 */
function randomBytes() {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid() + Date.now());
}

function secretBytes() {
  const s = props().getProperty('ENC_SECRET');
  if (!s) throw new Error('NOT_SETUP');
  return Utilities.base64Decode(s);
}

function hmac(str, key) { return Utilities.computeHmacSha256Signature(Utilities.newBlob(str).getBytes(), key); }

function xorStream(bytes, nonce, key) {
  const outB = [];
  for (let i = 0; i < bytes.length; i += 32) {
    const ks = hmac(nonce + ':' + (i / 32), key);
    for (let j = 0; j < 32 && i + j < bytes.length; j++) {
      let v = (bytes[i + j] ^ ks[j]) & 0xff;
      if (v > 127) v -= 256;
      outB.push(v);
    }
  }
  return outB;
}

function enc(plain) {
  const key = secretBytes();
  const nonce = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  const ct = Utilities.base64Encode(xorStream(Utilities.newBlob(plain).getBytes(), nonce, key));
  const mac = Utilities.base64Encode(hmac(nonce + ':' + ct, key).slice(0, 16));
  return 'v1:' + nonce + ':' + ct + ':' + mac;
}

function dec(s) {
  const parts = String(s).split(':');
  if (parts[0] !== 'v1' || parts.length !== 4) throw new Error('BAD_CIPHER');
  const key = secretBytes();
  if (Utilities.base64Encode(hmac(parts[1] + ':' + parts[2], key).slice(0, 16)) !== parts[3]) throw new Error('BAD_MAC');
  return Utilities.newBlob(xorStream(Utilities.base64Decode(parts[2]), parts[1], key)).getDataAsString();
}
