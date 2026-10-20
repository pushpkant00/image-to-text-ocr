# Chrome Web Store submission kit

Everything needed to publish **Image to Text OCR**. Copy/paste the blocks below
into the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

---

## 0. Before you start

- [ ] One-time **$5** developer registration, verified email
- [ ] `npm run build` succeeds (no TypeScript errors)
- [ ] `npm run package` produces `release/image-to-text-ocr-1.0.0.zip`
- [ ] Extension loads cleanly from `dist/` (`chrome://extensions` → **Load unpacked**, no errors)
- [ ] A smoke test with a real key: selection OCR, right-click image, popup paste, one Convert mode, history, Settings save/test, dark-mode toggle
- [ ] Privacy policy is publicly reachable (see **§3.5**)
- [ ] Listing graphics ready (see **§4**)

> The uploaded ZIP is exactly `dist/`. It contains no `node_modules`, no source
> TypeScript, no `.pem`/`.crx`, and no landing page.

---

## 1. Package

```bash
npm run build     # dist/
npm run package   # release/image-to-text-ocr-1.0.0.zip
```

Dashboard → **New item** → upload that ZIP.

---

## 1b. Create the item now — the published extension ID is not the dev ID

`chrome.identity.getAuthToken()` only works for an OAuth client whose **Item ID**
matches the running extension id. Unpacked builds get a path-derived id
(`gmniehaogkjbpbjdncmpoimcdgknkopg`); the Web Store assigns a **different,
permanent id** when the item is created.

So, before submitting for review:

1. Upload the ZIP once (it may be rejected/unpublished — that is fine) to create the item
2. Copy the new **Item ID** from the dashboard (item details, or the store URL)
3. Google Cloud Console → **Credentials → Create credentials → OAuth client ID →
   Chrome extension** → paste the **published** Item ID → copy the client id
4. Put that id in `firebase-secrets.json` as `googleClientId` (replacing the
   unpacked-build one), then `npm run package` and upload the ZIP again
5. Test Google sign-in from the store-installed build before submitting

> Email-link sign-in keeps working through Firebase even if the Google client id
> is missing; only the "Continue with Google" button needs this.
>
> If you keep developing unpacked, keep the old client id in a second file
> (`firebase-secrets.dev.json`) and swap it in for local builds — one manifest can
> hold only one `oauth2.client_id`.

---

## 2. Store listing

**Name** (max 45 chars)

```
Image to Text OCR
```

**Short description** (max 132 chars)

```
Turn images into copyable text with your own free Gemini or OpenRouter key. Select, capture, convert.
```

**Category:** Productivity → Tools
**Language:** English

**Detailed description**

```
Image to Text OCR turns anything you can see into text you can copy.

SELECT ANYTHING
Press Ctrl+Shift+X (Command+Shift+X on Mac) and drag a box over an image, a chart, a scanned PDF, a video frame, or a slide deck. The text appears in a small card within a couple of seconds and streams in live as it is recognized.

THREE WAYS TO CAPTURE
• Ctrl+Shift+X — drag a region anywhere on the page
• Right-click any image → "Extract text from this image"
• Open the popup to upload an image file or paste a screenshot with Ctrl+V

CONVERT FILES
The Convert tab turns what you captured into a document:
• Jpg To Word — OCR an image into an editable .docx
• Pdf To Text — extract a PDF's text layer
• Pdf To Word — editable Word document, with OCR for scanned pages
• Text To PDF and Text To Word
Files are assembled on your device; no conversions are uploaded.

HISTORY THAT STAYS YOURS
Search, filter by language, copy, or delete past captures in the side panel or the dashboard. Optionally sign in to sync history across devices — entries are encrypted on your device before they are stored.

BRING YOUR OWN KEY — NO SUBSCRIPTION
This extension has no server and no paid plan. You connect it to an OCR provider with your own free API key:
• Google AI Studio (Gemini) — free tier, fastest option (about 2–4 seconds per capture)
• OpenRouter — free vision models with a daily free quota
Your key is stored only in your browser and is sent only to the provider you choose. Setup takes a minute in Settings, and the Test button confirms the key works.

PRIVACY BY DESIGN
• No analytics, no ads, no tracking
• No developer server — requests go from your browser to your OCR provider
• API keys never leave your device and are never synced
• Images are not stored in history
• History sync is optional and encrypted before upload

DARK MODE
Settings, History, and the popup follow your system theme, with a manual toggle.

OPEN SOURCE
MIT licensed. Source and issues: github.com/pushpkant00/image-to-text-ocr

NOTE: A free API key (Google AI Studio or OpenRouter) is required for OCR. The extension works on normal websites; Chrome blocks all extensions from chrome:// pages and the Chrome Web Store.
```

---

## 3. Privacy practices tab

### 3.1 Single purpose

```
Convert images and PDFs into editable, copyable text. The user selects a screen
region, right-clicks an image, or opens a file; the extension sends that image to
the OCR provider the user configured with their own API key and returns the
recognized text, with optional encrypted history sync.
```

### 3.2 Permission justifications

`activeTab`
```
Used only after an explicit user gesture (keyboard shortcut, context menu, or
popup button) to capture the visible tab so the selected region can be OCR'd.
```

`scripting`
```
Injects the drag-to-select overlay and result card into the active tab after the
user presses Ctrl+Shift+X or chooses the context-menu item.
```

`contextMenus`
```
Adds the "Extract text from this image" right-click item used to OCR a specific
image on the page.
```

`storage`
```
Stores user settings in chrome.storage.sync and, locally, the user's own OCR API
key and their text-only history (chrome.storage.local).
```

`offscreen`
```
MV3 service workers have no DOM or canvas. The offscreen document crops and
JPEG-encodes the captured image, runs pdf.js for PDFs, and builds .docx/.pdf
output — all locally.
```

`sidePanel`
```
Shows the searchable OCR history in Chrome's side panel.
```

`notifications`
```
Explains why a capture failed on a restricted page (chrome://, New Tab, Chrome
Web Store), where Chrome blocks all extensions.
```

`identity`
```
Optional Google sign-in (chrome.identity.getAuthToken) used only to let the user
sync their OCR history across devices with Firebase. Not required for any core
feature.
```

Host permissions — `http://*/*`, `https://*/*`
```
The selection overlay and result card must work on any page the user chooses, and
a right-clicked image must be fetched from its own site so it can be OCR'd. The
extension also calls the OCR provider the user selected
(generativelanguage.googleapis.com or openrouter.ai). There is no narrower
pattern that still supports "select text from any site".
```

Host permission — `file:///*`
```
Lets the same selection/right-click OCR work on local HTML files the user opens.
Requires the user to enable "Allow access to file URLs"; without it the extension
simply does nothing there.
```

### 3.3 Remote code

```
No, I am not using remote code.
```

All JavaScript is bundled in the ZIP (including pdf.js). The extension only
fetches **data** at runtime: the user's OCR requests and a public model list from
`openrouter.ai/api/v1/models`.

### 3.4 Data usage

Check **“This item collects or uses user data”**, then select:

| Category | Ticked | Why |
|---|---|---|
| Personally identifiable information | ✅ | Email address, only if the user opts into account sync |
| Authentication information | ✅ | Firebase tokens while signed in |
| Website content | ✅ | The image/screenshot the user explicitly chooses to OCR is transmitted to their chosen OCR provider |
| Health, financial, location, web history, personal communications, user activity | ❌ | Not collected |

Then answer:

- **Sold to third parties?** No
- **Used or transferred for purposes unrelated to the single purpose?** No
- **Used or transferred to determine creditworthiness or for lending?** No

Justification box:

```
OCR requires sending the image the user selected to the OCR provider the user
configured (Google Gemini or OpenRouter), authenticated with the user's own API
key. That is the extension's core function and the only reason image data leaves
the browser. The developer operates no server and receives nothing. Account sync
is optional, stores only the user's email plus encrypted history, and can be
deleted from Settings at any time. No data is sold, used for advertising, or used
to train models by the developer.
```

- [ ] Tick the **Limited Use** certification

### 3.5 Privacy policy URL

```
https://github.com/pushpkant00/image-to-text-ocr/blob/main/PRIVACY.md
```

(Any public URL works. If you prefer, publish the file on GitHub Pages and use
that URL instead. The policy must stay publicly reachable while the item is live.)

### 3.6 Notes for review (important)

The extension is BYOK, so a reviewer cannot run OCR without a key. Add a
short-lived key and step-by-step test instructions:

```
1. Install the extension. A first-run toast opens Settings (or click the gear in
   the popup).
2. Paste this temporary Google AI Studio key: <TEMP_KEY>
3. Click Save, then Test — it should report a response time.
4. Open https://en.wikipedia.org/wiki/Text and press Ctrl+Shift+X; draw a box over
   a paragraph. Text streams into the card; click Copy.
5. Right-click any image on that page → "Extract text from this image".
6. Popup → Convert tab → Jpg To Word with any screenshot; a .docx downloads.
7. Settings → toggle dark mode. Optional: History page → search/delete.

The key above is rate-limited and will be revoked after review. OCR requests go
directly from the browser to Google using the user's key; the developer has no
server.
```

> Create the key in a dedicated Google Cloud project, cap it (quota/budget), and
> delete it after approval. The extension id is
> `gmniehaogkjbpbjdncmpoimcdgknkopg` for the unpacked build; the store id may
> differ once published.

---

## 4. Graphics

| Asset | Required | Size | Status |
|---|---|---|---|
| Store icon | ✅ | 128×128 PNG | `icons/icon128.png` |
| Screenshots | ✅ (1–5) | 1280×800 PNG | `store/screenshots/1-settings.png`, `2-history.png`, `3-popup.png` |
| Small promo tile | optional | 440×280 | not generated |
| Marquee promo tile | optional | 1400×560 | not generated |
| YouTube video | optional | — | — |

Screenshots must show the real UI (no device frames or marketing text required).

---

## 5. Publish

1. **Distribution** → Public, all regions
2. **Pricing** → Free
3. Review the **Privacy practices** answers from §3
4. Click **Submit for review** (typically a few days; broad host permissions and
   a BYOK requirement are the usual discussion points)

### After approval

- [ ] Verify the store listing and install from the store (not unpacked)
- [ ] Confirm OCR works with a fresh key on the store build
- [ ] Add the store link to `README.md` (the "Install" section currently says *Listing pending*)
- [ ] Rotate/delete the temporary review key
- [ ] For updates: bump `version` in `manifest.json`, rebuild, `npm run package`, upload the new ZIP

### Common rejection causes to avoid

- **"Needs a key"** → always include working review notes and a capped test key
- **Broad host permissions** → the justification in §3.2 must be specific; do not leave it blank
- **Missing privacy policy** → the URL must load without login
- **Remote code** → never load scripts from a CDN; pdf.js is vendored in `libs/`
- **Undisclosed data transfer** → tick *Website content* and explain the provider request
- **Excessive description** → do not repeat keywords or add unrelated features
