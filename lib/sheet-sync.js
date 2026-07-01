// 팝업/백그라운드 양쪽에서 공유하는 구글 시트 동기화 로직 (UI 부작용 없음)
const SheetSync = (() => {
  // popup.js의 mergeLyrics와 동일한 병합 로직. renderLibrary() 등 UI 호출은 하지 않는다.
  async function mergeLyricsIntoStorage(newLyrics) {
    const data = await new Promise(resolve => chrome.storage.local.get(['savedLyrics'], resolve));
    let list = data.savedLyrics || [];
    let added = 0;
    let updated = 0;
    let autoOnlyAdded = 0;
    let autoOnlyUpdated = 0;

    let maxIdx = 0;
    list.forEach(item => {
      if (item.parsed && item.parsed.index) {
        const idx = parseInt(item.parsed.index, 10);
        if (!isNaN(idx) && idx > maxIdx) maxIdx = idx;
      }
    });

    newLyrics.forEach(newItem => {
      if (!newItem.srtText) return;

      const rawNameToParse = (newItem.parsed && newItem.parsed.original) ? newItem.parsed.original : newItem.name;
      const parsed = SheetParser.parseFileName(rawNameToParse);

      if (!parsed.index && newItem.parsed && newItem.parsed.index) {
        parsed.index = newItem.parsed.index;
      }

      if (newItem.parsed && newItem.parsed.keywords) {
        parsed.keywords = newItem.parsed.keywords;
      }

      const existingIndex = list.findIndex(l => {
        if (l.parsed && l.parsed.artistOrig && l.parsed.titleOrig && parsed.artistOrig && parsed.titleOrig) {
          return l.parsed.artistOrig === parsed.artistOrig && l.parsed.titleOrig === parsed.titleOrig;
        }
        return l.name === newItem.name;
      });

      if (newItem.autoOnly) {
        parsed.index = '';
      } else if (!parsed.index) {
        if (existingIndex >= 0 && list[existingIndex].parsed && list[existingIndex].parsed.index) {
          parsed.index = list[existingIndex].parsed.index;
        } else {
          maxIdx++;
          parsed.index = String(maxIdx).padStart(4, '0');
        }
      } else {
        const isConflict = list.some((l, idx) => idx !== existingIndex && l.parsed && l.parsed.index === parsed.index);
        if (isConflict) {
          maxIdx++;
          parsed.index = String(maxIdx).padStart(4, '0');
        } else {
          const idx = parseInt(parsed.index, 10);
          if (!isNaN(idx) && idx > maxIdx) maxIdx = idx;
        }
      }

      const standardName = SheetParser.buildStandardName(parsed);
      const entryToSave = {
        ...newItem,
        name: standardName,
        parsed: parsed,
        autoOnly: !!newItem.autoOnly
      };

      if (existingIndex >= 0) {
        list[existingIndex] = { ...list[existingIndex], ...entryToSave, updatedAt: Date.now() };
        updated++;
        if (newItem.autoOnly) autoOnlyUpdated++;
      } else {
        const entry = { ...entryToSave, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) };
        list.push(entry);
        added++;
        if (newItem.autoOnly) autoOnlyAdded++;
      }
    });

    await chrome.storage.local.set({ savedLyrics: list });
    return { added, updated, autoOnlyAdded, autoOnlyUpdated };
  }

  // 시트 URL을 받아 fetch + 파싱 + 병합 + lastSheetSyncAt 갱신까지 수행.
  // UI 토스트/버튼 상태 변경 없음 — 실패해도 throw하지 않고 {ok:false, error}만 반환.
  async function fetchAndMergeSheet(url) {
    if (!url) return { ok: false, error: 'no_url' };
    try {
      const response = await fetch(SheetParser.toExportUrl(url));
      if (!response.ok) return { ok: false, error: 'http_' + response.status };
      const newLyrics = SheetParser.rowsToLyrics(SheetParser.parseCSV(await response.text()).slice(1));
      if (newLyrics.length === 0) return { ok: false, error: 'no_data' };
      const result = await mergeLyricsIntoStorage(newLyrics);
      await chrome.storage.local.set({ lastSheetSyncAt: Date.now() });
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  return { mergeLyricsIntoStorage, fetchAndMergeSheet };
})();
