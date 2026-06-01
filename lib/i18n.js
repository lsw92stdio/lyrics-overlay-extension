/**
 * i18n helper — wraps chrome.i18n.getMessage
 * Usage:
 *   t('key')                → translated string (falls back to key)
 *   t('key', ['arg1'])      → with substitutions
 *   I18n.applyToDOM()       → applies data-i18n / data-i18n-placeholder / data-i18n-title
 */
const I18n = (() => {
  function t(key, subs) {
    if (typeof chrome !== 'undefined' && chrome.i18n) {
      const msg = chrome.i18n.getMessage(key, subs);
      if (msg) return msg;
    }
    return key;
  }

  function applyToDOM(root) {
    const r = root || document;
    r.querySelectorAll('[data-i18n]').forEach(el => {
      const v = t(el.dataset.i18n);
      if (v) el.textContent = v;
    });
    r.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const v = t(el.dataset.i18nPlaceholder);
      if (v) el.placeholder = v;
    });
    r.querySelectorAll('[data-i18n-title]').forEach(el => {
      const v = t(el.dataset.i18nTitle);
      if (v) el.title = v;
    });
    r.querySelectorAll('[data-i18n-html]').forEach(el => {
      const v = t(el.dataset.i18nHtml);
      if (v) el.innerHTML = v;
    });
  }

  return { t, applyToDOM };
})();
