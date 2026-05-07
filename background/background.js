/**
 * Background Service Worker
 */

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
  }
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
        fontFamily: "'Noto Sans KR', 'Noto Sans JP', sans-serif"
      };
      chrome.storage.local.set({ settings: defaultSettings });
    }
    if (!data.savedLyrics) {
      chrome.storage.local.set({ savedLyrics: [] });
    }
  });
});
