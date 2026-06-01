const heroSubs = {
  ko: '싱크 가사 오버레이 — 사용 가이드',
  en: 'Sync Lyrics Overlay — User Guide',
  ja: '同期歌詞オーバーレイ — 使い方ガイド'
};

function switchLang(lang) {
  document.querySelectorAll('.lang-section').forEach(el => el.classList.remove('visible'));
  document.querySelectorAll('.lang-btn').forEach(el => el.classList.remove('active'));

  const section = document.querySelector(`.lang-section[data-lang="${lang}"]`);
  const btn = document.querySelector(`.lang-btn[data-lang="${lang}"]`);
  if (section) section.classList.add('visible');
  if (btn) btn.classList.add('active');

  document.getElementById('heroSub').textContent = heroSubs[lang] || heroSubs.en;
  localStorage.setItem('helpLang', lang);
}

function detectLang() {
  const saved = localStorage.getItem('helpLang');
  if (saved && ['ko', 'en', 'ja'].includes(saved)) return saved;
  const ui = (navigator.language || 'en').toLowerCase();
  if (ui.startsWith('ko')) return 'ko';
  if (ui.startsWith('ja')) return 'ja';
  return 'en';
}

document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => switchLang(btn.dataset.lang));
});

switchLang(detectLang());
