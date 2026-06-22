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
    // 드래그 상태 (시작 기준점 + 포인터 이동량 방식, 세로는 박스 바닥 기준)
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragStartCenterX: 0,
    dragStartBottomVp: 0,
    // 새로 추가된 상태
    lastElapsed: 0,
    hasJumpedBeforeStart: false,
    endNoticeShown: false,
    // 외부 클럭(예: SoundCloud 오디오 currentTime)으로 가사를 구동할 때 사용.
    // null이면 기존처럼 내부 타이머(performance.now)로 동작.
    externalClock: null,
    siteState: {} // 사이트별 상태 저장
  };

  // SoundCloud 등 미디어 사이트의 "현재 재생 위치(ms)" 제공자.
  // initSoundCloudSync에서 주입되며, 해당 사이트가 아니면 null로 유지된다.
  let scGetPositionMs = null;

  // 현재 호스트명 및 사이트별 상태 처리
  const currentHostname = window.location.hostname;

  // 확장프로그램이 리로드/업데이트되면 페이지에 남은 옛 content script의
  // chrome.runtime 컨텍스트가 무효화된다. 이 상태에서 chrome.* 호출은
  // "Extension context invalidated" 에러를 던지므로, 호출 전에 유효성을 확인한다.
  function extAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  if (extAlive()) {
    chrome.storage.local.get(['siteStates'], (data) => {
      if (data.siteStates && data.siteStates[currentHostname]) {
        state.siteState = data.siteStates[currentHostname];
      }
    });
  }

  function updateSiteState(updates) {
    if (!extAlive()) return;
    chrome.storage.local.get(['siteStates'], (data) => {
      const states = data.siteStates || {};
      states[currentHostname] = { ...(states[currentHostname] || {}), ...updates };
      chrome.storage.local.set({ siteStates: states });

      // Update local state immediately for sync
      state.siteState = states[currentHostname];
    });
  }

  // ============================================================
  // 오버레이 DOM 생성 (Shadow DOM)
  // ============================================================
  function createOverlay() {
    if (state.overlay) return;

    const host = document.createElement('div');
    host.id = 'lyrics-overlay-host';
    host.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:0;z-index:2147483647;pointer-events:none;';
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

    // 이전 가사 컨텍스트 (옵션 ON일 때만 채워짐)
    const prevContext = document.createElement('div');
    prevContext.className = 'lyrics-context lyrics-context-prev';

    // lines 컨테이너 - 동적으로 줄이 추가/제거됨
    const linesContainer = document.createElement('div');
    linesContainer.className = 'lyrics-lines';

    // 다음 가사 컨텍스트 (옵션 ON일 때만 채워짐)
    const nextContext = document.createElement('div');
    nextContext.className = 'lyrics-context lyrics-context-next';

    box.appendChild(prevContext);
    box.appendChild(linesContainer);
    box.appendChild(nextContext);

    // 호버 시 나타나는 고정(핀) 토글 버튼
    const pinBtn = document.createElement('div');
    pinBtn.className = 'lyrics-pin-btn';
    pinBtn.title = chrome.i18n.getMessage('overlay_pin_title') || 'Pin / Unpin';
    pinBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';
    pinBtn.addEventListener('mousedown', (e) => e.stopPropagation()); // 드래그 시작 방지
    pinBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePinFromOverlay(); });
    box.appendChild(pinBtn);

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
      prevContext,
      nextContext,
      pinBtn,
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
    } else if (hostname.includes('soundcloud.com')) {
      remote.classList.add('theme-soundcloud');
    }
    remote.innerHTML = `
      <div class="remote-drag-handle" title="${chrome.i18n.getMessage('remote_drag_title')}"><svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="2" cy="2" r="1.3"/><circle cx="6" cy="2" r="1.3"/><circle cx="2" cy="7" r="1.3"/><circle cx="6" cy="7" r="1.3"/><circle cx="2" cy="12" r="1.3"/><circle cx="6" cy="12" r="1.3"/></svg></div>
      <div class="remote-controls">
        <button class="remote-btn remote-btn-library" id="remote-library-btn" title="${chrome.i18n.getMessage('remote_title_song_list')}">🎵</button>
        <button class="remote-btn remote-btn-timeline" id="remote-timeline-btn" title="${chrome.i18n.getMessage('remote_title_timeline')}">📜</button>
        <button class="remote-btn remote-btn-area" id="remote-area-btn" title="${chrome.i18n.getMessage('remote_title_area')}">🎯</button>
        <button class="remote-btn remote-btn-play" id="remote-toggle-play" title="${chrome.i18n.getMessage('remote_title_play_pause')}">▶</button>
        <button class="remote-btn remote-btn-stop" id="remote-stop" title="${chrome.i18n.getMessage('remote_title_stop')}">■</button>
        <div class="remote-divider"></div>
        <button class="remote-btn remote-btn-sync-minus" id="remote-sync-minus" title="${chrome.i18n.getMessage('remote_title_sync_minus')}">−</button>
        <div class="remote-sync-val" id="remote-sync-val" title="${chrome.i18n.getMessage('remote_title_sync_reset')}">0.0s</div>
        <button class="remote-btn remote-btn-sync-plus" id="remote-sync-plus" title="${chrome.i18n.getMessage('remote_title_sync_plus')}">+</button>
      </div>
      <button class="remote-btn remote-btn-minimize" id="remote-minimize-btn" title="${chrome.i18n.getMessage('remote_title_minimize')}" style="width: 20px;">›</button>
      <div class="remote-library-panel hidden" id="remote-library-panel">
        <div class="remote-library-header">${chrome.i18n.getMessage('remote_lib_title')} <button class="remote-library-close" id="remote-library-close">✕</button></div>
        <div class="remote-library-search">
          <input type="text" id="remote-library-search-input" placeholder="${chrome.i18n.getMessage('remote_search_ph')}" autocomplete="off">
        </div>
        <div class="remote-library-list" id="remote-library-list"></div>
      </div>
      <div class="remote-timeline-panel hidden" id="remote-timeline-panel">
        <div class="remote-timeline-header">${chrome.i18n.getMessage('remote_timeline_title')} <button class="remote-timeline-close" id="remote-timeline-close">✕</button></div>
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

    // ── 패널 자동 닫힘 (무동작 시) ──────────────────────────────
    // 가사 목록/타임라인 패널을 열어두고 아무 동작 없이 일정 시간이 지나면 자동으로 닫는다.
    // 설정으로 on/off 및 시간(초)을 지정. (기본: 켜짐, 5초)
    let panelAutoCloseTimer = null;
    function panelsOpen() {
      return !libPanel.classList.contains('hidden') || !timelinePanel.classList.contains('hidden');
    }
    function clearPanelAutoClose() {
      if (panelAutoCloseTimer) { clearTimeout(panelAutoCloseTimer); panelAutoCloseTimer = null; }
    }
    function schedulePanelAutoClose() {
      clearPanelAutoClose();
      const s = state.settings || {};
      if (s.remotePanelAutoClose === false) return; // 꺼짐
      if (!panelsOpen()) return;
      const sec = Number(s.remotePanelAutoCloseSec);
      const ms = (isFinite(sec) && sec > 0 ? sec : 5) * 1000;
      panelAutoCloseTimer = setTimeout(() => {
        libPanel.classList.add('hidden');
        timelinePanel.classList.add('hidden');
      }, ms);
    }
    // 리모컨 내 어떤 동작이든 발생하면 타이머를 리셋 (무동작 기준)
    ['mousemove', 'mousedown', 'keydown', 'input', 'wheel', 'focusin'].forEach(ev => {
      remote.addEventListener(ev, () => { if (panelsOpen()) schedulePanelAutoClose(); }, true);
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
        schedulePanelAutoClose();
      } else {
        libPanel.classList.add('hidden');
        clearPanelAutoClose();
      }
    });

    btnLibClose.addEventListener('click', () => {
      libPanel.classList.add('hidden');
      clearPanelAutoClose();
    });

    btnTimeline.addEventListener('click', () => {
      if (timelinePanel.classList.contains('hidden')) {
        renderRemoteTimeline(timelineList);
        updatePanelPosition(remote, timelinePanel);
        timelinePanel.classList.remove('hidden');
        libPanel.classList.add('hidden');
        schedulePanelAutoClose();
      } else {
        timelinePanel.classList.add('hidden');
        clearPanelAutoClose();
      }
    });

    timelineClose.addEventListener('click', () => {
      timelinePanel.classList.add('hidden');
      clearPanelAutoClose();
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
      updateSiteState({ remoteMinimized: isMin });
      // 패널 열려있으면 닫기
      if (isMin) {
        libPanel.classList.add('hidden');
        timelinePanel.classList.add('hidden');
      }
    });

    setupDrag(container, box);
    setupRemoteDrag(remote);
    
    // 리모컨 저장된 위치 복원
    chrome.storage.local.get(['remotePosition', 'remoteMinimized'], (globalData) => {
      const data = (state.siteState.remotePosition || state.siteState.remoteMinimized !== undefined)
        ? state.siteState
        : globalData;
        
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
    if (!extAlive()) return;
    const data = await new Promise(r => chrome.storage.local.get(['savedLyrics', 'settings'], r));
    const list = data.savedLyrics || [];
    const url = data.settings && data.settings.googleSheetUrl;
    if (list.length > 0 || !url) return;

    listEl.innerHTML = `<div class="remote-sync-status"><span class="remote-sync-spinner"></span>${chrome.i18n.getMessage('remote_loading')}</div>`;

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
        // Auto Only는 번호 채번 제외 (수동 목록에서 숨겨지므로 번호 불필요)
        if (l.parsed && !l.parsed.index && !l.autoOnly) {
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

      const normalCount = newLyrics.filter(l => !l.autoOnly).length;
      const autoOnlyCount = newLyrics.length - normalCount;
      const unit = chrome.i18n.getMessage('remote_songs_unit') || '곡';
      const autoLabel = chrome.i18n.getMessage('toast_auto_only_label') || '자동';
      const countLabel = autoOnlyCount > 0
        ? `${normalCount}${unit} (+${autoOnlyCount} ${autoLabel})`
        : `${normalCount}${unit}`;
      listEl.innerHTML = `<div class="remote-sync-status remote-sync-done">✓ ${chrome.i18n.getMessage('remote_sync_done', [countLabel])}</div>`;
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      listEl.innerHTML = '';
    }
  }

  function getRemoteMatchChips(item, q) {
    const chips = [];
    const lower = q.toLowerCase();
    if (!item.parsed) {
      if (item.name.toLowerCase().includes(lower)) chips.push({ type: chrome.i18n.getMessage('chip_filename'), value: item.name });
      return chips;
    }
    if (item.parsed.index && item.parsed.index.includes(lower)) chips.push({ type: chrome.i18n.getMessage('chip_number'), value: item.parsed.index });
    if (item.parsed.artist && item.parsed.artist.toLowerCase().includes(lower)) chips.push({ type: chrome.i18n.getMessage('chip_artist'), value: item.parsed.artist });
    if (item.parsed.title && item.parsed.title.toLowerCase().includes(lower)) chips.push({ type: chrome.i18n.getMessage('chip_title'), value: item.parsed.title });
    if (item.parsed.keywords) {
      item.parsed.keywords.filter(k => k.toLowerCase().includes(lower))
        .forEach(k => chips.push({ type: chrome.i18n.getMessage('chip_keyword'), value: k }));
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
    if (!extAlive()) return;
    chrome.storage.local.get(['savedLyrics'], (data) => {
      let list = data.savedLyrics || [];

      // autoOnly 가사는 수동 목록에서 제외 (자동 감지로만 사용)
      list = list.filter(item => SheetParser.isManualVisible(item));

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
        listEl.innerHTML = `<div style="padding:12px;text-align:center;color:rgba(255,255,255,0.5);font-size:11px;">${chrome.i18n.getMessage('remote_no_results')}</div>`;
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
    
    // 팝업 복원용 트랙 정보 갱신 (사이트별로 저장)
    updateSiteState({ currentTrack: {
      name: state.trackName,
      count: parsed.length,
      duration: SRTParser.getTotalDuration(parsed),
      srtText: item.srtText
    }});

    // 새 곡이므로 타임라인 갱신 + 스크롤 맨 위로
    refreshRemoteTimelineForNewTrack();

    // 새 곡의 최대 줄 수 기준으로 박스 높이 고정 재계산
    recalcBoxDimensions();
    reapplyAlignForContentChange();

    play();
  }

  function escapeHtml(str) {
    return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag]));
  }

  // 새 곡 로드 시 리모컨 타임라인을 새 가사로 다시 그리고 스크롤을 맨 위로 올린다.
  // (이전 곡에서 아래로 스크롤된 상태가 남아 불편하던 문제 해결)
  function refreshRemoteTimelineForNewTrack() {
    if (!state.overlay || !state.overlay.timelineList) return;
    renderRemoteTimeline(state.overlay.timelineList);
    state.overlay.timelineList.scrollTop = 0;
  }

  function renderRemoteTimeline(listEl) {
    if (!extAlive()) return;
    if (!state.lyrics || state.lyrics.length === 0) {
      listEl.innerHTML = `<div style="padding:12px;text-align:center;color:rgba(255,255,255,0.5);font-size:11px;">${chrome.i18n.getMessage('remote_no_lyrics')}</div>`;
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
        left: 0;
        right: 0;
        z-index: 2147483647;
        pointer-events: none;
        transition: opacity 0.3s ease;
        font-family: 'Noto Sans KR', 'M PLUS 1 Code', 'Malgun Gothic', sans-serif;
      }

      .lyrics-box {
        position: absolute;
        text-align: center;
        padding: 16px 32px;
        border-radius: 12px;
        max-width: 80vw;
        min-width: 200px;
        width: max-content;
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.08);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        transition: background-color 0.3s ease;
        pointer-events: auto;
        cursor: grab;
        user-select: none;
        -webkit-user-select: none;
        bottom: 0;
      }

      .lyrics-box.dragging {
        cursor: grabbing;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
        border-color: rgba(0, 255, 163, 0.3);
      }

      /* 이전/다음 가사 컨텍스트 - 메인보다 작고 채도/명도 낮게 */
      .lyrics-context {
        opacity: 0.5;
        filter: saturate(0.55);
        line-height: 1.25;
        margin: 0;
        min-height: 0;
        overflow: hidden;
      }
      /* 이전/다음 표시 ON일 때만 최대 줄 수 기준 높이를 확보해 크기 변동 방지 */
      .lyrics-box.show-prev-context .lyrics-context-prev {
        min-height: var(--lyrics-min-h-context, 0px);
        margin-bottom: 6px;
      }
      .lyrics-box.show-next-context .lyrics-context-next {
        min-height: var(--lyrics-min-h-context, 0px);
        margin-top: 6px;
      }

      /* 고정(핀) 토글 버튼 - 박스 모서리 안쪽에 심플하게, 호버 시 표시 */
      .lyrics-pin-btn {
        position: absolute;
        top: 6px;
        right: 8px;
        width: 15px;
        height: 15px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #ffffff; /* 설정(pinColor)으로 덮어씀 */
        cursor: pointer;
        pointer-events: auto;
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      .lyrics-pin-btn svg {
        width: 14px;
        height: 14px;
        display: block;
      }
      .lyrics-box:hover .lyrics-pin-btn { opacity: 0.4; }
      .lyrics-pin-btn:hover { opacity: 0.9; }
      /* 고정 중일 때는 항상 보이게 */
      .lyrics-pin-btn.active { opacity: 0.85; }

      .lyrics-lines {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        pointer-events: none;
        min-height: var(--lyrics-min-h-main, 0);
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
      .lyrics-remote.theme-soundcloud {
        --theme-color: #FF5500;
        --theme-bg-07: rgba(255, 85, 0, 0.07);
        --theme-bg-12: rgba(255, 85, 0, 0.12);
        --theme-bg-25: rgba(255, 85, 0, 0.25);
        --theme-bg-30: rgba(255, 85, 0, 0.3);
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
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes lyricsFadeOut {
        from { opacity: 1; }
        to { opacity: 0; }
      }

      /* 슬라이드 애니메이션 - 페이드와 구분되게 가로 이동 위주로 */
      .animation-slide .lyrics-box.entering {
        animation: lyricsSlideIn 0.5s cubic-bezier(0.16,1,0.3,1) forwards;
      }
      .animation-slide .lyrics-box.exiting {
        animation: lyricsSlideOut 0.4s cubic-bezier(0.7,0,0.84,0) forwards;
      }
      @keyframes lyricsSlideIn {
        from { opacity: 0; transform: translateX(-40px); }
        to { opacity: 1; transform: translateX(0); }
      }
      @keyframes lyricsSlideOut {
        from { opacity: 1; transform: translateX(0); }
        to { opacity: 0; transform: translateX(40px); }
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

      /* 텍스트 외곽선 굵기 (슬라이더) - 투명 배경 가독성용.
         paint-order: stroke fill → 외곽선이 글자 뒤에 그려져 글자가 가려지지 않음. */
      .lyrics-line-orig, .lyrics-line-pron, .lyrics-line-main, .lyrics-line-solo {
        -webkit-text-stroke: var(--lyric-stroke, 0) rgba(0,0,0,0.95);
        paint-order: stroke fill;
      }
    `;
  }

  // ============================================================
  // 설정 적용
  // ============================================================
  function applySettings(baseSettings) {
    if (!baseSettings) return;
    state.settings = baseSettings;
    // 설정 변경 시 컨텍스트 재렌더 강제 (폰트/색/토글 즉시 반영)
    state._lastContextSig = null;

    // 현재 사이트의 덮어쓰기 설정이 있으면 병합
    const settings = {
      ...baseSettings,
      ...(state.siteState && state.siteState.styleOverrides ? state.siteState.styleOverrides : {})
    };

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

    // 배경 투명도 0% + 블러 0px이면 테두리/그림자까지 제거해 완전 투명하게.
    // (그렇지 않으면 외곽선·그림자가 남아 완전 투명이 불가능)
    const fullyTransparent = bgOpacity <= 0 && bgBlur <= 0;
    box.style.border = fullyTransparent ? 'none' : '';
    box.style.boxShadow = fullyTransparent ? 'none' : '';

    if (settings.fontFamily) {
      container.style.fontFamily = settings.fontFamily;
    }

    // 정렬 (왼쪽/가운데/오른쪽) — 박스 내부 텍스트 + 여러 줄 정렬 + 박스 자체 앵커
    const align = settings.textAlign || 'center';
    box.style.textAlign = align;
    if (state.overlay.linesContainer) {
      state.overlay.linesContainer.style.alignItems =
        align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
    }
    // 박스 앵커 위치 갱신 (정렬에 따라 box의 left/right/transform 재설정)
    restoreSavedPosition();

    // 텍스트 외곽선
    if (settings.textShadow === false) {
      box.classList.add('no-text-shadow');
    } else {
      box.classList.remove('no-text-shadow');
    }

    // 텍스트 외곽선 굵기 (0이면 없음). 박스에 CSS 변수로 지정 → 모든 줄에 적용.
    const outlineWidth = Math.max(0, Number(settings.outlineWidth) || 0);
    box.style.setProperty('--lyric-stroke', outlineWidth + 'px');

    // 이전/다음 가사 표시 ON일 때 박스 가로/세로 크기 고정 재계산
    recalcBoxDimensions();
    // 너비 변경에 따른 중앙 정렬 위치 보정
    reapplyAlignForContentChange();

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

    // 핀 버튼 색상/활성 상태 동기화
    if (state.overlay && state.overlay.pinBtn) {
      state.overlay.pinBtn.style.color = settings.pinColor || '#FFFFFF';
      state.overlay.pinBtn.classList.toggle('active', !!state.siteState.isPinned);
    }
  }

  /**
   * 현재 표시 중인 줄들에 설정 기반 인라인 스타일 적용
   */
  function applyLineStyles() {
    if (!state.overlay || !state.settings) return;
    const settings = {
      ...state.settings,
      ...(state.siteState && state.siteState.styleOverrides ? state.siteState.styleOverrides : {})
    };
    const lines = state.overlay.linesContainer.children;

    for (const line of lines) {
      if (line.classList.contains('lyrics-line-orig')) {
        line.style.fontSize = `${settings.origFontSize || 20}px`;
        line.style.color = settings.origColor || '#FFA800';
      } else if (line.classList.contains('lyrics-line-pron')) {
        line.style.fontSize = `${settings.pronFontSize || 18}px`;
        line.style.color = settings.pronColor || '#F5E6CC';
      } else if (line.classList.contains('lyrics-line-main') || line.classList.contains('lyrics-line-solo')) {
        line.style.fontSize = `${settings.mainFontSize || 28}px`;
        line.style.color = settings.mainColor || '#FFFFFF';
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

    // 단일 엔트리 모드: 컨텍스트 블록은 비워 잔상 방지
    if (state.overlay.prevContext) state.overlay.prevContext.innerHTML = '';
    if (state.overlay.nextContext) state.overlay.nextContext.innerHTML = '';
    linesContainer.classList.remove('context-gap');

    // 현재 가사 줄 렌더링
    appendEntryLines(linesContainer, entry, 1);

    // 새 내용으로 너비가 바뀐 뒤 중앙 정렬 중심을 다시 고정 (드리프트 방지)
    reapplyAlignForContentChange();

    if (state.overlay.timelineList) {
      updateRemoteTimelineHighlight(entry);
    }
  }

  // 줄 클래스별 line-height (CSS 값과 동기화, 높이 계산에 사용)
  const LINE_STYLE = {
    'lyrics-line-orig': { lineHeight: 1.4 },
    'lyrics-line-pron': { lineHeight: 1.4 },
    'lyrics-line-main': { lineHeight: 1.5 },
    'lyrics-line-solo': { lineHeight: 1.5 }
  };

  // 엔트리의 줄들을 분류해 { text, className, fontSize, color }[] 로 반환.
  //   1줄: [solo]
  //   2줄: [orig, main]
  //   3줄: [orig, pron, main]
  function getLineSpecs(entry, s) {
    if (!entry || !entry.lines) return [];
    const lineCount = entry.lines.length;
    const showPron = s.showPronunciation !== false;
    const specs = [];

    entry.lines.forEach((text, i) => {
      // 3줄일 때 발음(index 1) 숨기기
      if (lineCount === 3 && i === 1 && !showPron) return;

      // 2줄 이상일 때 원문(index 0) 숨기기
      if (lineCount > 1 && i === 0 && s.showOriginal === false) return;

      let className, fontSize, color;
      if (lineCount === 1) {
        className = 'lyrics-line-solo';
        fontSize = s.mainFontSize || 28;
        color = s.mainColor || '#FFFFFF';
      } else if (i === lineCount - 1) {
        // 마지막 줄: 한국어 번역 (메인)
        className = 'lyrics-line-main';
        fontSize = s.mainFontSize || 28;
        color = s.mainColor || '#FFFFFF';
      } else if (lineCount === 3 && i === 1) {
        // 3줄에서 2번째: 발음
        className = 'lyrics-line-pron';
        fontSize = s.pronFontSize || 18;
        color = s.pronColor || '#F5E6CC';
      } else {
        // 첫 번째 줄: 원문
        className = 'lyrics-line-orig';
        fontSize = s.origFontSize || 20;
        color = s.origColor || '#FFA800';
      }

      specs.push({ text, className, fontSize, color });
    });
    return specs;
  }

  // 엔트리의 줄들을 컨테이너에 렌더링한다. (updateDisplay / 컨텍스트 표시 공용)
  //   scale: 폰트 크기 배율 (현재 가사 = 1, 이전/다음 = scale<1)
  function appendEntryLines(container, entry, scale) {
    container.innerHTML = '';
    if (!entry || !entry.lines) return;
    const s = {
      ...state.settings,
      ...(state.siteState && state.siteState.styleOverrides ? state.siteState.styleOverrides : {})
    };
    const k = scale || 1;

    getLineSpecs(entry, s).forEach(spec => {
      const div = document.createElement('div');
      div.className = spec.className;
      div.style.fontSize = `${spec.fontSize * k}px`;
      div.style.color = spec.color;
      div.textContent = spec.text;
      container.appendChild(div);
    });
  }

  // ============================================================
  // 이전/다음 가사 컨텍스트 표시
  // ============================================================
  const GAP_BLANK_MS = 5000; // 이 시간 이상 비는 구간에서만 가운데를 비움

  // 현재 시간 기준으로 이전/현재/다음 엔트리와 그 인덱스를 구한다.
  //   활성 엔트리(t∈[start,end])가 있으면 그것이 current.
  //   빈 구간이면:
  //     - 간격이 GAP_BLANK_MS 미만이면 직전 가사를 가운데에 '유지'(깜빡임 방지)
  //     - 간격이 GAP_BLANK_MS 이상이면 가운데를 비움(current=null)
  //     - 마지막 가사 이후(다음 없음)도 직전 가사를 유지(종료 알림이 대체)
  function findContextAtTime(entries, t) {
    if (!entries || entries.length === 0) {
      return { prevIdx: -1, currIdx: -1, nextIdx: -1 };
    }
    let currIdx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (t >= entries[i].startTime && t <= entries[i].endTime) { currIdx = i; break; }
    }
    if (currIdx >= 0) {
      return { prevIdx: currIdx - 1, currIdx, nextIdx: currIdx + 1 < entries.length ? currIdx + 1 : -1 };
    }

    // 빈 구간: 다음 엔트리 = 첫 startTime > t
    let nextIdx = -1;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].startTime > t) { nextIdx = i; break; }
    }
    const prevIdx = nextIdx === -1 ? entries.length - 1 : nextIdx - 1;

    // 첫 가사 이전(직전 없음): 가운데 비우고 다음만 예고
    if (prevIdx < 0) {
      return { prevIdx: -1, currIdx: -1, nextIdx };
    }

    const gapEnd = nextIdx >= 0 ? entries[nextIdx].startTime : Infinity;
    const gapDur = gapEnd - entries[prevIdx].endTime;

    // 짧은 간격 또는 마지막 가사 이후 → 직전 가사를 가운데에 유지
    if (gapDur < GAP_BLANK_MS || nextIdx === -1) {
      return { prevIdx: prevIdx - 1, currIdx: prevIdx, nextIdx };
    }

    // 긴 간격(간주 등) → 가운데 비움
    return { prevIdx, currIdx: -1, nextIdx };
  }

  const CONTEXT_SCALE = 0.62; // 이전/다음 가사 폰트 배율

  // 컨텍스트(이전/현재/다음) 표시 갱신. tick 루프에서 이전/다음 중 하나라도 ON일 때 사용.
  function updateContextDisplay(t) {
    if (!state.overlay) return;
    const { box, linesContainer, prevContext, nextContext } = state.overlay;
    const entries = state.lyrics;
    const ctx = findContextAtTime(entries, t);

    const s = {
      ...state.settings,
      ...(state.siteState && state.siteState.styleOverrides ? state.siteState.styleOverrides : {})
    };
    const showPrev = s.showPrevLyrics === true;
    const showNext = s.showNextLyrics === true;

    // 변경 없으면 재렌더 생략 (표시 플래그도 시그니처에 포함)
    const sig = `${ctx.prevIdx}|${ctx.currIdx}|${ctx.nextIdx}|${showPrev ? 1 : 0}${showNext ? 1 : 0}`;
    if (state._lastContextSig === sig) return;
    state._lastContextSig = sig;

    // 표시할 게 하나도 없으면 숨김
    if (ctx.prevIdx < 0 && ctx.currIdx < 0 && ctx.nextIdx < 0) {
      state.currentEntry = null;
      box.classList.add('empty');
      prevContext.innerHTML = '';
      nextContext.innerHTML = '';
      linesContainer.innerHTML = '';
      linesContainer.classList.remove('context-gap');
      return;
    }

    // 박스가 이미 보이는 상태였다면 진입 애니메이션을 재실행하지 않고 내용만 갱신
    const wasHidden = box.classList.contains('empty') || box.classList.contains('exiting');
    box.classList.remove('empty', 'exiting');
    if (wasHidden) {
      box.classList.remove('entering');
      void box.offsetWidth;
      box.classList.add('entering');
    }

    // 이전/다음 (축소) — 각각 설정에 따라 표시. 꺼진 쪽은 비움.
    appendEntryLines(prevContext, (showPrev && ctx.prevIdx >= 0) ? entries[ctx.prevIdx] : null, CONTEXT_SCALE);
    appendEntryLines(nextContext, (showNext && ctx.nextIdx >= 0) ? entries[ctx.nextIdx] : null, CONTEXT_SCALE);

    // 현재 (메인). 빈 구간이면 가운데 비움 (빈 슬롯 높이만 확보)
    if (ctx.currIdx >= 0) {
      const cur = entries[ctx.currIdx];
      state.currentEntry = cur;
      linesContainer.classList.remove('context-gap');
      appendEntryLines(linesContainer, cur, 1);
      if (state.overlay.timelineList) updateRemoteTimelineHighlight(cur);
    } else {
      state.currentEntry = null;
      linesContainer.innerHTML = '';
      linesContainer.classList.add('context-gap');
    }

    reapplyAlignForContentChange();
  }

  // 이전/다음 가사 표시(showPrevLyrics/showNextLyrics) ON일 때만:
  //   - 곡 전체에서 등장하는 최대 줄 수 기준으로 메인/컨텍스트 영역 높이를 확보
  // OFF일 때는 이전(고정 전) 동작으로 되돌린다.
  function recalcBoxDimensions() {
    if (!state.overlay || !state.overlay.box) return;
    const box = state.overlay.box;
    const s = {
      ...state.settings,
      ...(state.siteState && state.siteState.styleOverrides ? state.siteState.styleOverrides : {})
    };
    const showPrev = s.showPrevLyrics === true;
    const showNext = s.showNextLyrics === true;

    if (!(showPrev || showNext) || !state.lyrics || state.lyrics.length === 0) {
      box.style.removeProperty('width');
      box.style.removeProperty('--lyrics-min-h-main');
      box.style.removeProperty('--lyrics-min-h-context');
      box.classList.remove('show-prev-context', 'show-next-context');
      return;
    }

    box.classList.toggle('show-prev-context', showPrev);
    box.classList.toggle('show-next-context', showNext);

    let maxLines = 1;
    state.lyrics.forEach(entry => {
      const specs = getLineSpecs(entry, s);
      if (specs.length > maxLines) maxLines = specs.length;
    });
    maxLines = Math.min(3, Math.max(1, maxLines));

    // maxLines 줄 수에 해당하는 "형태"(클래스 구성)를 합성 엔트리로 얻어 높이 계산
    const shapeSpecs = getLineSpecs({ lines: new Array(maxLines).fill('') }, s);
    const gapTotal = 4 * Math.max(0, shapeSpecs.length - 1);
    const heightMain = shapeSpecs.reduce((sum, sp) => sum + sp.fontSize * LINE_STYLE[sp.className].lineHeight, 0) + gapTotal;
    const heightContext = shapeSpecs.reduce((sum, sp) => sum + sp.fontSize * CONTEXT_SCALE * LINE_STYLE[sp.className].lineHeight, 0) + gapTotal;

    box.style.setProperty('--lyrics-min-h-main', heightMain + 'px');
    box.style.setProperty('--lyrics-min-h-context', heightContext + 'px');
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

      // 외부 클럭(SoundCloud 등)이 연결돼 있으면 실제 재생 위치를 따라감.
      // 그렇지 않으면 기존처럼 내부 타이머로 진행.
      const elapsed = state.externalClock
        ? Math.max(0, state.externalClock.getTimeMs()) + state.syncOffset
        : performance.now() - state.startTimestamp + state.syncOffset;
      const totalDuration = SRTParser.getTotalDuration(state.lyrics);
      
      // 1. 종료 알림 로직
      const s = state.settings || {};
      const showEndNotice = s.showEndNotice !== false;
      const showCountdown = s.showCountdown !== false;

      const showContext = s.showPrevLyrics === true || s.showNextLyrics === true;

      if (elapsed > totalDuration + 1000) {
        if (showEndNotice && !state.endNoticeShown && state.lyrics.length > 0) {
          state.endNoticeShown = true;
          // 종료 알림 시에는 컨텍스트 잔상 없이 "🎵 Finish 🎵"만 표시
          state._lastContextSig = null;
          updateDisplay({
            index: 'finish',
            start: totalDuration + 1000,
            end: totalDuration + 5000,
            lines: ['🎵 Finish 🎵']
          });
        }

        // 종료 알림이 떠있는 시간(약 4초)을 벌어주기 위해 여유 시간 증가.
        // 단, 외부 클럭(SoundCloud 등) 모드에서는 오디오가 재생을 제어하므로
        // 가사 길이만으로 종료시키지 않는다 → 반복 재생/뒤로 탐색 시 가사가 되살아남.
        if (!state.externalClock && elapsed > totalDuration + 5000) {
          stopPlayback();
          return;
        }
      } else {
        // 아직 종료 시점이 아니면
        state.endNoticeShown = false;

        // 가사 렌더링: 컨텍스트(이전/현재/다음) 모드 또는 기존 단일 모드
        if (showContext) {
          updateContextDisplay(elapsed);
        } else {
          const entry = SRTParser.findEntryAtTime(state.lyrics, elapsed);
          updateDisplay(entry);
        }
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

    // SoundCloud 등에서 수동으로 재생한 가사도 실제 오디오 위치에 맞춰 싱크.
    // (자동 매칭 경로는 이미 externalClock을 설정해두므로 중복 연결되지 않음)
    // 오디오 엘리먼트를 미리 캡처하지 않고 매번 실시간 조회 → 늦게 생성/재생성돼도 추종.
    if (!state.externalClock && scGetPositionMs) {
      state.externalClock = { getTimeMs: () => scGetPositionMs() || 0 };
    }

    state.isPlaying = true;
    state.isPaused = false;
    state.startTimestamp = performance.now();
    state.lastElapsed = 0;
    state.hasJumpedBeforeStart = false;
    state.endNoticeShown = false;
    state.currentEntry = null;
    state._lastContextSig = null; // 새 재생 → 컨텍스트 재렌더 보장
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
    state.externalClock = null;
    state._lastContextSig = null;
    if (state.animFrameId) {
      cancelAnimationFrame(state.animFrameId);
      state.animFrameId = null;
    }
    if (state.overlay) {
      state.overlay.container.classList.add('hidden');
      state.overlay.progressBar.classList.remove('visible');
      state.overlay.box.classList.add('empty');
      state.overlay.linesContainer.innerHTML = '';
      if (state.overlay.prevContext) state.overlay.prevContext.innerHTML = '';
      if (state.overlay.nextContext) state.overlay.nextContext.innerHTML = '';
      state.overlay.linesContainer.classList.remove('context-gap');
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

      // 드래그 시작 시점의 포인터 위치와 박스의 현재 위치를 기준점으로 저장한다.
      // 박스는 bottom:0(아래 고정)이므로 세로 기준은 항상 '박스 바닥(bottom)'으로 통일한다.
      // 이후 포인터 '이동량(delta)'만 더해 배치하므로 첫 프레임에 위치가 그대로 유지된다.
      const boxRect = box.getBoundingClientRect();
      state.dragStartX = e.clientX;
      state.dragStartY = e.clientY;
      state.dragStartCenterX = boxRect.left + boxRect.width / 2;  // 뷰포트 기준 박스 중심 X
      state.dragStartBottomVp = boxRect.bottom;                   // 뷰포트 기준 박스 바닥 Y

      box.classList.add('dragging');
    });

    document.addEventListener('mousemove', (e) => {
      if (!state.isDragging) return;
      e.preventDefault();

      const dx = e.clientX - state.dragStartX;
      const dy = e.clientY - state.dragStartY;

      // 경계 제한에만 사용 (transform 영향 없는 레이아웃 크기)
      const halfW = box.offsetWidth / 2;
      const boxH = box.offsetHeight;

      // 박스 중심 X = 시작 중심 + 가로 이동량
      let centerX = state.dragStartCenterX + dx;
      centerX = Math.max(halfW, Math.min(centerX, window.innerWidth - halfW));

      // 박스 바닥 Y(뷰포트) = 시작 바닥 + 세로 이동량. 바닥은 [boxH, innerHeight] 범위로 제한.
      let bottomVp = state.dragStartBottomVp + dy;
      bottomVp = Math.max(boxH, Math.min(bottomVp, window.innerHeight));

      // 드래그 중에는 두 모드 모두 뷰포트(fixed)로 직접 배치 (드래그 중 스크롤 없음).
      container.style.position = 'fixed';
      container.style.top = 'auto';
      container.style.bottom = (window.innerHeight - bottomVp) + 'px';
      applyContainerAlign(container, centerX);

      // 핀 모드면 문서 좌표 앵커도 갱신 (드래그 후 스크롤 시 페이지에 고정 유지)
      if (isOverlayPinned()) {
        state._pinDocBottom = bottomVp + window.scrollY;
        state._pinDocCenterX = centerX + window.scrollX;
      }
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
    // container가 전체 너비이므로 box의 실제 위치를 기준으로 저장
    const boxRect = state.overlay.box.getBoundingClientRect();
    // 중심점/좌측/우측 끝 비율을 모두 저장. 복원 시 현재 정렬(textAlign)에 맞는 끝점을
    // 기준으로 복원해야, 가사 길이(박스 너비)가 바뀌어도 좌/우 정렬이 그 끝점에 고정된다.
    const posData = {
      xCenterPercent: (boxRect.left + boxRect.width / 2) / window.innerWidth,
      xLeftPercent: boxRect.left / window.innerWidth,
      xRightPercent: (window.innerWidth - boxRect.right) / window.innerWidth,
      yPercent: boxRect.top / window.innerHeight, // 하위 호환성 유지
      bottomPercent: (window.innerHeight - boxRect.bottom) / window.innerHeight
    };
    if (isOverlayPinned()) {
      // 고정 모드: 박스 바닥(bottom)을 문서 좌표로 저장 (box가 bottom:0 → 바닥 기준 배치).
      // docTop도 하위 호환을 위해 함께 저장. docLeft/docRight는 좌/우 정렬 고정용.
      updateSiteState({
        overlayPinPosition: {
          docBottom: boxRect.bottom + window.scrollY,
          docTop: boxRect.top + window.scrollY,
          docCenterX: boxRect.left + boxRect.width / 2 + window.scrollX,
          docLeft: boxRect.left + window.scrollX,
          docRight: boxRect.right + window.scrollX
        }
      });
    } else {
      updateSiteState({ overlayPosition: posData });
    }
  }

  // 저장된 위치 데이터(posData)에서, 현재 정렬(align)에 맞는 고정 끝점을 기준으로
  // box의 시각적 중심 X를 계산한다. 좌/우 정렬은 해당 끝점이 박스 너비와 무관하게
  // 항상 그 자리에 고정되도록, 가운데 정렬만 중심점을 그대로 사용한다.
  function computeCenterXFromPosData(pos, align, boxW, viewportWidth) {
    if (align === 'left' && pos.xLeftPercent != null) {
      return pos.xLeftPercent * viewportWidth + boxW / 2;
    }
    if (align === 'right' && pos.xRightPercent != null) {
      return viewportWidth - pos.xRightPercent * viewportWidth - boxW / 2;
    }
    if (pos.xCenterPercent != null) return pos.xCenterPercent * viewportWidth;
    return (pos.xPercent != null ? pos.xPercent : 0.5) * viewportWidth;
  }

  // 고정(핀) 모드: 저장된 문서 좌표(docLeft/docRight/docCenterX) 중 현재 정렬에 맞는
  // 끝점을 기준으로 box 중심의 문서 X좌표를 계산한다.
  function computeDocCenterXForAlign(pinPosData, align, boxW) {
    if (align === 'left' && pinPosData.docLeft != null) {
      return pinPosData.docLeft + boxW / 2;
    }
    if (align === 'right' && pinPosData.docRight != null) {
      return pinPosData.docRight - boxW / 2;
    }
    return pinPosData.docCenterX;
  }

  function restoreSavedPosition() {
    chrome.storage.local.get(['overlayPosition', 'overlayPinPosition'], (globalData) => {
      if (!state.overlay) return;
      const c = state.overlay.container;

      const posData = state.siteState.overlayPosition || globalData.overlayPosition;
      const pinPosData = state.siteState.overlayPinPosition || globalData.overlayPinPosition;

      // 호스트/컨테이너는 항상 fixed. 핀(페이지 고정)은 스크롤 양만큼 위치를 직접 보정해
      // 페이지에 붙어 함께 흘러가게 한다. (position:absolute는 사이트의 스크롤 컨테이너/
      // containing-block 환경에 따라 스크롤-어웨이가 안 먹는 경우가 있어 fixed+보정으로 통일)
      const pinned = isOverlayPinned();
      if (state.overlay.host) {
        state.overlay.host.style.position = 'fixed';
        state.overlay.host.style.width = '100%';
      }
      c.style.position = 'fixed';

      const settings = {
        ...(state.settings || {}),
        ...(state.siteState && state.siteState.styleOverrides ? state.siteState.styleOverrides : {})
      };
      const align = settings.textAlign || 'center';
      const boxW = state.overlay.box.offsetWidth;

      if (pinned) {
        const boxH = state.overlay.box.offsetHeight;
        let docBottom, docCenterX;
        if (pinPosData && pinPosData.docBottom != null) {
          docBottom = pinPosData.docBottom;
          docCenterX = computeDocCenterXForAlign(pinPosData, align, boxW);
        } else if (pinPosData && pinPosData.docTop != null) {
          // 하위 호환: 예전엔 docTop(박스 상단)을 저장 → 높이를 더해 바닥으로 환산
          docBottom = pinPosData.docTop + boxH;
          docCenterX = computeDocCenterXForAlign(pinPosData, align, boxW);
        } else if (posData) {
          const centerX = computeCenterXFromPosData(posData, align, boxW, window.innerWidth);
          const bottomVp = posData.bottomPercent !== undefined
            ? (window.innerHeight - posData.bottomPercent * window.innerHeight)
            : (posData.yPercent * window.innerHeight + boxH);
          docBottom = bottomVp + window.scrollY;
          docCenterX = centerX + window.scrollX;
        } else {
          docCenterX = window.innerWidth / 2 + window.scrollX;
          docBottom = window.innerHeight - 100 + window.scrollY;
        }
        setPinScrollAnchor(docBottom, docCenterX); // 앵커 저장 + 스크롤 리스너 + 즉시 배치
        return;
      }

      // 기본(고정 OFF) 모드: 뷰포트 기준 fixed (스크롤 따라 화면에 머무름)
      detachPinScroll();
      if (posData) {
        const pos = posData;
        const centerX = computeCenterXFromPosData(pos, align, boxW, window.innerWidth);

        if (pos.bottomPercent !== undefined) {
          const bottomY = pos.bottomPercent * window.innerHeight;
          c.style.top = 'auto';
          c.style.bottom = bottomY + 'px';
        } else {
          // 하위 호환(yPercent=박스 상단): box가 bottom:0이므로 container.bottom 기준으로 환산
          const topVp = pos.yPercent * window.innerHeight;
          const boxH = state.overlay.box.offsetHeight;
          c.style.top = 'auto';
          c.style.bottom = (window.innerHeight - (topVp + boxH)) + 'px';
        }
        applyContainerAlign(c, centerX);
      } else {
        // 기본 위치: 하단 중앙
        c.style.top = '';
        c.style.bottom = '60px';
        applyContainerAlign(c, window.innerWidth / 2);
      }
    });
  }

  function isOverlayPinned() {
    return !!state.siteState.isPinned;
  }

  // ── 핀(페이지 고정) 스크롤 보정 ──────────────────────────────────
  // 문서 좌표(docBottom/docCenterX)를 기준으로, 현재 스크롤 양을 빼서 뷰포트(fixed)
  // 위치를 계산한다. 스크롤하면 위치가 함께 이동해 '페이지에 고정'된 것처럼 보인다.
  function applyPinnedViewportPosition() {
    if (!state.overlay || !isOverlayPinned()) return;
    if (state._pinDocBottom == null) return;
    const c = state.overlay.container;
    const bottomVp = state._pinDocBottom - window.scrollY;   // 뷰포트 기준 박스 바닥
    const centerXVp = state._pinDocCenterX - window.scrollX; // 뷰포트 기준 중심 X
    c.style.position = 'fixed';
    c.style.top = 'auto';
    c.style.bottom = (window.innerHeight - bottomVp) + 'px';
    applyContainerAlign(c, centerXVp);
  }

  function setPinScrollAnchor(docBottom, docCenterX) {
    state._pinDocBottom = docBottom;
    state._pinDocCenterX = docCenterX;
    attachPinScroll();
    applyPinnedViewportPosition();
  }

  function attachPinScroll() {
    if (state._pinScrollHandler) return;
    const onScroll = () => {
      if (state._pinRaf) return;
      state._pinRaf = requestAnimationFrame(() => {
        state._pinRaf = null;
        applyPinnedViewportPosition();
      });
    };
    state._pinScrollHandler = onScroll;
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
  }

  function detachPinScroll() {
    if (!state._pinScrollHandler) return;
    window.removeEventListener('scroll', state._pinScrollHandler);
    window.removeEventListener('resize', state._pinScrollHandler);
    state._pinScrollHandler = null;
    if (state._pinRaf) { cancelAnimationFrame(state._pinRaf); state._pinRaf = null; }
  }

  // 정렬 설정에 따라 box의 left/right/transform을 설정.
  // centerX: 항상 box의 **시각적 중심**이 위치할 X좌표.
  //   모든 호출자(드래그, 위치 복원, 영역 선택 등)가 중심 기준으로 전달.
  // container는 항상 left:0; right:0 (전체 뷰포트 너비) 유지.
  // box를 position:absolute로 container 내부에서 배치.
  // 세 정렬 모두 centerX에서 box 너비의 절반을 빼거나 더하여 edge를 직접 계산.
  function applyContainerAlign(c, centerX) {
    if (!state.overlay) return;
    const box = state.overlay.box;
    const settings = {
      ...(state.settings || {}),
      ...(state.siteState && state.siteState.styleOverrides ? state.siteState.styleOverrides : {})
    };
    const align = settings.textAlign || 'center';

    // 진입 애니메이션(scale/translateY)이 적용 중일 때 getBoundingClientRect()는
    // 변형된 크기를 반환해 너비가 출렁인다. offsetWidth는 transform 영향을 받지 않는
    // 레이아웃 너비라 드래그/재배치 시 튐이 없다.
    const boxW = box.offsetWidth || box.getBoundingClientRect().width || 0;
    const halfW = boxW / 2;

    // 가사 내용이 바뀌어 너비가 변해도 중앙을 유지할 수 있도록 마지막 중심 좌표를 캐시
    state.overlay._alignCenterX = centerX;

    // container는 항상 전체 너비
    c.style.left = '0';
    c.style.right = '0';

    if (align === 'right') {
      // 우측 정렬: box의 오른쪽 끝 = centerX + halfW
      const rightEdge = centerX + halfW;
      box.style.left = 'auto';
      box.style.right = Math.max(0, window.innerWidth - rightEdge) + 'px';
      box.style.transform = '';
    } else if (align === 'left') {
      // 좌측 정렬: box의 왼쪽 끝 = centerX - halfW
      const leftEdge = centerX - halfW;
      box.style.left = Math.max(0, leftEdge) + 'px';
      box.style.right = 'auto';
      box.style.transform = '';
    } else {
      // 중앙 정렬: box의 왼쪽 끝 = centerX - halfW (left 정렬과 동일한 계산)
      // 텍스트는 box 내부에서 text-align: center로 이미 중앙 정렬됨
      const leftEdge = centerX - halfW;
      box.style.left = Math.max(0, leftEdge) + 'px';
      box.style.right = 'auto';
      box.style.transform = '';
    }
  }

  // 가사 내용이 바뀌면 너비(max-content)가 변한다. 중앙 정렬은 left가 고정 픽셀이라
  // 너비 변화 시 중심이 좌우로 드리프트한다("왔다갔다"). 내용 변경 후 캐시된 중심으로
  // 다시 배치해 중심을 고정한다. (좌/우 정렬은 끝점이 고정이라 너비 변화에 안정적이므로 제외)
  function reapplyAlignForContentChange() {
    if (!state.overlay || state.isDragging) return;
    const o = state.overlay;
    if (o._alignCenterX == null) return;
    const settings = {
      ...(state.settings || {}),
      ...(state.siteState && state.siteState.styleOverrides ? state.siteState.styleOverrides : {})
    };
    const align = settings.textAlign || 'center';
    if (align !== 'center') return;
    applyContainerAlign(o.container, o._alignCenterX);
  }

  // 가사창의 핀 버튼으로 고정 on/off 토글. 현재 보이는 위치를 그대로 유지한다.
  function togglePinFromOverlay() {
    const willPin = !state.siteState.isPinned;
    const updates = { isPinned: willPin };

    if (state.overlay) {
      const boxRect = state.overlay.box.getBoundingClientRect();
      if (willPin) {
        // 켤 때: 현재 화면 위치(박스 바닥 기준)를 문서 좌표로 저장 → 그 자리에 고정
        updates.overlayPinPosition = {
          docBottom: boxRect.bottom + window.scrollY,
          docTop: boxRect.top + window.scrollY,
          docCenterX: boxRect.left + boxRect.width / 2 + window.scrollX,
          docLeft: boxRect.left + window.scrollX,
          docRight: boxRect.right + window.scrollX
        };
      } else {
        // 끌 때: 현재 화면 위치를 뷰포트 비율로 저장 → 그 자리에서 뷰포트 고정으로 복귀
        updates.overlayPosition = {
          xCenterPercent: (boxRect.left + boxRect.width / 2) / window.innerWidth,
          xLeftPercent: boxRect.left / window.innerWidth,
          xRightPercent: (window.innerWidth - boxRect.right) / window.innerWidth,
          yPercent: boxRect.top / window.innerHeight,
          bottomPercent: (window.innerHeight - boxRect.bottom) / window.innerHeight
        };
      }
      
      // Update UI immediately for responsiveness
      state.overlay.pinBtn.classList.toggle('active', willPin);
    }
    
    updateSiteState(updates);

    // Update local state immediately so restoreSavedPosition uses the correct
    // pin position captured above (updateSiteState is async; the callback fires
    // too late for the restoreSavedPosition call below).
    Object.assign(state.siteState, updates);
    restoreSavedPosition();
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
        updateSiteState({
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
      return { error: chrome.i18n.getMessage('content_load_first') };
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
        const bottomEdgeVp = rect.top + rect.height * 0.92; // 가사 박스 하단이 위치할 뷰포트 Y
        const c = state.overlay.container;

        if (isOverlayPinned()) {
          // 고정 모드: 뷰포트로 배치 후 문서 좌표 앵커 갱신 (스크롤 보정은 리스너가 처리)
          c.style.position = 'fixed';
          c.style.top = 'auto';
          c.style.bottom = `${window.innerHeight - bottomEdgeVp}px`;
          applyContainerAlign(c, centerX);
          state._pinDocBottom = bottomEdgeVp + window.scrollY;
          state._pinDocCenterX = centerX + window.scrollX;
        } else {
          // 기본 모드: 뷰포트 하단 기준
          c.style.position = 'fixed';
          c.style.top = 'auto';
          c.style.bottom = `${window.innerHeight - bottomEdgeVp}px`;
          applyContainerAlign(c, centerX);
        }
        
        // 새로 설정된 위치를 기준으로 저장
        setTimeout(() => {
          savePosition();
        }, 50);
        
        // 시각적 피드백 (box에 scale 적용)
        const box = state.overlay.box;
        const origTransform = box.style.transform || '';
        box.style.transform = origTransform + ' scale(1.05)';
        setTimeout(() => {
          if (state.overlay) {
            box.style.transform = origTransform;
          }
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
        // 트랙 정보 저장 (팝업 복원용, 사이트별)
        updateSiteState({ currentTrack: {
          name: state.trackName,
          count: parsed.length,
          duration: SRTParser.getTotalDuration(parsed),
          srtText: message.srtText
        }});
        // 새 곡이므로 타임라인 갱신 + 스크롤 맨 위로
        refreshRemoteTimelineForNewTrack();
        sendResponse({
          success: true,
          count: parsed.length,
          duration: SRTParser.getTotalDuration(parsed)
        });
        break;
      }

      case 'PLAY':
        if (state.lyrics.length === 0) {
          sendResponse({ success: false, error: chrome.i18n.getMessage('content_no_lyrics') });
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
        chrome.storage.local.get(['settings', 'siteStates'], (data) => {
          if (data.settings) {
            state.settings = data.settings;
          }
          if (data.siteStates && data.siteStates[currentHostname]) {
            state.siteState = data.siteStates[currentHostname];
          }
          if (state.settings) applySettings(state.settings);
        });
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

      case 'GET_STATUS': {
        let currentTime = 0;
        if (state.isPlaying) {
          if (state.isPaused) {
            currentTime = state.pausedAt + state.syncOffset;
          } else if (state.externalClock) {
            // 외부 클럭(SoundCloud 등) 연동 시 실제 오디오 위치 사용
            currentTime = Math.max(0, state.externalClock.getTimeMs()) + state.syncOffset;
          } else {
            currentTime = performance.now() - state.startTimestamp + state.syncOffset;
          }
        }
        sendResponse({
          isPlaying: state.isPlaying,
          isPaused: state.isPaused,
          hasLyrics: state.lyrics.length > 0,
          lyricCount: state.lyrics.length,
          trackName: state.trackName,
          syncOffset: state.syncOffset,
          currentTime,
          totalDuration: SRTParser.getTotalDuration(state.lyrics)
        });
        break;
      }

      default:
        break;
    }
    return true;
  });

  // 설정 및 사이트 상태 변경 감지
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings && changes.settings.newValue) {
      const newSettings = changes.settings.newValue;
      const shouldShowRemote = newSettings.remoteEnabledSites && newSettings.remoteEnabledSites[currentHostname] === true;
      // 이미 overlay가 있거나 리모컨을 켜야 하는 경우만 처리
      if (state.overlay || shouldShowRemote) {
        applySettings(newSettings);
      }
    }
    
    if (changes.siteStates && changes.siteStates.newValue) {
      const newStates = changes.siteStates.newValue;
      if (newStates[currentHostname]) {
        const myNewState = newStates[currentHostname];
        const oldPinned = !!state.siteState.isPinned;
        const newPinned = !!myNewState.isPinned;
        
        state.siteState = myNewState;
        
        // 외부 탭 등에서 핀 상태가 변경된 경우 즉시 UI 업데이트
        if (oldPinned !== newPinned && state.overlay) {
          state.overlay.pinBtn.classList.toggle('active', newPinned);
          restoreSavedPosition();
        }
      }
    }
  });

  // ============================================================
  // SoundCloud 자동 싱크
  //   현재 재생 중인 곡(제목/가수)을 감지해 라이브러리 가사와 자동 매칭하고,
  //   오디오의 실제 재생 위치(currentTime)에 맞춰 가사를 동기화한다.
  //   ※ soundcloud.com 에서만 동작하며, 다른 사이트에는 영향을 주지 않는다.
  //   ※ DOM 선택자(제목/가수)는 SoundCloud UI 변경 시 튜닝이 필요할 수 있음.
  // ============================================================
  function initSoundCloudSync() {
    if (!window.location.hostname.includes('soundcloud.com')) return;

    const SC_DEBUG = false; // 진단용 로그 (필요 시 true로)
    const log = (...a) => { if (SC_DEBUG) console.log('[LyricsOverlay/SC]', ...a); };

    let followKey = null;  // 현재 따라가고 있는 곡의 식별자 (매칭 성공 시에만 설정)
    let following = false; // 현재 SoundCloud가 가사를 구동 중인지
    let lastMetaKey = '';  // 직전 tick의 메타 키 — 같으면 storage 읽기 스킵

    // ── 라이브러리 메모리 캐시 ──────────────────────────────────────
    // 매초 storage.get 대신 이 캐시를 사용. storage.onChanged로 자동 갱신.
    let cachedLibrary = null;
    chrome.storage.local.get(['savedLyrics'], (d) => { cachedLibrary = d.savedLyrics || []; });
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.savedLyrics) cachedLibrary = changes.savedLyrics.newValue || [];
    });

    // ── DOM 요소 캐시 (getPositionMs 전용) ──────────────────────────
    // querySelectorAll/querySelector를 매 프레임 호출하는 비용을 줄임.
    // SoundCloud는 SPA이므로 주기적으로 재검색하되, 유효할 때는 재사용.
    let _cachedAudio = null;
    let _cachedPb = null;
    let _cachedHandle = null;
    let _cachedTimePassed = null;
    let _domCacheAge = 0; // 마지막 DOM 재검색 시각 (performance.now)

    function refreshDomCache() {
      const els = [...document.querySelectorAll('audio')];
      const playing = els.find(a => (a.currentSrc || a.src) && !a.paused);
      _cachedAudio = playing
        || (els.filter(a => a.currentSrc || a.src).sort((x, y) => (y.currentTime || 0) - (x.currentTime || 0))[0])
        || els[0] || null;
      _cachedPb = document.querySelector('.playbackTimeline__progressWrapper[role="progressbar"]')
               || document.querySelector('.playbackTimeline [role="progressbar"]')
               || document.querySelector('[role="progressbar"]');
      _cachedHandle = document.querySelector('.playbackTimeline__progressHandle');
      _cachedTimePassed = document.querySelector('.playbackTimeline__timePassed');
      _domCacheAge = performance.now();
    }

    // 현재 재생 위치(ms)를 여러 소스로부터 얻는다.
    //   1) <audio> 엘리먼트 currentTime (있으면 가장 정확)
    //   2) 재생바 progressbar의 aria-valuenow(초) / 핸들 위치(%) × 길이
    //   3) 시간 텍스트(.playbackTimeline__timePassed) 파싱
    // DOM 캐시는 2초마다 갱신 → 60fps 루프에서 매번 querySelectorAll 방지
    function getPositionMs() {
      if (performance.now() - _domCacheAge > 2000) refreshDomCache();

      const a = _cachedAudio;
      if (a && a.currentTime > 0) return a.currentTime * 1000;

      const pb = _cachedPb;
      if (pb) {
        const now = parseFloat(pb.getAttribute('aria-valuenow'));
        const max = parseFloat(pb.getAttribute('aria-valuemax'));
        const handle = _cachedHandle;
        if (handle && !isNaN(max) && max > 0) {
          const leftPct = parseFloat(handle.style.left);
          if (!isNaN(leftPct)) return (leftPct / 100) * max * 1000;
        }
        if (!isNaN(now)) return now * 1000;
      }

      // 텍스트 폴백 (예: "1:23")
      const t = _cachedTimePassed;
      if (t) {
        const ms = parseTimeTextMs(t.textContent);
        if (ms != null) return ms;
      }
      return 0;
    }

    function parseTimeTextMs(txt) {
      if (!txt) return null;
      const nums = txt.replace(/[^0-9:]/g, '').split(':').map(Number).filter(n => !isNaN(n));
      if (nums.length === 0) return null;
      let sec = 0;
      for (const n of nums) sec = sec * 60 + n;
      return sec * 1000;
    }

    // 수동 재생 경로(play())에서도 동일한 위치 소스에 싱크하도록 주입
    scGetPositionMs = getPositionMs;

    // 현재 곡의 제목/가수 추출 (MediaSession 우선, 실패 시 플레이어 바 DOM)
    function getMetadata() {
      try {
        const m = navigator.mediaSession && navigator.mediaSession.metadata;
        if (m && m.title) return { title: m.title, artist: m.artist || '' };
      } catch (e) {}

      const titleEl = document.querySelector('.playbackSoundBadge__titleLink');
      if (titleEl) {
        const title = (titleEl.getAttribute('title') || titleEl.textContent || '').trim();
        const artistEl = document.querySelector('.playbackSoundBadge__lightLink');
        const artist = artistEl ? (artistEl.getAttribute('title') || artistEl.textContent || '').trim() : '';
        if (title) return { title, artist };
      }
      return null;
    }

    // 매칭용 정규화: 괄호 부가설명/부가어 제거 후 영문·숫자·한글·가나·한자만 남김
    //   ※ NFC 정규화 필수: SoundCloud 제목은 분해형(NFD, 예: か+結합탁점)으로 와서
    //      완성형(NFC) 라이브러리 이름과 코드포인트가 달라 그대로는 매칭 실패함.
    function normalize(s) {
      return (s || '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/\(.*?\)|\[.*?\]|【.*?】/g, ' ')
        .replace(/official|audio|lyric video|lyrics?|m\/?v|feat\.?|ft\.?|prod\.?/g, ' ')
        .replace(/[^0-9a-z가-힣぀-ヿ一-鿿]/g, '')
        .trim();
    }

    function matchLibrary(meta, list) {
      const nTitle = normalize(meta.title);
      const nArtist = normalize(meta.artist);
      if (!nTitle) return null;

      let best = null, bestScore = 0;
      for (const item of list) {
        const p = item.parsed || {};
        const titles = [p.titleOrig, p.titleKo, item.name].filter(Boolean).map(normalize);
        const artists = [p.artistOrig, p.artistKo].filter(Boolean).map(normalize);
        const nameNorm = normalize(item.name);

        let score = 0;
        if (titles.some(t => t && (t === nTitle || t.includes(nTitle) || nTitle.includes(t)))) score += 2;
        else if (nameNorm.includes(nTitle)) score += 1;

        if (nArtist && artists.some(a => a && (a.includes(nArtist) || nArtist.includes(a)))) score += 1;
        else if (nArtist && nameNorm.includes(nArtist)) score += 0.5;

        if (score > bestScore) { bestScore = score; best = item; }
      }
      // 제목이 확실히 일치(2점)할 때만 채택해 오매칭 방지
      return bestScore >= 2 ? best : null;
    }

    function stopFollowing() {
      if (!following) return;
      following = false;
      stopPlayback(); // externalClock도 함께 정리됨
      log('가사 추적 중지');
    }

    function handleTick() {
      // 설정에서 '노래 자동 감지'를 끄면 동작하지 않음 (기본값: 켜짐)
      if (state.settings && state.settings.autoDetectSong === false) {
        if (following) { stopFollowing(); followKey = null; }
        return;
      }

      const meta = getMetadata();
      const key = meta ? normalize(meta.title) + '|' + normalize(meta.artist) : '';

      // 이미 이 곡을 따라가는 중이면 그대로 유지
      if (following && key && key === followKey) return;

      // 곡이 바뀌었으면 기존 추적 중지
      if (following && key !== followKey) {
        stopFollowing();
        followKey = null;
      }

      if (!meta) { lastMetaKey = ''; return; }

      // 메타 키가 직전과 동일하면 이미 매칭 시도한 상태 → storage 재읽기 불필요
      if (key === lastMetaKey) return;
      lastMetaKey = key;

      // 메모리 캐시 우선, 없으면 storage에서 읽기 (첫 초기화 전 등 드문 상황)
      const tryMatch = (all) => {
        const item = matchLibrary(meta, all);
        if (!item) { log('매칭 실패 — SoundCloud:', meta, '| 후보 곡 수:', all.length); return; }

        log('매칭 성공 →', item.name, '| 현재 위치(ms):', getPositionMs());
        state.externalClock = { getTimeMs: () => getPositionMs() || 0 };
        following = true;
        followKey = key;
        playFromRemoteLibrary(item);
      };

      if (cachedLibrary !== null) {
        tryMatch(cachedLibrary);
      } else {
        chrome.storage.local.get(['savedLyrics'], (data) => {
          cachedLibrary = data.savedLyrics || [];
          tryMatch(cachedLibrary);
        });
      }
    }

    // SPA 곡 전환을 감지하기 위해 주기적으로 확인
    const intervalId = setInterval(() => {
      // 확장 프로그램이 리로드되어 컨텍스트가 무효화되면 인터벌을 정리한다.
      // (이 처리가 없으면 "Extension context invalidated" 에러가 매초 발생)
      if (!chrome.runtime || !chrome.runtime.id) { clearInterval(intervalId); return; }
      try { handleTick(); } catch (e) { /* 컨텍스트 일시 오류 등은 무시 */ }
    }, 1000);
    log('SoundCloud 자동 싱크 활성화');
  }

  // ============================================================
  // 비디오 일시정지/재생 연동 (치지직 VOD + 유튜브)
  //   영상을 멈추면 가사도 멈추고, 다시 재생하면 가사도 이어서 재생.
  //   ※ 위치 동기화가 아니라 play/pause '상태'만 가사에 미러링한다.
  //   ※ VOD에서만 동작(라이브는 duration이 무한 → 제외). 가사 재생 중일 때만 반응.
  // ============================================================
  function initVideoSync() {
    const host = window.location.hostname;
    const isChzzk = host.includes('chzzk.naver.com');
    const isYouTube = host.includes('youtube.com');
    if (!isChzzk && !isYouTube) return;

    let boundVideo = null;

    // 치지직 플레이어 클래스 우선, 없으면 일반 video
    const findVideo = () =>
      document.querySelector('video.webplayer-internal-video')
      ?? document.querySelector('video');

    // VOD 판별: 메타데이터 로드 후 duration이 유한한 양수일 때만 true (라이브=Infinity)
    const isVodVideo = (v) => {
      if (!v || v.readyState < 1) return false;
      if (!isFinite(v.duration)) return false; // 라이브
      return v.duration > 0;
    };

    // 영상 → 가사 단방향 미러링. 가드로 중복/오작동 방지.
    const onVideoPause = () => {
      // 가사가 재생 중(비일시정지)이고 VOD일 때만 일시정지
      if (state.isPlaying && !state.isPaused && isVodVideo(boundVideo)) {
        pause();
      }
    };
    const onVideoPlay = () => {
      // 가사가 일시정지 상태일 때만 이어서 재생 (재생 중에 play() 호출 시 처음부터 재시작되므로 가드)
      if (state.isPlaying && state.isPaused && isVodVideo(boundVideo)) {
        play();
      }
    };

    const attach = (v) => {
      if (v === boundVideo) return;
      if (boundVideo) {
        boundVideo.removeEventListener('pause', onVideoPause);
        boundVideo.removeEventListener('play', onVideoPlay);
      }
      boundVideo = v;
      if (v) {
        v.addEventListener('pause', onVideoPause);
        v.addEventListener('play', onVideoPlay);
      }
    };

    // SPA 대응: 영상 엘리먼트가 새로 생성/교체될 수 있으므로 주기적으로 현재 video를 찾아 재부착
    const intervalId = setInterval(() => {
      if (!chrome.runtime || !chrome.runtime.id) { clearInterval(intervalId); return; }
      try {
        const v = findVideo();
        if (v && v !== boundVideo) attach(v);
      } catch (e) { /* 컨텍스트 일시 오류 등은 무시 */ }
    }, 1000);
  }

  // 초기화
  loadSettings();
  initSoundCloudSync();
  initVideoSync();

})();
