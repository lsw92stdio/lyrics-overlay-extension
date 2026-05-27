/**
 * Content Script - 싱크 가사 오버레이 엔진
 * 
 * 웹 페이지 위에 오버레이를 생성하고,
 * 타이머 기반으로 SRT 가사를 싱크하여 표시합니다.
 * 
 * \N 구분자로 1~3줄 지원:
 *   1줄: 단일 텍스트
 *   2줄: 원문 + 한국어 번역 (번역이 크게)
 *   3줄: 원문 + 발음 + 한국어 번역 (번역이 크게)
 *   마지막 줄 = 메인 (크게, 흰색)
 *   나머지 줄 = 서브 (작게, 색상 다름)
 */

(() => {
  'use strict';

  // ============================================================
  // 상태 관리
  // ============================================================
  const state = {
    lyrics: [],
    isPlaying: false,
    isPaused: false,
    startTimestamp: 0,
    pausedAt: 0,
    syncOffset: 0,        // 싱크 오프셋 (ms) - 양수:가사 늦게, 음수:가사 빠르게
    currentEntry: null,
    animFrameId: null,
    settings: null,
    overlay: null,
    shadowRoot: null,
    trackName: '',
    // 드래그 상태
    isDragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
    // 새로 추가된 상태
    lastElapsed: 0,
    hasJumpedBeforeStart: false,
    endNoticeShown: false
  };

  // ============================================================
  // 오버레이 DOM 생성 (Shadow DOM)
  // ============================================================
  function createOverlay() {
    if (state.overlay) return;

    const host = document.createElement('div');
    host.id = 'lyrics-overlay-host';
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: 'closed' });
    state.shadowRoot = shadow;

    const style = document.createElement('style');
    style.textContent = getOverlayCSS();
    shadow.appendChild(style);

    const customStyle = document.createElement('style');
    customStyle.id = 'custom-css';
    shadow.appendChild(customStyle);

    const container = document.createElement('div');
    container.className = 'lyrics-overlay-container animation-fade hidden';

    const box = document.createElement('div');
    box.className = 'lyrics-box empty';

    // lines 컨테이너 - 동적으로 줄이 추가/제거됨
    const linesContainer = document.createElement('div');
    linesContainer.className = 'lyrics-lines';

    box.appendChild(linesContainer);
    container.appendChild(box);
    shadow.appendChild(container);

    // 진행 바
    const progressBar = document.createElement('div');
    progressBar.className = 'lyrics-progress-bar';
    const progressFill = document.createElement('div');
    progressFill.className = 'lyrics-progress-fill';
    progressBar.appendChild(progressFill);
    shadow.appendChild(progressBar);

    state.overlay = {
      host,
      container,
      box,
      linesContainer,
      progressBar,
      progressFill,
      style,
      customStyle
    };

    // 플로팅 리모컨 생성
    const remote = document.createElement('div');
    remote.className = 'lyrics-remote hidden'; // 설정에 따라 보여짐
    
    // 사이트별 테마 적용
    const hostname = window.location.hostname;
    if (hostname.includes('chzzk.naver.com')) {
      remote.classList.add('theme-chzzk');
    } else if (hostname.includes('youtube.com')) {
      remote.classList.add('theme-youtube');
    } else if (hostname.includes('twitch.tv')) {
      remote.classList.add('theme-twitch');
    }
    remote.innerHTML = `
      <div class="remote-drag-handle" title="드래그해서 이동">⋮⋮</div>
      <div class="remote-controls">
        <button class="remote-btn remote-btn-library" id="remote-library-btn" title="노래 목록">🎵</button>
        <button class="remote-btn remote-btn-timeline" id="remote-timeline-btn" title="타임라인">📜</button>
        <button class="remote-btn remote-btn-area" id="remote-area-btn" title="영역 선택">🎯</button>
        <button class="remote-btn remote-btn-play" id="remote-toggle-play" title="재생/일시정지">▶</button>
        <button class="remote-btn remote-btn-stop" id="remote-stop" title="가사 닫기">■</button>
        <div class="remote-divider"></div>
        <button class="remote-btn remote-btn-sync-minus" id="remote-sync-minus" title="싱크 -0.1s">−</button>
        <div class="remote-sync-val" id="remote-sync-val" title="클릭시 싱크 초기화">0.0s</div>
        <button class="remote-btn remote-btn-sync-plus" id="remote-sync-plus" title="싱크 +0.1s">+</button>
      </div>
      <button class="remote-btn remote-btn-minimize" id="remote-minimize-btn" title="최소화/최대화" style="width: 20px;">›</button>
      <div class="remote-library-panel hidden" id="remote-library-panel">
        <div class="remote-library-header">가사 목록 <button class="remote-library-close" id="remote-library-close">✕</button></div>
        <div class="remote-library-search">
          <input type="text" id="remote-library-search-input" placeholder="곡명, 가수 검색..." autocomplete="off">
        </div>
        <div class="remote-library-list" id="remote-library-list"></div>
      </div>
      <div class="remote-timeline-panel hidden" id="remote-timeline-panel">
        <div class="remote-timeline-header">타임라인 <button class="remote-timeline-close" id="remote-timeline-close">✕</button></div>
        <div class="remote-timeline-list" id="remote-timeline-list"></div>
      </div>
    `;
    shadow.appendChild(remote);

    const btnLib = remote.querySelector('#remote-library-btn');
    const libPanel = remote.querySelector('#remote-library-panel');
    const btnLibClose = remote.querySelector('#remote-library-close');
    const libList = remote.querySelector('#remote-library-list');

    const btnTimeline = remote.querySelector('#remote-timeline-btn');
    const timelinePanel = remote.querySelector('#remote-timeline-panel');
    const timelineClose = remote.querySelector('#remote-timeline-close');
    const timelineList = remote.querySelector('#remote-timeline-list');

    const btnArea = remote.querySelector('#remote-area-btn');

    const btnToggle = remote.querySelector('#remote-toggle-play');
    const btnStop = remote.querySelector('#remote-stop');
    const btnMinus = remote.querySelector('#remote-sync-minus');
    const btnPlus = remote.querySelector('#remote-sync-plus');
    const syncVal = remote.querySelector('#remote-sync-val');
    const btnMinimize = remote.querySelector('#remote-minimize-btn');
    const remoteControls = remote.querySelector('.remote-controls');

    const searchInput = remote.querySelector('#remote-library-search-input');

    btnToggle.addEventListener('click', () => {
      if (!state.isPlaying) { if (state.lyrics.length > 0) play(); }
      else if (state.isPaused) { play(); }
      else { pause(); }
    });

    if (btnArea) {
      btnArea.addEventListener('click', () => {
        startAreaSelection();
        btnArea.blur(); // 클릭 후 포커스 해제 (하이라이트 제거)
      });
    }

    btnStop.addEventListener('click', stopPlayback);

    btnMinus.addEventListener('click', () => { adjustSyncFromRemote(-100); });
    btnPlus.addEventListener('click', () => { adjustSyncFromRemote(100); });
    syncVal.addEventListener('click', () => { adjustSyncFromRemote(-state.syncOffset); });

    searchInput.addEventListener('input', (e) => {
      loadRemoteLibrary(libList, e.target.value);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        libPanel.classList.add('hidden');
        searchInput.blur();
      }
    });

    btnLib.addEventListener('click', () => {
      if (libPanel.classList.contains('hidden')) {
        searchInput.value = '';
        updatePanelPosition(remote, libPanel);
        libPanel.classList.remove('hidden');
        timelinePanel.classList.add('hidden');
        autoSyncFromSheetIfEmpty(libList).then(() => {
          loadRemoteLibrary(libList, '');
          setTimeout(() => searchInput.focus(), 100);
        });
      } else {
        libPanel.classList.add('hidden');
      }
    });

    btnLibClose.addEventListener('click', () => {
      libPanel.classList.add('hidden');
    });

    btnTimeline.addEventListener('click', () => {
      if (timelinePanel.classList.contains('hidden')) {
        renderRemoteTimeline(timelineList);
        updatePanelPosition(remote, timelinePanel);
        timelinePanel.classList.remove('hidden');
        libPanel.classList.add('hidden');
      } else {
        timelinePanel.classList.add('hidden');
      }
    });

    timelineClose.addEventListener('click', () => {
      timelinePanel.classList.add('hidden');
    });

    state.overlay.remote = remote;
    state.overlay.btnToggle = btnToggle;
    state.overlay.syncVal = syncVal;
    state.overlay.libPanel = libPanel;
    state.overlay.timelinePanel = timelinePanel;
    state.overlay.timelineList = timelineList;

    // 리모컨 바깥 클릭 시 패널 자동 닫기 (Shadow DOM 외부 클릭만)
    document.addEventListener('mousedown', (e) => {
      if (!state.overlay || !state.overlay.remote) return;
      // closed Shadow DOM에서는 내부 클릭이 host로 retarget됨 → shadow 리스너가 처리
      if (e.target === host) return;
      // 진짜 외부 클릭일 때만 패널 닫기
      libPanel.classList.add('hidden');
      timelinePanel.classList.add('hidden');
    });
    // Shadow DOM 내부에서도 바깥 영역 체크
    shadow.addEventListener('mousedown', (e) => {
      if (!remote.contains(e.target)) {
        libPanel.classList.add('hidden');
        timelinePanel.classList.add('hidden');
      }
    });

    // 최소화 토글 버튼
    btnMinimize.addEventListener('click', () => {
      remote.classList.toggle('minimized');
      const isMin = remote.classList.contains('minimized');
      btnMinimize.textContent = isMin ? '‹' : '›';
      chrome.storage.local.set({ remoteMinimized: isMin });
      // 패널 열려있으면 닫기
      if (isMin) {
        libPanel.classList.add('hidden');
        timelinePanel.classList.add('hidden');
      }
    });

    setupDrag(container, box);
    setupRemoteDrag(remote);
    
    // 리모컨 저장된 위치 복원
    chrome.storage.local.get(['remotePosition', 'remoteMinimized'], (data) => {
      if (data.remotePosition) {
        let right, bottom;
        // 비율 기반 저장값이 있으면 현재 창 크기로 변환
        if (data.remotePosition.rightRatio !== undefined) {
          right = data.remotePosition.rightRatio * window.innerWidth;
          bottom = data.remotePosition.bottomRatio * window.innerHeight;
        } else {
          // 구형 픽셀 기반 저장값 호환
          right = parseFloat(data.remotePosition.right) || 30;
          bottom = parseFloat(data.remotePosition.bottom) || 30;
        }
        // 경계 안으로 보정
        right = Math.max(0, Math.min(right, window.innerWidth - remote.offsetWidth));
        bottom = Math.max(0, Math.min(bottom, window.innerHeight - remote.offsetHeight));
        remote.style.right = right + 'px';
        remote.style.bottom = bottom + 'px';
        remote.style.left = 'auto';
        remote.style.top = 'auto';
      }
      if (data.remoteMinimized) {
        remote.classList.add('minimized');
        btnMinimize.textContent = '‹';
      }
    });

    // 창 크기 변경 시 리모컨이 화면 밖으로 나가지 않도록 보정
    window.addEventListener('resize', () => {
      const rect = remote.getBoundingClientRect();
      let right = window.innerWidth - rect.right;
      let bottom = window.innerHeight - rect.bottom;
      right = Math.max(0, Math.min(right, window.innerWidth - remote.offsetWidth));
      bottom = Math.max(0, Math.min(bottom, window.innerHeight - remote.offsetHeight));
      remote.style.right = right + 'px';
      remote.style.bottom = bottom + 'px';
      remote.style.left = 'auto';
      remote.style.top = 'auto';
    });
    
    restoreSavedPosition();
  }

  function updatePanelPosition(remote, panel) {
    const rect = remote.getBoundingClientRect();
    // 패널 최대 높이(300px) + 여유(20px)가 위에 들어가지 않으면 아래로
    if (rect.top < 330) {
      panel.classList.add('panel-below');
    } else {
      panel.classList.remove('panel-below');
    }
  }

  async function autoSyncFromSheetIfEmpty(listEl) {
    const data = await new Promise(r => chrome.storage.local.get(['savedLyrics', 'settings'], r));
    const list = data.savedLyrics || [];
    const url = data.settings && data.settings.googleSheetUrl;
    if (list.length > 0 || !url) return;

    listEl.innerHTML = '<div class="remote-sync-status"><span class="remote-sync-spinner"></span>구글 시트에서 불러오는 중...</div>';

    try {
      const response = await fetch(SheetParser.toExportUrl(url));
      if (!response.ok) { listEl.innerHTML = ''; return; }

      const newLyrics = SheetParser.rowsToLyrics(SheetParser.parseCSV(await response.text()).slice(1));
      if (newLyrics.length === 0) { listEl.innerHTML = ''; return; }

      let maxIdx = 0;
      newLyrics.forEach(l => {
        const n = l.parsed && l.parsed.index ? parseInt(l.parsed.index, 10) : NaN;
        if (!isNaN(n) && n > maxIdx) maxIdx = n;
      });
      newLyrics.forEach(l => {
        if (l.parsed && !l.parsed.index) {
          maxIdx++;
          l.parsed.index = String(maxIdx).padStart(4, '0');
        }
      });
      const withIds = newLyrics.map(l => ({
        ...l,
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        createdAt: Date.now()
      }));
      await new Promise(r => chrome.storage.local.set({ savedLyrics: withIds }, r));

      listEl.innerHTML = `<div class="remote-sync-status remote-sync-done">✓ ${newLyrics.length}곡 연동 완료</div>`;
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      listEl.innerHTML = '';
    }
  }

  function getRemoteMatchChips(item, q) {
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

  function renderRemoteMatchChips(chips, q) {
    return chips.map(({ type, value }) => {
      const idx = value.toLowerCase().indexOf(q.toLowerCase());
      const highlighted = idx === -1
        ? escapeHtml(value)
        : escapeHtml(value.slice(0, idx)) + `<mark>${escapeHtml(value.slice(idx, idx + q.length))}</mark>` + escapeHtml(value.slice(idx + q.length));
      return `<span class="remote-match-chip"><span class="remote-chip-type">${escapeHtml(type)}</span>${highlighted}</span>`;
    }).join('');
  }

  function loadRemoteLibrary(listEl, searchTerm = '') {
    chrome.storage.local.get(['savedLyrics'], (data) => {
      let list = data.savedLyrics || [];
      
      if (searchTerm) {
        const lowerTerm = searchTerm.toLowerCase();
        list = list.filter(item => {
          let keywords = '';
          if (item.parsed) {
            keywords += (item.parsed.titleOrig || '') + ' ';
            keywords += (item.parsed.titleKo || '') + ' ';
            keywords += (item.parsed.artistOrig || '') + ' ';
            keywords += (item.parsed.artistKo || '') + ' ';
            if (item.parsed.keywords) keywords += item.parsed.keywords.join(' ') + ' ';
          }
          return item.name.toLowerCase().includes(lowerTerm) || keywords.toLowerCase().includes(lowerTerm);
        });
      }

      if (list.length === 0) {
        listEl.innerHTML = '<div style="padding:12px;text-align:center;color:rgba(255,255,255,0.5);font-size:11px;">검색 결과가 없습니다.</div>';
        return;
      }
      
      const sortedList = [...list].sort((a, b) => {
        const aIndex = a.parsed?.index ? parseInt(a.parsed.index) : Infinity;
        const bIndex = b.parsed?.index ? parseInt(b.parsed.index) : Infinity;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return a.name.localeCompare(b.name);
      });

      const s = state.settings || {};
      const displayLang = s.libraryDisplayLang || 'both';

      listEl.innerHTML = sortedList.map((item, idx) => {
        let titleHtml = escapeHtml(item.name);
        let artistHtml = '';
        let indexBadge = '';
        
        if (item.parsed) {
          if (item.parsed.index) {
            indexBadge = `<span class="remote-library-index">${escapeHtml(item.parsed.index)}</span>`;
          }
          
          let title = '';
          let artist = '';
          
          if (displayLang === 'orig') {
            title = item.parsed.titleOrig || item.parsed.titleKo || item.name;
            artist = item.parsed.artistOrig || item.parsed.artistKo || '';
          } else if (displayLang === 'ko') {
            title = item.parsed.titleKo || item.parsed.titleOrig || item.name;
            artist = item.parsed.artistKo || item.parsed.artistOrig || '';
          } else {
            const titleOrig = item.parsed.titleOrig || '';
            const titleKo = item.parsed.titleKo || '';
            title = titleKo ? (titleOrig ? `${titleKo}<span class="remote-library-title-sub">${escapeHtml(titleOrig)}</span>` : titleKo) : (titleOrig || item.name);
            
            const artistOrig = item.parsed.artistOrig || '';
            const artistKo = item.parsed.artistKo || '';
            artist = artistKo ? (artistOrig && artistOrig !== artistKo ? `${artistKo}<span class="remote-library-artist-sub">${escapeHtml(artistOrig)}</span>` : artistKo) : artistOrig;
          }
          
          titleHtml = escapeHtml(title).replace(/&amp;/g, '&');
          // re-escape except spans we just built
          if (displayLang === 'both') {
            titleHtml = (item.parsed.titleKo || item.parsed.titleOrig) ? 
              (item.parsed.titleKo 
                ? (item.parsed.titleOrig && item.parsed.titleOrig !== item.parsed.titleKo
                  ? `${escapeHtml(item.parsed.titleKo)}<span class="remote-library-title-sub">${escapeHtml(item.parsed.titleOrig)}</span>`
                  : escapeHtml(item.parsed.titleKo))
                : escapeHtml(item.parsed.titleOrig)
              ) : escapeHtml(item.name);
            const aOrig = item.parsed.artistOrig || '';
            const aKo = item.parsed.artistKo || '';
            artist = aKo 
              ? (aOrig && aOrig !== aKo ? `${escapeHtml(aKo)} <span class="remote-library-artist-sub">${escapeHtml(aOrig)}</span>` : escapeHtml(aKo))
              : escapeHtml(aOrig);
          } else {
            titleHtml = escapeHtml(title);
            artist = escapeHtml(artist);
          }
          
          if (artist) {
            artistHtml = `<div class="remote-library-artist">${artist}</div>`;
          }
        }
        
        const isActive = (state.trackName === item.name);
        const chipsHtml = searchTerm ? renderRemoteMatchChips(getRemoteMatchChips(item, searchTerm), searchTerm) : '';
        return `<div class="remote-library-item ${isActive ? 'active' : ''}" data-index="${idx}" data-id="${item.id || ''}">
          <div class="remote-library-title">${indexBadge}${titleHtml}</div>
          ${artistHtml}
          ${chipsHtml ? `<div class="remote-match-chips">${chipsHtml}</div>` : ''}
        </div>`;
      }).join('');

      listEl.querySelectorAll('.remote-library-item').forEach(el => {
        el.addEventListener('click', () => {
          const idx = parseInt(el.dataset.index);
          const item = sortedList[idx];
          if (item) {
            playFromRemoteLibrary(item);
            if (state.overlay && state.overlay.libPanel) {
              state.overlay.libPanel.classList.add('hidden');
            }
          }
        });
      });
    });
  }

  function playFromRemoteLibrary(item) {
    if (!item || !item.srtText) return;
    const parsed = SRTParser.parse(item.srtText);
    state.lyrics = parsed;
    state.syncOffset = 0;
    state.trackName = item.name;
    
    // 팝업 복원용 트랙 정보 갱신
    chrome.storage.local.set({ currentTrack: {
      name: state.trackName,
      count: parsed.length,
      duration: SRTParser.getTotalDuration(parsed),
      srtText: item.srtText
    }});
    
    play();
  }

  function escapeHtml(str) {
    return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag]));
  }

  function renderRemoteTimeline(listEl) {
    if (!state.lyrics || state.lyrics.length === 0) {
      listEl.innerHTML = '<div style="padding:12px;text-align:center;color:rgba(255,255,255,0.5);font-size:11px;">현재 로드된 가사가 없습니다.</div>';
      return;
    }
    
    listEl.innerHTML = state.lyrics.map((entry, idx) => {
      const timeStr = formatTimeRemote(entry.startTime);
      
      let textHtml = '';
      if (entry.lines && entry.lines.length > 0) {
        if (entry.lines.length === 1) {
          textHtml = escapeHtml(entry.lines[0]);
        } else {
          const mainLine = entry.lines[entry.lines.length - 1];
          const subLines = entry.lines.slice(0, -1).join(' / ');
          textHtml = `${escapeHtml(mainLine)}<div style="font-size:10px; opacity:0.6; margin-top:2px;">${escapeHtml(subLines)}</div>`;
        }
      }

      return `<div class="remote-timeline-item" data-time="${entry.startTime}">
        <span class="remote-timeline-time">${timeStr}</span>
        <span class="remote-timeline-text">${textHtml}</span>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.remote-timeline-item').forEach(el => {
      el.addEventListener('click', () => {
        const timeMs = parseInt(el.dataset.time, 10);
        seek(timeMs);
        if (!state.isPlaying) play();
      });
    });
    
    // 현재 활성화된 줄 하이라이트
    if (state.currentEntry) {
      updateRemoteTimelineHighlight(state.currentEntry);
    }
  }

  function formatTimeRemote(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
    const s = (totalSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function updateRemoteTimelineHighlight(entry) {
    if (!state.overlay || !state.overlay.timelineList) return;
    const list = state.overlay.timelineList;
    list.querySelectorAll('.active').forEach(el => el.classList.remove('active'));
    
    if (entry && entry.startTime !== undefined) {
      const items = list.querySelectorAll('.remote-timeline-item');
      for (const el of items) {
        if (parseInt(el.dataset.time, 10) === entry.startTime) {
          el.classList.add('active');
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        }
      }
    }
  }

  function adjustSyncFromRemote(delta) {
    state.syncOffset += delta;
    updateRemoteSyncDisplay();
    // 일시정지 중이면 표시 업데이트
    if (state.isPaused && state.isPlaying) {
      const elapsed = state.pausedAt + state.syncOffset;
      const entry = SRTParser.findEntryAtTime(state.lyrics, elapsed);
      state.currentEntry = null; // 강제 업데이트
      updateDisplay(entry);
    }
  }

  function updateRemoteSyncDisplay() {
    if (!state.overlay || !state.overlay.syncVal) return;
    const s = state.syncOffset / 1000;
    state.overlay.syncVal.textContent = (s > 0 ? '+' : '') + s.toFixed(1) + 's';
  }

  // ============================================================
  // 인라인 CSS
  // ============================================================
  function getOverlayCSS() {
    return `
      @import url('https://fonts.googleapis.com/css2?family=M+PLUS+1+Code:wght@600&display=swap');

      .lyrics-overlay-container {
        position: fixed;
        z-index: 2147483647;
        display: flex;
        justify-content: center;
        align-items: center;
        pointer-events: none;
        transition: opacity 0.3s ease;
        font-family: 'Noto Sans KR', 'M PLUS 1 Code', 'Malgun Gothic', sans-serif;
      }

      .lyrics-box {
        text-align: center;
        padding: 16px 32px;
        border-radius: 12px;
        max-width: 80vw;
        min-width: 200px;
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.08);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        transition: background-color 0.3s ease;
        pointer-events: auto;
        cursor: grab;
        user-select: none;
        -webkit-user-select: none;
      }

      .lyrics-box.dragging {
        cursor: grabbing;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
        border-color: rgba(0, 255, 163, 0.3);
      }

      .lyrics-lines {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        pointer-events: none;
      }

      /* 원문 라인 */
      .lyrics-line-orig {
        font-size: 20px;
        font-weight: 600;
        line-height: 1.4;
        letter-spacing: 0.01em;
        text-shadow: 0 2px 6px rgba(0,0,0,0.7), 0 0 2px rgba(0,0,0,0.8);
        color: #FFA800;
        opacity: 0.9;
      }

      /* 발음 라인 */
      .lyrics-line-pron {
        font-size: 18px;
        font-weight: 600;
        line-height: 1.4;
        letter-spacing: 0.01em;
        text-shadow: 0 2px 6px rgba(0,0,0,0.7), 0 0 2px rgba(0,0,0,0.8);
        color: #F5E6CC;
        opacity: 0.85;
      }

      /* 한국어 번역 (메인) - 항상 마지막 줄 */
      .lyrics-line-main {
        font-size: 28px;
        font-weight: 600;
        line-height: 1.5;
        letter-spacing: 0.02em;
        text-shadow: 0 2px 8px rgba(0,0,0,0.8), 0 0 2px rgba(0,0,0,0.9);
        color: #FFFFFF;
        margin-top: 2px;
      }

      /* 1줄짜리: 메인 스타일 적용 */
      .lyrics-line-solo {
        font-size: 28px;
        font-weight: 600;
        line-height: 1.5;
        letter-spacing: 0.02em;
        text-shadow: 0 2px 8px rgba(0,0,0,0.8), 0 0 2px rgba(0,0,0,0.9);
        color: #FFFFFF;
      }

      .lyrics-box.empty { opacity: 0; pointer-events: none; }

      /* 페이드 애니메이션 */
      .animation-fade .lyrics-box { transition: opacity 0.4s cubic-bezier(0.4,0,0.2,1); }
      .animation-fade .lyrics-box.entering {
        animation: lyricsFadeIn 0.4s cubic-bezier(0.4,0,0.2,1) forwards;
      }
      .animation-fade .lyrics-box.exiting {
        animation: lyricsFadeOut 0.4s cubic-bezier(0.4,0,0.2,1) forwards;
      }

      /* 원격 컨트롤 (리모컨) */
      .lyrics-remote {
        --theme-color: #00FFA3;
        --theme-bg-07: rgba(0, 255, 163, 0.07);
        --theme-bg-12: rgba(0, 255, 163, 0.12);
        --theme-bg-25: rgba(0, 255, 163, 0.25);
        --theme-bg-30: rgba(0, 255, 163, 0.3);

        position: fixed;
        bottom: 30px;
        right: 30px;
        background: rgba(20, 21, 23, 0.92);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        display: flex;
        align-items: center;
        padding: 6px;
        gap: 4px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        pointer-events: auto;
        color: white;
        user-select: none;
        -webkit-user-select: none;
        transition: opacity 0.3s ease, transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        z-index: 2147483647;
      }
      .lyrics-remote.theme-chzzk {
        --theme-color: #00FFA3;
        --theme-bg-07: rgba(0, 255, 163, 0.07);
        --theme-bg-12: rgba(0, 255, 163, 0.12);
        --theme-bg-25: rgba(0, 255, 163, 0.25);
        --theme-bg-30: rgba(0, 255, 163, 0.3);
      }
      .lyrics-remote.theme-youtube {
        --theme-color: #FF0033;
        --theme-bg-07: rgba(255, 0, 51, 0.07);
        --theme-bg-12: rgba(255, 0, 51, 0.12);
        --theme-bg-25: rgba(255, 0, 51, 0.25);
        --theme-bg-30: rgba(255, 0, 51, 0.3);
      }
      .lyrics-remote.theme-twitch {
        --theme-color: #9147FF;
        --theme-bg-07: rgba(145, 71, 255, 0.07);
        --theme-bg-12: rgba(145, 71, 255, 0.12);
        --theme-bg-25: rgba(145, 71, 255, 0.25);
        --theme-bg-30: rgba(145, 71, 255, 0.3);
      }
      .lyrics-remote.hidden {
        opacity: 0;
        transform: translateY(20px) scale(0.9);
        pointer-events: none;
      }
      .lyrics-remote.minimized .remote-controls {
        display: none !important;
      }
      .lyrics-remote.minimized .remote-drag-handle {
        padding-right: 0px;
      }
      .remote-drag-handle {
        cursor: grab;
        padding: 4px 5px;
        color: rgba(255, 255, 255, 0.35);
        display: flex;
        align-items: center;
        font-size: 13px;
        letter-spacing: 1px;
      }
      .remote-drag-handle:active {
        cursor: grabbing;
        color: rgba(255, 255, 255, 0.8);
      }
      .remote-controls {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .remote-divider {
        width: 1px;
        height: 20px;
        background: rgba(255,255,255,0.12);
        margin: 0 2px;
        flex-shrink: 0;
      }
      .remote-btn {
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.05);
        color: white;
        width: 32px;
        height: 32px;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        transition: background 0.2s, transform 0.1s;
      }
      .remote-btn:hover { background: rgba(255,255,255,0.15); }
      .remote-btn:active { background: rgba(255,255,255,0.25); transform: scale(0.95); }
      .remote-sync-val {
        font-size: 12px;
        font-weight: bold;
        min-width: 40px;
        text-align: center;
        cursor: pointer;
        padding: 0 4px;
      }
      .remote-sync-val:hover { color: var(--theme-color); }

      /* 리모컨 노래 목록 패널 */
      .remote-library-panel, .remote-timeline-panel {
        position: absolute;
        bottom: 100%;
        right: 0;
        margin-bottom: 8px;
        margin-top: 0;
        top: auto;
        background: rgba(20, 21, 23, 0.97);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        width: 250px;
        max-height: 300px;
        display: flex;
        flex-direction: column;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        pointer-events: auto;
        color: white;
        transition: opacity 0.2s, transform 0.2s;
        overflow: hidden;
      }
      .remote-library-panel.panel-below, .remote-timeline-panel.panel-below {
        bottom: auto;
        top: 100%;
        margin-bottom: 0;
        margin-top: 8px;
      }
      .remote-library-panel.hidden, .remote-timeline-panel.hidden {
        opacity: 0;
        transform: translateY(10px) scale(0.95);
        pointer-events: none;
      }
      .remote-library-header, .remote-timeline-header {
        padding: 10px 12px;
        font-size: 13px;
        font-weight: 600;
        border-bottom: 1px solid rgba(255,255,255,0.1);
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: rgba(255,255,255,0.05);
      }
      .remote-library-close, .remote-timeline-close {
        background: none;
        border: none;
        color: rgba(255,255,255,0.5);
        cursor: pointer;
        font-size: 14px;
        padding: 0 4px;
      }
      .remote-library-close:hover, .remote-timeline-close:hover { color: white; }
      .remote-library-search {
        padding: 6px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      .remote-library-search input {
        width: 100%;
        background: rgba(255,255,255,0.1);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 4px;
        color: white;
        padding: 6px 8px;
        font-size: 12px;
        outline: none;
        box-sizing: border-box;
      }
      .remote-library-search input:focus {
        border-color: var(--theme-color);
        background: rgba(255,255,255,0.15);
      }
      .remote-library-list, .remote-timeline-list {
        flex: 1;
        overflow-y: auto;
        padding: 4px 0;
      }
      .remote-library-list::-webkit-scrollbar, .remote-timeline-list::-webkit-scrollbar { width: 6px; }
      .remote-library-list::-webkit-scrollbar-thumb, .remote-timeline-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 3px; }
      .remote-library-item, .remote-timeline-item {
        padding: 8px 12px;
        font-size: 12px;
        cursor: pointer;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      .remote-library-title {
        font-size: 12px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .remote-library-index {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        background: var(--theme-bg-12);
        color: var(--theme-color);
        border: 1px solid var(--theme-bg-30);
        border-radius: 4px;
        font-size: 9px;
        font-weight: 700;
        padding: 1px 4px;
        font-family: monospace;
        letter-spacing: 0.03em;
      }
      .remote-library-title-sub {
        font-size: 10px;
        opacity: 0.55;
        font-weight: 400;
        margin-left: 3px;
      }
      .remote-library-artist {
        font-size: 10px;
        color: rgba(255,255,255,0.5);
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .remote-library-artist-sub {
        opacity: 0.7;
        font-weight: 400;
      }
      @keyframes remote-spin {
        to { transform: rotate(360deg); }
      }
      .remote-sync-status {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 20px 12px;
        font-size: 11px;
        color: rgba(255,255,255,0.6);
      }
      .remote-sync-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(255,255,255,0.15);
        border-top-color: var(--theme-color);
        border-radius: 50%;
        animation: remote-spin 0.8s linear infinite;
        flex-shrink: 0;
      }
      .remote-sync-done {
        color: var(--theme-color);
      }
      .remote-sync-done .remote-sync-spinner {
        display: none;
      }
      .remote-match-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 3px;
        margin-top: 3px;
      }
      .remote-match-chip {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        background: rgba(255,255,255,0.07);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 3px;
        padding: 1px 5px;
        font-size: 10px;
        color: rgba(255,255,255,0.6);
        white-space: nowrap;
      }
      .remote-chip-type {
        color: rgba(255,255,255,0.35);
        font-size: 9px;
      }
      .remote-chip-type::after {
        content: '·';
        margin-left: 2px;
      }
      .remote-match-chip mark {
        background: none;
        color: var(--theme-color);
        font-weight: 600;
      }
      .remote-library-item.active .remote-library-index {
        background: var(--theme-bg-25);
      }
      .remote-timeline-item {
        display: flex;
        gap: 8px;
        align-items: flex-start;
      }
      .remote-timeline-time {
        color: var(--theme-color);
        font-family: monospace;
        font-size: 11px;
        opacity: 0.9;
      }
      .remote-timeline-text {
        flex: 1;
        line-height: 1.4;
      }
      .remote-library-item:hover, .remote-timeline-item:hover {
        background: rgba(255,255,255,0.08);
      }
      .remote-library-item.active, .remote-timeline-item.active {
        color: var(--theme-color);
        font-weight: 600;
      }
      .remote-timeline-item.active {
        background: var(--theme-bg-07);
        border-left: 2px solid var(--theme-color);
      }
      .lyrics-remote.hidden {
        opacity: 0;
        transform: translateY(20px) scale(0.9);
        pointer-events: none;
      }
      .remote-drag-handle {
        cursor: grab;
        padding: 4px 6px;
        color: rgba(255, 255, 255, 0.4);
        display: flex;
        align-items: center;
        font-size: 14px;
      }
      .remote-drag-handle:active {
        cursor: grabbing;
        color: rgba(255, 255, 255, 0.8);
      }
      .remote-controls {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .remote-btn {
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.05);
        color: white;
        width: 32px;
        height: 32px;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        transition: background 0.2s, transform 0.1s;
      }
      .remote-btn:hover { background: rgba(255,255,255,0.15); }
      .remote-btn:active { background: rgba(255,255,255,0.25); transform: scale(0.95); }
      .remote-sync-val {
        font-size: 12px;
        font-weight: bold;
        min-width: 36px;
        text-align: center;
        cursor: pointer;
        padding: 0 3px;
        color: var(--theme-color);
      }
      .remote-sync-val:hover { color: white; }


      @keyframes lyricsFadeIn {
        from { opacity: 0; transform: translateY(10px) scale(0.98); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes lyricsFadeOut {
        from { opacity: 1; transform: translateY(0); }
        to { opacity: 0; transform: translateY(-8px); }
      }

      /* 슬라이드 애니메이션 */
      .animation-slide .lyrics-box.entering {
        animation: lyricsSlideIn 0.5s cubic-bezier(0.16,1,0.3,1) forwards;
      }
      .animation-slide .lyrics-box.exiting {
        animation: lyricsSlideOut 0.4s cubic-bezier(0.7,0,0.84,0) forwards;
      }
      @keyframes lyricsSlideIn {
        from { opacity: 0; transform: translateY(30px) scale(0.95); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes lyricsSlideOut {
        from { opacity: 1; transform: translateY(0) scale(1); }
        to { opacity: 0; transform: translateY(-30px) scale(0.95); }
      }

      .animation-none .lyrics-box { transition: none; }

      .lyrics-overlay-container.hidden {
        opacity: 0 !important;
      }
      .lyrics-overlay-container.hidden .lyrics-box {
        pointer-events: none !important;
      }

      /* 진행 바 */
      .lyrics-progress-bar {
        position: fixed;
        bottom: 0; left: 0; right: 0;
        height: 3px;
        background: rgba(255,255,255,0.1);
        z-index: 2147483646;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.3s ease;
      }
      .lyrics-progress-bar.visible { opacity: 1; }
      .lyrics-progress-fill {
        height: 100%;
        background: var(--theme-color, #00FFA3);
        border-radius: 0 2px 2px 0;
        transition: width 0.1s linear;
        width: 0%;
      }

      /* 텍스트 외곽선 비활성 */
      .no-text-shadow .lyrics-line-orig,
      .no-text-shadow .lyrics-line-pron,
      .no-text-shadow .lyrics-line-main,
      .no-text-shadow .lyrics-line-solo {
        text-shadow: none !important;
      }
    `;
  }

  // ============================================================
  // 설정 적용
  // ============================================================
  function applySettings(settings) {
    state.settings = settings;

    // 리모컨 활성화 여부 처리 (사이트별)
    const hostname = window.location.hostname;
    let shouldShowRemote = false;
    
    if (settings.remoteEnabledSites && settings.remoteEnabledSites[hostname] === true) {
      shouldShowRemote = true;
    }

    if (!state.overlay) {
      if (shouldShowRemote) {
        createOverlay();
      } else {
        return;
      }
    }

    const { container, box, customStyle } = state.overlay;

    // 애니메이션
    container.className = container.className.replace(/animation-\w+/g, '');
    container.classList.add(`animation-${settings.animation || 'fade'}`);

    // 배경색 + 투명도 + 블러
    const bgColor = settings.bgColor || '#000000';
    const bgOpacity = settings.bgOpacity ?? 0.45;
    const bgBlur = settings.bgBlur ?? 4;
    const r = parseInt(bgColor.slice(1, 3), 16);
    const g = parseInt(bgColor.slice(3, 5), 16);
    const b = parseInt(bgColor.slice(5, 7), 16);
    box.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${bgOpacity})`;
    box.style.backdropFilter = `blur(${bgBlur}px)`;
    box.style.webkitBackdropFilter = `blur(${bgBlur}px)`;

    if (settings.fontFamily) {
      container.style.fontFamily = settings.fontFamily;
    }

    // 텍스트 외곽선
    if (settings.textShadow === false) {
      box.classList.add('no-text-shadow');
    } else {
      box.classList.remove('no-text-shadow');
    }

    // 커스텀 CSS
    if (settings.customCSS) {
      customStyle.textContent = settings.customCSS;
    } else {
      customStyle.textContent = '';
    }

    if (shouldShowRemote) {
      if (state.overlay && state.overlay.remote) {
        state.overlay.remote.classList.remove('hidden');
      }
    } else {
      // 재생 중이 아닐 때만 숨김
      if (!state.isPlaying && state.overlay && state.overlay.remote) {
        state.overlay.remote.classList.add('hidden');
      }
    }

    // 리모컨 버튼 표시/숨김
    if (state.overlay && state.overlay.remote) {
      const r = state.overlay.remote;
      const setVisible = (selector, visible) => {
        const el = r.querySelector(selector);
        if (el) el.style.display = visible ? '' : 'none';
      };
      setVisible('.remote-btn-library',    settings.remoteBtnLibrary    !== false);
      setVisible('.remote-btn-timeline',   settings.remoteBtnTimeline   !== false);
      setVisible('.remote-btn-area',       settings.remoteBtnArea       !== false);
      setVisible('.remote-btn-play',       settings.remoteBtnPlayStop   !== false);
      setVisible('.remote-btn-stop',       settings.remoteBtnPlayStop   !== false);
      setVisible('.remote-divider',        settings.remoteBtnSync       !== false);
      setVisible('.remote-btn-sync-minus', settings.remoteBtnSync       !== false);
      setVisible('#remote-sync-val',       settings.remoteBtnSync       !== false);
      setVisible('.remote-btn-sync-plus',  settings.remoteBtnSync       !== false);
    }

    // 리모컨 가사 목록이 열려있다면 새로고침 (표시 언어 설정 반영)
    if (state.overlay.libPanel && !state.overlay.libPanel.classList.contains('hidden')) {
      const searchInput = state.overlay.remote.querySelector('#remote-library-search-input');
      const libList = state.overlay.remote.querySelector('#remote-library-list');
      if (libList) {
        loadRemoteLibrary(libList, searchInput ? searchInput.value : '');
      }
    }

    // 진행 바 표시/숨김 설정 즉시 반영
    if (state.overlay.progressBar) {
      if (settings.showProgressBar !== false) {
        // 재생 중일 때만 다시 visible, 정지 상태면 유지
        if (state.isPlaying && !state.isPaused) {
          state.overlay.progressBar.classList.add('visible');
        }
      } else {
        state.overlay.progressBar.classList.remove('visible');
      }
    }

    // 현재 표시 중인 줄들에 스타일 실시간 적용
    applyLineStyles();
  }

  /**
   * 현재 표시 중인 줄들에 설정 기반 인라인 스타일 적용
   */
  function applyLineStyles() {
    if (!state.overlay || !state.settings) return;
    const s = state.settings;
    const lines = state.overlay.linesContainer.children;

    for (const line of lines) {
      if (line.classList.contains('lyrics-line-orig')) {
        line.style.fontSize = `${s.origFontSize || 20}px`;
        line.style.color = s.origColor || '#FFA800';
      } else if (line.classList.contains('lyrics-line-pron')) {
        line.style.fontSize = `${s.pronFontSize || 18}px`;
        line.style.color = s.pronColor || '#F5E6CC';
      } else if (line.classList.contains('lyrics-line-main') || line.classList.contains('lyrics-line-solo')) {
        line.style.fontSize = `${s.mainFontSize || 28}px`;
        line.style.color = s.mainColor || '#FFFFFF';
      }
    }
  }

  // ============================================================
  // 가사 표시 업데이트
  // ============================================================
  function updateDisplay(entry) {
    if (!state.overlay) return;
    const { box, linesContainer } = state.overlay;

    if (!entry) {
      if (state.currentEntry !== null) {
        box.classList.remove('entering');
        box.classList.add('exiting');
        setTimeout(() => {
          if (state.currentEntry === null) {
            box.classList.add('empty');
            box.classList.remove('exiting');
            linesContainer.innerHTML = '';
          }
        }, 400);
        state.currentEntry = null;
      }
      return;
    }

    // 같은 가사면 업데이트 불필요
    if (state.currentEntry && state.currentEntry.index === entry.index) {
      return;
    }

    // 새 가사 표시
    state.currentEntry = entry;
    box.classList.remove('empty', 'exiting');
    box.classList.remove('entering');
    void box.offsetWidth;
    box.classList.add('entering');

    // 줄 렌더링
    linesContainer.innerHTML = '';
    const lineCount = entry.lines.length;
    const s = state.settings || {};
    const showPron = s.showPronunciation !== false;

    // 줄 분류:
    //   1줄: [solo]
    //   2줄: [orig, main]
    //   3줄: [orig, pron, main]
    entry.lines.forEach((text, i) => {
      // 3줄일 때 발음(index 1) 숨기기
      if (lineCount === 3 && i === 1 && !showPron) return;
      
      // 2줄 이상일 때 원문(index 0) 숨기기
      if (lineCount > 1 && i === 0 && s.showOriginal === false) return;

      const div = document.createElement('div');

      if (lineCount === 1) {
        div.className = 'lyrics-line-solo';
        div.style.fontSize = `${s.mainFontSize || 28}px`;
        div.style.color = s.mainColor || '#FFFFFF';
      } else if (i === lineCount - 1) {
        // 마지막 줄: 한국어 번역 (메인)
        div.className = 'lyrics-line-main';
        div.style.fontSize = `${s.mainFontSize || 28}px`;
        div.style.color = s.mainColor || '#FFFFFF';
      } else if (lineCount === 3 && i === 1) {
        // 3줄에서 2번째: 발음
        div.className = 'lyrics-line-pron';
        div.style.fontSize = `${s.pronFontSize || 18}px`;
        div.style.color = s.pronColor || '#F5E6CC';
      } else {
        // 첫 번째 줄: 원문
        div.className = 'lyrics-line-orig';
        div.style.fontSize = `${s.origFontSize || 20}px`;
        div.style.color = s.origColor || '#FFA800';
      }

      div.textContent = text;
      linesContainer.appendChild(div);
    });

    if (state.overlay.timelineList) {
      updateRemoteTimelineHighlight(entry);
    }
  }

  // ============================================================
  // 진행 바 업데이트
  // ============================================================
  function updateProgressBar(currentTime) {
    if (!state.overlay || state.lyrics.length === 0) return;
    const totalDuration = SRTParser.getTotalDuration(state.lyrics);
    if (totalDuration <= 0) return;
    const percent = Math.min((currentTime / totalDuration) * 100, 100);
    state.overlay.progressFill.style.width = `${percent}%`;
  }

  // ============================================================
  // 재생 엔진
  // ============================================================
  function startPlaybackLoop() {
    function tick() {
      if (!state.isPlaying || state.isPaused) return;

      const elapsed = performance.now() - state.startTimestamp + state.syncOffset;
      const totalDuration = SRTParser.getTotalDuration(state.lyrics);
      
      // 1. 종료 알림 로직
      const s = state.settings || {};
      const showEndNotice = s.showEndNotice !== false;
      const showCountdown = s.showCountdown !== false;

      if (elapsed > totalDuration + 1000) {
        if (showEndNotice && !state.endNoticeShown && state.lyrics.length > 0) {
          state.endNoticeShown = true;
          // 가상의 종료 엔트리 렌더링
          updateDisplay({
            index: 'finish',
            start: totalDuration + 1000,
            end: totalDuration + 5000,
            lines: ['🎵 Finish 🎵']
          });
        }
        
        // 종료 알림이 떠있는 시간(약 4초)을 벌어주기 위해 여유 시간 증가
        if (elapsed > totalDuration + 5000) {
          stopPlayback();
          return;
        }
      } else {
        // 아직 종료 시점이 아니면
        state.endNoticeShown = false;
        
        // 일반 가사 렌더링
        const entry = SRTParser.findEntryAtTime(state.lyrics, elapsed);
        updateDisplay(entry);
      }
      
      updateProgressBar(elapsed);
      state.animFrameId = requestAnimationFrame(tick);
    }

    state.animFrameId = requestAnimationFrame(tick);
  }

  function play() {
    createOverlay();
    // 설정은 페이지 로드 시에만 적용, 여기서 다시 로드하면 패널 참조가 귀쳐짐

    if (state.overlay && state.overlay.btnToggle) state.overlay.btnToggle.textContent = '⏸';
    if (state.overlay && state.overlay.remote) state.overlay.remote.classList.remove('hidden');

    if (state.isPaused) {
      const pauseDuration = performance.now() - (state.startTimestamp + state.pausedAt);
      state.startTimestamp += pauseDuration;
      state.isPaused = false;
      state.overlay.container.classList.remove('hidden');
      if (state.settings?.showProgressBar !== false) {
        state.overlay.progressBar.classList.add('visible');
      }
      startPlaybackLoop();
      return;
    }

    state.isPlaying = true;
    state.isPaused = false;
    state.startTimestamp = performance.now();
    state.lastElapsed = 0;
    state.hasJumpedBeforeStart = false;
    state.endNoticeShown = false;
    state.currentEntry = null;
    state.overlay.container.classList.remove('hidden');
    if (state.settings?.showProgressBar !== false) {
      state.overlay.progressBar.classList.add('visible');
    }
    state.overlay.progressFill.style.width = '0%';
    startPlaybackLoop();
  }

  function pause() {
    if (!state.isPlaying) return;
    state.isPaused = true;
    state.pausedAt = performance.now() - state.startTimestamp;
    if (state.overlay && state.overlay.btnToggle) state.overlay.btnToggle.textContent = '▶';
    if (state.animFrameId) {
      cancelAnimationFrame(state.animFrameId);
      state.animFrameId = null;
    }
  }

  function stopPlayback() {
    state.isPlaying = false;
    state.isPaused = false;
    state.pausedAt = 0;
    state.lastElapsed = 0;
    state.endNoticeShown = false;
    state.currentEntry = null;
    if (state.animFrameId) {
      cancelAnimationFrame(state.animFrameId);
      state.animFrameId = null;
    }
    if (state.overlay) {
      state.overlay.container.classList.add('hidden');
      state.overlay.progressBar.classList.remove('visible');
      state.overlay.box.classList.add('empty');
      state.overlay.linesContainer.innerHTML = '';
      state.overlay.progressFill.style.width = '0%';
      if (state.overlay.btnToggle) state.overlay.btnToggle.textContent = '▶';
      
      // 사이트별 리모컨 ON 상태면 숨기지 않음
      const hostname = window.location.hostname;
      const siteEnabled = state.settings && state.settings.remoteEnabledSites && state.settings.remoteEnabledSites[hostname] === true;
      if (!siteEnabled && state.overlay.remote) {
        state.overlay.remote.classList.add('hidden');
      }
    }
  }

  function seek(timeMs) {
    if (!state.isPlaying) return;
    
    // 점프를 통해 첫 가사 이전으로 이동한 경우 카운트다운 방지
    if (state.lyrics.length > 0 && timeMs < state.lyrics[0].start) {
      state.hasJumpedBeforeStart = true;
    }
    
    state.startTimestamp = performance.now() - timeMs;
    if (state.isPaused) {
      state.pausedAt = timeMs;
      const entry = SRTParser.findEntryAtTime(state.lyrics, timeMs);
      updateDisplay(entry);
      updateProgressBar(timeMs);
    }
  }

  // ============================================================
  // 드래그 기능
  // ============================================================
  function setupDrag(container, box) {
    box.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      state.isDragging = true;

      const rect = container.getBoundingClientRect();
      // 클릭 지점과 박스 중심의 오프셋
      const centerX = rect.left + rect.width / 2;
      state.dragOffsetX = e.clientX - centerX;
      state.dragOffsetY = e.clientY - rect.top;

      box.classList.add('dragging');
    });

    document.addEventListener('mousemove', (e) => {
      if (!state.isDragging) return;
      e.preventDefault();

      // centerX: 박스의 중심이 위치할 X좌표
      let centerX = e.clientX - state.dragOffsetX;
      let newY = e.clientY - state.dragOffsetY;

      // 화면 경계 제한 (중심 기준)
      const rect = container.getBoundingClientRect();
      const halfW = rect.width / 2;
      centerX = Math.max(halfW, Math.min(centerX, window.innerWidth - halfW));
      newY = Math.max(0, Math.min(newY, window.innerHeight - rect.height));

      // bottom 기준으로 위치 설정 (savePosition과 일관성 유지)
      const bottomY = window.innerHeight - newY - rect.height;
      container.style.left = centerX + 'px';
      container.style.top = 'auto';
      container.style.bottom = bottomY + 'px';
      container.style.transform = 'translateX(-50%)';
    });

    document.addEventListener('mouseup', () => {
      if (!state.isDragging) return;
      state.isDragging = false;

      if (state.overlay) {
        state.overlay.box.classList.remove('dragging');
      }

      savePosition();
    });
  }

  function savePosition() {
    if (!state.overlay) return;
    const rect = state.overlay.container.getBoundingClientRect();
    // 중심점 비율 및 하단 기준 비율로 저장 (위로 자라나게 하기 위함)
    const posData = {
      xCenterPercent: (rect.left + rect.width / 2) / window.innerWidth,
      yPercent: rect.top / window.innerHeight, // 하위 호환성 유지
      bottomPercent: (window.innerHeight - rect.bottom) / window.innerHeight
    };
    chrome.storage.local.set({ overlayPosition: posData });
  }

  function restoreSavedPosition() {
    chrome.storage.local.get(['overlayPosition'], (data) => {
      if (data.overlayPosition && state.overlay) {
        const pos = data.overlayPosition;
        // 새 형식 (중심점) 또는 구 형식 (좌측) 호환
        const centerX = pos.xCenterPercent
          ? pos.xCenterPercent * window.innerWidth
          : (pos.xPercent * window.innerWidth);
          
        if (pos.bottomPercent !== undefined) {
          const bottomY = pos.bottomPercent * window.innerHeight;
          state.overlay.container.style.left = centerX + 'px';
          state.overlay.container.style.top = 'auto';
          state.overlay.container.style.bottom = bottomY + 'px';
        } else {
          const y = pos.yPercent * window.innerHeight;
          state.overlay.container.style.left = centerX + 'px';
          state.overlay.container.style.top = y + 'px';
          state.overlay.container.style.bottom = 'auto';
        }
        state.overlay.container.style.transform = 'translateX(-50%)';
      } else if (state.overlay) {
        // 기본 위치: 하단 중앙
        state.overlay.container.style.left = '50%';
        state.overlay.container.style.top = '';
        state.overlay.container.style.bottom = '60px';
        state.overlay.container.style.transform = 'translateX(-50%)';
      }
    });
  }

  // ============================================================
  // 설정 로드
  // ============================================================
  function loadSettings() {
    chrome.storage.local.get(['settings'], (data) => {
      if (data.settings) {
        applySettings(data.settings);
      }
    });
  }
  // ============================================================
  // 리모컨 드래그 (Remote Drag)
  // ============================================================
  function setupRemoteDrag(remote) {
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialRight = 0, initialBottom = 0;

    const handle = remote.querySelector('.remote-drag-handle');
    if (!handle) return;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      
      const rect = remote.getBoundingClientRect();
      initialRight = window.innerWidth - rect.right;
      initialBottom = window.innerHeight - rect.bottom;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      
      let newRight = initialRight - dx;
      let newBottom = initialBottom - dy;
      
      newRight = Math.max(0, Math.min(newRight, window.innerWidth - remote.offsetWidth));
      newBottom = Math.max(0, Math.min(newBottom, window.innerHeight - remote.offsetHeight));
      
      remote.style.right = newRight + 'px';
      remote.style.bottom = newBottom + 'px';
      remote.style.left = 'auto';
      remote.style.top = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        // 비율로 저장 (창 크기 변경 대응)
        const rect = remote.getBoundingClientRect();
        const right = window.innerWidth - rect.right;
        const bottom = window.innerHeight - rect.bottom;
        chrome.storage.local.set({
          remotePosition: {
            right: right + 'px',
            bottom: bottom + 'px',
            rightRatio: right / window.innerWidth,
            bottomRatio: bottom / window.innerHeight
          }
        });
      }
    });
  }

  // ============================================================
  // 화면 영역 선택 (Area Selection) 모드
  // ============================================================
  function startAreaSelection() {
    if (!state.overlay || !state.overlay.container) {
      return { error: '자막을 먼저 로드해주세요.' };
    }

    const doc = document;
    if (doc.getElementById('lyrics-area-selection-overlay')) return;

    const selectionOverlay = doc.createElement('div');
    selectionOverlay.id = 'lyrics-area-selection-overlay';
    selectionOverlay.className = 'lyrics-area-selection-overlay';

    const highlighter = doc.createElement('div');
    highlighter.id = 'lyrics-area-highlighter';
    highlighter.className = 'lyrics-area-highlighter';
    
    doc.body.appendChild(selectionOverlay);
    doc.body.appendChild(highlighter);

    const onMouseMove = (e) => {
      selectionOverlay.style.pointerEvents = 'none';
      const target = doc.elementFromPoint(e.clientX, e.clientY);
      selectionOverlay.style.pointerEvents = 'auto';

      if (!target || target === doc.body || target === doc.documentElement) {
        highlighter.style.display = 'none';
        selectionOverlay.dataset.targetRect = '';
        return;
      }

      if (state.overlay.container.contains(target) || target === highlighter) {
        highlighter.style.display = 'none';
        selectionOverlay.dataset.targetRect = '';
        return;
      }

      const rect = target.getBoundingClientRect();
      highlighter.style.display = 'block';
      highlighter.style.left = `${rect.left}px`;
      highlighter.style.top = `${rect.top}px`;
      highlighter.style.width = `${rect.width}px`;
      highlighter.style.height = `${rect.height}px`;

      selectionOverlay.dataset.targetRect = JSON.stringify({
        left: rect.left, top: rect.top, width: rect.width, height: rect.height
      });
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const rectStr = selectionOverlay.dataset.targetRect;
      if (rectStr) {
        const rect = JSON.parse(rectStr);
        
        // 요소의 X 정중앙, Y 하단 92% 지점 (조금 더 아래로 내림)
        const centerX = rect.left + (rect.width / 2);
        const bottomY = window.innerHeight - (rect.top + rect.height * 0.92);

        state.overlay.container.style.left = `${centerX}px`;
        state.overlay.container.style.top = 'auto';
        state.overlay.container.style.bottom = `${bottomY}px`;
        
        // 새로 설정된 위치를 기준으로 중앙 비율, 상단 비율 다시 계산하여 저장
        // bottom이 설정되면 브라우저가 top을 자동 계산하므로 getBoundingClientRect로 실제 top을 가져와 저장
        setTimeout(() => {
          savePosition();
        }, 50);
        
        // 시각적 피드백
        state.overlay.container.style.transform = 'translateX(-50%) scale(1.05)';
        setTimeout(() => {
          if (state.overlay) state.overlay.container.style.transform = 'translateX(-50%) scale(1)';
        }, 150);
      }
      cleanup();
    };

    const cleanup = () => {
      selectionOverlay.removeEventListener('mousemove', onMouseMove);
      selectionOverlay.removeEventListener('click', onClick);
      if (selectionOverlay.parentNode) selectionOverlay.parentNode.removeChild(selectionOverlay);
      if (highlighter.parentNode) highlighter.parentNode.removeChild(highlighter);
      doc.removeEventListener('keydown', onKeyDown);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') cleanup();
    };

    selectionOverlay.addEventListener('mousemove', onMouseMove);
    selectionOverlay.addEventListener('click', onClick);
    doc.addEventListener('keydown', onKeyDown);
  }


  // ============================================================
  // 메시지 수신
  // ============================================================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'START_AREA_SELECTION': {
        const result = startAreaSelection();
        if (result && result.error) {
          sendResponse({ success: false, error: result.error });
        } else {
          sendResponse({ success: true });
        }
        break;
      }
        
      case 'LOAD_LYRICS': {
        const parsed = SRTParser.parse(message.srtText);
        state.lyrics = parsed;
        state.syncOffset = 0;
        state.trackName = message.trackName || '';
        createOverlay();
        // overlay가 이미 있을 때는 applySettings만 재실행 (패널 참조 유지)
        if (state.settings) applySettings(state.settings);
        else loadSettings();
        // 트랙 정보 저장 (팝업 복원용)
        chrome.storage.local.set({ currentTrack: {
          name: state.trackName,
          count: parsed.length,
          duration: SRTParser.getTotalDuration(parsed),
          srtText: message.srtText
        }});
        sendResponse({ 
          success: true, 
          count: parsed.length,
          duration: SRTParser.getTotalDuration(parsed)
        });
        break;
      }

      case 'PLAY':
        if (state.lyrics.length === 0) {
          sendResponse({ success: false, error: '가사가 로드되지 않았습니다.' });
        } else {
          play();
          sendResponse({ success: true });
        }
        break;

      case 'PAUSE':
        pause();
        sendResponse({ success: true, paused: true });
        break;

      case 'STOP':
        stopPlayback();
        sendResponse({ success: true });
        break;

      case 'TOGGLE_PLAYBACK':
        if (!state.isPlaying) {
          if (state.lyrics.length > 0) play();
        } else if (state.isPaused) {
          play();
        } else {
          pause();
        }
        sendResponse({ 
          success: true, 
          isPlaying: state.isPlaying, 
          isPaused: state.isPaused 
        });
        break;

      case 'SEEK':
        seek(message.timeMs);
        sendResponse({ success: true });
        break;

      case 'UPDATE_STYLE':
        if (message.settings) {
          applySettings(message.settings);
        }
        sendResponse({ success: true });
        break;

      case 'ADJUST_SYNC':
        state.syncOffset += (message.deltaMs || 0);
        // 일시정지 중이면 표시 업데이트
        if (state.isPaused && state.isPlaying) {
          const elapsed = state.pausedAt + state.syncOffset;
          const entry = SRTParser.findEntryAtTime(state.lyrics, elapsed);
          state.currentEntry = null; // 강제 업데이트
          updateDisplay(entry);
        }
        sendResponse({ success: true, syncOffset: state.syncOffset });
        break;

      case 'GET_STATUS':
        sendResponse({
          isPlaying: state.isPlaying,
          isPaused: state.isPaused,
          hasLyrics: state.lyrics.length > 0,
          lyricCount: state.lyrics.length,
          trackName: state.trackName,
          syncOffset: state.syncOffset,
          currentTime: state.isPlaying 
            ? (state.isPaused ? state.pausedAt + state.syncOffset : performance.now() - state.startTimestamp + state.syncOffset)
            : 0,
          totalDuration: SRTParser.getTotalDuration(state.lyrics)
        });
        break;

      default:
        break;
    }
    return true;
  });

  // 설정 변경 감지
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings && changes.settings.newValue) {
      const newSettings = changes.settings.newValue;
      const hostname = window.location.hostname;
      const shouldShowRemote = newSettings.remoteEnabledSites && newSettings.remoteEnabledSites[hostname] === true;
      // 이미 overlay가 있거나 리모컨을 켜야 하는 경우만 처리
      if (state.overlay || shouldShowRemote) {
        applySettings(newSettings);
      }
    }
  });

  // 초기화
  loadSettings();

})();
