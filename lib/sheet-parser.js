const SheetParser = (() => {
  function parseCSV(csvText) {
    const rows = [];
    let currentRow = [];
    let currentCell = '';
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
      const char = csvText[i];
      const nextChar = csvText[i + 1];

      if (inQuotes) {
        if (char === '"' && nextChar === '"') { currentCell += '"'; i++; }
        else if (char === '"') { inQuotes = false; }
        else { currentCell += char; }
      } else {
        if (char === '"') { inQuotes = true; }
        else if (char === ',') { currentRow.push(currentCell); currentCell = ''; }
        else if (char === '\n' || char === '\r') {
          if (char === '\r' && nextChar === '\n') i++;
          currentRow.push(currentCell);
          rows.push(currentRow);
          currentRow = [];
          currentCell = '';
        } else { currentCell += char; }
      }
    }
    if (currentCell !== '' || csvText.endsWith(',')) currentRow.push(currentCell);
    if (currentRow.length > 0) rows.push(currentRow);
    return rows;
  }

  function splitOriginalAndKorean(text) {
    text = text.trim();
    const match = text.match(/(.+?)\s*[\(\[](.+?)[\)\]]$/);
    if (!match) return { orig: text, ko: '' };
    const part1 = match[1].trim();
    const part2 = match[2].trim();
    const hasHangul1 = /[가-힣]/.test(part1);
    const hasHangul2 = /[가-힣]/.test(part2);
    if (hasHangul1 && !hasHangul2) return { orig: part2, ko: part1 };
    return { orig: part1, ko: part2 };
  }

  function parseFileName(fileName) {
    const cleanName = fileName.replace(/\.srt$/i, '').trim();
    const match = cleanName.match(/^(\d+)?\s*(.*?)\s*-\s*(.*)$/);
    if (match) {
      const artistParts = splitOriginalAndKorean(match[2].trim());
      const titleParts = splitOriginalAndKorean(match[3].trim());
      const standardArtist = artistParts.ko ? `${artistParts.orig} (${artistParts.ko})` : artistParts.orig;
      const standardTitle = titleParts.ko ? `${titleParts.orig} (${titleParts.ko})` : titleParts.orig;
      return {
        index: match[1] || '',
        artist: standardArtist, artistOrig: artistParts.orig, artistKo: artistParts.ko,
        title: standardTitle, titleOrig: titleParts.orig, titleKo: titleParts.ko,
        original: cleanName
      };
    }
    return { original: cleanName, index: '', artist: '', title: '', artistOrig: '', artistKo: '', titleOrig: '', titleKo: '' };
  }

  // parsed(parseFileName 결과와 동일한 셰이프) → 표준 파일명 ("{index} {artist} - {title}.srt")
  function buildStandardName(parsed) {
    if (!parsed.artist && !parsed.title) {
      return parsed.original.endsWith('.srt') ? parsed.original : parsed.original + '.srt';
    }
    const baseName = `${parsed.artist} - ${parsed.title}.srt`;
    return parsed.index ? `${parsed.index} ${baseName}` : baseName;
  }

  function toExportUrl(url) {
    const match = url.match(/\/d\/(.*?)\/edit/);
    return (match && match[1])
      ? `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv`
      : url;
  }

  // CSV rows(헤더 제외) → lyrics 배열
  // 열 구성: A=Name, B=SRT Text, C=Keywords, D=Auto Only(1이면 자동 감지 전용), E=동기화된 영상
  function rowsToLyrics(rows) {
    const lyrics = [];
    for (const row of rows) {
      if (row.length >= 2 && row[0].trim() && row[1].trim()) {
        const name = row[0].trim().replace(/\.srt$/i, '');
        const srtText = row[1].trim();
        const parsed = parseFileName(name);
        if (row.length >= 3 && row[2].trim()) {
          parsed.keywords = row[2].split(',').map(k => k.trim()).filter(k => k);
        }
        const lyric = { name, srtText, parsed, updatedAt: Date.now() };
        // D열 "Auto Only": 값이 1이면 수동 목록/검색/곡수에서 제외하고 자동 감지로만 사용
        if (row.length >= 4 && row[3].trim() === '1') {
          lyric.autoOnly = true;
        }
        // E열 "동기화된 영상": 값이 있을 때만 포함 — 비어있으면 로컬에 등록된 값을 보존
        // (mergeLyrics의 {...existing, ...entryToSave} 병합 규칙상 필드 자체가 없어야 보존됨)
        if (row.length >= 5 && row[4].trim()) {
          lyric.videoSyncs = parseVideoSyncs(row[4]);
        }
        lyrics.push(lyric);
      }
    }
    return lyrics;
  }

  // "url|offsetMs;url2|offsetMs2" 형식 텍스트 → [{url, offsetMs}] 배열
  function parseVideoSyncs(text) {
    if (!text) return [];
    return text.split(';').map(s => s.trim()).filter(Boolean).map(pair => {
      const idx = pair.lastIndexOf('|');
      if (idx < 0) return null;
      const url = pair.slice(0, idx).trim();
      const offsetMs = parseInt(pair.slice(idx + 1).trim(), 10);
      return (url && !isNaN(offsetMs)) ? { url, offsetMs } : null;
    }).filter(Boolean);
  }

  // [{url, offsetMs}] 배열 → "url|offsetMs;url2|offsetMs2" 형식 텍스트
  function stringifyVideoSyncs(list) {
    return (list || []).map(s => `${s.url}|${s.offsetMs}`).join('; ');
  }

  // 수동 목록(라이브러리 리스트/검색/곡 수)에 노출할지 여부.
  //   autoOnly 가사는 자동 감지(SoundCloud 등)로만 사용되며 목록에는 보이지 않는다.
  function isManualVisible(item) {
    return !(item && item.autoOnly);
  }

  return { parseCSV, parseFileName, buildStandardName, toExportUrl, rowsToLyrics, isManualVisible, parseVideoSyncs, stringifyVideoSyncs };
})();
