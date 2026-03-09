/**
 * gdrive.js — Shared Google Drive helper for CCY Travelog
 * Replace CLIENT_ID and API_KEY with your values from Google Cloud Console.
 */

const GDRIVE_CLIENT_ID = '377869285807-hkidh1sdvr3ph7cjtgrha82mmjr6p3pc.apps.googleusercontent.com';
const GDRIVE_API_KEY   = 'AIzaSyA75PrCkhOWUgE8uEtv4nyBc9I26Kru7Ms';
const GDRIVE_SCOPES    = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME      = 'ccy-travelog';

// ── State ─────────────────────────────────────────────────────────────────────
let _tokenClient    = null;
let _accessToken    = null;
let _rootFolderId   = null;
let _plansFolderId  = null;
let _imagesFolderId = null;
let _signedIn       = false;

const _signInCallbacks = [];
function onSignInChange(fn) { _signInCallbacks.push(fn); }
function _fire(v) {
  _signedIn = v;
  console.log('[gdrive] sign-in state:', v);
  _signInCallbacks.forEach(fn => { try { fn(v); } catch(e) { console.error('[gdrive] callback error', e); } });
}

// ── Token storage ─────────────────────────────────────────────────────────────
function _saveToken(token, expiresIn) {
  const expiry = Date.now() + (expiresIn || 3600) * 1000 - 120000; // 2 min safety buffer
  localStorage.setItem('gdrive_token', token);
  localStorage.setItem('gdrive_expiry', String(expiry));
}
function _getSavedToken() {
  const t = localStorage.getItem('gdrive_token');
  const e = parseInt(localStorage.getItem('gdrive_expiry') || '0');
  return (t && Date.now() < e) ? t : null;
}
function _clearToken() {
  localStorage.removeItem('gdrive_token');
  localStorage.removeItem('gdrive_expiry');
}

// ── Load Google scripts ───────────────────────────────────────────────────────
function loadGDrive() {
  return new Promise((resolve, reject) => {
    let gapiOk = false, gisOk = false;
    function check() { if (gapiOk && gisOk) resolve(); }

    // GAPI
    const s1 = document.createElement('script');
    s1.src = 'https://apis.google.com/js/api.js';
    s1.onerror = () => reject(new Error('Failed to load gapi'));
    s1.onload = () => {
      gapi.load('client', async () => {
        try {
          await gapi.client.init({
            apiKey: GDRIVE_API_KEY,
            discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'],
          });
          console.log('[gdrive] gapi ready');
          gapiOk = true; check();
        } catch(e) { console.error('[gdrive] gapi init failed', e); reject(e); }
      });
    };
    document.head.appendChild(s1);

    // GIS
    const s2 = document.createElement('script');
    s2.src = 'https://accounts.google.com/gsi/client';
    s2.onerror = () => reject(new Error('Failed to load GIS'));
    s2.onload = () => {
      try {
        _tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: GDRIVE_CLIENT_ID,
          scope: GDRIVE_SCOPES,
          callback: '', // set per-call below
        });
        console.log('[gdrive] GIS ready');
        gisOk = true; check();
      } catch(e) { console.error('[gdrive] GIS init failed', e); reject(e); }
    };
    document.head.appendChild(s2);
  });
}

// ── Sign in ───────────────────────────────────────────────────────────────────
function gdriveSignIn() {
  if (!_tokenClient) { alert('Google APIs still loading, please wait a moment.'); return; }
  // Assign callback fresh each call — avoids stale closure issues
  _tokenClient.callback = async (resp) => {
    if (resp.error) { console.error('[gdrive] token error:', resp); return; }
    _accessToken = resp.access_token;
    _saveToken(_accessToken, resp.expires_in);
    gapi.client.setToken({ access_token: _accessToken });
    console.log('[gdrive] signed in, setting up folders…');
    await _ensureFolders();
    console.log('[gdrive] folders ready, firing sign-in');
    _fire(true);
  };
  const saved = _getSavedToken();
  _tokenClient.requestAccessToken({ prompt: saved ? '' : 'select_account' });
}

// ── Sign out ──────────────────────────────────────────────────────────────────
function gdriveSignOut() {
  if (_accessToken) google.accounts.oauth2.revoke(_accessToken, () => {});
  _accessToken = null;
  gapi.client.setToken(null);
  _clearToken();
  _rootFolderId = _plansFolderId = _imagesFolderId = null;
  _fire(false);
}

function gdriveIsSignedIn() { return _signedIn; }

// ── Silent restore on page load ───────────────────────────────────────────────
async function gdriveRestore() {
  const saved = _getSavedToken();
  if (!saved) { console.log('[gdrive] no saved token to restore'); return; }
  console.log('[gdrive] restoring token from storage…');
  _accessToken = saved;
  gapi.client.setToken({ access_token: saved });
  try {
    await _ensureFolders();
    console.log('[gdrive] silent restore complete');
    _fire(true);
  } catch(e) {
    console.error('[gdrive] silent restore failed — token likely expired', e);
    _clearToken();
  }
}

// ── Folder setup ──────────────────────────────────────────────────────────────
async function _ensureFolders() {
  _rootFolderId   = await _getOrCreateFolder(FOLDER_NAME, null);
  _plansFolderId  = await _getOrCreateFolder('plans',  _rootFolderId);
  _imagesFolderId = await _getOrCreateFolder('images', _rootFolderId);
}

async function _getOrCreateFolder(name, parentId) {
  const q = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`;
  const res = await gapi.client.drive.files.list({ q, fields: 'files(id)', spaces: 'drive' });
  if (res.result.files?.length) { console.log('[gdrive] folder exists:', name); return res.result.files[0].id; }
  const c = await gapi.client.drive.files.create({
    resource: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : [] },
    fields: 'id',
  });
  console.log('[gdrive] created folder:', name);
  return c.result.id;
}

// ── Drive fetch ───────────────────────────────────────────────────────────────
async function _fetch(url, opts = {}) {
  const token = _accessToken;
  if (!token) throw new Error('[gdrive] no access token');
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers||{}) } });
  if (!r.ok) throw new Error(`[gdrive] HTTP ${r.status}: ${await r.text()}`);
  return r;
}

// ── JSON helpers ──────────────────────────────────────────────────────────────
async function driveListPlans() {
  if (!_plansFolderId) { console.warn('[gdrive] driveListPlans: no folder'); return []; }
  const res = await gapi.client.drive.files.list({
    q: `'${_plansFolderId}' in parents and name contains '.json' and trashed=false`,
    fields: 'files(id,name,modifiedTime)', spaces: 'drive', orderBy: 'modifiedTime desc',
  });
  return res.result.files || [];
}

async function driveReadJSON(fileId) {
  const r = await _fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return await r.json();
}

async function driveWriteJSON(filename, data) {
  if (!_plansFolderId) { console.warn('[gdrive] driveWriteJSON: no folder'); return; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const existing = await _findFile(filename, _plansFolderId);
  await _upload(existing?.id || null, filename, blob, 'application/json', !existing, _plansFolderId);
  console.log('[gdrive] wrote:', filename);
}

async function driveDeleteJSON(filename) {
  if (!_plansFolderId) return;
  const f = await _findFile(filename, _plansFolderId);
  if (f) await gapi.client.drive.files.delete({ fileId: f.id });
}

// ── Image helpers ─────────────────────────────────────────────────────────────
async function driveWriteImage(filename, blob) {
  if (!_imagesFolderId) { console.warn('[gdrive] driveWriteImage: no folder'); return null; }
  const existing = await _findFile(filename, _imagesFolderId);
  const r = await _upload(existing?.id||null, filename, blob, blob.type, !existing, _imagesFolderId);
  return r.id || existing?.id;
}

async function driveReadImage(fileId) {
  try { const r = await _fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`); return _toDataURL(await r.blob()); }
  catch(e) { console.warn('[gdrive] image read error:', e); return null; }
}

async function driveDeleteImage(filename) {
  if (!_imagesFolderId) return;
  const f = await _findFile(filename, _imagesFolderId);
  if (f) await gapi.client.drive.files.delete({ fileId: f.id });
}

async function driveFindImage(filename) {
  if (!_imagesFolderId) return null;
  const f = await _findFile(filename, _imagesFolderId);
  return f ? f.id : null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
async function _findFile(name, folderId) {
  const res = await gapi.client.drive.files.list({
    q: `name='${name}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id,name)', spaces: 'drive',
  });
  return res.result.files?.[0] || null;
}

async function _upload(fileId, name, blob, mimeType, isCreate, parentId) {
  const meta = isCreate ? { name, mimeType, parents: [parentId] } : { name, mimeType };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', blob);
  const url = isCreate
    ? 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name'
    : `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,name`;
  const r = await fetch(url, { method: isCreate ? 'POST' : 'PATCH', headers: { Authorization: `Bearer ${_accessToken}` }, body: form });
  return await r.json();
}

function _toDataURL(blob) {
  return new Promise(res => { const r = new FileReader(); r.onload = e => res(e.target.result); r.readAsDataURL(blob); });
}

function slugify(title) {
  return (title||'untitled').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'untitled';
}
