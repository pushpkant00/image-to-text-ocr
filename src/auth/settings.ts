interface SettingsResponse {
  ok?: boolean;
  settings?: Partial<OCRSettings>;
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

  void load();
});
