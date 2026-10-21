interface SettingsResponse {
  ok?: boolean;
  settings?: Partial<OCRSettings>;
  error?: string;
}

interface AccountResponse {
  ok?: boolean;
  user?: AuthUser | null;
  error?: string;
}

interface SimpleResponse {
  ok?: boolean;
  error?: string;
  ms?: number;
  note?: string;
  exhausted?: boolean;
}

document.addEventListener('DOMContentLoaded', () => {
  const q = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not found`);
    return el as T;
  };

  const languageSelect = q<HTMLSelectElement>('language-select');
  const removeBreaks = q<HTMLInputElement>('remove-breaks');
  const mergeSpaces = q<HTMLInputElement>('merge-spaces');
  const showResultCard = q<HTMLInputElement>('show-result-card');
  const openHistory = q<HTMLInputElement>('open-history');
  const autoDownload = q<HTMLInputElement>('auto-download');

  // ---------- cloud OCR ----------
  const visionModelSelect = q<HTMLSelectElement>('vision-model');
  const openRouterModels = document.getElementById('openrouter-models');
  const keyLabel = q<HTMLElement>('vision-key-label');
  const keyHelp = q<HTMLElement>('vision-key-help');
  const keyLink = q<HTMLElement>('vision-key-link');
  const keyInput = q<HTMLInputElement>('vision-key');
  const keyToggle = q<HTMLButtonElement>('key-toggle');
  const keySave = q<HTMLButtonElement>('key-save');
  const keyTest = q<HTMLButtonElement>('key-test');
  const keyClear = q<HTMLButtonElement>('key-clear');
  const keyStatus = q<HTMLElement>('key-status');
  const keyMissing = q<HTMLElement>('key-missing');

  interface VisionKeyResponse {
    ok?: boolean;
    apiKey?: string;
    error?: string;
  }

  let hasSavedKey = false;

  type Provider = 'google' | 'openrouter';

  function selectedProvider(): Provider {
    return visionModelSelect.value.startsWith('openrouter:') ? 'openrouter' : 'google';
  }

  function providerCopy(provider: Provider): {
    label: string;
    help: string;
    link: string;
    placeholder: string;
  } {
    if (provider === 'openrouter') {
      return {
        label: 'OpenRouter API key',
        help: 'Stored on this device only and sent straight to OpenRouter. Free models allow about 20 requests a minute and 50 a day.',
        link: 'Get a free key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">openrouter.ai/keys</a>.',
        placeholder: 'sk-or-v1…',
      };
    }
    return {
      label: 'Gemini API key',
      help: 'Stored on this device only and sent straight to Google. Never synced, never sent to our server.',
      link: 'Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">aistudio.google.com/apikey</a>.',
      placeholder: 'AIza…',
    };
  }

  function setKeyStatus(message: string, kind: '' | 'success' | 'error' = ''): void {
    keyStatus.textContent = message;
    keyStatus.classList.remove('hidden', 'success', 'error');
    if (!message) {
      keyStatus.classList.add('hidden');
      return;
    }
    if (kind) keyStatus.classList.add(kind);
  }

  function refreshKeyUi(): void {
    const copy = providerCopy(selectedProvider());
    keyLabel.textContent = copy.label;
    keyHelp.textContent = copy.help;
    keyLink.innerHTML = copy.link;
    keyClear.classList.toggle('hidden', !hasSavedKey);
    keyInput.placeholder = hasSavedKey ? 'Saved key — paste a new one to replace' : copy.placeholder;
    keyInput.value = '';
    // Make an unsaved key obvious before someone presses Test and wonders why
    // the provider says the key is missing.
    keyMissing.textContent = hasSavedKey
      ? ''
      : `No ${selectedProvider() === 'openrouter' ? 'OpenRouter' : 'Gemini'} key saved on this device yet — paste one and press Save.`;
    keyMissing.classList.toggle('hidden', hasSavedKey);
  }

  async function loadKey(): Promise<void> {
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'GET_VISION_KEY',
        provider: selectedProvider(),
      })) as VisionKeyResponse;
      hasSavedKey = Boolean(res?.apiKey);
    } catch {
      /* leave the UI in its default state */
    }
    refreshKeyUi();
  }

  /** Fill the OpenRouter group with the free image models it serves today. */
  async function loadOpenRouterModels(): Promise<void> {
    if (!openRouterModels) return;
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        data?: {
          id?: string;
          name?: string;
          pricing?: { prompt?: string; completion?: string };
          architecture?: { input_modalities?: string[] };
        }[];
      };
      const free = (body.data || []).filter((m) => {
        const isFree =
          m.id?.endsWith(':free') &&
          (m.pricing?.prompt === '0' || m.pricing?.prompt === '0.0') &&
          (m.pricing?.completion === '0' || m.pricing?.completion === '0.0');
        return Boolean(isFree && (m.architecture?.input_modalities || []).includes('image'));
      });
      if (!free.length) return;
      openRouterModels.textContent = '';
      for (const model of free) {
        const option = document.createElement('option');
        option.value = `openrouter:${model.id}`;
        option.textContent = model.name || model.id || '';
        openRouterModels.appendChild(option);
      }
    } catch {
      /* offline or blocked: keep the built-in fallback list */
    }
  }

  let saveTimer: number | undefined;

  function flash(control: HTMLElement, ok: boolean): void {
    const status = control.closest('.panel')?.querySelector('.save-status');
    if (!(status instanceof HTMLElement)) return;
    status.textContent = ok ? 'Saved' : "Couldn't save — try again";
    status.classList.toggle('error', !ok);
    status.classList.remove('hidden');
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => status.classList.add('hidden'), 2000);
  }

  async function load(): Promise<void> {
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })) as SettingsResponse;
      const s: Partial<OCRSettings> = res?.settings || {};
      languageSelect.value = s.language || 'eng';
      const storedModel = s.visionModel || '';
      const knownModel = Array.from(visionModelSelect.options).some((o) => o.value === storedModel);
      if (!knownModel && storedModel.startsWith('openrouter:')) {
        // A model that dropped off the live list: keep showing it so the choice
        // on screen matches what OCR will actually use.
        const option = document.createElement('option');
        option.value = storedModel;
        option.textContent = `${storedModel.slice('openrouter:'.length)} (currently unavailable)`;
        (openRouterModels || visionModelSelect).appendChild(option);
      }
      visionModelSelect.value =
        knownModel || storedModel.startsWith('openrouter:') ? storedModel : 'google:gemini-3.5-flash';
      removeBreaks.checked = s.removeLineBreaks !== false;
      mergeSpaces.checked = s.mergeSpaces !== false;
      showResultCard.checked = s.showResultCard !== false;
      openHistory.checked = s.openHistoryAfterOcr !== false;
      autoDownload.checked = s.autoDownload === true;
    } catch {
      /* keep the defaults already rendered */
    }
    await loadKey();
  }

  async function save(control: HTMLElement, settings: Partial<OCRSettings>): Promise<void> {
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings })) as SettingsResponse;
      flash(control, res?.ok === true);
    } catch {
      flash(control, false);
    }
  }

  languageSelect.addEventListener('change', () => save(languageSelect, { language: languageSelect.value }));
  removeBreaks.addEventListener('change', () => save(removeBreaks, { removeLineBreaks: removeBreaks.checked }));
  mergeSpaces.addEventListener('change', () => save(mergeSpaces, { mergeSpaces: mergeSpaces.checked }));
  showResultCard.addEventListener('change', () => save(showResultCard, { showResultCard: showResultCard.checked }));
  openHistory.addEventListener('change', () => save(openHistory, { openHistoryAfterOcr: openHistory.checked }));
  autoDownload.addEventListener('change', () => save(autoDownload, { autoDownload: autoDownload.checked }));

  visionModelSelect.addEventListener('change', async () => {
    setKeyStatus('');
    await save(visionModelSelect, { visionModel: visionModelSelect.value });
    await loadKey();
  });

  keyToggle.addEventListener('click', () => {
    const show = keyInput.type === 'password';
    keyInput.type = show ? 'text' : 'password';
    keyToggle.textContent = show ? 'Hide' : 'Show';
  });

  async function saveKey(announce = true): Promise<boolean> {
    const apiKey = keyInput.value.trim();
    if (!apiKey) {
      if (announce) {
        setKeyStatus('Paste your key first.', 'error');
        keyInput.focus();
      }
      return false;
    }
    keySave.disabled = true;
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'SAVE_VISION_KEY',
        apiKey,
        provider: selectedProvider(),
      })) as SimpleResponse;
      if (res?.ok) {
        hasSavedKey = true;
        refreshKeyUi();
        setKeyStatus('Key saved on this device.', 'success');
        return true;
      }
      setKeyStatus(res?.error || "Couldn't save the key.", 'error');
    } catch {
      setKeyStatus("Couldn't save the key.", 'error');
    } finally {
      keySave.disabled = false;
    }
    return false;
  }

  async function testKey(): Promise<void> {
    const typed = keyInput.value.trim();
    if (!typed && !hasSavedKey) {
      setKeyStatus('Save a key first.', 'error');
      return;
    }
    keyTest.disabled = true;
    setKeyStatus('Testing…');
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'TEST_VISION_KEY',
        apiKey: typed || undefined,
        model: visionModelSelect.value,
        provider: selectedProvider(),
      })) as SimpleResponse;
      if (res?.ok) {
        if (res.exhausted) {
          setKeyStatus(
            `Key is valid, but ${res.note}. Free requests resume at 00:00 UTC — pick a Gemini model to keep working now.`,
            'error',
          );
        } else if (res.note) {
          setKeyStatus(`Key works — ${res.note}.`, 'success');
        } else {
          const seconds = typeof res.ms === 'number' ? ` in ${(res.ms / 1000).toFixed(1)}s` : '';
          setKeyStatus(`Key works — the model replied${seconds}.`, 'success');
        }
      } else setKeyStatus(res?.error || 'The model rejected this key.', 'error');
    } catch (err) {
      setKeyStatus(err instanceof Error ? err.message : 'Test failed.', 'error');
    } finally {
      keyTest.disabled = false;
    }
  }

  keySave.addEventListener('click', () => void saveKey());
  keyTest.addEventListener('click', () => void testKey());

  // Enter saves; pasting a key saves and verifies it, so a key can't sit
  // unsaved in the box while OCR keeps reporting "no key configured".
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void saveKey();
    }
  });
  keyInput.addEventListener('paste', () => {
    // Save automatically so a key can't sit unsaved while OCR reports "no key";
    // leave the Test click to the user.
    window.setTimeout(() => {
      if (keyInput.value.trim().length > 20) void saveKey(false);
    }, 30);
  });

  keyClear.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'CLEAR_VISION_KEY', provider: selectedProvider() });
      hasSavedKey = false;
      refreshKeyUi();
      setKeyStatus('Key removed.', '');
    } catch {
      setKeyStatus("Couldn't remove the key.", 'error');
    }
  });

  // ---------- danger zone (account deletion) ----------
  const dangerZone = q<HTMLElement>('danger-zone');
  const userMenu = q<HTMLElement>('user-menu');
  const avatar = q<HTMLSpanElement>('avatar');
  const userEmail = q<HTMLSpanElement>('user-email');
  const signOutBtn = q<HTMLButtonElement>('sign-out-btn');
  const deleteAccountBtn = q<HTMLButtonElement>('delete-account-btn');
  const deleteConfirm = q<HTMLDivElement>('delete-confirm');
  const deleteConfirmText = q<HTMLInputElement>('delete-confirm-text');
  const deleteStatus = q<HTMLDivElement>('delete-status');
  const deleteConfirmBtn = q<HTMLButtonElement>('delete-confirm-btn');
  const deleteCancelBtn = q<HTMLButtonElement>('delete-cancel-btn');
  let dangerBusy = false;

  function setDangerBusy(value: boolean): void {
    dangerBusy = value;
    [deleteAccountBtn, deleteConfirmBtn, deleteCancelBtn].forEach((b) => {
      b.disabled = value;
    });
  }

  function setDeleteStatus(message: string, kind = ''): void {
    deleteStatus.textContent = message;
    deleteStatus.classList.remove('hidden', 'error', 'success', 'warn');
    if (message) deleteStatus.classList.add(kind);
    else deleteStatus.classList.add('hidden');
  }

  async function loadAccount(): Promise<void> {
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'AUTH_STATE' })) as AccountResponse;
      const user = res?.ok ? res.user ?? null : null;
      if (!user) {
        dangerZone.classList.add('hidden');
        userMenu.classList.add('hidden');
        return;
      }
      avatar.textContent = (user.email || '?').trim().charAt(0).toUpperCase() || '?';
      userEmail.textContent = user.email || '';
      dangerZone.classList.remove('hidden');
      userMenu.classList.remove('hidden');
    } catch {
      dangerZone.classList.add('hidden');
      userMenu.classList.add('hidden');
    }
  }

  signOutBtn.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'AUTH_SIGN_OUT' });
    } finally {
      window.location.replace('signin.html');
    }
  });

  async function doDeleteAccount(): Promise<void> {
    if (dangerBusy) return;
    if (deleteConfirmText.value.trim().toUpperCase() !== 'DELETE') {
      setDeleteStatus('Type DELETE to confirm.', 'error');
      return;
    }
    setDangerBusy(true);
    try {
      setDeleteStatus('Confirming with Google, then deleting…');
      const res = (await chrome.runtime.sendMessage({ type: 'AUTH_DELETE' })) as SimpleResponse;
      if (!res?.ok) {
        setDeleteStatus(res?.error || 'Delete failed', 'error');
        return;
      }
      window.location.replace('signin.html');
    } catch {
      setDeleteStatus('Delete failed — try again.', 'error');
    } finally {
      setDangerBusy(false);
    }
  }

  deleteAccountBtn.addEventListener('click', () => {
    deleteConfirm.classList.toggle('hidden');
    setDeleteStatus('');
    deleteConfirmText.value = '';
    if (!deleteConfirm.classList.contains('hidden')) deleteConfirmText.focus();
  });
  deleteCancelBtn.addEventListener('click', () => {
    deleteConfirm.classList.add('hidden');
    setDeleteStatus('');
    deleteConfirmText.value = '';
  });
  deleteConfirmBtn.addEventListener('click', () => void doDeleteAccount());
  deleteConfirmText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doDeleteAccount();
  });

  window.__ocrTheme?.mount(document.getElementById('theme-toggle'));

  void (async () => {
    await loadOpenRouterModels();
    await load();
  })();
  void loadAccount();
});
