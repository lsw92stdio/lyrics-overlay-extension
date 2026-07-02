// 팝업/백그라운드 양쪽에서 공유하는 구글 시트 동기화 로직 (UI 부작용 없음)
const SheetSync = (() => {
  // popup.js의 mergeLyrics와 동일한 병합 로직. renderLibrary() 등 UI 호출은 하지 않는다.
  // 로컬 값을 무조건 시트로 덮어쓰지 않고, 필드별로 "이미 로컬에 있으면 유지" 또는
  // "합집합 병합" 규칙을 적용한다 (자세한 규칙은 각 필드 처리 부분의 주석 참고).
  async function mergeLyricsIntoStorage(newLyrics) {
    const data = await new Promise(resolve => chrome.storage.local.get(['savedLyrics'], resolve));
    let list = data.savedLyrics || [];
    let added = 0;
    let updated = 0;
    let autoOnlyAdded = 0;
    let autoOnlyUpdated = 0;
    const srtConflicts = []; // 로컬과 시트의 자막 본문이 달라 로컬을 유지한 곡 목록

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

      const existingIndex = list.findIndex(l => {
        if (l.parsed && l.parsed.artistOrig && l.parsed.titleOrig && parsed.artistOrig && parsed.titleOrig) {
          return l.parsed.artistOrig === parsed.artistOrig && l.parsed.titleOrig === parsed.titleOrig;
        }
        return l.name === newItem.name;
      });

      // 키워드: 로컬 값과 시트 값의 합집합(중복 제거) — 어느 한쪽이 비어도 다른 쪽 값은 보존.
      const localKeywords = (existingIndex >= 0 && list[existingIndex].parsed && list[existingIndex].parsed.keywords) || [];
      const sheetKeywords = (newItem.parsed && newItem.parsed.keywords) || [];
      if (localKeywords.length || sheetKeywords.length) {
        parsed.keywords = Array.from(new Set([...localKeywords, ...sheetKeywords]));
      }

      // Auto Only: 이미 라이브러리에 있는 곡은 로컬 값을 그대로 유지(시트 D열 무시),
      // 신규로 추가되는 곡만 시트 D열 값을 적용한다.
      const autoOnlyValue = existingIndex >= 0
        ? !!list[existingIndex].autoOnly
        : !!newItem.autoOnly;

      if (autoOnlyValue) {
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
        autoOnly: autoOnlyValue
      };

      // 영상 동기화(videoSyncs): url 기준 합집합. 같은 url이 양쪽에 있으면 로컬 값(offsetMs)을
      // 유지하고, 시트에만 있는 새 url만 추가한다. 시트 E열이 비어있으면(newItem.videoSyncs
      // 자체가 없음) 이 블록을 건너뛰어 기존 로컬 값이 그대로 보존된다.
      if (newItem.videoSyncs && newItem.videoSyncs.length) {
        const localSyncs = (existingIndex >= 0 && list[existingIndex].videoSyncs) || [];
        const merged = localSyncs.slice();
        newItem.videoSyncs.forEach(sheetSync => {
          if (!merged.some(s => s.url === sheetSync.url)) merged.push(sheetSync);
        });
        entryToSave.videoSyncs = merged;
      }

      // 자막 본문(srtText): 로컬에 이미 내용이 있고 시트 값과 다르면 로컬을 유지하고
      // 충돌 목록에 기록한다(사용자가 나중에 확인해서 선택할 수 있도록 — 조용히 덮어쓰지 않음).
      if (existingIndex >= 0 && list[existingIndex].srtText && list[existingIndex].srtText !== newItem.srtText) {
        srtConflicts.push({ id: list[existingIndex].id, name: standardName, sheetSrtText: newItem.srtText });
        entryToSave.srtText = list[existingIndex].srtText;
      }

      if (existingIndex >= 0) {
        list[existingIndex] = { ...list[existingIndex], ...entryToSave, updatedAt: Date.now() };
        updated++;
        if (autoOnlyValue) autoOnlyUpdated++;
      } else {
        const entry = { ...entryToSave, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) };
        list.push(entry);
        added++;
        if (autoOnlyValue) autoOnlyAdded++;
      }
    });

    await chrome.storage.local.set({ savedLyrics: list });
    return { added, updated, autoOnlyAdded, autoOnlyUpdated, srtConflicts };
  }

  // 시트 URL을 받아 fetch + 파싱 + 병합 + lastSheetSyncAt 갱신까지 수행.
  // UI 토스트/버튼 상태 변경 없음 — 실패해도 throw하지 않고 {ok:false, error}만 반환.
  // 자막 충돌이 있으면(팝업이 닫혀있어 확인창을 띄울 수 없는 백그라운드 자동 동기화 경로이므로)
  // sheetSyncConflicts storage 큐에 누적 저장해두고, 팝업이 열릴 때 사용자에게 보여준다.
  async function fetchAndMergeSheet(url) {
    if (!url) return { ok: false, error: 'no_url' };
    try {
      const response = await fetch(SheetParser.toExportUrl(url));
      if (!response.ok) return { ok: false, error: 'http_' + response.status };
      const newLyrics = SheetParser.rowsToLyrics(SheetParser.parseCSV(await response.text()).slice(1));
      if (newLyrics.length === 0) return { ok: false, error: 'no_data' };
      const result = await mergeLyricsIntoStorage(newLyrics);
      await chrome.storage.local.set({ lastSheetSyncAt: Date.now() });

      if (result.srtConflicts && result.srtConflicts.length) {
        const { sheetSyncConflicts } = await new Promise(resolve => chrome.storage.local.get(['sheetSyncConflicts'], resolve));
        const queue = sheetSyncConflicts || [];
        result.srtConflicts.forEach(c => {
          const idx = queue.findIndex(x => x.id === c.id);
          const entry = { id: c.id, name: c.name, sheetSrtText: c.sheetSrtText, detectedAt: Date.now() };
          if (idx >= 0) queue[idx] = entry; else queue.push(entry);
        });
        await chrome.storage.local.set({ sheetSyncConflicts: queue });
      }

      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // 자막 충돌 확인 후 사용자가 "시트로 교체"를 선택했을 때 해당 곡의 srtText만 갱신한다.
  async function applySrtText(id, sheetSrtText) {
    const { savedLyrics } = await new Promise(resolve => chrome.storage.local.get(['savedLyrics'], resolve));
    const list = savedLyrics || [];
    const idx = list.findIndex(l => l.id === id);
    if (idx < 0) return false;
    list[idx] = { ...list[idx], srtText: sheetSrtText, updatedAt: Date.now() };
    await chrome.storage.local.set({ savedLyrics: list });
    return true;
  }

  return { mergeLyricsIntoStorage, fetchAndMergeSheet, applySrtText };
})();
