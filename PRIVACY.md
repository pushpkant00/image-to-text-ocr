# Privacy Policy — Image to Text OCR

_Last updated: 6 October 2026_

**The short version:** OCR runs entirely on your device. Screenshots and images never leave your browser, and there is no analytics, advertising, or tracking of any kind. An optional account exists only if you want to sync history between devices — and even then the recognized text is encrypted before upload and lives under your own Google account.

## 1. Data processed on your device

- Captured screenshots, selected regions, pasted images, and image files you open are processed **locally** in an offscreen document using Tesseract.js (WebAssembly).
- Extracted text, confidence scores, and language are saved to history. While you are not logged in (first use or guest), history lives in `chrome.storage.local` on your device; once you log in it is stored only in your account's encrypted cloud history (§2) and removed from browser storage.
- Images are **not** stored in history and are discarded after recognition.
- Settings are stored in `chrome.storage.sync` and travel through Google's Chrome Sync only if you have browser sync enabled — the extension itself does not send them anywhere.

If you never log in, **nothing about your OCR activity leaves your device**.

## 2. Optional account and cloud history

You can log in with your Google account or an email sign-in link. This is off by default and every core feature works without it. When you log in, your history is stored in your account's database instead of browser storage and follows you to every device you sign in on.

When you log in, the extension contacts **Firebase Authentication** and stores:

- your account's email address and account identifier (uid), needed to authenticate you;
- your history entries in **Cloud Firestore**, where the **text is encrypted on your device before upload** (AES-256-GCM) — only non-sensitive metadata (language, confidence, timestamp, crop area) is stored in plain form;
- a small profile document containing the account's random encryption key, readable only while signed in as you (Firestore security rules restrict every `users/{uid}` document to its owner).

Encryption happens before anything is uploaded, so your history is never stored as plain text. The key lives in your own profile document instead of being derived from a password: treat this as defense-in-depth at rest, not zero-knowledge against Google itself (Google operates both Firebase Authentication and Firestore and could technically read the key and the data together). Neither ever leaves Google's servers — and your images never reach any server at all.

When signed in, new entries are written straight to your account's database (browser storage stays empty) and the side panel/dashboard read from it (newest 100). Entries you collected before logging in are uploaded automatically on sign-in. When you sign out, a decrypted copy is kept locally so your history remains available on this device.

## 3. Every network request the extension can make

| Destination | When | What is sent |
|---|---|---|
| `identitytoolkit.googleapis.com` | Only when you log in (Google or email link) or delete your account | A Google access token (for Google login), your email address (for email-link login), account tokens |
| `securetoken.googleapis.com` | Only while signed in | Refresh token (routine token renewal) |
| `firestore.googleapis.com` | Only while signed in | Your uid, encrypted history entries, encryption key (in your private profile document) |
| `cdn.jsdelivr.net` | First use of a non-English language | Nothing personal — downloads the open-source language model file (e.g. `fra.traineddata.gz`); English is bundled and needs no download |
| The website hosting an image you right-click | Right-click → extract text | A normal fetch of that image from its own site |

The OCR engine itself makes no network calls during recognition.

## 4. What we do not do

- No analytics, telemetry, or crash reporting
- No advertising, ad networks, or fingerprinting
- No selling, renting, or sharing of personal data with third parties
- No reading of your images — they never leave your device — and no server-side access to your recognized text beyond the encrypted sync storage described in §2

## 5. Third-party services

- **Firebase / Google** (authentication, Firestore) — only used if you enable login. Subject to [Google's Privacy Policy](https://policies.google.com/privacy).
- **jsDelivr** — serves open-source OCR language models; receives a routine file download (no account data).

## 6. Data removal

- Delete individual entries or clear all history from the side panel at any time.
- Deleting your account from Settings → Danger zone asks for a typed confirmation and re-confirms your login if Firebase requires it, then deletes your synced history, deletes the account itself, and clears local history.
- Uninstalling the extension removes local data; to clear synced data, log in and delete your history/account first.

## 7. Children

The extension is not directed at children under 13 and does not knowingly collect personal information from them.

## 8. Changes and contact

Material changes to this policy will be noted by updating this file's date in the repository.

Questions? Open an issue at [github.com/pushpkant00/image-to-text-ocr](https://github.com/pushpkant00/image-to-text-ocr/issues).
