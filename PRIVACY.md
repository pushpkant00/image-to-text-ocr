# Privacy Policy — Image to Text OCR

_Last updated: 20 October 2026_

**The short version:** the extension has no server of its own. To recognize text it sends the image you selected (or pasted, or opened) from your browser straight to the OCR provider you chose — Google Gemini or OpenRouter — using **your own API key**. Nothing passes through the developer. History sync is optional, and when you use it the recognized text is encrypted on your device before it is stored. There is no analytics, advertising, or tracking of any kind.

## 1. Data processed on your device

- Screenshots, selected regions, pasted images, and image files you open are cropped, resized (max 1536 px), and JPEG-encoded inside an offscreen document in your browser.
- PDF conversions first extract the PDF's own text layer with pdf.js; pages without one are rasterized and OCR'd page by page.
- `.docx` and `.pdf` outputs (Convert tab) are generated locally.
- Extracted text and metadata (language, timestamp, crop area) are written to history. While signed out, history lives in `chrome.storage.local`; once you sign in it is stored only in your account's cloud history (§3) and removed from browser storage.
- Images are **not** stored in history; the encoded copy is discarded after recognition.
- API keys are stored in `chrome.storage.local` on this device and are never synced.
- Settings are stored in `chrome.storage.sync` and travel through Chrome Sync only if you have browser sync enabled.

If you never log in, the only data that leaves your browser is what §2 describes.

## 2. OCR providers (the images you choose to process)

The extension does not run OCR locally. When you capture or upload something, the encoded image is sent over HTTPS directly to the provider selected in Settings, authenticated with your key:

| Provider | Endpoint | What is sent |
|---|---|---|
| Google (Gemini API) | `generativelanguage.googleapis.com` | Your key, the encoded image, a short extraction prompt, and the language hint from Settings |
| OpenRouter | `openrouter.ai` | Your key, the encoded image, a short extraction prompt, and the language hint; OpenRouter forwards the request to the underlying free model provider |

- Requests are made by your browser; no developer-operated proxy or backend is involved, and the developer never receives the image or the key.
- Google, OpenRouter, and OpenRouter's upstream model providers process those requests under their own privacy policies. Google's is at [policies.google.com/privacy](https://policies.google.com/privacy); OpenRouter's is at [openrouter.ai/privacy](https://openrouter.ai/privacy). Free OpenRouter models may log prompts for training or abuse prevention — check their terms, and use the Gemini provider if you need stricter handling.
- Settings periodically fetches the public model catalogue from `openrouter.ai/api/v1/models`; that request contains no personal data and no key.
- Your API key itself is issued by the provider and is subject to that provider's terms (including free-tier rate limits and quotas).

## 3. Optional account and cloud history

You can sign in with a Google account or an email sign-in link. This is off by default and every core feature works without it. When you sign in, the extension contacts **Firebase Authentication** and **Cloud Firestore** and stores:

- your account's email address and account identifier (uid), needed to authenticate you;
- your history entries in Firestore, where the **text is encrypted on your device before upload** (AES-256-GCM) — only non-sensitive metadata (language, timestamp, crop area) is stored in plain form;
- a small profile document containing the account's random encryption key, readable only while signed in as you (Firestore security rules restrict every `users/{uid}` document to its owner).

Encryption happens before anything is uploaded, so history is never stored as plain text. The key lives in your own profile document instead of being derived from a password: treat this as defense-in-depth at rest, not zero-knowledge against Google, which operates both Firebase Authentication and Firestore and could technically read the key and the data together. Neither leaves Google's servers — and your images never reach Google through this path at all.

When signed in, new entries are written straight to your account's database (browser storage stays empty) and the side panel and dashboard read from it (newest 100). Entries collected before logging in are uploaded on sign-in. When you sign out, a decrypted copy is kept locally so history remains available on this device.

## 4. Every network request the extension can make

| Destination | When | What is sent |
|---|---|---|
| `generativelanguage.googleapis.com` | Each Gemini OCR request (only if Gemini is the selected provider) | Your key, the encoded image, prompt, language hint |
| `openrouter.ai` | Each OpenRouter OCR request; Settings model refresh | Your key, the encoded image, prompt, language hint; or a public model-list request |
| `identitytoolkit.googleapis.com` | Only when you sign in (Google or email link) or delete your account | A Google access token (for Google sign-in) or your email address (for email-link sign-in), plus account tokens |
| `securetoken.googleapis.com` | Only while signed in | Refresh token (routine token renewal) |
| `firestore.googleapis.com` | Only while signed in | Your uid, encrypted history entries, and the account encryption key in your private profile document |
| The website hosting an image you right-click | Right-click → *Extract text from this image* | A normal fetch of that image from its own site |

Recognition itself makes no other calls.

## 5. What we do not do

- No analytics, telemetry, or crash reporting
- No advertising, ad networks, or fingerprinting
- No selling, renting, or sharing of personal data
- No developer-side access to your images, keys, or recognized text
- No use of your data to train models, and no use for creditworthiness or lending purposes

The extension's use of any data received is limited to providing and improving its single purpose: converting an image you selected into text you can copy, plus the optional history sync described above. This use complies with the Chrome Web Store User Data Policy, including its Limited Use requirements.

## 6. Data removal

- Delete individual entries or clear all history from the side panel or dashboard at any time.
- Deleting your account in Settings → Danger zone asks for a typed confirmation and, if Firebase requires it, re-confirms your sign-in; it then deletes your synced history, deletes the account, and clears local history.
- Uninstalling the extension removes local data (keys, settings, local history). To clear synced data first, sign in and delete your history or account.
- OCR requests already sent to a provider are governed by that provider's retention policy.

## 7. Children

The extension is not directed at children under 13 and does not knowingly collect personal information from them.

## 8. Changes and contact

Material changes to this policy will be noted by updating the date above in this repository.

Questions or data requests? Open an issue at [github.com/pushpkant00/image-to-text-ocr](https://github.com/pushpkant00/image-to-text-ocr/issues).
