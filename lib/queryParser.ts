export interface ParsedQuery {
  keywords?: string;
  exactDuration?: number;  // ms — the floor of the typed time (e.g. "3:15" → 195000)
  minDuration?: number;    // ms — explicit range min
  maxDuration?: number;    // ms — explicit range max
  raw: string;
  isEmpty: boolean;
}

// "3:15" typed → 195000ms
function parseDuration(str: string): number {
  const parts = str.split(':').map(Number);
  if (parts.length === 2) {
    const [min, sec] = parts;
    if (!isNaN(min) && !isNaN(sec)) return (min * 60 + sec) * 1000;
  }
  return 0;
}

export function formatDuration(ms: number, showMs = false): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const base = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  if (!showMs) return base;
  const millis = ms % 1000;
  return `${base}.${millis.toString().padStart(3, '0')}`;
}

// Given an exactDuration, return the ms range that displays as that time.
// "3:15" = 195000ms–195999ms — everything that renders as "3:15".
export function exactDurationRange(ms: number, looseSecs = 0): [number, number] {
  return [ms - looseSecs * 1000, ms + 999 + looseSecs * 1000];
}

export function parseQuery(input: string): ParsedQuery {
  let q = input.trim();
  const result: ParsedQuery = { raw: input, isEmpty: !q };
  if (!q) return result;

  // "between X and Y"
  const betweenMatch = q.match(/between\s+(\d{1,2}:\d{2})\s+and\s+(\d{1,2}:\d{2})/i);
  if (betweenMatch) {
    result.minDuration = parseDuration(betweenMatch[1]);
    result.maxDuration = parseDuration(betweenMatch[2]) + 999;
    q = q.replace(betweenMatch[0], '').trim();
  }

  // "X to Y" or "X-Y" range (if no between match)
  if (!result.minDuration) {
    const rangeMatch = q.match(/(\d{1,2}:\d{2})\s*(?:to|-)\s*(\d{1,2}:\d{2})/i);
    if (rangeMatch) {
      result.minDuration = parseDuration(rangeMatch[1]);
      result.maxDuration = parseDuration(rangeMatch[2]) + 999;
      q = q.replace(rangeMatch[0], '').trim();
    }
  }

  // Single exact duration "3:15"
  if (!result.minDuration) {
    const exactMatch = q.match(/\b(\d{1,2}:\d{2})\b/);
    if (exactMatch) {
      result.exactDuration = parseDuration(exactMatch[1]);
      q = q.replace(exactMatch[0], '').trim();
    }
  }

  const keywords = q.replace(/\s+/g, ' ').trim();
  if (keywords) result.keywords = keywords;

  return result;
}
