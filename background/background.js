/**
 * Background Service Worker
 */

importScripts('../lib/sheet-parser.js', '../lib/sheet-sync.js');

const SHEET_ALARM_NAME = 'sheetAutoSync';

// Popup → Content Script 메시지 중계
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'content') {
    // Popup에서 Content Script로 보내는 메시지
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
          sendResponse(response);
        });
      }
    });
    return true; // 비동기 응답
  }

  if (message.target === 'background') {
    // 확장프로그램 상태 조회 등
    if (message.type === 'GET_STATE') {
      chrome.storage.local.get(['currentLyrics', 'settings', 'savedLyrics'], (data) => {
        sendResponse(data);
      });
      return true;
    }

    if (message.type === 'SYNC_ALARM_UPDATE') {
      reconcileAlarm();
      return false;
    }
  }
});

// 설정에 따라 자동 동기화 알람을 생성/해제한다 (storage가 유일한 근거 — payload 신뢰 안 함)
async function reconcileAlarm() {
  const { settings } = await chrome.storage.local.get(['settings']);
  const enabled = settings && settings.sheetAutoSyncEnabled === true;
  const intervalMin = (settings && settings.sheetAutoSyncIntervalMin) || 1440;

  if (!enabled) {
    await chrome.alarms.clear(SHEET_ALARM_NAME);
    return;
  }
  await chrome.alarms.create(SHEET_ALARM_NAME, { periodInMinutes: intervalMin });
}

// 실제 동기화 수행. 실패해도 조용히 로그만 남기고 재시도하지 않음(팝업 없이도 동작하므로 UI 없음)
async function runBackgroundSync() {
  const { settings } = await chrome.storage.local.get(['settings']);
  const url = settings && settings.googleSheetUrl;
  if (!url) return;
  const res = await SheetSync.fetchAndMergeSheet(url);
  if (!res.ok) {
    console.warn('[sheetAutoSync] sync failed:', res.error);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SHEET_ALARM_NAME) {
    runBackgroundSync();
  }
});

// 브라우저가 닫혀 있는 동안은 알람이 발화하지 않으므로, 시작 시 주기가 지났으면 즉시 1회 동기화
async function maybeCatchUpSync() {
  const { settings, lastSheetSyncAt } = await chrome.storage.local.get(['settings', 'lastSheetSyncAt']);
  if (!settings || settings.sheetAutoSyncEnabled !== true) return;
  const intervalMs = (settings.sheetAutoSyncIntervalMin || 1440) * 60 * 1000;
  const last = lastSheetSyncAt || 0;
  if (Date.now() - last >= intervalMs) {
    await runBackgroundSync();
  }
}

chrome.runtime.onStartup.addListener(async () => {
  await reconcileAlarm();
  await maybeCatchUpSync();
});

// 확장프로그램 설치/업데이트 시 기본 설정 초기화
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['settings'], (data) => {
    if (!data.settings) {
      const defaultSettings = {
        origFontSize: 20,
        origColor: '#FFA800',
        showOriginal: true,
        pronFontSize: 18,
        pronColor: '#F5E6CC',
        showPronunciation: true,
        mainFontSize: 28,
        mainColor: '#FFFFFF',
        bgColor: '#000000',
        bgOpacity: 0.45,
        bgBlur: 4,
        libraryDisplayLang: 'both',
        textShadow: true,
        animation: 'fade',
        fontFamily: "'Noto Sans KR', 'Noto Sans JP', sans-serif",
        sheetAutoSyncEnabled: false,
        sheetAutoSyncIntervalMin: 1440
      };
      chrome.storage.local.set({ settings: defaultSettings });
    }
    if (!data.savedLyrics) {
      chrome.storage.local.set({ savedLyrics: [] });
    }
  });
  reconcileAlarm();
});
