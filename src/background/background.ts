import { cleanText } from '../ocr/text-detector.js';
import {
  DEFAULT_VISION_MODEL,
  VISION_MODELS,
  VisionError,
  modelValue,
  parseVisionModel,
  testVisionKey,
  type VisionProvider,
} from '../ocr/vision.js';
import {
  getAuthState,
  signInWithGoogle,
  sendLoginEmail,
  loginWithEmail,
  signOut,
  deleteAccount,
  pushEntry,
  removeEntryFromCloud,
  clearCloudHistory,
  syncHistory,
  listHistory,
} from './firebase.js';
import { isFirebaseConfigured } from '../shared/firebase-config.js';

const DEFAULT_MODEL_VALUE = modelValue('google', DEFAULT_VISION_MODEL);

const DEFAULT_SETTINGS: OCRSettings = {
  language: 'eng',
  visionModel: DEFAULT_MODEL_VALUE,
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
  const settings = { ...DEFAULT_SETTINGS, ...s };
  const parsed = parseVisionModel(settings.visionModel);
  let normalized = modelValue(parsed.provider, parsed.model);
  // Retired Google models (3.7/3.8 Flash reject minimal thinking and stall for
  // over a minute) fall back to the fast default instead of failing.
  if (parsed.provider === 'google' && !(VISION_MODELS as readonly string[]).includes(parsed.model)) {
    normalized = DEFAULT_MODEL_VALUE;
  }
  if (normalized !== settings.visionModel) {
    settings.visionModel = normalized;
    chrome.storage.sync.set({ visionModel: normalized }).catch(() => {});
  }
  return settings;
}

async function saveHistoryEntry(entry: OCRHistoryEntry): Promise<void> {
  const { history = [] } = await chrome.storage.local.get<LocalStorage>({ history: [] });
  history.unshift(entry);
  await chrome.storage.local.set({ history: history.slice(0, 100) });
}

// ---------- OCR credentials ----------
/**
 * The offscreen document never reads settings itself — the background resolves
 * the user's Gemini key and passes it down with the payload.
 *
 * Images go straight from this extension to Google; there is no backend. Users
 * supply their own API key (free tier from aistudio.google.com/apikey).
 */
interface EngineConfig {
  apiKey: string;
  model: string;
  provider: VisionProvider;
}

async function getVisionKey(provider: VisionProvider = 'google'): Promise<string> {
  const storageKey = provider === 'openrouter' ? 'openrouterApiKey' : 'visionApiKey';
  const stored = await chrome.storage.local.get<LocalStorage>({ [storageKey]: '' });
  return String(stored[storageKey] || '').trim();
}

async function resolveEngine(settings: OCRSettings): Promise<EngineConfig> {
  const parsed = parseVisionModel(settings.visionModel);
  return {
    apiKey: await getVisionKey(parsed.provider),
    model: parsed.model,
    provider: parsed.provider,
  };
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
        justification: 'Render PDF pages with pdf.js workers and crop screenshots off the main thread',
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

/** Push an OCR event to every extension page (popup, side panel). Content
 *  scripts are not reached by runtime.sendMessage, so nothing double-handles. */
function broadcast(event: OcrBroadcast): void {
  chrome.runtime.sendMessage(event).catch(() => {});
}

async function ocrViaOffscreen(payload: OcrRunPayload): Promise<RawOcrResult> {
  const engine = await resolveEngine(await getSettings());
  return sendViaOffscreen<RawOcrResult>('OCR_RUN', { ...payload, ...engine });
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
    timestamp: Date.now(),
    language: settings.language,
    ...extra,
  };
  if (text) {
    const user = await getAuthState();
    if (user) {
      // Signed in → the account database is the store (browser storage stays clean).
      try {
        await pushEntry(entry);
        chrome.runtime.sendMessage({ type: 'HISTORY_UPDATED' }).catch(() => {});
      } catch (err) {
        console.warn('[ocr] cloud push failed, staged on-device:', errorMessage(err));
        await saveHistoryEntry(entry); // flushes to the cloud on the next sync
      }
    } else {
      // Signed out (first-time / guest) → history lives in chrome.storage.local.
      await saveHistoryEntry(entry);
    }
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
  tabId,
  requestId,
}: {
  windowId?: number;
  area: SelectionArea;
  dpr?: number;
  language?: string;
  tabId?: number;
  requestId?: string;
}): Promise<OCRHistoryEntry> {
  const settings = await getSettings();
  // Capture as JPEG: Chrome encodes it faster than PNG and the bytes never
  // leave the extension anyway (the crop is re-encoded before upload).
  const capture = { format: 'jpeg' as const, quality: 92 };
  const screenshot =
    windowId === undefined
      ? await chrome.tabs.captureVisibleTab(capture)
      : await chrome.tabs.captureVisibleTab(windowId, capture);
  const raw = await ocrViaOffscreen({
    imageData: screenshot,
    area,
    language: language || settings.language,
    dpr: dpr || 1,
    tabId,
    requestId,
    startedAt: Date.now(),
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
  void ensureOffscreen();
});

// ---------- right-click on an image ----------
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ocr-right-click' || !info.srcUrl) return;
  try {
    const settings = await getSettings();
    const started = Date.now();
    broadcast({ type: 'OCR_START', startedAt: started });
    const imageData = await fetchAsDataUrl(info.srcUrl);
    const raw = await ocrViaOffscreen({ imageData, language: settings.language, startedAt: started });
    if (raw?.error) throw new Error(raw.error);
    const entry = await processResult(raw, settings);
    const ms = Date.now() - started;
    broadcast({ type: 'OCR_RESULT', entry, ms, startedAt: started });
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
  // Warm the offscreen document while the user is still dragging, so the first
  // OCR request doesn't pay for loading pdf.js + the vision module.
  void ensureOffscreen();
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
        const started = Date.now();
        broadcast({ type: 'OCR_START', requestId: msg.requestId, startedAt: started });
        const entry = await ocrSelection({
          windowId: tab?.windowId,
          area: msg.area,
          dpr: msg.dpr,
          language: msg.language,
          tabId: tab?.id,
          requestId: msg.requestId,
        });
        const ms = Date.now() - started;
        sendResponse({ ok: true, entry });
        broadcast({ type: 'OCR_RESULT', entry, ms, requestId: msg.requestId, startedAt: started });
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
        const started = Date.now();
        broadcast({ type: 'OCR_START', startedAt: started });
        const raw = await ocrViaOffscreen({
          imageData: msg.imageData,
          language: msg.language || settings.language,
          startedAt: started,
        });
        if (raw?.error) throw new Error(raw.error);
        const entry = await processResult(raw, settings, { language: msg.language || settings.language });
        const ms = Date.now() - started;
        sendResponse({ ok: true, entry, ms });
        broadcast({ type: 'OCR_RESULT', entry, ms, startedAt: started });
        break;
      }
      case 'GET_SETTINGS':
        sendResponse({ ok: true, settings: await getSettings() });
        break;
      case 'SAVE_SETTINGS':
        await chrome.storage.sync.set(msg.settings || {});
        sendResponse({ ok: true });
        break;
      case 'GET_VISION_KEY':
        sendResponse({ ok: true, apiKey: await getVisionKey(msg.provider) });
        break;
      case 'SAVE_VISION_KEY': {
        const apiKey = (msg.apiKey || '').trim();
        if (!apiKey) throw new Error('API key is empty.');
        const storageKey = msg.provider === 'openrouter' ? 'openrouterApiKey' : 'visionApiKey';
        await chrome.storage.local.set({ [storageKey]: apiKey });
        sendResponse({ ok: true });
        break;
      }
      case 'CLEAR_VISION_KEY': {
        const storageKey = msg.provider === 'openrouter' ? 'openrouterApiKey' : 'visionApiKey';
        await chrome.storage.local.remove(storageKey);
        sendResponse({ ok: true });
        break;
      }
      case 'OPEN_SETTINGS':
        await chrome.tabs.create({ url: chrome.runtime.getURL('auth/settings.html') });
        sendResponse({ ok: true });
        break;
      case 'TEST_VISION_KEY': {
        const settings = await getSettings();
        const parsed = msg.model
          ? parseVisionModel(msg.model)
          : parseVisionModel(settings.visionModel);
        const provider = msg.provider || parsed.provider;
        const apiKey = (msg.apiKey || '').trim() || (await getVisionKey(provider));
        const info = await testVisionKey(apiKey, parsed.model, undefined, provider);
        sendResponse({ ok: true, ms: info.ms, note: info.note, exhausted: info.exhausted });
        break;
      }
      case 'GET_HISTORY': {
        const { history: local = [] } = await chrome.storage.local.get<LocalStorage>({ history: [] });
        let history = local;
        let error: string | undefined;
        if (await getAuthState()) {
          // Signed in → read from the account database, not browser storage.
          try {
            const cloud = await listHistory();
            const ids = new Set(cloud.map((entry) => entry.id));
            history = [...cloud, ...local.filter((entry) => !ids.has(entry.id))] // local = unflushed staging
              .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
              .slice(0, 100);
          } catch (err) {
            error = errorMessage(err); // offline — fall back to the staging copy below
            console.warn('[sync] history read from database failed:', error);
          }
        }
        sendResponse(history.length || !error ? { ok: true, history } : { ok: false, error });
        break;
      }
      case 'CLEAR_HISTORY':
        await chrome.storage.local.set({ history: [] });
        clearCloudHistory().catch((err: unknown) => console.warn('[ocr] cloud clear failed:', errorMessage(err)));
        chrome.runtime.sendMessage({ type: 'HISTORY_UPDATED' }).catch(() => {});
        sendResponse({ ok: true });
        break;
      case 'DELETE_ENTRY': {
        const { history = [] } = await chrome.storage.local.get<LocalStorage>({ history: [] });
        await chrome.storage.local.set({ history: history.filter((e) => e.id !== msg.id) });
        await removeEntryFromCloud(msg.id).catch((err: unknown) =>
          console.warn('[ocr] cloud delete failed:', errorMessage(err)),
        );
        chrome.runtime.sendMessage({ type: 'HISTORY_UPDATED' }).catch(() => {});
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
      case 'AUTH_SEND_LOGIN_EMAIL':
        await sendLoginEmail(msg.email);
        sendResponse({ ok: true });
        break;
      case 'AUTH_LOGIN_WITH_EMAIL':
        sendResponse({ ok: true, user: await loginWithEmail(msg.email, msg.code) });
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
        try {
          sendResponse({ ok: true, stats: await syncHistory() });
        } catch (err) {
          // The dashboard shows this message in its sync banner — no stack noise.
          const detail = err instanceof Error ? err.message : String(err);
          console.warn('[ocr] sync failed:', detail);
          sendResponse({ ok: false, error: detail });
        }
        break;
      case 'PDF_EXTRACT': {
        // from popup: { pdfData, language? } — offscreen does the work
        const engine = await resolveEngine(await getSettings());
        const res = await sendViaOffscreen<PdfExtractResponse | undefined>('PDF_RUN', {
          pdfData: msg.pdfData,
          language: msg.language,
          ...engine,
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
      case 'OCR_PARTIAL': {
        // relayed from the offscreen document to the tab that asked for OCR
        broadcast({ type: 'OCR_LIVE', requestId: msg.requestId, text: msg.text, startedAt: msg.startedAt });
        if (msg.tabId) {
          chrome.tabs
            .sendMessage(msg.tabId, {
              type: 'OCR_PARTIAL',
              requestId: msg.requestId,
              text: msg.text,
            })
            .catch(() => {});
        }
        sendResponse({ ok: true });
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
    // These failures are already reported to the user (status line, dashboard
    // banner). Logging them as errors would badge the extension in
    // chrome://extensions even though nothing is broken.
    const detail = err instanceof Error ? err.message : String(err);
    const expected =
      err instanceof VisionError ||
      /permission denied|rules|session expired|network|no API key|not configured/i.test(detail);
    const log = expected ? console.warn : console.error;
    log('[ocr] message failed:', (msg as { type?: string })?.type, detail);
    sendResponse({ ok: false, error: errorMessage(err) });
  });
  return true; // async response
});
