document.addEventListener('DOMContentLoaded', async () => {
  if (typeof I18n !== 'undefined') I18n.applyToDOM();

  const params = new URLSearchParams(window.location.search);
  const itemId = params.get('id');

  const trackTitle = document.getElementById('trackTitle');
  const entriesList = document.getElementById('entriesList');
  const bulkSyncMs = document.getElementById('bulkSyncMs');
  const btnApplySync = document.getElementById('btnApplySync');
  const pasteTarget = document.getElementById('pasteTarget');
  const pasteArea = document.getElementById('pasteArea');
  const btnCopyColumn = document.getElementById('btnCopyColumn');
  const btnApplyPaste = document.getElementById('btnApplyPaste');
  const btnCancel = document.getElementById('btnCancel');
  const btnSave = document.getElementById('btnSave');
  const pastePreviewModal = document.getElementById('pastePreviewModal');
  const pastePreviewList = document.getElementById('pastePreviewList');
  const btnPastePreviewCancel = document.getElementById('btnPastePreviewCancel');
  const btnPastePreviewConfirm = document.getElementById('btnPastePreviewConfirm');

  let libraryItem = null;
  let rows = [];
  let pendingPaste = null; // { target, lines }

  function linesToTriplet(lines) {
    if (lines.length === 1) return { orig: '', pron: '', trans: lines[0] };
    if (lines.length === 2) return { orig: lines[0], pron: '', trans: lines[1] };
    if (lines.length === 3) return { orig: lines[0], pron: lines[1], trans: lines[2] };
    return { orig: '', pron: '', trans: '' };
  }

  function tripletToLines(t) {
    return [t.orig, t.pron, t.trans].map(s => (s || '').trim()).filter(Boolean);
  }

  const { savedLyrics = [] } = await chrome.storage.local.get('savedLyrics');
  libraryItem = savedLyrics.find(l => l.id === itemId);

  if (!libraryItem) {
    trackTitle.textContent = 'Not found';
    return;
  }

  trackTitle.textContent = libraryItem.parsed?.title || libraryItem.name;

  const entries = SRTParser.parse(libraryItem.srtText || '');
  rows = entries.map(e => ({
    startTime: e.startTime,
    endTime: e.endTime,
    ...linesToTriplet(e.lines)
  }));

  function renderRows() {
    entriesList.innerHTML = '';
    rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      tr.dataset.idx = i;

      const tdStart = document.createElement('td');
      const inputStart = document.createElement('input');
      inputStart.type = 'text';
      inputStart.className = 'row-input col-time';
      inputStart.value = SRTParser.toSRTTimestamp(row.startTime);
      inputStart.addEventListener('change', () => { row.startTime = SRTParser.parseTimestamp(inputStart.value); });
      tdStart.appendChild(inputStart);

      const tdEnd = document.createElement('td');
      const inputEnd = document.createElement('input');
      inputEnd.type = 'text';
      inputEnd.className = 'row-input col-time';
      inputEnd.value = SRTParser.toSRTTimestamp(row.endTime);
      inputEnd.addEventListener('change', () => { row.endTime = SRTParser.parseTimestamp(inputEnd.value); });
      tdEnd.appendChild(inputEnd);

      tr.appendChild(tdStart);
      tr.appendChild(tdEnd);

      ['orig', 'pron', 'trans'].forEach(field => {
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'row-input';
        input.value = row[field] || '';
        input.addEventListener('input', () => { row[field] = input.value; });
        td.appendChild(input);
        tr.appendChild(td);
      });

      entriesList.appendChild(tr);
    });
  }

  function refreshTimeInputs() {
    entriesList.querySelectorAll('tr').forEach(tr => {
      const i = parseInt(tr.dataset.idx, 10);
      const inputs = tr.querySelectorAll('input.col-time');
      inputs[0].value = SRTParser.toSRTTimestamp(rows[i].startTime);
      inputs[1].value = SRTParser.toSRTTimestamp(rows[i].endTime);
    });
  }

  renderRows();

  btnApplySync.addEventListener('click', () => {
    const delta = parseInt(bulkSyncMs.value, 10) || 0;
    if (!delta) return;
    rows.forEach(r => {
      r.startTime = Math.max(0, r.startTime + delta);
      r.endTime = Math.max(r.startTime + 1, r.endTime + delta);
    });
    refreshTimeInputs();
  });

  btnCopyColumn.addEventListener('click', async () => {
    const target = pasteTarget.value;
    const text = rows.map(r => r[target] || '').join('\n');
    try {
      await navigator.clipboard.writeText(text);
      const original = btnCopyColumn.textContent;
      btnCopyColumn.textContent = I18n.t('btn_copied') || 'Copied!';
      setTimeout(() => { btnCopyColumn.textContent = original; }, 1000);
    } catch (err) {
      alert(I18n.t('toast_copy_failed') || 'Failed to copy to clipboard.');
    }
  });

  btnApplyPaste.addEventListener('click', () => {
    const target = pasteTarget.value;
    const pastedLines = pasteArea.value.split('\n').map(l => l.trim());
    const count = Math.min(pastedLines.length, rows.length);

    if (pastedLines.length !== rows.length) {
      alert(I18n.t('alert_paste_count_mismatch') || 'Pasted line count differs from subtitle count.');
    }

    pastePreviewList.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const tr = document.createElement('tr');
      const tdBefore = document.createElement('td');
      tdBefore.className = 'before-cell';
      tdBefore.textContent = rows[i][target] || '(없음)';
      const tdAfter = document.createElement('td');
      tdAfter.className = 'after-cell';
      tdAfter.textContent = pastedLines[i] || '(없음)';
      tr.appendChild(tdBefore);
      tr.appendChild(tdAfter);
      pastePreviewList.appendChild(tr);
    }

    pendingPaste = { target, lines: pastedLines.slice(0, count) };
    pastePreviewModal.classList.add('visible');
  });

  btnPastePreviewCancel.addEventListener('click', () => {
    pendingPaste = null;
    pastePreviewModal.classList.remove('visible');
  });

  btnPastePreviewConfirm.addEventListener('click', () => {
    if (!pendingPaste) return;
    const { target, lines } = pendingPaste;
    lines.forEach((line, i) => { rows[i][target] = line; });
    pendingPaste = null;
    pastePreviewModal.classList.remove('visible');
    renderRows();
  });

  btnCancel.addEventListener('click', () => window.close());

  btnSave.addEventListener('click', async () => {
    const newEntries = rows
      .map(r => ({ startTime: r.startTime, endTime: r.endTime, lines: tripletToLines(r) }))
      .filter(e => e.lines.length > 0);

    const srtText = SRTParser.stringify(newEntries);
    const { savedLyrics: current = [] } = await chrome.storage.local.get('savedLyrics');
    const idx = current.findIndex(l => l.id === itemId);
    if (idx < 0) { window.close(); return; }

    current[idx].srtText = srtText;
    current[idx].updatedAt = Date.now();
    await chrome.storage.local.set({ savedLyrics: current });
    window.close();
  });
});
