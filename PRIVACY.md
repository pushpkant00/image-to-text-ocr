# Privacy Policy — Image to Text OCR

_Last updated: 6 October 2026_

**The short version:** OCR runs entirely on your device. Screenshots and images never leave your browser, and there is no analytics, advertising, or tracking of any kind. An optional account exists only if you want to sync history between devices — and even then the recognized text is encrypted before upload and lives under your own Google account.

## 1. Data processed on your device

- Captured screenshots, selected regions, pasted images, and image files you open are processed **locally** in an offscreen document using Tesseract.js (WebAssembly).
- Extracted text, confidence scores, and language are saved to history in `chrome.storage.local` on your device.
- Images are **not** stored in history and are discarded after recognition.
- Settings are stored in `chrome.storage.sync` and travel through Google's Chrome Sync only if you have browser sync enabled — the extension itself does not send them anywhere.

If you never log in, **nothing about your OCR activity leaves your device**.

## 2. Optional account and cloud history

You can log in with your Google account or a one-time 6-digit code sent to your email to merge history across devices. This is off by default and every core feature works without it.

When you log in, the extension contacts **Firebase Authentication** and stores:

- your account's email address and account identifier (uid), needed to authenticate you;
- your history entries in **Cloud Firestore**, where the **text is encrypted on your device before upload** (AES-256-GCM) — only non-sensitive metadata (language, confidence, timestamp, crop area) is stored in plain form;
- a small profile document containing the account's random encryption key, readable only while signed in as you (Firestore security rules restrict every `users/{uid}` document to its owner).

Encryption happens before anything is uploaded, so your history is never stored as plain text. The key lives in your own profile document instead of being derived from a password: treat this as defense-in-depth at rest, not zero-knowledge against Google itself (Google operates both Firebase Authentication and Firestore and could technically read the key and the data together). Neither ever leaves Google's servers — and your images never reach any server at all.

When signed in, history entries you create are uploaded automatically so they appear on your other signed-in devices, and entries from other devices are merged into your local history (newest 100, deduplicated).

## 3. Every network request the extension can make

| Destination | When | What is sent |
|---|---|---|
| `identitytoolkit.googleapis.com` | Only when you log in (Google or email code) or delete your account | A Google access token (for Google login and for issuing email login codes), your email address, account tokens |
| `gmail.googleapis.com` | Only when you request an email login code | Your one-time 6-digit login code, sent as a single email to the address you entered — sent from your own Gmail account (the extension can only send this one email; it never reads your mail) |
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
- **Gmail API** — only if you request an email login code; the extension sends that one code email from your own Gmail account (send permission only — it never reads your mail).
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
