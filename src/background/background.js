import { cleanText } from '../ocr/text-detector.js';

const DEFAULT_SETTINGS = { language: 'eng', removeLineBreaks: true, mergeSpaces: true };

// ---------- storage helpers (settings in sync, history in local) ----------
async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...s };
}

async function saveHistoryEntry(entry) {
  const { history = [] } = await chrome.storage.local.get({ history: [] });
  history.unshift(entry);
  await chrome.storage.local.set({ history: history.slice(0, 100) });
}

// ---------- offscreen ----------
const OFFSCREEN_URL = 'offscreen/offscreen.html';
let creatingOffscreen = null;

async function offscreenExists() {
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

async function ensureOffscreen() {
  // Never blindly create: Chrome allows only ONE offscreen document.
  if (await offscreenExists()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS', 'CLIPBOARD'],
        justification: 'Run Tesseract.js OCR and crop screenshots off the main thread',
      })
      .catch((e) => {
        // Lost a race with another call — document exists, that's fine.
        if (!/already exists|single offscreen document/i.test(String(e?.message || e))) throw e;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

// Ask the offscreen document to OCR an image (it has DOM + canvas + workers).
// Retries while the document is still loading its scripts; resets it if wedged.
async function ocrViaOffscreen({ imageData, area, language, dpr }) {
  const payload = { imageData, area, language, dpr };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await ensureOffscreen();
    try {
      return await chrome.runtime.sendMessage({ type: 'OCR_RUN', payload });
    } catch (e) {
      lastError = e;
      await sleep(attempt === 0 ? 500 : 1500);
    }
  }
  // Last resort: close a possibly wedged document and start fresh once.
  try {
    await chrome.offscreen.closeDocument().catch(() => {});
    await ensureOffscreen();
    return await chrome.runtime.sendMessage({ type: 'OCR_RUN', payload });
  } catch (e) {
    throw lastError || e;
  }
}

async function fetchAsDataUrl(url) {
  const res = await fetch(url);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function processResult(raw, settings, extra = {}) {
  const text = cleanText(raw.text || '', {
    removeLineBreaks: settings.removeLineBreaks,
    mergeSpaces: settings.mergeSpaces,
  });
  const entry = {
    id: crypto.randomUUID(),
    text,
    confidence: Math.round(raw.confidence || 0),
    timestamp: Date.now(),
    language: settings.language,
    ...extra,
  };
  if (text) await saveHistoryEntry(entry);
  return entry;
}

function openSidePanel(windowId) {
  // sidePanel.open must be called during a user gesture chain where possible
  return chrome.sidePanel.open({ windowId }).catch(() => {});
}

// Full pipeline for a selected screen area
async function ocrSelection({ tabId, windowId, area, dpr, language }) {
  const settings = await getSettings();
  const screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const raw = await ocrViaOffscreen({
    imageData: screenshot,
    area,
    language: language || settings.language,
    dpr: dpr || 1,
  });
  if (raw?.error) throw new Error(raw.error);
  return await processResult(raw, settings, { area });
}

// ---------- install ----------
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.create({
    id: 'ocr-right-click',
    title: 'Extract text from this image',
    contexts: ['image'],
  });
  const cur = await chrome.storage.sync.get(DEFAULT_SETTINGS);
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
    // send text back to the tab so the content script can copy + toast
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'OCR_DONE', entry }).catch(() => {});
    if (tab?.windowId) openSidePanel(tab.windowId);
  } catch (err) {
    console.error('[ocr] right-click failed:', err);
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'OCR_FAILED', error: String(err?.message || err) }).catch(() => {});
  }
});

// ---------- selection trigger (with injection fallback) ----------
function isRestrictedUrl(url = '') {
  return /^(chrome|edge|about|chrome-extension|moz-extension|view-source):|^https:\/\/(chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/.test(url);
}

function notifyBlocked(tab) {
  const where = isRestrictedUrl(tab?.url)
    ? 'Extensions cannot run on this page (try a normal website like wikipedia.org).'
    : 'Could not reach the page. Refresh the tab and try again.';
  chrome.notifications
    .create({ type: 'basic', iconUrl: 'icons/icon48.png', title: 'Image to Text OCR', message: where })
    .catch(() => {});
}

async function triggerSelection(tab) {
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
      return { ok: false, error: String(err?.message || err) };
    }
  }
}

// ---------- keyboard shortcut ----------
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-selection') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await triggerSelection(tab);
  if (!res.ok) notifyBlocked(tab);
});

// ---------- messages ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'OCR_CAPTURE': {
        // from content script: { area, dpr, language? }
        const tab = sender.tab;
        const entry = await ocrSelection({
          tabId: tab?.id,
          windowId: tab?.windowId,
          area: message.area,
          dpr: message.dpr,
          language: message.language,
        });
        sendResponse({ ok: true, entry });
        if (tab?.windowId) openSidePanel(tab.windowId);
        // tell the originating tab so it can copy to clipboard + toast
        if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'OCR_DONE', entry }).catch(() => {});
        break;
      }
      case 'OCR_IMAGE_DATA': {
        // from popup paste/upload: { imageData, language? }
        const settings = await getSettings();
        const raw = await ocrViaOffscreen({
          imageData: message.imageData,
          language: message.language || settings.language,
        });
        if (raw?.error) throw new Error(raw.error);
        const entry = await processResult(raw, settings);
        sendResponse({ ok: true, entry });
        break;
      }
      case 'START_SELECTION_POPUP': {
        // from popup button: forward to active tab (with injection fallback)
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const res = await triggerSelection(tab);
        if (!res.ok && isRestrictedUrl(tab?.url)) {
          sendResponse({ ok: false, error: 'BLOCKED_PAGE' });
        } else {
          sendResponse(res);
        }
        break;
      }
      case 'GET_SETTINGS':
        sendResponse({ ok: true, settings: await getSettings() });
        break;
      case 'SAVE_SETTINGS':
        await chrome.storage.sync.set(message.settings || {});
        sendResponse({ ok: true });
        break;
      case 'GET_HISTORY': {
        const { history = [] } = await chrome.storage.local.get({ history: [] });
        sendResponse({ ok: true, history });
        break;
      }
      case 'CLEAR_HISTORY':
        await chrome.storage.local.set({ history: [] });
        sendResponse({ ok: true });
        break;
      case 'DELETE_ENTRY': {
        const { history = [] } = await chrome.storage.local.get({ history: [] });
        await chrome.storage.local.set({ history: history.filter((e) => e.id !== message.id) });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })().catch((err) => {
    console.error('[ocr] message failed:', message?.type, err);
    sendResponse({ ok: false, error: String(err?.message || err) });
  });
  return true; // async response
});
