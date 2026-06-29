document.addEventListener('DOMContentLoaded', async () => {
  if (typeof I18n !== 'undefined') I18n.applyToDOM();

  const tbody = document.getElementById('libraryList');
  const emptyState = document.getElementById('emptyState');
  const btnRefresh = document.getElementById('btnRefresh');
  const searchInput = document.getElementById('searchInput');

  let currentQuery = '';

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>'"]/g, (tag) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag]));
  }

  function matchesQuery(item, q) {
    if (!q) return true;
    const p = item.parsed || {};
    const inKeywords = p.keywords && p.keywords.some((k) => k.toLowerCase().includes(q));
    return (p.index && p.index.includes(q)) ||
      (p.artist && p.artist.toLowerCase().includes(q)) ||
      (p.title && p.title.toLowerCase().includes(q)) ||
      (item.name && item.name.toLowerCase().includes(q)) ||
      inKeywords;
  }

  async function loadData(query) {
    currentQuery = query || '';
    const { savedLyrics = [] } = await chrome.storage.local.get('savedLyrics');
    const q = currentQuery.toLowerCase().trim();

    let list = savedLyrics.filter((item) => matchesQuery(item, q));

    // 번호 있으면 번호순, 없으면 이름순 (popup.js renderLibrary와 동일 규칙)
    list.sort((a, b) => {
      const aIndex = a.parsed?.index ? parseInt(a.parsed.index, 10) : Infinity;
      const bIndex = b.parsed?.index ? parseInt(b.parsed.index, 10) : Infinity;
      if (aIndex !== bIndex) return aIndex - bIndex;
      return (a.name || '').localeCompare(b.name || '');
    });

    tbody.innerHTML = '';

    if (list.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }
    emptyState.classList.add('hidden');

    for (const item of list) {
      const p = item.parsed || {};
      const tr = document.createElement('tr');
      tr.dataset.id = item.id;

      const fieldNames = ['index', 'titleOrig', 'titleKo', 'artistOrig', 'artistKo', 'keywords', 'videoSyncs'];
      const inputs = {};

      fieldNames.forEach((field) => {
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = `row-input col-${field.toLowerCase()}`;
        if (field === 'keywords') input.value = (p.keywords || []).join(', ');
        else if (field === 'videoSyncs') input.value = SheetParser.stringifyVideoSyncs(item.videoSyncs);
        else input.value = p[field] || '';
        inputs[field] = input;
        td.appendChild(input);
        tr.appendChild(td);
      });

      // Auto Only 체크박스
      const tdAuto = document.createElement('td');
      tdAuto.className = 'col-autoonly';
      const cbAuto = document.createElement('input');
      cbAuto.type = 'checkbox';
      cbAuto.checked = !!item.autoOnly;
      tdAuto.appendChild(cbAuto);
      tr.appendChild(tdAuto);

      // 동작 (저장/삭제)
      const tdActions = document.createElement('td');
      tdActions.className = 'row-actions';

      const btnSave = document.createElement('button');
      btnSave.className = 'btn-primary';
      btnSave.textContent = I18n.t('btn_save') || 'Save';
      btnSave.addEventListener('click', () => saveRow(item.id, {
        index: inputs.index.value,
        titleOrig: inputs.titleOrig.value,
        titleKo: inputs.titleKo.value,
        artistOrig: inputs.artistOrig.value,
        artistKo: inputs.artistKo.value,
        keywords: inputs.keywords.value,
        videoSyncs: inputs.videoSyncs.value,
        autoOnly: cbAuto.checked,
      }));

      const btnEditSrt = document.createElement('button');
      btnEditSrt.className = 'btn-secondary';
      btnEditSrt.textContent = I18n.t('btn_edit_subtitle') || 'Edit Subtitles';
      btnEditSrt.addEventListener('click', () => {
        chrome.windows.create({
          url: chrome.runtime.getURL(`subtitle-editor/subtitle-editor.html?id=${encodeURIComponent(item.id)}`),
          type: 'popup',
          width: 900,
          height: 700
        });
      });

      const btnDelete = document.createElement('button');
      btnDelete.className = 'btn-danger';
      btnDelete.textContent = I18n.t('btn_delete') || 'Delete';
      btnDelete.addEventListener('click', () => deleteRow(item.id, item.name));

      tdActions.appendChild(btnSave);
      tdActions.appendChild(btnEditSrt);
      tdActions.appendChild(btnDelete);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
  }

  async function saveRow(id, fields) {
    const { savedLyrics = [] } = await chrome.storage.local.get('savedLyrics');
    const idx = savedLyrics.findIndex((l) => l.id === id);
    if (idx < 0) return;

    const titleOrig = fields.titleOrig.trim();
    const titleKo = fields.titleKo.trim();
    const artistOrig = fields.artistOrig.trim();
    const artistKo = fields.artistKo.trim();

    // Auto Only는 번호를 채번/유지하지 않음 (popup.js mergeLyrics / content.js
    // autoSyncFromSheetIfEmpty에 이미 적용된 규칙과 동일하게 유지)
    const index = fields.autoOnly ? '' : fields.index.trim();

    // 번호 충돌 검사: 다른 항목이 이미 같은 번호를 쓰면 저장 거부.
    // (자동으로 다른 번호를 골라 바꿔버리면 사용자가 명시적으로 고른 값을 조용히
    // 바꾸게 되어 혼란스러우므로, 충돌 시에는 알리고 사용자가 직접 다시 정하게 한다.)
    if (index && savedLyrics.some((l, i) => i !== idx && l.parsed && l.parsed.index === index)) {
      alert(I18n.t('alert_index_conflict') || '이미 사용 중인 번호입니다.');
      return;
    }

    const parsed = {
      index,
      artistOrig, artistKo,
      artist: artistKo ? `${artistOrig} (${artistKo})` : artistOrig,
      titleOrig, titleKo,
      title: titleKo ? `${titleOrig} (${titleKo})` : titleOrig,
      original: savedLyrics[idx].parsed?.original || savedLyrics[idx].name,
      keywords: fields.keywords.split(',').map((k) => k.trim()).filter(Boolean),
    };

    savedLyrics[idx].parsed = parsed;
    savedLyrics[idx].name = SheetParser.buildStandardName(parsed);
    if (fields.autoOnly) savedLyrics[idx].autoOnly = true;
    else delete savedLyrics[idx].autoOnly;
    savedLyrics[idx].videoSyncs = SheetParser.parseVideoSyncs(fields.videoSyncs);
    savedLyrics[idx].updatedAt = Date.now();

    await chrome.storage.local.set({ savedLyrics });
    loadData(currentQuery);
  }

  async function deleteRow(id, name) {
    if (!confirm(`${I18n.t('btn_delete') || 'Delete'}: ${name}?`)) return;
    const { savedLyrics = [] } = await chrome.storage.local.get('savedLyrics');
    await chrome.storage.local.set({ savedLyrics: savedLyrics.filter((l) => l.id !== id) });
    loadData(currentQuery);
  }

  btnRefresh.addEventListener('click', () => loadData(searchInput.value));
  searchInput.addEventListener('input', () => loadData(searchInput.value));

  loadData('');
});
