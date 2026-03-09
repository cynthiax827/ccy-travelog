/**
 * gdrive.js — Google Drive helper for CCY Travelog
 * Fill in your CLIENT_ID and API_KEY from Google Cloud Console.
 */

const GDRIVE_CLIENT_ID = '377869285807-hkidh1sdvr3ph7cjtgrha82mmjr6p3pc.apps.googleusercontent.com';
const GDRIVE_API_KEY   = 'AIzaSyA75PrCkhOWUgE8uEtv4nyBc9I26Kru7Ms';
const GDRIVE_SCOPES    = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME      = 'ccy-travelog';

// ── Internal state ────────────────────────────────────────────────────────────
let _tokenClient    = null;
let _accessToken    = null;
let _rootFolderId   = null;
let _plansFolderId  = null;
let _imagesFolderId = null;
let _signedIn       = false;

// ── Sign-in change callbacks ──────────────────────────────────────────────────
const _cbs = [];
function onSignInChange(fn) { _cbs.push(fn); }
function _fire(v) {
  _signedIn = v;
  _cbs.forEach(fn => { try { fn(v); } catch(e) { console.error('[gdrive] cb error', e); } });
}

// ── Token storage (persists across page reloads) ──────────────────────────────
function _saveToken(token, expiresIn) {
  const expiry = Date.now() + (expiresIn || 3600) * 1000 - 120000;
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

// ── Load Google scripts and initialise ───────────────────────────────────────
// Returns a Promise that resolves when both GAPI and GIS are fully ready.
function loadGDrive() {
  return new Promise((resolve, reject) => {
    let gapiOk = false, gisOk = false;
    function done() { if (gapiOk && gisOk) resolve(); }

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
          gapiOk = true;
          done();
        } catch(e) {
          console.error('[gdrive] gapi init failed:', e);
          reject(e);
        }
      });
    };
    document.head.appendChild(s1);

    // GIS — callback intentionally left empty here, assigned in gdriveSignIn()
    const s2 = document.createElement('script');
    s2.src = 'https://accounts.google.com/gsi/client';
    s2.onerror = () => reject(new Error('Failed to load GIS'));
    s2.onload = () => {
      try {
        _tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: GDRIVE_CLIENT_ID,
          scope: GDRIVE_SCOPES,
          callback: '', // will be set in gdriveSignIn
        });
        console.log('[gdrive] GIS ready');
        gisOk = true;
        done();
      } catch(e) {
        console.error('[gdrive] GIS init failed:', e);
        reject(e);
      }
    };
    document.head.appendChild(s2);
  });
}

// ── Sign in (manual button press) ────────────────────────────────────────────
function gdriveSignIn() {
  if (!_tokenClient) {
    alert('Google APIs still loading — please try again in a moment.');
    return;
  }
  // Assign callback right before requesting — avoids async callback issues
  _tokenClient.callback = function(resp) {
    if (resp.error) {
      console.error('[gdrive] sign-in error:', resp.error);
      return;
    }
    console.log('[gdrive] got token, setting up…');
    _accessToken = resp.access_token;
    _saveToken(_accessToken, resp.expires_in);
    gapi.client.setToken({ access_token: _accessToken });
    // ensureFolders then fire — all async inside a plain function
    _ensureFolders().then(() => {
      console.log('[gdrive] ready after sign-in');
      _fire(true);
    }).catch(e => {
      console.error('[gdrive] folder setup failed:', e);
      _fire(true); // still fire so UI updates
    });
  };
  _tokenClient.requestAccessToken({ prompt: 'select_account' });
}

// ── Sign out ──────────────────────────────────────────────────────────────────
function gdriveSignOut() {
  if (_accessToken) {
    google.accounts.oauth2.revoke(_accessToken, () => console.log('[gdrive] revoked'));
  }
  _accessToken = null;
  gapi.client.setToken(null);
  _clearToken();
  _rootFolderId = _plansFolderId = _imagesFolderId = null;
  _fire(false);
}

function gdriveIsSignedIn() { return _signedIn; }

// ── Silent restore on page load ───────────────────────────────────────────────
// Call this after loadGDrive() resolves. Returns a Promise.
function gdriveRestore() {
  const saved = _getSavedToken();
  if (!saved) {
    console.log('[gdrive] no saved token');
    return Promise.resolve();
  }
  console.log('[gdrive] restoring saved token…');
  _accessToken = saved;
  gapi.client.setToken({ access_token: saved });
  return _ensureFolders()
    .then(() => {
      console.log('[gdrive] restore complete');
      _fire(true);
    })
    .catch(e => {
      console.error('[gdrive] restore failed — token likely expired:', e);
      _clearToken();
    });
}

// ── Folder helpers ────────────────────────────────────────────────────────────
function _ensureFolders() {
  return _getOrCreateFolder(FOLDER_NAME, null)
    .then(rootId => {
      _rootFolderId = rootId;
      return Promise.all([
        _getOrCreateFolder('plans',  rootId),
        _getOrCreateFolder('images', rootId),
      ]);
    })
    .then(([plansId, imagesId]) => {
      _plansFolderId  = plansId;
      _imagesFolderId = imagesId;
      console.log('[gdrive] folders:', _plansFolderId, _imagesFolderId);
    });
}

function _getOrCreateFolder(name, parentId) {
  const q = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`;
  return gapi.client.drive.files.list({ q, fields: 'files(id)', spaces: 'drive' })
    .then(res => {
      if (res.result.files && res.result.files.length > 0) {
        return res.result.files[0].id;
      }
      return gapi.client.drive.files.create({
        resource: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : [] },
        fields: 'id',
      }).then(c => c.result.id);
    });
}

// ── Raw fetch with auth ───────────────────────────────────────────────────────
function _fetch(url, opts) {
  if (!_accessToken) return Promise.reject(new Error('[gdrive] not signed in'));
  opts = opts || {};
  opts.headers = Object.assign({ Authorization: 'Bearer ' + _accessToken }, opts.headers || {});
  return fetch(url, opts).then(r => {
    if (!r.ok) return r.text().then(t => { throw new Error('[gdrive] ' + r.status + ': ' + t); });
    return r;
  });
}

// ── JSON helpers ──────────────────────────────────────────────────────────────
function driveListPlans() {
  if (!_plansFolderId) return Promise.resolve([]);
  return gapi.client.drive.files.list({
    q: `'${_plansFolderId}' in parents and name contains '.json' and trashed=false`,
    fields: 'files(id,name,modifiedTime)', spaces: 'drive', orderBy: 'modifiedTime desc',
  }).then(res => res.result.files || []);
}

function driveReadJSON(fileId) {
  return _fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media')
    .then(r => r.json());
}

function driveWriteJSON(filename, data) {
  if (!_plansFolderId) return Promise.reject(new Error('[gdrive] folders not ready'));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  return _findFile(filename, _plansFolderId).then(existing => {
    return _upload(existing ? existing.id : null, filename, blob, 'application/json', !existing, _plansFolderId);
  }).then(() => console.log('[gdrive] saved:', filename));
}

function driveDeleteJSON(filename) {
  if (!_plansFolderId) return Promise.resolve();
  return _findFile(filename, _plansFolderId).then(f => {
    if (f) return gapi.client.drive.files.delete({ fileId: f.id });
  });
}

// ── Image helpers ─────────────────────────────────────────────────────────────
function driveWriteImage(filename, blob) {
  if (!_imagesFolderId) return Promise.reject(new Error('[gdrive] folders not ready'));
  return _findFile(filename, _imagesFolderId).then(existing => {
    return _upload(existing ? existing.id : null, filename, blob, blob.type, !existing, _imagesFolderId)
      .then(r => r.id || (existing && existing.id));
  });
}

function driveReadImage(fileId) {
  return _fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media')
    .then(r => r.blob()).then(_toDataURL)
    .catch(e => { console.warn('[gdrive] image read failed:', e); return null; });
}

function driveDeleteImage(filename) {
  if (!_imagesFolderId) return Promise.resolve();
  return _findFile(filename, _imagesFolderId).then(f => {
    if (f) return gapi.client.drive.files.delete({ fileId: f.id });
  });
}

function driveFindImage(filename) {
  if (!_imagesFolderId) return Promise.resolve(null);
  return _findFile(filename, _imagesFolderId).then(f => f ? f.id : null);
}

// ── Low-level helpers ─────────────────────────────────────────────────────────
function _findFile(name, folderId) {
  return gapi.client.drive.files.list({
    q: `name='${name}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id,name)', spaces: 'drive',
  }).then(res => (res.result.files && res.result.files[0]) || null);
}

function _upload(fileId, name, blob, mimeType, isCreate, parentId) {
  const meta = isCreate ? { name, mimeType, parents: [parentId] } : { name, mimeType };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', blob);
  const url = isCreate
    ? 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name'
    : 'https://www.googleapis.com/upload/drive/v3/files/' + fileId + '?uploadType=multipart&fields=id,name';
  return fetch(url, {
    method: isCreate ? 'POST' : 'PATCH',
    headers: { Authorization: 'Bearer ' + _accessToken },
    body: form,
  }).then(r => r.json());
}

function _toDataURL(blob) {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.readAsDataURL(blob);
  });
}

function slugify(title) {
  return (title || 'untitled').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}
