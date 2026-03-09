# CCY Travelog — Google Drive Setup Guide

## What you need to do once (takes ~30 minutes)

---

## Step 1 — Create a Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click **New Project**, name it `CCY Travelog`, click **Create**
3. Select your new project from the dropdown

---

## Step 2 — Enable the Google Drive API

1. In the left sidebar go to **APIs & Services → Library**
2. Search for **Google Drive API**, click it, click **Enable**

---

## Step 3 — Create an API Key

1. Go to **APIs & Services → Credentials**
2. Click **+ Create Credentials → API key**
3. Copy the key — you'll paste it into `gdrive.js` shortly
4. Click **Restrict Key** → under **API restrictions** select **Google Drive API** → Save

---

## Step 4 — Create an OAuth 2.0 Client ID

1. Still on **Credentials**, click **+ Create Credentials → OAuth client ID**
2. If prompted, configure the **OAuth consent screen** first:
   - User type: **External**
   - App name: `CCY Travelog`
   - Add your email as test user
   - Scopes: add `https://www.googleapis.com/auth/drive.file`
   - Save and continue
3. Back on **Create OAuth client ID**:
   - Application type: **Web application**
   - Name: `CCY Travelog`
   - Under **Authorised JavaScript origins**, add your deployed URL, e.g.:
     - `https://yourname.github.io`  (if using GitHub Pages)
     - `http://localhost:8080`        (for local testing)
4. Click **Create**, copy the **Client ID**

---

## Step 5 — Add credentials to gdrive.js

Open `gdrive.js` and replace the two placeholder values at the top:

```js
const GDRIVE_CLIENT_ID = 'YOUR_CLIENT_ID_HERE';   // ← paste OAuth Client ID
const GDRIVE_API_KEY   = 'YOUR_API_KEY_HERE';      // ← paste API Key
```

---

## Step 6 — Deploy the files

Host all four files on any static web server:

```
index.html
travel-planner.html
gdrive.js
```

**Recommended free options:**
- **GitHub Pages** — push to a repo, enable Pages in Settings → Pages
- **Netlify Drop** — drag the folder to [app.netlify.com/drop](https://app.netlify.com/drop)
- **Vercel** — `vercel deploy` via CLI

> ⚠️ The app must be served over **https://** (not `file://`) for Google OAuth to work.  
> Exception: `localhost` works over http for development.

---

## Step 7 — Share with collaborators

1. Open the deployed URL
2. Click **Sign in with Google** — you'll be asked to authorise the app
3. The app creates a `CCY Travelog/plans/` and `CCY Travelog/images/` folder in your Google Drive
4. Share the URL with collaborators — they sign in with their own Google account  
   *(They each need their own Google account but write to the **same Drive folder** — yours)*

> **Note:** For true shared write access, share the `CCY Travelog` Google Drive folder with each collaborator, and they should use the same Google account you used, **or** you can transfer folder ownership. The simplest approach: everyone uses the link but signs in with the same Google account (e.g. a shared travel account).

---

## How it works

| Local version | Online (Drive) version |
|---|---|
| Plans saved as JSON in `plans/` folder on disk | Plans saved as JSON files in Google Drive `CCY Travelog/plans/` |
| Images saved in `images/` folder on disk | Cover photos saved in Google Drive `CCY Travelog/images/` |
| Link Folder button to pick local directory | Sign in with Google button |
| Only works on your device | Works from any device, any browser |
| Autosaves on every edit | Autosaves on every edit (Drive API call) |

---

## Concurrent editing note

Google Drive does not merge edits — it's **last-write-wins**. If two people edit the same plan at the same time, the last save wins. This is fine for light collaboration (one person edits at a time). For real-time merge, a database like Supabase would be needed.
