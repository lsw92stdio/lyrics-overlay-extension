/**
 * SRT Parser - SRT 자막 파일을 파싱하는 유틸리티
 * 
 * SRT 형식 (\\N으로 줄 구분):
 * 1
 * 00:00:08,719 --> 00:00:12,425
 * 原文テキスト\\N발음 텍스트\\N한국어 번역
 * 
 * 파싱 결과:
 * [{ index, startTime (ms), endTime (ms), lines: ["원문", "발음", "번역"] }, ...]
 * 
 * lines 배열:
 *   1줄: ["텍스트"] - 단일 텍스트
 *   2줄: ["원문", "한국어 번역"] - 원문 + 번역
 *   3줄: ["원문", "발음", "한국어 번역"] - 원문 + 발음 + 번역
 * 
 * 마지막 줄이 항상 메인(한국어 번역), 나머지는 서브(원문/발음)
 */

const SRTParser = (() => {
  'use strict';

  /**
   * 타임스탬프 문자열을 밀리초로 변환
   * @param {string} timeStr - "HH:MM:SS,mmm" 형식
   * @returns {number} 밀리초
   */
  function parseTimestamp(timeStr) {
    const cleaned = timeStr.trim();
    const match = cleaned.match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!match) {
      console.warn('[SRT Parser] Invalid timestamp:', timeStr);
      return 0;
    }
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const seconds = parseInt(match[3], 10);
    const millis = parseInt(match[4], 10);
    return hours * 3600000 + minutes * 60000 + seconds * 1000 + millis;
  }

  /**
   * 밀리초를 "MM:SS" 형식 문자열로 변환
   * @param {number} ms - 밀리초
   * @returns {string} "MM:SS"
   */
  function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  /**
   * 밀리초를 "HH:MM:SS,mmm" SRT 타임스탬프로 변환
   * @param {number} ms - 밀리초
   * @returns {string} SRT 타임스탬프
   */
  function toSRTTimestamp(ms) {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const millis = ms % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
  }

  /**
   * SRT 텍스트를 파싱하여 구조화된 배열 반환
   * @param {string} srtText - SRT 파일 내용
   * @returns {Array<{index: number, startTime: number, endTime: number, lines: string[]}>}
   */
  function parse(srtText) {
    if (!srtText || typeof srtText !== 'string') {
      return [];
    }

    // BOM 제거 및 줄바꿈 통일
    const cleaned = srtText
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');

    // 빈 줄 기준으로 블록 분리
    const blocks = cleaned.split(/\n\n+/).filter(block => block.trim());
    const entries = [];

    for (const block of blocks) {
      const blockLines = block.trim().split('\n');
      
      if (blockLines.length < 2) continue;

      // 첫 줄: 인덱스 번호 (숫자가 아니면 스킵)
      const indexLine = blockLines[0].trim();
      if (!/^\d+$/.test(indexLine)) continue;
      
      // 둘째 줄: 타임스탬프
      const timeLine = blockLines[1].trim();
      const timeMatch = timeLine.match(/(.+?)\s*-->\s*(.+)/);
      if (!timeMatch) continue;

      const startTime = parseTimestamp(timeMatch[1]);
      const endTime = parseTimestamp(timeMatch[2]);

      // 나머지 줄: 가사 텍스트 - 실제 줄바꿈으로 합친 후 \N으로 분리
      const rawText = blockLines.slice(2).filter(l => l.trim()).join('\\N');
      
      // \N으로 분리하여 lines 배열 생성
      const lines = rawText
        .split('\\N')
        .map(l => l.trim())
        .filter(l => l.length > 0);

      if (lines.length === 0) continue;

      entries.push({
        index: parseInt(indexLine, 10),
        startTime,
        endTime,
        lines
      });
    }

    // 시작 시간 기준 정렬
    entries.sort((a, b) => a.startTime - b.startTime);

    return entries;
  }

  /**
   * 특정 시간(ms)에 해당하는 가사 항목 찾기
   * @param {Array} entries - 파싱된 가사 배열
   * @param {number} currentTime - 현재 시간 (ms)
   * @returns {Object|null} 해당 가사 항목 또는 null
   */
  function findEntryAtTime(entries, currentTime) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (currentTime >= entry.startTime && currentTime <= entry.endTime) {
        return entry;
      }
    }
    return null;
  }

  /**
   * 전체 가사의 총 재생 시간 반환
   * @param {Array} entries - 파싱된 가사 배열
   * @returns {number} 총 시간 (ms)
   */
  function getTotalDuration(entries) {
    if (!entries || entries.length === 0) return 0;
    return Math.max(...entries.map(e => e.endTime));
  }

  return {
    parse,
    parseTimestamp,
    formatTime,
    toSRTTimestamp,
    findEntryAtTime,
    getTotalDuration
  };
})();

// Content Script 환경에서 전역으로 사용 가능
if (typeof window !== 'undefined') {
  window.SRTParser = SRTParser;
}
