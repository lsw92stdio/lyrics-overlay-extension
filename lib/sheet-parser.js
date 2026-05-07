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

  function toExportUrl(url) {
    const match = url.match(/\/d\/(.*?)\/edit/);
    return (match && match[1])
      ? `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv`
      : url;
  }

  // CSV rows(헤더 제외) → lyrics 배열
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
        lyrics.push({ name, srtText, parsed, updatedAt: Date.now() });
      }
    }
    return lyrics;
  }

  return { parseCSV, parseFileName, toExportUrl, rowsToLyrics };
})();
