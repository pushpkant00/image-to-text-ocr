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
      removeBreaks.checked = s.removeLineBreaks !== false;
      mergeSpaces.checked = s.mergeSpaces !== false;
      showResultCard.checked = s.showResultCard !== false;
      openHistory.checked = s.openHistoryAfterOcr !== false;
      autoDownload.checked = s.autoDownload === true;
    } catch {
      /* keep the defaults already rendered */
    }
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

  // ---------- danger zone (account deletion) ----------
  const dangerZone = q<HTMLElement>('danger-zone');
  const deleteAccountBtn = q<HTMLButtonElement>('delete-account-btn');
  const deleteConfirm = q<HTMLDivElement>('delete-confirm');
  const deletePassword = q<HTMLInputElement>('delete-password');
  const deleteStatus = q<HTMLDivElement>('delete-status');
  const deleteConfirmBtn = q<HTMLButtonElement>('delete-confirm-btn');
  const deleteCancelBtn = q<HTMLButtonElement>('delete-cancel-btn');
  let accountEmail = '';
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

  async function initDangerZone(): Promise<void> {
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'AUTH_STATE' })) as AccountResponse;
      const user = res?.ok ? res.user ?? null : null;
      if (!user) {
        dangerZone.classList.add('hidden');
        return;
      }
      accountEmail = user.email;
      dangerZone.classList.remove('hidden');
    } catch {
      dangerZone.classList.add('hidden');
    }
  }

  async function doDeleteAccount(): Promise<void> {
    if (dangerBusy) return;
    const password = deletePassword.value;
    if (!password) {
      setDeleteStatus('Enter your password to confirm.', 'error');
      return;
    }
    setDangerBusy(true);
    try {
      setDeleteStatus('Deleting account…');
      const res = (await chrome.runtime.sendMessage({
        type: 'AUTH_DELETE',
        email: accountEmail,
        password,
      })) as SimpleResponse;
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
    deletePassword.value = '';
    if (!deleteConfirm.classList.contains('hidden')) deletePassword.focus();
  });
  deleteCancelBtn.addEventListener('click', () => {
    deleteConfirm.classList.add('hidden');
    setDeleteStatus('');
    deletePassword.value = '';
  });
  deleteConfirmBtn.addEventListener('click', () => void doDeleteAccount());
  deletePassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doDeleteAccount();
  });

  void load();
  void initDangerZone();
});
