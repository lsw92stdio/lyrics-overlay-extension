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
      .replace(/^﻿/, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');

    // 완전히 빈 줄(공백/탭만 있는 줄 포함)을 전부 제거한 뒤, "숫자만 있는 줄(인덱스) +
    // 바로 다음 줄이 타임스탬프(-->)"인 지점을 블록의 시작으로 인식하며 순회한다.
    // 구글 시트 등에 SRT를 붙여넣으면 블록 사이뿐 아니라 각 줄 사이에도 빈 줄(또는 스페이스만
    // 있는 줄)이 끼어드는 경우가 흔한데, "빈 줄(\n\n)"만으로 블록을 나누면 그런 경우 전체가
    // 파싱 불가능한 하나의 블록으로 뭉쳐버린다 — 그래서 빈 줄 자체를 블록 구분 신호로 쓰지
    // 않고, 인덱스+타임스탬프 패턴으로 블록을 직접 찾는다.
    const lines = cleaned.split('\n').filter(l => l.trim() !== '');
    const entries = [];
    let i = 0;

    const isIndexLine = (idx) =>
      idx < lines.length && /^\d+$/.test(lines[idx].trim()) &&
      idx + 1 < lines.length && /-->/.test(lines[idx + 1]);

    while (i < lines.length) {
      if (!isIndexLine(i)) { i++; continue; }

      const indexLine = lines[i].trim();
      const timeMatch = lines[i + 1].match(/(.+?)\s*-->\s*(.+)/);
      if (!timeMatch) { i++; continue; }

      const startTime = parseTimestamp(timeMatch[1]);
      const endTime = parseTimestamp(timeMatch[2]);

      // 다음 인덱스+타임스탬프 패턴이 나오기 전까지를 이 블록의 텍스트로 수집
      let j = i + 2;
      const textLines = [];
      while (j < lines.length && !isIndexLine(j)) {
        textLines.push(lines[j]);
        j++;
      }

      // \N으로 분리하여 lines 배열 생성
      const entryLines = textLines
        .map(l => l.trim())
        .filter(Boolean)
        .join('\\N')
        .split('\\N')
        .map(l => l.trim())
        .filter(l => l.length > 0);

      if (entryLines.length > 0) {
        entries.push({
          index: parseInt(indexLine, 10),
          startTime,
          endTime,
          lines: entryLines
        });
      }

      i = j;
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

  /**
   * 구조화된 가사 배열을 SRT 텍스트로 역직렬화
   * @param {Array<{startTime:number, endTime:number, lines:string[]}>} entries
   * @returns {string} SRT 텍스트
   */
  function stringify(entries) {
    return entries.map((e, i) =>
      `${i + 1}\n${toSRTTimestamp(e.startTime)} --> ${toSRTTimestamp(e.endTime)}\n${e.lines.join('\\N')}`
    ).join('\n\n') + '\n';
  }

  return {
    parse,
    stringify,
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
