/**
 * gdrive.js — Shared Google Drive helper for CCY Travelog
 *
 * SETUP: Replace CLIENT_ID and API_KEY with your own from Google Cloud Console.
 * See SETUP.md for step-by-step instructions.
 */

const GDRIVE_CLIENT_ID = '377869285807-hkidh1sdvr3ph7cjtgrha82mmjr6p3pc.apps.googleusercontent.com';
const GDRIVE_API_KEY   = 'AIzaSyA75PrCkhOWUgE8uEtv4nyBc9I26Kru7Ms';
const GDRIVE_SCOPES    = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME      = 'ccy-travelog';

// ── State ────────────────────────────────────────────────────────────────────
let _gapiReady   = false;
let _gisReady    = false;
let _tokenClient = null;
let _rootFolderId  = null;
let _plansFolderId = null;
let _imagesFolderId = null;
let _signedIn    = false;

// Callbacks registered by the page
const _onSignInChange = [];
function onSignInChange(fn) { _onSignInChange.push(fn); }
function _fireSignInChange(v) { _signedIn = v; _onSignInChange.forEach(fn => fn(v)); }

// ── Load GAPI + GIS scripts ──────────────────────────────────────────────────
function loadGDrive() {
  return new Promise((resolve) => {
    let gapiDone = false;
    let gisDone  = false;
    function checkBothReady() { if (gapiDone && gisDone) resolve(); }

    // Load gapi
    const gapiScript = document.createElement('script');
    gapiScript.src = 'https://apis.google.com/js/api.js';
    gapiScript.onload = () => {
      gapi.load('client', async () => {
        await gapi.client.init({
          apiKey: GDRIVE_API_KEY,
          discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'],
        });
        _gapiReady = true;
        gapiDone = true;
        checkBothReady();
      });
    };
    document.head.appendChild(gapiScript);

    // Load GIS token client
    const gisScript = document.createElement('script');
    gisScript.src = 'https://accounts.google.com/gsi/client';
    gisScript.onload = () => {
      _tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GDRIVE_CLIENT_ID,
        scope: GDRIVE_SCOPES,
        callback: async (response) => {
          if (response.error) { console.error('GIS error', response); return; }
          // Explicitly set the token on gapi.client so Drive API calls work
          gapi.client.setToken({ access_token: response.access_token });
          await _ensureFolders();
          _fireSignInChange(true);
        },
      });
      _gisReady = true;
      gisDone = true;
      checkBothReady();
    };
    document.head.appendChild(gisScript);
  });
}

// ── Sign in / out ────────────────────────────────────────────────────────────
async function gdriveSignIn() {
  if (!_tokenClient) { console.warn('GIS not ready'); return; }
  // Use empty prompt if we already have a token (silent re-auth), otherwise show account picker
  const hasToken = gapi.client.getToken();
  _tokenClient.requestAccessToken({ prompt: hasToken ? '' : 'select_account' });
}

function gdriveSignOut() {
  const token = gapi.client.getToken();
  if (token) {
    google.accounts.oauth2.revoke(token.access_token);
    gapi.client.setToken(null);
  }
  _rootFolderId = _plansFolderId = _imagesFolderId = null;
  _fireSignInChange(false);
}

function gdriveIsSignedIn() { return _signedIn; }

// ── Folder bootstrap ─────────────────────────────────────────────────────────
async function _getOrCreateFolder(name, parentId) {
  const q = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`;

  const res = await gapi.client.drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive' });
  if (res.result.files.length > 0) return res.result.files[0].id;

  const created = await gapi.client.drive.files.create({
    resource: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : [],
    },
    fields: 'id',
  });
  return created.result.id;
}

async function _ensureFolders() {
  _rootFolderId   = await _getOrCreateFolder(FOLDER_NAME, null);
  _plansFolderId  = await _getOrCreateFolder('plans',  _rootFolderId);
  _imagesFolderId = await _getOrCreateFolder('images', _rootFolderId);
}

// ── JSON file helpers ─────────────────────────────────────────────────────────

/** List all .json files in plans/ → [{ id, name }] */
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

/** Read a JSON file by Drive file ID */
async function driveReadJSON(fileId) {
  const token = gapi.client.getToken()?.access_token;
  // Use fetch directly for reliable media download
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Drive read failed: ${res.status}`);
  return await res.json();
}

/** Write (create or update) a JSON file in plans/ */
async function driveWriteJSON(filename, data) {
  if (!_plansFolderId) throw new Error('Drive not ready');
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });

  // Check if file already exists
  const existing = await _findFile(filename, _plansFolderId);

  if (existing) {
    // Update content via multipart upload
    await _uploadFile(existing.id, filename, blob, 'application/json', false);
  } else {
    await _uploadFile(null, filename, blob, 'application/json', true, _plansFolderId);
  }
}

/** Delete a JSON file from plans/ by filename */
async function driveDeleteJSON(filename) {
  if (!_plansFolderId) return;
  const file = await _findFile(filename, _plansFolderId);
  if (file) await gapi.client.drive.files.delete({ fileId: file.id });
}

// ── Image helpers ─────────────────────────────────────────────────────────────

/** Upload an image blob to images/ folder, returns a data URL for display */
async function driveWriteImage(filename, blob) {
  if (!_imagesFolderId) throw new Error('Drive not ready');
  const existing = await _findFile(filename, _imagesFolderId);
  if (existing) {
    await _uploadFile(existing.id, filename, blob, blob.type, false);
    return existing.id;
  } else {
    const res = await _uploadFile(null, filename, blob, blob.type, true, _imagesFolderId);
    return res.id;
  }
}

/** Read an image from Drive and return as data URL */
async function driveReadImage(fileId) {
  try {
    const token = gapi.client.getToken()?.access_token;
    if (!token) return null;
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const blob = await res.blob();
    return await _blobToDataURL(blob);
  } catch(e) { return null; }
}

/** Delete an image from images/ folder by filename */
async function driveDeleteImage(filename) {
  if (!_imagesFolderId) return;
  const file = await _findFile(filename, _imagesFolderId);
  if (file) await gapi.client.drive.files.delete({ fileId: file.id });
}

/** Find a file by name in a folder → { id, name } | null */
async function _findFile(name, folderId) {
  const q = `name='${name}' and '${folderId}' in parents and trashed=false`;
  const res = await gapi.client.drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive' });
  return res.result.files?.[0] || null;
}

/** Find image file in images/ folder by filename → Drive file ID | null */
async function driveFindImage(filename) {
  if (!_imagesFolderId) return null;
  const file = await _findFile(filename, _imagesFolderId);
  return file ? file.id : null;
}

// ── Multipart upload helper ──────────────────────────────────────────────────
async function _uploadFile(fileId, name, blob, mimeType, isCreate, parentId) {
  const token = gapi.client.getToken()?.access_token;
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

// ── Utility ──────────────────────────────────────────────────────────────────
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
