// Image to Text OCR — landing page behaviour.
// No dependencies: theme toggle, mobile nav, scroll reveals, animated stats,
// and click-to-copy for the install command.

(() => {
  'use strict';

  const root = document.documentElement;
  const THEME_KEY = 'ocr-theme';

  const SUN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  const store = {
    get() {
      try {
        return localStorage.getItem(THEME_KEY);
      } catch {
        return null;
      }
    },
    set(value) {
      try {
        localStorage.setItem(THEME_KEY, value);
      } catch {
        /* private mode */
      }
    },
  };

  const effectiveTheme = () => {
    const saved = store.get();
    if (saved === 'dark' || saved === 'light') return saved;
    return media.matches ? 'dark' : 'light';
  };

  function paintToggle(theme) {
    const button = document.getElementById('theme-toggle');
    if (!button) return;
    // show the mode the click switches to
    button.innerHTML = theme === 'dark' ? SUN : MOON;
    const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.setAttribute('aria-pressed', String(theme === 'dark'));
  }

  function applyTheme(theme, persist) {
    if (persist) {
      store.set(theme);
      root.dataset.theme = theme;
    } else {
      const saved = store.get();
      if (saved === 'dark' || saved === 'light') root.dataset.theme = saved;
      else delete root.dataset.theme; // follow the OS
    }
    paintToggle(effectiveTheme());
  }

  applyTheme(effectiveTheme(), false);

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark', true);
  });

  if (media.addEventListener) {
    media.addEventListener('change', () => {
      if (!store.get()) applyTheme(effectiveTheme(), false);
    });
  }

  // ---------------- mobile nav ----------------
  const menuButton = document.getElementById('menu-btn');
  const nav = document.getElementById('site-nav');
  const closeNav = () => {
    document.body.classList.remove('nav-open');
    menuButton?.setAttribute('aria-expanded', 'false');
  };
  menuButton?.addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    menuButton.setAttribute('aria-expanded', String(open));
  });
  nav?.addEventListener('click', (event) => {
    if (event.target instanceof HTMLElement && event.target.tagName === 'A') closeNav();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeNav();
  });
  document.addEventListener('click', (event) => {
    if (!document.body.classList.contains('nav-open')) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.closest('.site-header') || target.closest('.site-nav'))) return;
    closeNav();
  });

  // ---------------- header elevation ----------------
  const header = document.querySelector('.site-header');
  const onScroll = () => header?.classList.toggle('scrolled', window.scrollY > 6);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // ---------------- reveal on scroll ----------------
  const revealTargets = document.querySelectorAll(
    '.section-head, .card, .steps li, .speed-item, .table-wrap, .install-step, .note, .faq details, .flow, .cta-inner',
  );
  revealTargets.forEach((el, index) => {
    el.setAttribute('data-reveal', '');
    el.style.setProperty('--reveal-delay', `${(index % 4) * 70}ms`);
    if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('is-visible');
  });
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.06 },
    );
    revealTargets.forEach((el) => {
      if (!el.classList.contains('is-visible')) observer.observe(el);
    });
  } else {
    revealTargets.forEach((el) => el.classList.add('is-visible'));
  }

  // ---------------- animated stats ----------------
  function countUp(el) {
    const target = Number.parseFloat(el.getAttribute('data-count') || '0');
    const decimals = Number.parseInt(el.getAttribute('data-decimals') || '0', 10);
    if (reduced.matches) {
      el.textContent = target.toFixed(decimals);
      return;
    }
    const duration = 900;
    const started = performance.now();
    const tick = (now) => {
      const progress = Math.min((now - started) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = (target * eased).toFixed(decimals);
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  const counters = document.querySelectorAll('[data-count]');
  if (counters.length) {
    if ('IntersectionObserver' in window) {
      const counterObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            countUp(entry.target);
            counterObserver.unobserve(entry.target);
          }
        },
        { threshold: 0.4 },
      );
      counters.forEach((el) => counterObserver.observe(el));
    } else {
      counters.forEach(countUp);
    }
  }

  // ---------------- copy the install command ----------------
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  document.body.appendChild(toast);
  let toastTimer = 0;
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2000);
  }

  document.querySelectorAll('.code').forEach((block) => {
    block.setAttribute('tabindex', '0');
    block.setAttribute('role', 'button');
    const copy = async () => {
      const text = (block.textContent || '').trim();
      try {
        await navigator.clipboard.writeText(text);
        showToast('Command copied to clipboard');
      } catch {
        showToast('Press Ctrl+C to copy');
      }
    };
    block.addEventListener('click', copy);
    block.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void copy();
      }
    });
  });
})();
