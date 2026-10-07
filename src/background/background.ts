import { cleanText } from '../ocr/text-detector.js';
import {
  getAuthState,
  signInWithGoogle,
  sendLoginOtp,
  verifyLoginOtp,
  signOut,
  deleteAccount,
  pushEntry,
  removeEntryFromCloud,
  clearCloudHistory,
  syncHistory,
} from './firebase.js';
import { isFirebaseConfigured } from '../shared/firebase-config.js';

const DEFAULT_SETTINGS: OCRSettings = {
  language: 'eng',
  removeLineBreaks: true,
  mergeSpaces: true,
  showResultCard: true,
  openHistoryAfterOcr: true,
  autoDownload: false,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- storage helpers (settings in sync, history in local) ----------
async function getSettings(): Promise<OCRSettings> {
  const s = await chrome.storage.sync.get<SyncStorage>(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...s };
}

async function saveHistoryEntry(entry: OCRHistoryEntry): Promise<void> {
  const { history = [] } = await chrome.storage.local.get<LocalStorage>({ history: [] });
  history.unshift(entry);
  await chrome.storage.local.set({ history: history.slice(0, 100) });
}

// ---------- offscreen ----------
const OFFSCREEN_URL = 'offscreen/offscreen.html';
let creatingOffscreen: Promise<void> | null = null;

async function offscreenExists(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function ensureOffscreen(): Promise<void> {
  // Never blindly create: Chrome allows only ONE offscreen document.
  if (await offscreenExists()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS', 'CLIPBOARD'],
        justification: 'Run Tesseract.js OCR and crop screenshots off the main thread',
      })
      .catch((e: unknown) => {
        // Lost a race with another call — document exists, that's fine.
        if (!/already exists|single offscreen document/i.test(errorMessage(e))) throw e;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

// Ask the offscreen document to run a job (it has DOM + canvas + workers).
// Retries while the document is still loading its scripts; resets it if wedged.
async function sendViaOffscreen<T>(type: string, payload: unknown): Promise<T> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await ensureOffscreen();
    try {
      return await chrome.runtime.sendMessage({ type, payload });
    } catch (e) {
      lastError = e;
      await sleep(attempt === 0 ? 500 : 1500);
    }
  }
  // Last resort: close a possibly wedged document and start fresh once.
  try {
    await chrome.offscreen.closeDocument().catch(() => {});
    await ensureOffscreen();
    return await chrome.runtime.sendMessage({ type, payload });
  } catch (e) {
    throw lastError || e;
  }
}

async function ocrViaOffscreen(payload: OcrRunPayload): Promise<RawOcrResult> {
  return sendViaOffscreen<RawOcrResult>('OCR_RUN', payload);
}

async function fetchAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read image'));
    r.readAsDataURL(blob);
  });
}

async function processResult(
  raw: RawOcrResult,
  settings: OCRSettings,
  extra: Partial<Pick<OCRHistoryEntry, 'area' | 'language'>> = {},
): Promise<OCRHistoryEntry> {
  const text = cleanText(raw.text || '', {
    removeLineBreaks: settings.removeLineBreaks,
    mergeSpaces: settings.mergeSpaces,
  });
  const entry: OCRHistoryEntry = {
    id: crypto.randomUUID(),
    text,
    confidence: Math.round(raw.confidence || 0),
    timestamp: Date.now(),
    language: settings.language,
    ...extra,
  };
  if (text) {
    await saveHistoryEntry(entry);
    // mirror to the signed-in account (no-op when signed out)
    await pushEntry(entry).catch((err: unknown) => console.warn('[ocr] cloud push failed:', errorMessage(err)));
  }
  return entry;
}

function openSidePanel(windowId: number): Promise<void> {
  // sidePanel.open must be called during a user gesture chain where possible
  return chrome.sidePanel.open({ windowId }).catch(() => {});
}

// Full pipeline for a selected screen area
async function ocrSelection({
  windowId,
  area,
  dpr,
  language,
}: {
  windowId?: number;
  area: SelectionArea;
  dpr?: number;
  language?: string;
}): Promise<OCRHistoryEntry> {
  const settings = await getSettings();
  const screenshot =
    windowId === undefined
      ? await chrome.tabs.captureVisibleTab({ format: 'png' })
      : await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const raw = await ocrViaOffscreen({
    imageData: screenshot,
    area,
    language: language || settings.language,
    dpr: dpr || 1,
  });
  if (raw?.error) throw new Error(raw.error);
  return await processResult(raw, settings, { area, language: language || settings.language });
}

// ---------- install ----------
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.create({
    id: 'ocr-right-click',
    title: 'Extract text from this image',
    contexts: ['image'],
  });
  const cur = await chrome.storage.sync.get<SyncStorage>(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...cur });
});

// ---------- right-click on an image ----------
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ocr-right-click' || !info.srcUrl) return;
  try {
    const settings = await getSettings();
    const imageData = await fetchAsDataUrl(info.srcUrl);
    const raw = await ocrViaOffscreen({ imageData, language: settings.language });
    if (raw?.error) throw new Error(raw.error);
    const entry = await processResult(raw, settings);
    // send text back to the tab so the content script can show the result card
    if (tab?.id && settings.showResultCard) {
      chrome.tabs.sendMessage(tab.id, { type: 'OCR_DONE', entry }).catch(() => {});
    }
    if (tab?.windowId && settings.openHistoryAfterOcr) openSidePanel(tab.windowId);
  } catch (err) {
    console.error('[ocr] right-click failed:', err);
    if (tab?.id)
      chrome.tabs
        .sendMessage(tab.id, { type: 'OCR_FAILED', error: errorMessage(err) })
        .catch(() => {});
  }
});

// ---------- selection trigger (with injection fallback ----------
function isRestrictedUrl(url = ''): boolean {
  return /^(chrome|edge|about|chrome-extension|moz-extension|view-source):|^https:\/\/(chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/.test(url);
}

// Without the "tabs" permission Chrome hides tab.url for restricted schemes,
// so also detect the restriction from the injection error text.
function isBlockedError(error?: string): boolean {
  return Boolean(error && /cannot access|chrome:\/\//i.test(error));
}

function notifyBlocked(tab: chrome.tabs.Tab | undefined, error?: string): void {
  const where = isRestrictedUrl(tab?.url) || isBlockedError(error)
    ? 'Extensions cannot run on this page (try a normal website like wikipedia.org).'
    : 'Could not reach the page. Refresh the tab and try again.';
  chrome.notifications
    .create({ type: 'basic', iconUrl: 'icons/icon48.png', title: 'Image to Text OCR', message: where })
    .catch(() => {});
}

interface TriggerResult {
  ok: boolean;
  error?: string;
}

async function triggerSelection(tab?: chrome.tabs.Tab): Promise<TriggerResult> {
  if (!tab?.id) return { ok: false, error: 'No active tab' };
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_SELECTION' });
    return { ok: true };
  } catch (_) {
    // content script not present (e.g. tab predates install) — inject on demand
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/selection-overlay.js'] });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/content.css'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'START_SELECTION' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}

// ---------- keyboard shortcut ----------
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-selection') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await triggerSelection(tab);
  if (!res.ok) notifyBlocked(tab, res.error);
});

// ---------- messages ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const msg = message as BackgroundRequest | undefined;
  (async () => {
    if (!msg || typeof msg.type !== 'string') {
      sendResponse({ ok: false, error: 'unknown message' });
      return;
    }
    switch (msg.type) {
      case 'OCR_CAPTURE': {
        // from content script: { area, dpr, language? }
        const tab = sender.tab;
        const entry = await ocrSelection({
          windowId: tab?.windowId,
          area: msg.area,
          dpr: msg.dpr,
          language: msg.language,
        });
        sendResponse({ ok: true, entry });
        const settings = await getSettings();
        if (tab?.windowId && settings.openHistoryAfterOcr) openSidePanel(tab.windowId);
        // tell the originating tab so it can show the result card
        if (tab?.id && settings.showResultCard) {
          chrome.tabs.sendMessage(tab.id, { type: 'OCR_DONE', entry }).catch(() => {});
        }
        break;
      }
      case 'OCR_IMAGE_DATA': {
        // from popup paste/upload: { imageData, language? }
        const settings = await getSettings();
        const raw = await ocrViaOffscreen({
          imageData: msg.imageData,
          language: msg.language || settings.language,
        });
        if (raw?.error) throw new Error(raw.error);
        const entry = await processResult(raw, settings, { language: msg.language || settings.language });
        sendResponse({ ok: true, entry });
        break;
      }
      case 'GET_SETTINGS':
        sendResponse({ ok: true, settings: await getSettings() });
        break;
      case 'SAVE_SETTINGS':
        await chrome.storage.sync.set(msg.settings || {});
        sendResponse({ ok: true });
        break;
      case 'GET_HISTORY': {
        const { history = [] } = await chrome.storage.local.get<LocalStorage>({ history: [] });
        sendResponse({ ok: true, history });
        break;
      }
      case 'CLEAR_HISTORY':
        await chrome.storage.local.set({ history: [] });
        clearCloudHistory().catch((err: unknown) => console.warn('[ocr] cloud clear failed:', errorMessage(err)));
        sendResponse({ ok: true });
        break;
      case 'DELETE_ENTRY': {
        const { history = [] } = await chrome.storage.local.get<LocalStorage>({ history: [] });
        await chrome.storage.local.set({ history: history.filter((e) => e.id !== msg.id) });
        removeEntryFromCloud(msg.id).catch((err: unknown) =>
          console.warn('[ocr] cloud delete failed:', errorMessage(err)),
        );
        sendResponse({ ok: true });
        break;
      }
      case 'AUTH_STATE':
        sendResponse({
          ok: true,
          configured: isFirebaseConfigured(),
          googleAuth: Boolean((chrome.runtime.getManifest() as { oauth2?: { client_id?: string } }).oauth2?.client_id),
          user: await getAuthState(),
        });
        break;
      case 'AUTH_SIGN_IN_GOOGLE':
        sendResponse({ ok: true, user: await signInWithGoogle() });
        break;
      case 'AUTH_SEND_LOGIN_EMAIL': {
        const result = await sendLoginOtp(msg.email);
        sendResponse({ ok: true, ...result });
        break;
      }
      case 'AUTH_LOGIN_WITH_EMAIL':
        sendResponse({ ok: true, user: await verifyLoginOtp(msg.email, msg.code) });
        break;
      case 'AUTH_SIGN_OUT':
        await signOut();
        sendResponse({ ok: true });
        break;
      case 'AUTH_DELETE':
        await deleteAccount();
        sendResponse({ ok: true, user: null });
        break;
      case 'SYNC_HISTORY':
        sendResponse({ ok: true, stats: await syncHistory() });
        break;
      case 'PDF_EXTRACT': {
        // from popup: { pdfData, language? } — offscreen does the work
        const res = await sendViaOffscreen<PdfExtractResponse | undefined>('PDF_RUN', {
          pdfData: msg.pdfData,
          language: msg.language,
        });
        if (!res) throw new Error('No response from the PDF engine');
        if (res.error) throw new Error(res.error);
        const text = res.text || '';
        // Persist so a closed popup can restore the result on reopen.
        await chrome.storage.local.set({
          lastConvert: {
            text,
            pages: res.pages || 0,
            ts: Date.now(),
            mode: msg.mode,
            name: msg.name,
          } satisfies LastConvert,
        });
        sendResponse({ ok: true, text, pages: res.pages || 0, ocrPages: res.ocrPages || 0 });
        break;
      }
      case 'GET_LAST_CONVERT': {
        const { lastConvert = null } = await chrome.storage.local.get<LocalStorage>({ lastConvert: null });
        await chrome.storage.local.set({ lastConvert: null });
        sendResponse({ ok: true, lastConvert });
        break;
      }
      case 'CONVERT_PROGRESS':
        // progress broadcast from offscreen — the popup listens for it
        sendResponse({ ok: true });
        break;
      case 'OCR_RUN':
        // offscreen's own request; it listens for this message — we don't handle it
        sendResponse({ ok: false, error: 'unknown message' });
        break;
      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })().catch((err: unknown) => {
    console.error('[ocr] message failed:', (msg as { type?: string })?.type, err);
    sendResponse({ ok: false, error: errorMessage(err) });
  });
  return true; // async response
});
