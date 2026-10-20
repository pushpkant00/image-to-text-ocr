// Classic (non-module) script loaded in <head> so the chosen theme is applied
// before first paint. Pages call window.__ocrTheme.mount(button) to wire the
// toggle; the preference lives in localStorage, which every extension page
// shares (same chrome-extension:// origin).
(() => {
  const KEY = 'ocr-theme';
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  const SUN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  function current() {
    return root.dataset.theme === 'dark' ? 'dark' : 'light';
  }

  function preferred() {
    const saved = stored();
    if (saved === 'dark' || saved === 'light') return saved;
    return media.matches ? 'dark' : 'light';
  }

  function apply(theme) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  }

  apply(preferred());

  if (media.addEventListener) {
    media.addEventListener('change', () => {
      const saved = stored();
      if (saved !== 'dark' && saved !== 'light') apply(media.matches ? 'dark' : 'light');
    });
  }

  function mount(button) {
    if (!button) return;
    const sync = () => {
      const theme = current();
      // show the mode the click switches to
      button.innerHTML = theme === 'dark' ? SUN : MOON;
      const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.setAttribute('aria-pressed', String(theme === 'dark'));
    };
    button.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* private mode: still switch for this page */
      }
      apply(next);
      sync();
    });
    sync();
  }

  window.__ocrTheme = { mount, apply, current };
})();
