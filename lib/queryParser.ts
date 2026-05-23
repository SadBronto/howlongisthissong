export interface ParsedQuery {
  keywords?: string;
  exactDuration?: number;  // ms — center of proximity search
  minDuration?: number;    // ms
  maxDuration?: number;    // ms
  raw: string;
  isEmpty: boolean;
}

function parseDuration(str: string): number {
  const parts = str.split(':').map(Number);
  if (parts.length === 2) {
    const [min, sec] = parts;
    if (!isNaN(min) && !isNaN(sec)) return (min * 60 + sec) * 1000;
  }
  return 0;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function parseQuery(input: string): ParsedQuery {
  let q = input.trim();
  const result: ParsedQuery = { raw: input, isEmpty: !q };

  if (!q) return result;

  // "between X and Y"
  const betweenMatch = q.match(/between\s+(\d{1,2}:\d{2})\s+and\s+(\d{1,2}:\d{2})/i);
  if (betweenMatch) {
    result.minDuration = parseDuration(betweenMatch[1]);
    result.maxDuration = parseDuration(betweenMatch[2]);
    q = q.replace(betweenMatch[0], '').trim();
  }

  // "X to Y" or "X-Y" range (if no between match)
  if (!result.minDuration) {
    const rangeMatch = q.match(/(\d{1,2}:\d{2})\s*(?:to|-)\s*(\d{1,2}:\d{2})/i);
    if (rangeMatch) {
      result.minDuration = parseDuration(rangeMatch[1]);
      result.maxDuration = parseDuration(rangeMatch[2]);
      q = q.replace(rangeMatch[0], '').trim();
    }
  }

  // Single exact duration "3:16" (if no range found)
  if (!result.minDuration) {
    const exactMatch = q.match(/\b(\d{1,2}:\d{2})\b/);
    if (exactMatch) {
      result.exactDuration = parseDuration(exactMatch[1]);
      q = q.replace(exactMatch[0], '').trim();
    }
  }

  // Remaining text = keywords
  const keywords = q.replace(/\s+/g, ' ').trim();
  if (keywords) result.keywords = keywords;

  return result;
}
