# Privacy Policy — Image to Text OCR

_Last updated: 4 October 2026_

**The short version:** OCR runs entirely on your device. Screenshots and images never leave your browser, and there is no analytics, advertising, or tracking of any kind. An optional account exists only if you want to sync history between devices — and even then the recognized text is end-to-end encrypted, so it cannot be read by anyone but you.

## 1. Data processed on your device

- Captured screenshots, selected regions, pasted images, and image files you open are processed **locally** in an offscreen document using Tesseract.js (WebAssembly).
- Extracted text, confidence scores, and language are saved to history in `chrome.storage.local` on your device.
- Images are **not** stored in history and are discarded after recognition.
- Settings are stored in `chrome.storage.sync` and travel through Google's Chrome Sync only if you have browser sync enabled — the extension itself does not send them anywhere.

If you never sign in, **nothing about your OCR activity leaves your device**.

## 2. Optional account and cloud history

You can create an account (email + password) to merge history across devices. This is off by default and every core feature works without it.

When you sign in, the extension contacts **Firebase Authentication** (Google) and stores:

- your email address and account identifier (uid), needed to authenticate you;
- your history entries in **Cloud Firestore**, where the **text is encrypted on your device before upload** (AES-256-GCM, with a key derived from your password via PBKDF2-SHA256, 600,000 iterations) — only non-sensitive metadata (language, confidence, timestamp, crop area) is stored in plain form;
- a small profile document containing your random encryption salt and the wrapped (password-protected) encryption key.

Because encryption happens before anything is uploaded, **the sync provider cannot read your history text**. Changing your password re-wraps the key; it never exposes the text to the server.

When signed in, history entries you create are uploaded automatically so they appear on your other signed-in devices, and entries from other devices are merged into your local history (newest 100, deduplicated).

## 3. Every network request the extension can make

| Destination | When | What is sent |
|---|---|---|
| `identitytoolkit.googleapis.com` | Only when you sign in / sign up / verify email | Email, password (over TLS, for authentication), account tokens |
| `securetoken.googleapis.com` | Only while signed in | Refresh token (routine token renewal) |
| `firestore.googleapis.com` | Only while signed in | Your uid, encrypted history entries, salt / wrapped key |
| `cdn.jsdelivr.net` | First use of a non-English language | Nothing personal — downloads the open-source language model file (e.g. `fra.traineddata.gz`); English is bundled and needs no download |
| The website hosting an image you right-click | Right-click → extract text | A normal fetch of that image from its own site |

The OCR engine itself makes no network calls during recognition.

## 4. What we do not do

- No analytics, telemetry, or crash reporting
- No advertising, ad networks, or fingerprinting
- No selling, renting, or sharing of personal data with third parties
- No reading of your images or recognized text on any server — it is technically impossible for the synced history (see §2)

## 5. Third-party services

- **Firebase / Google** (authentication, Firestore) — only used if you enable sign-in. Subject to [Google's Privacy Policy](https://policies.google.com/privacy).
- **jsDelivr** — serves open-source OCR language models; receives a routine file download (no account data).

## 6. Data removal

- Delete individual entries or clear all history from the side panel at any time.
- Deleting your account from the side panel requires your password, then deletes your synced history, deletes the account itself, and clears local history.
- Uninstalling the extension removes local data; to clear synced data, sign in and delete your history/account first.

## 7. Children

The extension is not directed at children under 13 and does not knowingly collect personal information from them.

## 8. Changes and contact

Material changes to this policy will be noted by updating this file's date in the repository.

Questions? Open an issue at [github.com/pushpkant00/image-to-text-ocr](https://github.com/pushpkant00/image-to-text-ocr/issues).
