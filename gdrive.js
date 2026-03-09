/**
 * gdrive.js — Shared Google Drive helper for CCY Travelog
 * Replace the two values below with your own from Google Cloud Console.
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
let _driveReady     = false;

const _signInCallbacks = [];
function onSignInChange(fn) { _signInCallbacks.push(fn); }
function _fireSignInChange(v) {
  _signedIn = v;
  console.log('[gdrive] _fireSignInChange:', v);
  _signInCallbacks.forEach(fn => { try { fn(v); } catch(e) { console.error('[gdrive] callback error', e); } });
}

// ── Bootstrap: load Google scripts ───────────────────────────────────────────
function loadGDrive() {
  return new Promise((resolve, reject) => {
    let gapiLoaded = false;
    let gisLoaded  = false;

    function maybeResolve() {
      if (gapiLoaded && gisLoaded) {
        _driveReady = true;
        console.log('[gdrive] both scripts ready');
        resolve();
      }
    }

    // 1. Load GAPI client
    const gapiScript = document.createElement('script');
    gapiScript.src = 'https://apis.google.com/js/api.js';
    gapiScript.onerror = () => reject(new Error('Failed to load gapi'));
    gapiScript.onload = () => {
      gapi.load('client', async () => {
        try {
          await gapi.client.init({
            apiKey: GDRIVE_API_KEY,
            discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'],
          });
          console.log('[gdrive] gapi client ready');
          gapiLoaded = true;
          maybeResolve();
        } catch(e) {
          console.error('[gdrive] gapi init error:', e);
          reject(e);
        }
      });
    };
    document.head.appendChild(gapiScript);

    // 2. Load Google Identity Services
    const gisScript = document.createElement('script');
    gisScript.src = 'https://accounts.google.com/gsi/client';
    gisScript.onerror = () => reject(new Error('Failed to load GIS'));
    gisScript.onload = () => {
      try {
        _tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: GDRIVE_CLIENT_ID,
          scope: GDRIVE_SCOPES,
          // GIS callback must NOT be async — wrap it
          callback: (response) => { _handleTokenResponse(response); },
        });
        console.log('[gdrive] GIS token client ready');
        gisLoaded = true;
        maybeResolve();
      } catch(e) {
        console.error('[gdrive] GIS init error:', e);
        reject(e);
      }
    };
    document.head.appendChild(gisScript);
  });
}

// ── Token response handler ────────────────────────────────────────────────────
async function _handleTokenResponse(response) {
  console.log('[gdrive] token response received', response);
  if (response.error) {
    console.error('[gdrive] auth error:', response.error, response.error_description);
    return;
  }
  _accessToken = response.access_token;
  gapi.client.setToken({ access_token: _accessToken });
  console.log('[gdrive] token set — firing sign-in immediately');

  // Fire UI update immediately so button changes right away
  _fireSignInChange(true);

  // Set up folders in background
  try {
    await _ensureFolders();
    console.log('[gdrive] folders ready');
  } catch(e) {
    console.error('[gdrive] folder setup error:', e);
  }
}

// ── Sign in / out ─────────────────────────────────────────────────────────────
function gdriveSignIn() {
  if (!_tokenClient) {
    console.warn('[gdrive] tokenClient not ready yet');
    alert('Still loading Google APIs, please try again in a moment.');
    return;
  }
  console.log('[gdrive] requesting access token...');
  _tokenClient.requestAccessToken({ prompt: 'select_account' });
}

function gdriveSignOut() {
  if (_accessToken) {
    google.accounts.oauth2.revoke(_accessToken, () => {
      console.log('[gdrive] token revoked');
    });
  }
  _accessToken = null;
  gapi.client.setToken(null);
  _rootFolderId = _plansFolderId = _imagesFolderId = null;
  _fireSignInChange(false);
}

function gdriveIsSignedIn() { return _signedIn; }
function gdriveAreFoldersReady() { return !!(_plansFolderId && _imagesFolderId); }

// ── Folder helpers ────────────────────────────────────────────────────────────
async function _getOrCreateFolder(name, parentId) {
  const q = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`;

  const res = await gapi.client.drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive' });
  if (res.result.files && res.result.files.length > 0) {
    console.log('[gdrive] found folder:', name, res.result.files[0].id);
    return res.result.files[0].id;
  }
  const created = await gapi.client.drive.files.create({
    resource: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : [] },
    fields: 'id',
  });
  console.log('[gdrive] created folder:', name, created.result.id);
  return created.result.id;
}

async function _ensureFolders() {
  _rootFolderId   = await _getOrCreateFolder(FOLDER_NAME, null);
  _plansFolderId  = await _getOrCreateFolder('plans',  _rootFolderId);
  _imagesFolderId = await _getOrCreateFolder('images', _rootFolderId);
}

// ── Drive fetch helper ────────────────────────────────────────────────────────
async function _driveFetch(url, options = {}) {
  const token = _accessToken || gapi.client.getToken()?.access_token;
  if (!token) throw new Error('No access token');
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive API error ${res.status}: ${text}`);
  }
  return res;
}

// ── JSON helpers ──────────────────────────────────────────────────────────────
async function driveListPlans() {
  if (!_plansFolderId) return [];
  const res = await gapi.client.drive.files.list({
    q: `'${_plansFolderId}' in parents and name contains '.json' and trashed=false`,
    fields: 'files(id,name,modifiedTime)',
    spaces: 'drive',
    orderBy: 'modifiedTime desc',
  });
  return res.result.files || [];
}

async function driveReadJSON(fileId) {
  const res = await _driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return await res.json();
}

async function driveWriteJSON(filename, data) {
  if (!_plansFolderId) throw new Error('Drive folders not ready');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const existing = await _findFile(filename, _plansFolderId);
  await _uploadFile(existing?.id || null, filename, blob, 'application/json', !existing, _plansFolderId);
}

async function driveDeleteJSON(filename) {
  if (!_plansFolderId) return;
  const file = await _findFile(filename, _plansFolderId);
  if (file) await gapi.client.drive.files.delete({ fileId: file.id });
}

// ── Image helpers ─────────────────────────────────────────────────────────────
async function driveWriteImage(filename, blob) {
  if (!_imagesFolderId) throw new Error('Drive folders not ready');
  const existing = await _findFile(filename, _imagesFolderId);
  const result = await _uploadFile(existing?.id || null, filename, blob, blob.type, !existing, _imagesFolderId);
  return result.id || existing?.id;
}

async function driveReadImage(fileId) {
  try {
    const res = await _driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    const blob = await res.blob();
    return await _blobToDataURL(blob);
  } catch(e) { console.warn('[gdrive] image read error:', e); return null; }
}

async function driveDeleteImage(filename) {
  if (!_imagesFolderId) return;
  const file = await _findFile(filename, _imagesFolderId);
  if (file) await gapi.client.drive.files.delete({ fileId: file.id });
}

async function driveFindImage(filename) {
  if (!_imagesFolderId) return null;
  const file = await _findFile(filename, _imagesFolderId);
  return file ? file.id : null;
}

// ── File utilities ────────────────────────────────────────────────────────────
async function _findFile(name, folderId) {
  const q = `name='${name}' and '${folderId}' in parents and trashed=false`;
  const res = await gapi.client.drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive' });
  return res.result.files?.[0] || null;
}

async function _uploadFile(fileId, name, blob, mimeType, isCreate, parentId) {
  const token = _accessToken || gapi.client.getToken()?.access_token;
  const metadata = isCreate
    ? { name, mimeType, parents: [parentId] }
    : { name, mimeType };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);
  const url = isCreate
    ? 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name'
    : `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,name`;
  const res = await fetch(url, {
    method: isCreate ? 'POST' : 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return await res.json();
}

function _blobToDataURL(blob) {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.readAsDataURL(blob);
  });
}

function slugify(title) {
  return (title || 'untitled').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}
