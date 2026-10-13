// Border Beats – TikTok helper
//
// A small program that runs on your own PC (nothing to install: Node.js only). It
//   • serves Border Beats at http://127.0.0.1:8743/ (open it from there to post),
//   • does "Log in with TikTok" (TikTok's own login page; your password never touches this program),
//   • keeps your app keys and login in files next to it (tiktok-keys.json, tiktok-login.json),
//   • uploads finished videos to your TikTok account with their captions.
// The web page never sees your keys or login; it only talks to this helper.
//
// Start it with "Start Border Beats.bat" (or: node tiktok-helper.js). Stop it with Ctrl+C.
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = Number(process.env.BB_PORT) || 8743;
const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:${PORT}`;
const REDIRECT_URI = `${ORIGIN}/callback/`;          // register exactly this in the TikTok developer portal
const DIR = __dirname;
const DATA = process.env.BB_DATA_DIR || DIR;
const KEYS_FILE = path.join(DATA, 'tiktok-keys.json');
const LOGIN_FILE = path.join(DATA, 'tiktok-login.json');
const TMP = path.join(os.tmpdir(), 'border-beats-uploads');
const AUTH_URL = process.env.TIKTOK_AUTH_URL || 'https://www.tiktok.com/v2/auth/authorize/';
const API = (process.env.TIKTOK_API_BASE || 'https://open.tiktokapis.com').replace(/\/$/, '');
const SCOPES = 'user.info.basic,video.publish,video.upload';
const CHUNK = 10_000_000;                             // 10 MB chunks for files over 64 MB (TikTok: 5–64 MB)
const VERSION = 1;

// ---------------------------------------------------------------- keys and login (local files)
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function keys() {
  const k = readJSON(KEYS_FILE);
  const key = (k && String(k.client_key || '').trim()) || '';
  const secret = (k && String(k.client_secret || '').trim()) || '';
  if (!key || !secret || /PASTE/i.test(key + secret)) return null;
  return { key, secret };
}
function ensureKeysTemplate() {
  if (fs.existsSync(KEYS_FILE)) return;
  fs.writeFileSync(KEYS_FILE, JSON.stringify({
    client_key: 'PASTE_YOUR_CLIENT_KEY_HERE',
    client_secret: 'PASTE_YOUR_CLIENT_SECRET_HERE',
    note: 'From developers.tiktok.com > Manage apps > your app (use the Sandbox keys while testing). Keep this file private.',
  }, null, 2));
}
let login = readJSON(LOGIN_FILE);                     // { access_token, refresh_token, open_id, scope, expires_at, refresh_expires_at, user }
function saveLogin(l) {
  login = l;
  if (l) fs.writeFileSync(LOGIN_FILE, JSON.stringify(l, null, 2), { mode: 0o600 });
  else fs.rmSync(LOGIN_FILE, { force: true });
}

// ---------------------------------------------------------------- TikTok API calls
async function tiktokForm(pathname, form) {
  const res = await fetch(API + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams(form).toString(),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || data.error) {
    const err = new Error(data.error_description || data.error || `TikTok answered ${res.status}`);
    err.code = data.error || `http_${res.status}`;
    throw err;
  }
  return data;
}
async function tiktokJSON(pathname, body, method = 'POST', retried = false) {
  const token = await accessToken();
  const res = await fetch(API + pathname, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  const e = data.error || {};
  if (!res.ok || (e.code && e.code !== 'ok')) {
    const err = new Error(friendly(e.code, e.message || `TikTok answered ${res.status}`));
    err.code = e.code || `http_${res.status}`;
    err.status = res.status;
    if (err.code === 'access_token_invalid' && !retried && login) {   // renew once, then try again
      await accessToken(true);
      return tiktokJSON(pathname, body, method, true);
    }
    throw err;
  }
  return data.data || {};
}
function friendly(code, fallback) {
  return ({
    spam_risk_too_many_posts: 'TikTok says this account has posted the most it can for today. Try again tomorrow.',
    spam_risk_user_banned_from_posting: 'TikTok says this account can’t post right now.',
    reached_active_user_cap: 'The daily limit of people posting through this app is reached. Try again tomorrow.',
    unaudited_client_can_only_post_to_private_accounts: 'Your TikTok app isn’t approved by TikTok yet, so posts must be "Only me" and your TikTok account must be set to private while posting.',
    privacy_level_option_mismatch: 'That privacy choice isn’t allowed for this account right now.',
    access_token_invalid: 'The TikTok login ran out. Log in again.',
    scope_not_authorized: 'The TikTok login is missing posting permission. Log out, then log in again and allow posting.',
    rate_limit_exceeded: 'TikTok asks to slow down. Waiting a moment…',
    url_ownership_unverified: 'TikTok wants the app’s website verified for this kind of upload.',
  })[code] || fallback;
}
let refreshing = null;                                // one renewal at a time; everyone else waits for it
async function accessToken(force = false) {
  if (!login) { const e = new Error('Not logged in to TikTok.'); e.code = 'not_logged_in'; throw e; }
  if (!force && Date.now() < login.expires_at - 5 * 60_000) return login.access_token;
  if (!refreshing) refreshing = renew().finally(() => { refreshing = null; });
  return refreshing;
}
async function renew() {
  const k = keys();
  if (!k) { const e = new Error('The app keys are missing.'); e.code = 'no_keys'; throw e; }
  const was = login;
  try {
    const t = await tiktokForm('/v2/oauth/token/', {
      client_key: k.key, client_secret: k.secret, grant_type: 'refresh_token', refresh_token: was.refresh_token,
    });
    saveLogin({ ...was, ...tokenFields(t) });       // TikTok may hand out a new refresh token: always keep the newest
    return login.access_token;
  } catch (e) {
    if (/^(invalid_grant|invalid_request|invalid_client|access_denied)$/.test(e.code || '')) {   // TikTok said no: log in again
      saveLogin(null);
      const err = new Error('The TikTok login ran out. Log in again.');
      err.code = 'not_logged_in';
      throw err;
    }
    const err = new Error('TikTok couldn’t be reached to renew the login. Check the internet connection and try again.');
    err.code = 'network';                            // keep the login: it may well still be good
    throw err;
  }
}
function tokenFields(t) {
  return {
    access_token: t.access_token, refresh_token: t.refresh_token, open_id: t.open_id, scope: t.scope,
    expires_at: Date.now() + (Number(t.expires_in) || 86400) * 1000,
    refresh_expires_at: Date.now() + (Number(t.refresh_expires_in) || 31536000) * 1000,
  };
}
async function userInfo() {
  const d = await tiktokJSON('/v2/user/info/?fields=open_id,avatar_url,display_name', null, 'GET');   // user.info.basic fields
  return d.user || {};
}

// ---------------------------------------------------------------- login flow (PKCE, TikTok's hex variant)
const pending = new Map();                             // state -> { verifier, at }
function startLogin() {
  const k = keys();
  if (!k) return null;
  for (const [s, v] of pending) if (Date.now() - v.at > 15 * 60_000) pending.delete(s);
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(48).toString('base64url');            // 64 unreserved characters
  const challenge = crypto.createHash('sha256').update(verifier).digest('hex');   // TikTok wants hex, not base64url
  pending.set(state, { verifier, at: Date.now() });
  const q = new URLSearchParams({
    client_key: k.key, response_type: 'code', scope: SCOPES, redirect_uri: REDIRECT_URI,
    state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${q}`;
}
async function finishLogin(query) {
  const state = query.get('state') || '';
  const p = pending.get(state);
  pending.delete(state);
  if (query.get('error')) throw new Error(query.get('error_description') || query.get('error'));
  if (!p) throw new Error('This login link is old or was already used. Start the login again.');
  const k = keys();
  if (!k) throw new Error('The app keys are missing.');
  const t = await tiktokForm('/v2/oauth/token/', {
    client_key: k.key, client_secret: k.secret, code: query.get('code') || '', grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI, code_verifier: p.verifier,
  });
  const granted = String(t.scope || '').split(',');
  if (!granted.includes('video.publish') && !granted.includes('video.upload')) {
    const k2 = keys();
    try { await tiktokForm('/v2/oauth/revoke/', { client_key: k2.key, client_secret: k2.secret, token: t.access_token }); } catch (e) { /* ignore */ }
    throw new Error('The login worked, but posting wasn’t allowed. Log in again and keep the switch for posting videos turned on.');
  }
  saveLogin(tokenFields(t));
  try { saveLogin({ ...login, user: await userInfo() }); } catch (e) { /* the name can come later */ }
  return login;
}
async function logout() {
  const k = keys();
  if (login && k) {
    try { await tiktokForm('/v2/oauth/revoke/', { client_key: k.key, client_secret: k.secret, token: login.access_token }); } catch (e) { /* forget it anyway */ }
  }
  saveLogin(null);
}

// ---------------------------------------------------------------- uploads
const files = new Map();                               // fileId -> { path, size, at }
async function receiveFile(req) {
  await fsp.mkdir(TMP, { recursive: true });
  const id = crypto.randomBytes(12).toString('hex');
  const file = path.join(TMP, `${id}.mp4`);
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      let done = false;
      req.pipe(out);
      req.on('error', reject);
      req.on('aborted', () => reject(new Error('The video didn’t arrive completely.')));
      req.on('close', () => { if (!done && !req.complete) reject(new Error('The video didn’t arrive completely.')); });
      out.on('error', reject);
      out.on('finish', () => { done = true; resolve(); });
    });
  } catch (e) {
    await fsp.rm(file, { force: true }).catch(() => {});
    throw e;
  }
  const size = (await fsp.stat(file)).size;
  if (size < 1000) { await fsp.rm(file, { force: true }); throw new Error('The video file arrived empty.'); }
  files.set(id, { path: file, size, at: Date.now() });
  return { fileId: id, size };
}
function chunkPlan(size) {
  if (size <= 64_000_000) return { chunk_size: size, total_chunk_count: 1 };   // up to 64 MB: one piece
  return { chunk_size: CHUNK, total_chunk_count: Math.floor(size / CHUNK) };        // the remainder rides on the last chunk
}
async function putChunks(uploadUrl, file, size, plan) {
  const fh = await fsp.open(file, 'r');
  try {
    for (let i = 0; i < plan.total_chunk_count; i++) {
      const start = i * plan.chunk_size;
      const end = i === plan.total_chunk_count - 1 ? size - 1 : start + plan.chunk_size - 1;
      const buf = Buffer.alloc(end - start + 1);
      await fh.read(buf, 0, buf.length, start);
      let res = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          res = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${size}` },
            body: buf,
          });
        } catch (e) { res = null; }                     // the connection dropped: send this part again
        if (res && res.status < 500) break;
        await sleep(2000 * (attempt + 1));
      }
      if (!res) { const e = new Error('The connection to TikTok kept dropping during the upload. Try again.'); e.code = 'upload_network'; throw e; }
      if (![200, 201, 206].includes(res.status)) {
        const e = new Error(res.status === 403 ? 'The upload link expired. Try posting again.' : `TikTok refused part ${i + 1} of the upload (${res.status}).`);
        e.code = `upload_${res.status}`;
        throw e;
      }
    }
  } finally {
    await fh.close();
  }
}
async function publish(job) {
  const f = files.get(job.fileId);
  if (!f) { const e = new Error('The video isn’t on the helper any more. Try again.'); e.code = 'no_file'; throw e; }
  if (job.mode !== 'inbox') cleanPostInfo(job.post_info);   // a form problem: refused before TikTok, the video stays
  try {
    return await publishFile(f, job);
  } finally {                                           // posted or not, the temporary copy goes
    files.delete(job.fileId);
    await fsp.rm(f.path, { force: true }).catch(() => {});
  }
}
async function publishFile(f, { mode, post_info }) {
  const plan = chunkPlan(f.size);
  const source_info = { source: 'FILE_UPLOAD', video_size: f.size, ...plan };
  let init;
  for (let attempt = 0; ; attempt++) {
    try {
      init = mode === 'inbox'
        ? await tiktokJSON('/v2/post/publish/inbox/video/init/', { source_info })
        : await tiktokJSON('/v2/post/publish/video/init/', { post_info: cleanPostInfo(post_info), source_info });
      break;
    } catch (e) {
      if (e.code === 'rate_limit_exceeded' && attempt < 4) { await sleep(15000); continue; }
      throw e;
    }
  }
  try {
    await putChunks(init.upload_url, f.path, f.size, plan);
  } catch (e) {
    if (e.code !== 'upload_403' && e.code !== 'upload_416') throw e;
    // The link expired, or TikTok lost track of the parts: one fresh start
    init = mode === 'inbox'
      ? await tiktokJSON('/v2/post/publish/inbox/video/init/', { source_info })
      : await tiktokJSON('/v2/post/publish/video/init/', { post_info: cleanPostInfo(post_info), source_info });
    await putChunks(init.upload_url, f.path, f.size, plan);
  }
  return { publish_id: init.publish_id };
}
// Only the fields TikTok accepts, in the right types (the page builds them from the person's own choices)
function cleanPostInfo(p = {}) {
  const title = String(p.title || '');
  if (title.length > 2200) { const e = new Error('The caption is longer than TikTok allows (2200 characters).'); e.code = 'title_too_long'; throw e; }
  const out = {
    title,
    privacy_level: String(p.privacy_level || ''),
    disable_comment: p.disable_comment !== false,       // off unless the person turned it on
    disable_duet: p.disable_duet !== false,
    disable_stitch: p.disable_stitch !== false,
    brand_content_toggle: !!p.brand_content_toggle,
    brand_organic_toggle: !!p.brand_organic_toggle,
  };
  if (!out.privacy_level) { const e = new Error('Choose who can see the video first.'); e.code = 'no_privacy'; throw e; }
  return out;
}
// Old temporary uploads are cleared away
setInterval(async () => {
  for (const [id, f] of files) if (Date.now() - f.at > 3 * 3600_000) { files.delete(id); fsp.rm(f.path, { force: true }).catch(() => {}); }
}, 600_000).unref();

// ---------------------------------------------------------------- web server
const sleep = ms => new Promise(r => setTimeout(r, ms));
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function page(title, text, closeAfter) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07080f;color:#eef1fa;font:16px/1.5 "Segoe UI",system-ui,sans-serif}
main{max-width:420px;padding:28px;border:1px solid rgba(255,255,255,.1);border-radius:18px;background:#0e101a;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#97a0b6;margin:0}</style>
<main><h1>${esc(title)}</h1><p>${esc(text)}</p></main>${closeAfter ? `<script>setTimeout(()=>{if(window.opener&&!window.opener.closed)window.close();else location.href='/'},${closeAfter})</script>` : ''}`;   // a popup closes; a tab goes back to Border Beats
}
// Only this PC's own page may use the API (guards against other websites poking at the helper)
function allowedApi(req) {
  const host = String(req.headers.host || '');
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return false;
  const origin = req.headers.origin;
  if (origin && origin !== ORIGIN && origin !== `http://localhost:${PORT}`) return false;
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false;
  return req.headers['x-border-beats'] === '1';
}
async function readBody(req, limit = 1e6) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > limit) throw new Error('Too large'); }
  return s ? JSON.parse(s) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  try {
    // The app itself
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const host = String(req.headers.host || '');
      if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return send(res, 400, 'Bad host', 'text/plain');
      return send(res, 200, fs.readFileSync(path.join(DIR, 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && p === '/favicon.ico') return send(res, 204, '');

    // Login
    if (req.method === 'GET' && p === '/auth/login') {
      const to = startLogin();
      if (!to) return send(res, 200, page('App keys missing', `Put your TikTok app's client key and secret in ${KEYS_FILE}, then try again.`), 'text/html; charset=utf-8');
      res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (req.method === 'GET' && p === '/callback/') {
      try {
        const l = await finishLogin(url.searchParams);
        const name = (l.user && (l.user.display_name || l.user.username)) || 'your account';
        return send(res, 200, page('Logged in to TikTok', `Border Beats can now post to ${name}. This tab closes by itself.`, 1800), 'text/html; charset=utf-8');
      } catch (e) {
        return send(res, 200, page('TikTok login didn’t work', e.message), 'text/html; charset=utf-8');
      }
    }

    // API for the page
    if (p.startsWith('/api/')) {
      if (!allowedApi(req)) return send(res, 403, { ok: false, message: 'Not allowed' });
      if (req.method === 'GET' && p === '/api/tiktok/status') {
        let user = login && login.user;
        if (login && !user) { try { user = await userInfo(); saveLogin({ ...login, user }); } catch (e) { /* shown as unknown */ } }
        return send(res, 200, {
          ok: true, version: VERSION, configured: !!keys(), loggedIn: !!login, user: login ? (user || {}) : null,
          scopes: login ? String(login.scope || '').split(',').filter(Boolean) : [], redirectUri: REDIRECT_URI, keysFile: KEYS_FILE,
          canDirect: !!login && String(login.scope || '').split(',').includes('video.publish'),
          canInbox: !!login && String(login.scope || '').split(',').includes('video.upload'),
        });
      }
      if (req.method === 'POST' && p === '/api/tiktok/logout') { await logout(); return send(res, 200, { ok: true }); }
      if (req.method === 'GET' && p === '/api/tiktok/creator') {
        return send(res, 200, { ok: true, creator: await tiktokJSON('/v2/post/publish/creator_info/query/', {}) });
      }
      if (req.method === 'POST' && p === '/api/tiktok/file') return send(res, 200, { ok: true, ...(await receiveFile(req)) });
      if (req.method === 'POST' && p === '/api/tiktok/publish') return send(res, 200, { ok: true, ...(await publish(await readBody(req))) });
      if (req.method === 'GET' && p === '/api/tiktok/publish-status') {
        const d = await tiktokJSON('/v2/post/publish/status/fetch/', { publish_id: url.searchParams.get('id') || '' });
        return send(res, 200, { ok: true, status: d.status, fail_reason: d.fail_reason || '', post_ids: d.publicaly_available_post_id || [] });
      }
      return send(res, 404, { ok: false, message: 'Unknown' });
    }
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    send(res, 200, { ok: false, code: e.code || 'error', message: e.message || String(e) });
  }
});

ensureKeysTemplate();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* nothing left over */ }
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.log(`\nThe helper already runs (port ${PORT} is taken). Open ${ORIGIN}/ in your browser.\n`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`\n  Border Beats is running at ${ORIGIN}/`);
  console.log(`  TikTok login redirect URI (register it in the developer portal): ${REDIRECT_URI}`);
  console.log(keys() ? '  App keys: found.' : `  App keys: missing – put them in ${KEYS_FILE}`);
  console.log(login ? '  TikTok: logged in.' : '  TikTok: not logged in yet.');
  console.log('  Keep this window open while you use Border Beats. Ctrl+C stops it.\n');
  if (!process.env.BB_NO_OPEN) {
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', `${ORIGIN}/`]);
    else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [`${ORIGIN}/`]);
  }
});
