export function inferCatalogMetadata(source, folderName = '') {
  const text = `${typeof source === 'string' ? source : ''} ${typeof folderName === 'string' ? folderName : ''}`;
  const year = Number(text.match(/\b(19\d{2}|20\d{2})\b/)?.[1]) || null;
  const lower = text.toLocaleLowerCase();
  const level = /\bnationals?\b/.test(lower) ? 'Nationals'
    : /\bstate\b/.test(lower) ? 'State'
      : /\bchapter\b/.test(lower) ? 'Chapter'
        : /\bschool\b/.test(lower) ? 'School'
          : null;
  const roundMatch = text.match(/\b(Sprint|Target|Team|Countdown|Warm-Up|Warm Up)\s+Round\b/i);
  const round = roundMatch ? roundMatch[1].replace(/\s+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) : null;
  const numberMatch = text.match(/\bproblem\s*#?\s*([1-9]\d{0,2})\b/i);
  const problemNumber = numberMatch ? Number(numberMatch[1]) : null;
  return { year, level, round, problemNumber };
}

export function catalogGroupName(year, level) {
  const parts = [year, level].filter(value => value !== null && value !== undefined && String(value).trim());
  return parts.length ? parts.join(' ') : 'Source details needed';
}
