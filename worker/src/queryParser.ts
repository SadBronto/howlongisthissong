// Shared with lib/queryParser.ts — keep in sync

export interface ParsedQuery {
  keywords?: string;
  exactDuration?: number;         // ms — floor of the typed time
  exactDurationWindowMs?: number; // 1000 for M:SS | 100 for M:SS.M | 10 | 1
  minDuration?: number;           // ms — range / open-ended lower bound
  maxDuration?: number;           // ms — range / open-ended upper bound
  raw: string;
  isEmpty: boolean;
}

// Duration token: M:SS or M:SS.mmm (1–3 ms digits)
const DUR = String.raw`\d{1,2}:\d{2}(?:\.\d{1,3})?`;

function parseDurationMs(str: string): number {
  const m = str.match(/^(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!m) return 0;
  const base = (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000;
  return base + (m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0);
}

function windowMsFor(str: string): number {
  const m = str.match(/\.(\d{1,3})$/);
  if (!m) return 1000;
  return Math.pow(10, 3 - m[1].length);
}

export function exactDurationRange(
  ms:        number,
  windowMs = 1000,
  looseSecs = 0,
): [number, number] {
  return [ms - looseSecs * 1000, ms + windowMs - 1 + looseSecs * 1000];
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function parseQuery(input: string): ParsedQuery {
  let q = input.trim();
  const result: ParsedQuery = { raw: input, isEmpty: !q };
  if (!q) return result;

  const betweenRe = new RegExp(`between\\s+(${DUR})\\s+and\\s+(${DUR})`, 'i');
  const bm = q.match(betweenRe);
  if (bm) {
    result.minDuration = parseDurationMs(bm[1]);
    result.maxDuration = parseDurationMs(bm[2]) + windowMsFor(bm[2]) - 1;
    q = q.replace(bm[0], '').trim();
  }

  if (result.minDuration == null) {
    const rangeRe = new RegExp(`(${DUR})\\s*(?:to|-)\\s*(${DUR})`, 'i');
    const rm = q.match(rangeRe);
    if (rm) {
      result.minDuration = parseDurationMs(rm[1]);
      result.maxDuration = parseDurationMs(rm[2]) + windowMsFor(rm[2]) - 1;
      q = q.replace(rm[0], '').trim();
    }
  }

  if (result.minDuration == null && result.maxDuration == null) {
    const overRe  = new RegExp(`>\\s*(${DUR})`);
    const underRe = new RegExp(`<\\s*(${DUR})`);
    const om = q.match(overRe);
    const um = q.match(underRe);
    if (om) {
      result.minDuration = parseDurationMs(om[1]);
      q = q.replace(om[0], '').trim();
    }
    if (um) {
      result.maxDuration = parseDurationMs(um[1]) - 1;
      q = q.replace(um[0], '').trim();
    }
  }

  if (result.minDuration == null && result.maxDuration == null) {
    const exactRe = new RegExp(`\\b(${DUR})\\b`);
    const em = q.match(exactRe);
    if (em) {
      result.exactDuration         = parseDurationMs(em[1]);
      result.exactDurationWindowMs = windowMsFor(em[1]);
      q = q.replace(em[0], '').trim();
    }
  }

  const keywords = q.replace(/\s+/g, ' ').trim();
  if (keywords) result.keywords = keywords;

  return result;
}

export function sanitizeForFts(input: string): string {
  return input
    .replace(/["""*()\[\]^~]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => `"${w.replace(/"/g, '')}"`)
    .join(' ');
}
