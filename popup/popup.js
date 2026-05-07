/**
 * Popup Script - 팝업 UI 로직
 */

document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  const els = {
    tabBtns: document.querySelectorAll('.tab-btn'),
    tabContents: document.querySelectorAll('.tab-content'),
    currentTrack: document.getElementById('currentTrack'),
    trackName: document.getElementById('trackName'),
    trackMeta: document.getElementById('trackMeta'),
    progressSection: document.getElementById('progressSection'),
    progressBar: document.getElementById('progressBar'),
    progressFill: document.getElementById('progressFill'),
    currentTime: document.getElementById('currentTime'),
    totalTime: document.getElementById('totalTime'),
    btnPlay: document.getElementById('btnPlay'),
    btnStop: document.getElementById('btnStop'),
    playIcon: document.getElementById('playIcon'),
    fileInput: document.getElementById('fileInput'),

    syncAdjust: document.getElementById('syncAdjust'),
    syncOffsetValue: document.getElementById('syncOffsetValue'),
    btnSyncReset: document.getElementById('btnSyncReset'),
    lyricsTimeline: document.getElementById('lyricsTimeline'),
    timelineList: document.getElementById('timelineList'),
    timelineCount: document.getElementById('timelineCount'),
    libraryList: document.getElementById('libraryList'),
    btnAddLibrary: document.getElementById('btnAddLibrary'),
    btnExportLibrary: document.getElementById('btnExportLibrary'),
    btnReloadSheet: document.getElementById('btnReloadSheet'),

    btnExportSheetFormat: document.getElementById('btnExportSheetFormat'),
    btnImportLibrary: document.getElementById('btnImportLibrary'),
    btnExportLibrary: document.getElementById('btnExportLibrary'),
    btnClearLibrary: document.getElementById('btnClearLibrary'),
    btnImportSettings: document.getElementById('btnImportSettings'),
    btnExportSettings: document.getElementById('btnExportSettings'),
    libraryFileInput: document.getElementById('libraryFileInput'),
    libraryJsonInput: document.getElementById('libraryJsonInput'),
    settingsJsonInput: document.getElementById('settingsJsonInput'),
    tabLibrary: document.getElementById('tab-library'),
    libraryList: document.getElementById('libraryList'),
    libraryDropOverlay: document.getElementById('libraryDropOverlay'),
    librarySearchInput: document.getElementById('librarySearchInput'),
    origFontSize: document.getElementById('origFontSize'),
    origFontSizeValue: document.getElementById('origFontSizeValue'),
    origColor: document.getElementById('origColor'),
    origColorValue: document.getElementById('origColorValue'),
    showOriginal: document.getElementById('showOriginal'),
    showPronunciation: document.getElementById('showPronunciation'),
    pronFontSize: document.getElementById('pronFontSize'),
    pronFontSizeValue: document.getElementById('pronFontSizeValue'),
    pronColor: document.getElementById('pronColor'),
    pronColorValue: document.getElementById('pronColorValue'),
    mainFontSize: document.getElementById('mainFontSize'),
    mainFontSizeValue: document.getElementById('mainFontSizeValue'),
    mainColor: document.getElementById('mainColor'),
    mainColorValue: document.getElementById('mainColorValue'),
    bgColor: document.getElementById('bgColor'),
    bgColorValue: document.getElementById('bgColorValue'),
    bgOpacity: document.getElementById('bgOpacity'),
    bgOpacityValue: document.getElementById('bgOpacityValue'),
    bgBlur: document.getElementById('bgBlur'),
    bgBlurValue: document.getElementById('bgBlurValue'),
    libraryDisplayLang: document.getElementById('libraryDisplayLang'),
    settingsAnimation: document.getElementById('settingsAnimation'),
    textShadow: document.getElementById('textShadow'),
    googleSheetUrl: document.getElementById('googleSheetUrl'),
    btnSelectArea: document.getElementById('btnSelectArea'),
    libraryCount: document.getElementById('libraryCount'),
    btnSaveSettings: document.getElementById('btnSaveSettings'),
    btnResetSettings: document.getElementById('btnResetSettings'),
    showEndNotice: document.getElementById('showEndNotice'),
    showProgressBar: document.getElementById('showProgressBar'),
    btnToggleRemote: document.getElementById('btnToggleRemote'),
    remoteBtnLibrary: document.getElementById('remoteBtnLibrary'),
    remoteBtnTimeline: document.getElementById('remoteBtnTimeline'),
    remoteBtnArea: document.getElementById('remoteBtnArea'),
    remoteBtnPlayStop: document.getElementById('remoteBtnPlayStop'),
    remoteBtnSync: document.getElementById('remoteBtnSync')
  };

  let currentLyricsData = null;
  let parsedEntries = []; // SRT 파싱 결과 (타임라인용)
  let statusInterval = null;
  let activeTimelineIndex = -1;

  // ============================================================
  // 탭 전환
  // ============================================================
  els.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      els.tabBtns.forEach(b => b.classList.remove('active'));
      els.tabContents.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${tabId}`).classList.add('active');
    });
  });

  // 도움말 버튼
  document.getElementById('btnHelp').addEventListener('click', () => {
    window.open('https://www.notion.so/Lyrics-Overlay-34d476544c8e80a0a754e3a3fdf23edf?source=copy_link', '_blank');
  });

  // ============================================================
  // 토스트
  // ============================================================
  function showToast(message) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  // ============================================================
  // Content Script 통신
  // ============================================================
  async function sendToContent(message) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return null;
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, message, (response) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response);
        });
      });
    } catch { return null; }
  }

  // ============================================================
  // SRT 파일 로드
  // ============================================================
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file, 'UTF-8');
    });
  }

  async function loadSRTFile(file) {
    const text = await readFileAsText(file);
    const name = file.name.replace(/\.srt$/i, '');
    const response = await sendToContent({ type: 'LOAD_LYRICS', srtText: text, trackName: name });
    if (response?.success) {
      const parsed = parseFileName(name);
      currentLyricsData = { name, count: response.count, duration: response.duration, srtText: text, parsed };
      updatePlayerUI();
      updateSyncDisplay(0);
      buildTimeline(text);

      // 라이브러리에도 자동 추가
      const added = await addToLibrary(file.name, text);
      if (added !== false) {
        renderLibrary();
      }
      showToast(`"${name}" 로드 완료 (${response.count}줄)`);
    }
  }

  // ============================================================
  // 드래그 & 드롭 SRT 로드
  // ============================================================
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    els.currentTrack.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  els.currentTrack.addEventListener('dragenter', () => {
    els.currentTrack.classList.add('drop-hover');
  });

  els.currentTrack.addEventListener('dragleave', (e) => {
    if (!els.currentTrack.contains(e.relatedTarget)) {
      els.currentTrack.classList.remove('drop-hover');
    }
  });

  els.currentTrack.addEventListener('drop', async (e) => {
    els.currentTrack.classList.remove('drop-hover');
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.srt'));
    if (files.length === 0) {
      showToast('SRT 파일만 드롭할 수 있습니다.');
      return;
    }
    await loadSRTFile(files[0]);
  });

  function updatePlayerUI() {
    if (!currentLyricsData) return;
    els.currentTrack.querySelector('.track-placeholder').style.display = 'none';
    els.currentTrack.querySelector('.track-info').style.display = '';

    // 표시 옵션 적용
    const lang = els.libraryDisplayLang.value;
    const parsed = currentLyricsData.parsed || parseFileName(currentLyricsData.name);
    let htmlName = '';

    if (parsed.artistOrig || parsed.titleOrig) {
      let displayArtist = parsed.artist || '';
      let displayTitle = parsed.title || currentLyricsData.name;

      if (lang === 'orig') {
        displayArtist = parsed.artistOrig || displayArtist;
        displayTitle = parsed.titleOrig || displayTitle;
      } else if (lang === 'ko') {
        displayArtist = parsed.artistKo || parsed.artistOrig || displayArtist;
        displayTitle = parsed.titleKo || parsed.titleOrig || displayTitle;
      } else {
        displayArtist = parsed.artistKo ? `${parsed.artistOrig} (${parsed.artistKo})` : parsed.artistOrig;
        displayTitle = parsed.titleKo ? `${parsed.titleOrig} (${parsed.titleKo})` : parsed.titleOrig;
      }
      htmlName += `<div class="track-primary-title scroll-text-container"><span class="scroll-text-inner">${escapeHtml(displayTitle)}</span></div>`;

      if (parsed.index || displayArtist) {
        htmlName += `<div class="track-secondary-info">`;
        if (parsed.index) htmlName += `<span class="track-badge">${parsed.index}</span>`;
        if (displayArtist) htmlName += `<span class="track-artist scroll-text-container" style="max-width: 150px;"><span class="scroll-text-inner">${escapeHtml(displayArtist)}</span></span>`;
        htmlName += `</div>`;
      }

    } else {
      const displayTitle = parsed.original || currentLyricsData.name;
      htmlName += `<div class="track-primary-title scroll-text-container"><span class="scroll-text-inner">${escapeHtml(displayTitle)}</span></div>`;

      if (parsed.index) {
        htmlName += `<div class="track-secondary-info">`;
        htmlName += `<span class="track-badge">${parsed.index}</span>`;
        htmlName += `</div>`;
      }
    }

    els.trackName.innerHTML = htmlName;

    requestAnimationFrame(() => {
      els.trackName.querySelectorAll('.scroll-text-container').forEach(nameEl => {
        nameEl.classList.remove('needs-scroll-auto');
        if (nameEl.scrollWidth > nameEl.clientWidth) {
          nameEl.classList.add('needs-scroll-auto');
          const overflow = nameEl.scrollWidth - nameEl.clientWidth;
          const time = Math.max(3, overflow / 20);
          nameEl.style.setProperty('--scroll-amount', `-${overflow + 10}px`);
          nameEl.style.setProperty('--scroll-time', `${time}s`);
        }
      });
    });

    els.trackMeta.innerHTML = `
      <span class="meta-badge">📝 ${currentLyricsData.count}줄</span>
      <span class="meta-badge">⏱ ${formatTime(currentLyricsData.duration)}</span>
    `;
    els.progressSection.style.display = '';
    els.totalTime.textContent = formatTime(currentLyricsData.duration);
    els.btnPlay.disabled = false;
    els.btnStop.disabled = false;
  }

  function formatTime(ms) {
    const total = Math.floor(ms / 1000);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  function formatTimeSrt(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  // ============================================================
  // 타임라인 (가사 목록)
  // ============================================================
  function parseSRTForTimeline(srtText) {
    const entries = [];
    const blocks = srtText.trim().split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 3) continue;
      const timeMatch = lines[1].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
      if (!timeMatch) continue;
      const startMs = (+timeMatch[1] * 3600 + +timeMatch[2] * 60 + +timeMatch[3]) * 1000 + +timeMatch[4];
      const textLines = lines.slice(2).join(' ').split(/\\N/);
      entries.push({ startMs, lines: textLines });
    }
    return entries;
  }

  function buildTimeline(srtText) {
    parsedEntries = parseSRTForTimeline(srtText);
    if (parsedEntries.length === 0) {
      els.lyricsTimeline.style.display = 'none';
      return;
    }

    els.lyricsTimeline.style.display = '';
    els.timelineCount.textContent = `${parsedEntries.length}줄`;
    els.timelineList.innerHTML = '';

    parsedEntries.forEach((entry, i) => {
      const item = document.createElement('div');
      item.className = 'timeline-item';
      item.dataset.index = i;
      item.dataset.time = entry.startMs;

      const timeEl = document.createElement('span');
      timeEl.className = 'timeline-time';
      timeEl.textContent = formatTimeSrt(entry.startMs);

      const textEl = document.createElement('div');
      textEl.className = 'timeline-text';

      // 마지막 줄 = 메인 (번역), 나머지 = 서브
      if (entry.lines.length === 1) {
        textEl.textContent = entry.lines[0];
      } else {
        const mainLine = entry.lines[entry.lines.length - 1];
        const subLines = entry.lines.slice(0, -1).join(' / ');
        textEl.innerHTML = `${escapeHtml(mainLine)}<div class="timeline-text-sub">${escapeHtml(subLines)}</div>`;
      }

      item.appendChild(timeEl);
      item.appendChild(textEl);

      item.addEventListener('click', () => {
        seekToTime(entry.startMs);
      });

      els.timelineList.appendChild(item);
    });
  }

  async function seekToTime(timeMs) {
    const status = await sendToContent({ type: 'GET_STATUS' });
    if (!status) return;

    if (!status.isPlaying) {
      // 아직 재생 안 했으면 재생 시작
      await sendToContent({ type: 'PLAY' });
      els.playIcon.textContent = '⏸';
      startStatusPolling();
    }

    await sendToContent({ type: 'SEEK', timeMs });
  }

  function updateTimelineHighlight(currentTimeMs) {
    if (parsedEntries.length === 0) return;

    let newIndex = -1;
    for (let i = parsedEntries.length - 1; i >= 0; i--) {
      if (currentTimeMs >= parsedEntries[i].startMs) {
        newIndex = i;
        break;
      }
    }

    if (newIndex !== activeTimelineIndex) {
      // 이전 하이라이트 제거
      if (activeTimelineIndex >= 0) {
        const prev = els.timelineList.children[activeTimelineIndex];
        if (prev) prev.classList.remove('active');
      }
      // 새 하이라이트
      if (newIndex >= 0) {
        const curr = els.timelineList.children[newIndex];
        if (curr) {
          curr.classList.add('active');
          // 보이는 영역으로 스크롤
          curr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
      activeTimelineIndex = newIndex;
    }
  }

  // ============================================================
  // 싱크 조정
  // ============================================================
  function updateSyncDisplay(offset) {
    const sign = offset >= 0 ? '+' : '';
    els.syncOffsetValue.textContent = `${sign}${offset}ms`;
    els.syncAdjust.style.display = '';
  }

  // 키보드 싱크 조정
  document.addEventListener('keydown', async (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const delta = e.shiftKey ? 500 : 100;
      const direction = e.key === 'ArrowLeft' ? -1 : 1;
      const response = await sendToContent({ type: 'ADJUST_SYNC', deltaMs: delta * direction });
      if (response?.success) {
        updateSyncDisplay(response.syncOffset);
        showToast(`싱크: ${response.syncOffset >= 0 ? '+' : ''}${response.syncOffset}ms`);
      }
    }

    // R 키: 싱크 초기화
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      await resetSync();
    }
  });

  // 싱크 초기화 버튼
  els.btnSyncReset.addEventListener('click', resetSync);

  async function resetSync() {
    const status = await sendToContent({ type: 'GET_STATUS' });
    if (!status) return;
    const currentOffset = status.syncOffset || 0;
    if (currentOffset === 0) return;
    const response = await sendToContent({ type: 'ADJUST_SYNC', deltaMs: -currentOffset });
    if (response?.success) {
      updateSyncDisplay(0);
      showToast('싱크 초기화');
    }
  }

  // ============================================================
  // 재생 컨트롤
  // ============================================================
  els.fileInput.addEventListener('change', async (e) => { if (e.target.files[0]) await loadSRTFile(e.target.files[0]); e.target.value = ''; });

  els.btnPlay.addEventListener('click', async () => {
    const status = await sendToContent({ type: 'GET_STATUS' });
    if (!status) return;
    if (status.isPlaying && !status.isPaused) {
      await sendToContent({ type: 'PAUSE' }); els.playIcon.textContent = '▶'; stopStatusPolling();
    } else {
      await sendToContent({ type: 'PLAY' }); els.playIcon.textContent = '⏸'; startStatusPolling();
    }
  });

  els.btnStop.addEventListener('click', async () => {
    await sendToContent({ type: 'STOP' }); els.playIcon.textContent = '▶';
    els.progressFill.style.width = '0%'; els.currentTime.textContent = '00:00'; stopStatusPolling();
    activeTimelineIndex = -1;
    els.timelineList.querySelectorAll('.active').forEach(el => el.classList.remove('active'));
  });

  els.progressBar.addEventListener('click', async (e) => {
    if (!currentLyricsData) return;
    const rect = els.progressBar.getBoundingClientRect();
    const timeMs = ((e.clientX - rect.left) / rect.width) * currentLyricsData.duration;

    const status = await sendToContent({ type: 'GET_STATUS' });
    if (status && !status.isPlaying) {
      await sendToContent({ type: 'PLAY' });
      els.playIcon.textContent = '⏸';
      startStatusPolling();
    }

    await sendToContent({ type: 'SEEK', timeMs });
  });

  function startStatusPolling() {
    stopStatusPolling();
    statusInterval = setInterval(async () => {
      const status = await sendToContent({ type: 'GET_STATUS' });
      if (!status) return;
      if (status.isPlaying) {
        const pct = status.totalDuration > 0 ? (status.currentTime / status.totalDuration * 100) : 0;
        els.progressFill.style.width = `${Math.min(pct, 100)}%`;
        els.currentTime.textContent = formatTime(status.currentTime);
        if (!status.isPaused) els.playIcon.textContent = '⏸';
        updateTimelineHighlight(status.currentTime);
      } else {
        els.playIcon.textContent = '▶'; els.progressFill.style.width = '0%';
        els.currentTime.textContent = '00:00'; stopStatusPolling();
      }
    }, 250);
  }

  function stopStatusPolling() { if (statusInterval) { clearInterval(statusInterval); statusInterval = null; } }



  // ============================================================
  // 라이브러리
  // ============================================================
  els.btnAddLibrary.addEventListener('click', () => els.libraryFileInput.click());
  els.libraryFileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    let addedCount = 0;
    for (const file of files) {
      const success = await addToLibrary(file.name, await readFileAsText(file));
      if (success !== false) addedCount++;
    }
    renderLibrary();
    e.target.value = '';
    if (addedCount > 0) showToast(`${addedCount}개 파일 추가/수정됨`);
  });

  // 라이브러리 목록 드래그 & 드롭 지원
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    els.tabLibrary.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  els.tabLibrary.addEventListener('dragenter', () => {
    els.libraryDropOverlay.style.display = 'flex';
  });

  els.tabLibrary.addEventListener('dragleave', (e) => {
    if (!els.tabLibrary.contains(e.relatedTarget)) {
      els.libraryDropOverlay.style.display = 'none';
    }
  });

  els.tabLibrary.addEventListener('drop', async (e) => {
    els.libraryDropOverlay.style.display = 'none';
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.srt'));
    if (files.length === 0) {
      showToast('SRT 파일만 추가할 수 있습니다.');
      return;
    }

    let addedCount = 0;
    for (const file of files) {
      const success = await addToLibrary(file.name, await readFileAsText(file));
      if (success !== false) addedCount++;
    }
    renderLibrary();
    if (addedCount > 0) showToast(`${addedCount}개 파일 드롭 완료`);
  });

  // ============================================================
  // 커스텀 Confirm 모달
  // ============================================================
  function showConfirm(message) {
    return new Promise((resolve) => {
      const modal = document.getElementById('customConfirmModal');
      const msgEl = document.getElementById('customConfirmMessage');
      const btnOk = document.getElementById('customConfirmOk');
      const btnCancel = document.getElementById('customConfirmCancel');

      msgEl.textContent = message;
      modal.classList.add('visible');

      const cleanup = () => {
        modal.classList.remove('visible');
        btnOk.removeEventListener('click', onOk);
        btnCancel.removeEventListener('click', onCancel);
      };

      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };

      btnOk.addEventListener('click', onOk);
      btnCancel.addEventListener('click', onCancel);
    });
  }

  els.btnExportLibrary.addEventListener('click', async () => {
    const data = await getStorageData('savedLyrics');
    const list = data.savedLyrics || [];
    if (list.length === 0) {
      showToast('내보낼 데이터가 없습니다.');
      return;
    }
    const jsonStr = JSON.stringify(list, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lyrics_library.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('데이터를 내보냈습니다.');
  });

  els.btnClearLibrary.addEventListener('click', async () => {
    if (!(await showConfirm('저장된 모든 가사 데이터를 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다!'))) return;
    await chrome.storage.local.set({ savedLyrics: [] });
    renderLibrary();
    showToast('모든 가사가 삭제되었습니다.');
  });

  els.btnExportSheetFormat.addEventListener('click', async () => {
    const data = await getStorageData('savedLyrics');
    const list = data.savedLyrics || [];
    if (list.length === 0) {
      showToast('복사할 데이터가 없습니다.');
      return;
    }

    // 이름(순번 기준) 오름차순 정렬
    const sortedList = [...list].sort((a, b) => {
      const aIdx = a.parsed?.index ? parseInt(a.parsed.index, 10) : Infinity;
      const bIdx = b.parsed?.index ? parseInt(b.parsed.index, 10) : Infinity;
      return aIdx - bIdx;
    });

    let tsvContent = 'Name\tSRT Text\tKeywords\n';
    sortedList.forEach(item => {
      // 앞의 순번(숫자와 공백) 제거
      let cleanName = item.name.replace(/^\d+\s*/, '');
      const name = cleanName.replace(/"/g, '""');
      const srtText = (item.srtText || '').replace(/"/g, '""');

      let keywordsStr = '';
      if (item.parsed && item.parsed.keywords && item.parsed.keywords.length > 0) {
        keywordsStr = item.parsed.keywords.join(', ').replace(/"/g, '""');
      }

      // 줄바꿈이 있는 경우 쌍따옴표로 감쌈 (구글 시트 붙여넣기 규격)
      const formattedName = name.includes('\n') || name.includes('\r') || name.includes('"') ? `"${name}"` : name;
      const formattedSrt = srtText.includes('\n') || srtText.includes('\r') || srtText.includes('"') ? `"${srtText}"` : srtText;
      const formattedKeywords = keywordsStr.includes('\n') || keywordsStr.includes('\r') || keywordsStr.includes('"') ? `"${keywordsStr}"` : keywordsStr;

      tsvContent += `${formattedName}\t${formattedSrt}\t${formattedKeywords}\n`;
    });

    try {
      await navigator.clipboard.writeText(tsvContent);
      showToast('시트 양식이 클립보드에 복사되었습니다. 시트에 붙여넣기(Ctrl+V) 하세요!');
    } catch (err) {
      console.error('Failed to copy: ', err);
      showToast('클립보드 복사에 실패했습니다.');
    }
  });

  async function mergeLyrics(newLyrics) {
    const data = await getStorageData('savedLyrics');
    let list = data.savedLyrics || [];
    let added = 0;
    let updated = 0;

    let maxIdx = 0;
    list.forEach(item => {
      if (item.parsed && item.parsed.index) {
        const idx = parseInt(item.parsed.index, 10);
        if (!isNaN(idx) && idx > maxIdx) maxIdx = idx;
      }
    });

    newLyrics.forEach(newItem => {
      if (!newItem.srtText) return;

      // 이전 형식 호환 및 새로운 양식 적용을 위해 파일명 다시 파싱
      const rawNameToParse = (newItem.parsed && newItem.parsed.original) ? newItem.parsed.original : newItem.name;
      const parsed = parseFileName(rawNameToParse);

      // 혹시 기존 순번 데이터가 있다면 가져오기 (다시 파싱 시 없어질 수 있으므로)
      if (!parsed.index && newItem.parsed && newItem.parsed.index) {
        parsed.index = newItem.parsed.index;
      }

      // 키워드 데이터 보존
      if (newItem.parsed && newItem.parsed.keywords) {
        parsed.keywords = newItem.parsed.keywords;
      }

      const existingIndex = list.findIndex(l => {
        if (l.parsed && l.parsed.artistOrig && l.parsed.titleOrig && parsed.artistOrig && parsed.titleOrig) {
          return l.parsed.artistOrig === parsed.artistOrig && l.parsed.titleOrig === parsed.titleOrig;
        }
        return l.name === newItem.name;
      });

      if (!parsed.index) {
        if (existingIndex >= 0 && list[existingIndex].parsed && list[existingIndex].parsed.index) {
          parsed.index = list[existingIndex].parsed.index;
        } else {
          maxIdx++;
          parsed.index = String(maxIdx).padStart(4, '0');
        }
      } else {
        // 순번이 명시되어 있지만 다른 곡에서 이미 사용 중이라면 충돌 방지를 위해 채번
        const isConflict = list.some((l, idx) => idx !== existingIndex && l.parsed && l.parsed.index === parsed.index);
        if (isConflict) {
          maxIdx++;
          parsed.index = String(maxIdx).padStart(4, '0');
        } else {
          const idx = parseInt(parsed.index, 10);
          if (!isNaN(idx) && idx > maxIdx) maxIdx = idx;
        }
      }

      const standardName = buildStandardName(parsed);
      const entryToSave = {
        ...newItem,
        name: standardName,
        parsed: parsed
      };

      if (existingIndex >= 0) {
        list[existingIndex] = { ...list[existingIndex], ...entryToSave, updatedAt: Date.now() };
        updated++;
      } else {
        const entry = { ...entryToSave, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) };
        list.push(entry);
        added++;
      }
    });

    await chrome.storage.local.set({ savedLyrics: list });
    renderLibrary();
    return { added, updated };
  }

  // 간단한 CSV 파서 (줄바꿈이 포함된 따옴표 처리)
  async function syncFromSheet(url) {
    const btn = els.btnReloadSheet;
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '연동 중...';
    try {
      const response = await fetch(SheetParser.toExportUrl(url));
      if (response.ok) {
        const newLyrics = SheetParser.rowsToLyrics(SheetParser.parseCSV(await response.text()).slice(1));
        if (newLyrics.length > 0) {
          const result = await mergeLyrics(newLyrics);
          showToast(`시트 연동 완료! (추가 ${result.added}개, 수정 ${result.updated}개)`);
        } else {
          showToast('시트에서 유효한 데이터를 찾을 수 없습니다.');
        }
      } else {
        showToast('스프레드시트에 접근할 수 없습니다. 공유 설정을 확인해주세요.');
      }
    } catch (e) {
      showToast('시트 데이터를 가져오는 중 오류가 발생했습니다.');
      console.error(e);
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  els.btnReloadSheet.addEventListener('click', async () => {
    const s = await getSettings();
    const url = s.googleSheetUrl;
    if (!url) {
      showToast('설정에서 구글 스프레드시트 URL을 먼저 입력해주세요.');
      els.tabBtns[2].click();
      return;
    }

    if (!(await showConfirm('구글 스프레드시트에서 데이터를 가져와 현재 목록에 병합하시겠습니까?'))) return;

    await syncFromSheet(url);
    renderLibrary();
  });


  els.btnImportLibrary.addEventListener('click', () => els.libraryJsonInput.click());
  els.libraryJsonInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      const importedData = JSON.parse(text);
      if (Array.isArray(importedData)) {
        const result = await mergeLyrics(importedData);
        showToast(`가져오기 완료! (추가 ${result.added}개, 수정 ${result.updated}개)`);
      } else {
        showToast('유효하지 않은 JSON 파일 형식입니다.');
      }
    } catch (err) {
      showToast('JSON 파일을 읽는 중 오류가 발생했습니다.');
    }
    e.target.value = '';
  });

  els.btnExportSettings.addEventListener('click', async () => {
    const data = await getStorageData('settings', 'remotePosition', 'remoteMinimized');
    // 내보내기 전 정리: false인 사이트 제거, fontFamily 제거
    if (data.settings) {
      const s = data.settings;
      if (s.remoteEnabledSites) {
        s.remoteEnabledSites = Object.fromEntries(
          Object.entries(s.remoteEnabledSites).filter(([, v]) => v === true)
        );
      }
      delete s.fontFamily;
    }
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lyrics_settings.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('설정 데이터를 내보냈습니다.');
  });

  els.btnImportSettings.addEventListener('click', () => els.settingsJsonInput.click());
  els.settingsJsonInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      const importedData = JSON.parse(text);
      if (typeof importedData === 'object' && !Array.isArray(importedData)) {
        // 기존 형식을 위한 호환성 (최상위가 settings 데이터인 경우)
        let settingsToSave = importedData;
        let positionData = null;
        let minimizedData = null;

        // 새로운 형식인 경우 (최상위에 settings, remotePosition 등이 있는 경우)
        if (importedData.settings !== undefined) {
          settingsToSave = importedData.settings;
          positionData = importedData.remotePosition;
          minimizedData = importedData.remoteMinimized;
        }

        const updates = { settings: { ...defaultSettings, ...settingsToSave } };
        if (positionData !== undefined) updates.remotePosition = positionData;
        if (minimizedData !== undefined) updates.remoteMinimized = minimizedData;

        await chrome.storage.local.set(updates);
        await loadSettingsUI();
        await sendToContent({ type: 'UPDATE_STYLE', settings: updates.settings });
        showToast('설정 데이터를 가져왔습니다.');
      } else {
        showToast('올바른 설정 형식이 아닙니다.');
      }
    } catch (err) {
      showToast('올바른 JSON 파일이 아닙니다.');
    }
    e.target.value = '';
  });

  const parseFileName = SheetParser.parseFileName;

  function buildStandardName(parsed) {
    if (!parsed.artist && !parsed.title) {
      return parsed.original.endsWith('.srt') ? parsed.original : parsed.original + '.srt';
    }
    const baseName = `${parsed.artist} - ${parsed.title}.srt`;
    return parsed.index ? `${parsed.index} ${baseName}` : baseName;
  }

  async function addToLibrary(name, srtText) {
    const data = await getStorageData('savedLyrics');
    const list = data.savedLyrics || [];
    const parsed = parseFileName(name);

    const existing = list.findIndex(l => {
      if (l.parsed && l.parsed.artistOrig && l.parsed.titleOrig && parsed.artistOrig && parsed.titleOrig) {
        return l.parsed.artistOrig === parsed.artistOrig && l.parsed.titleOrig === parsed.titleOrig;
      }
      return l.name === name;
    });

    // 순번 충돌 검사 및 채번 로직
    if (!parsed.index) {
      if (existing >= 0 && list[existing].parsed && list[existing].parsed.index) {
        // 기존 파일 덮어쓰기이고 기존 파일에 순번이 있으면 유지
        parsed.index = list[existing].parsed.index;
      } else {
        // 새 파일이거나 기존 파일에도 순번이 없으면 자동 채번
        let maxIdx = 0;
        list.forEach(item => {
          if (item.parsed && item.parsed.index) {
            const idx = parseInt(item.parsed.index, 10);
            if (!isNaN(idx) && idx > maxIdx) maxIdx = idx;
          }
        });
        parsed.index = String(maxIdx + 1).padStart(4, '0');
      }
    } else {
      // 순번이 명시적으로 제공된 경우, 다른 파일이 이미 이 순번을 쓰고 있는지 확인
      const isConflict = list.some((l, idx) => idx !== existing && l.parsed && l.parsed.index === parsed.index);
      if (isConflict) {
        let maxIdx = 0;
        list.forEach(item => {
          if (item.parsed && item.parsed.index) {
            const idx = parseInt(item.parsed.index, 10);
            if (!isNaN(idx) && idx > maxIdx) maxIdx = idx;
          }
        });
        parsed.index = String(maxIdx + 1).padStart(4, '0');
      }
    }

    if (existing >= 0) {
      const confirmMsg = `원문 기준 동일한 파일("${list[existing].name}")이 이미 존재합니다.\n새 파일("${name}")로 덮어쓰시겠습니까?`;
      if (!(await showConfirm(confirmMsg))) {
        return false;
      }

      const standardName = buildStandardName(parsed);
      list[existing].name = standardName;
      list[existing].srtText = srtText;
      list[existing].parsed = parsed;
      list[existing].updatedAt = Date.now();
    } else {
      const standardName = buildStandardName(parsed);
      list.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: standardName,
        parsed,
        srtText,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }
    await chrome.storage.local.set({ savedLyrics: list });
    return true;
  }

  async function removeFromLibrary(id) {
    const data = await getStorageData('savedLyrics');
    await chrome.storage.local.set({ savedLyrics: (data.savedLyrics || []).filter(l => l.id !== id) });
    renderLibrary(); showToast('삭제됨');
  }

  async function loadFromLibrary(item) {
    const name = item.name.replace(/\.srt$/i, '');
    const response = await sendToContent({ type: 'LOAD_LYRICS', srtText: item.srtText, trackName: name });
    if (response?.success) {
      currentLyricsData = { name, count: response.count, duration: response.duration, srtText: item.srtText, parsed: item.parsed };
      updatePlayerUI(); updateSyncDisplay(0);
      buildTimeline(item.srtText);
      els.tabBtns[0].click(); showToast(`"${name}" 로드 완료`);
    }
  }

  function getMatchChips(item, q) {
    const chips = [];
    const lower = q.toLowerCase();
    if (!item.parsed) {
      if (item.name.toLowerCase().includes(lower)) chips.push({ type: '파일명', value: item.name });
      return chips;
    }
    if (item.parsed.index && item.parsed.index.includes(lower)) chips.push({ type: '번호', value: item.parsed.index });
    if (item.parsed.artist && item.parsed.artist.toLowerCase().includes(lower)) chips.push({ type: '가수', value: item.parsed.artist });
    if (item.parsed.title && item.parsed.title.toLowerCase().includes(lower)) chips.push({ type: '제목', value: item.parsed.title });
    if (item.parsed.keywords) {
      item.parsed.keywords.filter(k => k.toLowerCase().includes(lower))
        .forEach(k => chips.push({ type: '키워드', value: k }));
    }
    return chips;
  }

  function renderMatchChips(chips, q) {
    return chips.map(({ type, value }) => {
      const idx = value.toLowerCase().indexOf(q.toLowerCase());
      const highlighted = idx === -1
        ? escapeHtml(value)
        : escapeHtml(value.slice(0, idx)) + `<mark>${escapeHtml(value.slice(idx, idx + q.length))}</mark>` + escapeHtml(value.slice(idx + q.length));
      return `<span class="match-chip"><span class="chip-type">${escapeHtml(type)}</span>${highlighted}</span>`;
    }).join('');
  }

  async function renderLibrary(query = '') {
    const data = await getStorageData('savedLyrics');
    const allList = data.savedLyrics || [];
    let list = allList;

    // 총 곡 수 표시 (검색 필터 전 전체 수)
    if (els.libraryCount) {
      els.libraryCount.textContent = allList.length;
    }

    if (query) {
      const q = query.toLowerCase();
      list = list.filter(item => {
        if (!item.parsed) return item.name.toLowerCase().includes(q);
        const inKeywords = item.parsed.keywords && item.parsed.keywords.some(k => k.toLowerCase().includes(q));
        return (item.parsed.index && item.parsed.index.includes(q)) ||
          (item.parsed.artist && item.parsed.artist.toLowerCase().includes(q)) ||
          (item.parsed.title && item.parsed.title.toLowerCase().includes(q)) ||
          item.name.toLowerCase().includes(q) ||
          inKeywords;
      });
    }

    if (list.length === 0) {
      els.libraryList.innerHTML = '<div class="library-empty"><span>📄</span><p>저장된 가사가 없습니다</p><p class="sub">SRT 파일을 추가해주세요</p></div>';
      return;
    }

    // 순번이 있으면 순번으로, 없으면 이름으로 정렬
    list.sort((a, b) => {
      const aIndex = a.parsed?.index ? parseInt(a.parsed.index) : Infinity;
      const bIndex = b.parsed?.index ? parseInt(b.parsed.index) : Infinity;
      if (aIndex !== bIndex) return aIndex - bIndex;
      return a.name.localeCompare(b.name);
    });

    els.libraryList.innerHTML = list.map(item => {
      let displayName = escapeHtml(item.name);
      if (item.parsed) {
        const idxStr = item.parsed.index ? `<span class="library-item-index">${item.parsed.index}</span>` : '';
        if (item.parsed.artist && item.parsed.title) {
          let a = item.parsed.artist;
          let t = item.parsed.title;
          const langMode = els.libraryDisplayLang ? els.libraryDisplayLang.value : 'both';

          if (langMode === 'orig') {
            a = item.parsed.artistOrig || a;
            t = item.parsed.titleOrig || t;
          } else if (langMode === 'ko') {
            a = item.parsed.artistKo || item.parsed.artistOrig || a;
            t = item.parsed.titleKo || item.parsed.titleOrig || t;
          }

          displayName = `${idxStr}${escapeHtml(a)} - ${escapeHtml(t)}`;
        } else {
          // 형식에 맞지 않는 파일명인 경우 원본 유지하면서 순번 추가
          displayName = `${idxStr}${escapeHtml(item.parsed.original || item.name)}`;
        }
      }
      const chipsHtml = query ? renderMatchChips(getMatchChips(item, query), query) : '';
      return `
      <div class="library-item" data-id="${item.id}">
        <span class="library-item-icon">♪</span>
        <div class="library-item-info">
          <div class="library-item-name scroll-text-container"><span class="scroll-text-inner">${displayName}</span></div>
          ${chipsHtml ? `<div class="library-item-meta">${chipsHtml}</div>` : ''}
        </div>
        <button class="library-item-delete" data-id="${item.id}" title="삭제">✕</button>
      </div>`;
    }).join('');

    els.libraryList.querySelectorAll('.library-item').forEach(el => {
      el.addEventListener('click', (e) => { if (e.target.closest('.library-item-delete')) return; const item = list.find(l => l.id === el.dataset.id); if (item) loadFromLibrary(item); });

      el.addEventListener('mouseenter', () => {
        const nameEl = el.querySelector('.library-item-name');
        const innerEl = nameEl ? nameEl.querySelector('.scroll-text-inner') : null;
        if (nameEl && innerEl && nameEl.scrollWidth > nameEl.clientWidth) {
          nameEl.classList.add('needs-scroll');
          const overflow = nameEl.scrollWidth - nameEl.clientWidth;
          const time = Math.max(2, overflow / 30);
          nameEl.style.setProperty('--scroll-amount', `-${overflow + 10}px`);
          nameEl.style.setProperty('--scroll-time', `${time}s`);
        }
      });
      el.addEventListener('mouseleave', () => {
        const nameEl = el.querySelector('.library-item-name');
        if (nameEl) nameEl.classList.remove('needs-scroll');
      });
    });
    els.libraryList.querySelectorAll('.library-item-delete').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); removeFromLibrary(btn.dataset.id); });
    });
  }

  els.librarySearchInput.addEventListener('input', (e) => {
    renderLibrary(e.target.value.trim());
  });

  // ============================================================
  // 설정
  // ============================================================
  const defaultSettings = {
    origFontSize: 20, origColor: '#FFA800', showOriginal: true,
    pronFontSize: 18, pronColor: '#F5E6CC', showPronunciation: true,
    mainFontSize: 28, mainColor: '#FFFFFF',
    libraryDisplayLang: 'both',
    textShadow: true, animation: 'fade',
    googleSheetUrl: '',
    showEndNotice: true,
    showProgressBar: true,
    remoteEnabledSites: {}
  };

  function getSettings() { return new Promise(resolve => { chrome.storage.local.get(['settings'], data => { resolve({ ...defaultSettings, ...(data.settings || {}) }); }); }); }
  function saveSettings(settings) { return chrome.storage.local.set({ settings }); }

  async function loadSettingsUI() {
    const s = await getSettings();
    els.origFontSize.value = s.origFontSize || 20;
    els.origFontSizeValue.textContent = (s.origFontSize || 20) + 'px';
    els.origColor.value = s.origColor || '#FFA800';
    els.origColorValue.textContent = s.origColor || '#FFA800';
    els.showOriginal.checked = s.showOriginal !== false;
    els.pronFontSize.value = s.pronFontSize || 18;
    els.pronFontSizeValue.textContent = (s.pronFontSize || 18) + 'px';
    els.pronColor.value = s.pronColor || '#F5E6CC';
    els.pronColorValue.textContent = s.pronColor || '#F5E6CC';
    els.showPronunciation.checked = s.showPronunciation !== false;
    els.mainFontSize.value = s.mainFontSize || 28;
    els.mainFontSizeValue.textContent = (s.mainFontSize || 28) + 'px';
    els.mainColor.value = s.mainColor || '#FFFFFF';
    els.mainColorValue.textContent = s.mainColor || '#FFFFFF';
    els.bgColor.value = s.bgColor;
    els.bgColorValue.textContent = s.bgColor;
    els.bgOpacity.value = Math.round((s.bgOpacity ?? 0.45) * 100);
    els.bgOpacityValue.textContent = Math.round((s.bgOpacity ?? 0.45) * 100) + '%';
    els.bgBlur.value = s.bgBlur ?? 4;
    els.bgBlurValue.textContent = (s.bgBlur ?? 4) + 'px';
    els.libraryDisplayLang.value = s.libraryDisplayLang || 'both';
    els.settingsAnimation.value = s.animation || 'fade';
    els.textShadow.checked = s.textShadow !== false;
    els.showEndNotice.checked = s.showEndNotice !== false;
    els.showProgressBar.checked = s.showProgressBar !== false;
    els.remoteBtnLibrary.checked = s.remoteBtnLibrary !== false;
    els.remoteBtnTimeline.checked = s.remoteBtnTimeline !== false;
    els.remoteBtnArea.checked = s.remoteBtnArea !== false;
    els.remoteBtnPlayStop.checked = s.remoteBtnPlayStop !== false;
    els.remoteBtnSync.checked = s.remoteBtnSync !== false;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      let hostname = '';
      if (tabs[0] && tabs[0].url) {
        try { hostname = new URL(tabs[0].url).hostname; } catch (e) { }
      }
      const sites = s.remoteEnabledSites || {};
      const isEnabled = hostname ? sites[hostname] === true : false;
      els.btnToggleRemote.dataset.active = isEnabled ? 'true' : 'false';
      if (isEnabled) {
        els.btnToggleRemote.classList.add('active');
        els.btnToggleRemote.textContent = '리모컨 ON';
      } else {
        els.btnToggleRemote.classList.remove('active');
        els.btnToggleRemote.textContent = '리모컨 OFF';
      }
    });

    if (els.googleSheetUrl) els.googleSheetUrl.value = s.googleSheetUrl || '';
  }

  function bindSettingsInputs() {
    els.origFontSize.addEventListener('input', () => { els.origFontSizeValue.textContent = els.origFontSize.value + 'px'; });
    els.pronFontSize.addEventListener('input', () => { els.pronFontSizeValue.textContent = els.pronFontSize.value + 'px'; });
    els.mainFontSize.addEventListener('input', () => { els.mainFontSizeValue.textContent = els.mainFontSize.value + 'px'; });
    els.origColor.addEventListener('input', () => { els.origColorValue.textContent = els.origColor.value; });
    els.pronColor.addEventListener('input', () => { els.pronColorValue.textContent = els.pronColor.value; });
    els.mainColor.addEventListener('input', () => { els.mainColorValue.textContent = els.mainColor.value; });
    els.bgColor.addEventListener('input', () => { els.bgColorValue.textContent = els.bgColor.value; });
    els.bgOpacity.addEventListener('input', () => { els.bgOpacityValue.textContent = els.bgOpacity.value + '%'; });
    els.bgBlur.addEventListener('input', () => { els.bgBlurValue.textContent = els.bgBlur.value + 'px'; });
    els.libraryDisplayLang.addEventListener('change', () => {
      renderLibrary();
      updatePlayerUI();
    });

    els.btnSelectArea.addEventListener('click', () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'START_AREA_SELECTION' }, (response) => {
            if (response && response.error) {
              showToast(response.error);
            } else {
              window.close();
            }
          });
        }
      });
    });

    els.btnToggleRemote.addEventListener('click', () => {
      let isActive = els.btnToggleRemote.dataset.active === 'true';
      isActive = !isActive;
      els.btnToggleRemote.dataset.active = isActive ? 'true' : 'false';

      if (isActive) {
        els.btnToggleRemote.classList.add('active');
        els.btnToggleRemote.textContent = '리모컨 ON';
      } else {
        els.btnToggleRemote.classList.remove('active');
        els.btnToggleRemote.textContent = '리모컨 OFF';
      }

      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        let hostname = '';
        if (tabs[0] && tabs[0].url) {
          try { hostname = new URL(tabs[0].url).hostname; } catch (e) { }
        }
        const s = await getSettings();
        if (!s.remoteEnabledSites) s.remoteEnabledSites = {};
        if (hostname) {
          s.remoteEnabledSites[hostname] = isActive;
        }
        await saveSettings(s);
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'UPDATE_STYLE', settings: s }).catch(() => { });
        }
        showToast(isActive ? '현재 사이트 리모컨: ON' : '현재 사이트 리모컨: OFF');
      });
    });
  }

  els.btnSaveSettings.addEventListener('click', async () => {
    const s = await getSettings();
    // false인 사이트는 저장하지 않음 (ON인 사이트만 유지)
    const enabledSites = Object.fromEntries(
      Object.entries(s.remoteEnabledSites || {}).filter(([, v]) => v === true)
    );
    const settings = {
      origFontSize: parseInt(els.origFontSize.value), origColor: els.origColor.value,
      showOriginal: els.showOriginal.checked,
      pronFontSize: parseInt(els.pronFontSize.value), pronColor: els.pronColor.value,
      showPronunciation: els.showPronunciation.checked,
      mainFontSize: parseInt(els.mainFontSize.value), mainColor: els.mainColor.value,
      bgColor: els.bgColor.value, bgOpacity: parseInt(els.bgOpacity.value) / 100,
      bgBlur: parseInt(els.bgBlur.value),
      libraryDisplayLang: els.libraryDisplayLang.value,
      animation: els.settingsAnimation.value,
      textShadow: els.textShadow.checked,
      googleSheetUrl: els.googleSheetUrl ? els.googleSheetUrl.value.trim() : '',
      showEndNotice: els.showEndNotice.checked,
      showProgressBar: els.showProgressBar.checked,
      remoteBtnLibrary: els.remoteBtnLibrary.checked,
      remoteBtnTimeline: els.remoteBtnTimeline.checked,
      remoteBtnArea: els.remoteBtnArea.checked,
      remoteBtnPlayStop: els.remoteBtnPlayStop.checked,
      remoteBtnSync: els.remoteBtnSync.checked,
      remoteEnabledSites: enabledSites
    };
    await saveSettings(settings);
    await sendToContent({ type: 'UPDATE_STYLE', settings });

    showToast('설정이 저장되었습니다');
  });

  els.btnResetSettings.addEventListener('click', async () => {
    await saveSettings(defaultSettings);
    await loadSettingsUI();
    await sendToContent({ type: 'UPDATE_STYLE', settings: defaultSettings });
    showToast('기본값으로 복원되었습니다');
  });

  // ============================================================
  // ============================================================
  // 유틸리티
  // ============================================================
  function getStorageData(...keys) { return new Promise(resolve => { chrome.storage.local.get(keys, resolve); }); }
  function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str; return div.innerHTML; }

  // ============================================================
  // 초기화 - 상태 복원
  // ============================================================
  async function init() {
    // 최초 실행 플래그 설정
    const data = await getStorageData('isInitialized');
    if (!data.isInitialized) {
      await chrome.storage.local.set({ isInitialized: true });
    }

    await loadSettingsUI();
    bindSettingsInputs();

    const libraryData = await getStorageData('savedLyrics');
    const savedLyrics = libraryData.savedLyrics || [];
    const s = await getSettings();
    if (savedLyrics.length === 0 && s.googleSheetUrl) {
      await syncFromSheet(s.googleSheetUrl);
    }
    renderLibrary();

    const status = await sendToContent({ type: 'GET_STATUS' });

    if (status?.hasLyrics) {
      const stored = await getStorageData('currentTrack');
      if (stored.currentTrack) {
        currentLyricsData = {
          name: stored.currentTrack.name || status.trackName || '로드된 가사',
          count: status.lyricCount || stored.currentTrack.count,
          duration: status.totalDuration || stored.currentTrack.duration,
          srtText: stored.currentTrack.srtText
        };
        // 타임라인 복원
        if (stored.currentTrack.srtText) {
          buildTimeline(stored.currentTrack.srtText);
        }
      } else {
        currentLyricsData = {
          name: status.trackName || '로드된 가사',
          count: status.lyricCount,
          duration: status.totalDuration,
          srtText: null
        };
      }
      updatePlayerUI();

      if (status.syncOffset && status.syncOffset !== 0) {
        updateSyncDisplay(status.syncOffset);
      }

      if (status.isPlaying) {
        els.playIcon.textContent = status.isPaused ? '▶' : '⏸';
        if (!status.isPaused) startStatusPolling();
        if (status.totalDuration > 0) {
          const pct = (status.currentTime / status.totalDuration) * 100;
          els.progressFill.style.width = `${Math.min(pct, 100)}%`;
          els.currentTime.textContent = formatTime(status.currentTime);
          updateTimelineHighlight(status.currentTime);
        }
      }
    }
  }

  init();
});
