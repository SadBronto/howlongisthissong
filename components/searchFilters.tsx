'use client';

// Advanced-filter state type, URL <-> filter helpers, and the removable filter chip.
// Extracted from SearchPage to keep the component focused on rendering/logic.

export interface Filters {
  titleContains:  string;
  artistContains: string;
  genre:          string;
  yearFrom:       string;
  yearTo:         string;
  releaseType:    string;
  label:          string;
  artistType:     string;
  artistGender:   string;
  artistCountry:  string;
  language:       string;
  bpmMin:         string;
  bpmMax:         string;
  titleLenMin:    string;
  titleLenMax:    string;
  artistLenMin:   string;
  artistLenMax:   string;
}

export const EMPTY_FILTERS: Filters = {
  titleContains: '', artistContains: '',
  genre: '', yearFrom: '', yearTo: '', releaseType: '', label: '',
  artistType: '', artistGender: '', artistCountry: '', language: '',
  bpmMin: '', bpmMax: '',
  titleLenMin: '', titleLenMax: '', artistLenMin: '', artistLenMax: '',
};

export function filtersFromParams(sp: URLSearchParams): Filters {
  return {
    titleContains:  sp.get('title')          ?? '',
    artistContains: sp.get('artist')         ?? '',
    genre:          sp.get('genre')          ?? '',
    yearFrom:       sp.get('year_from')      ?? '',
    yearTo:         sp.get('year_to')        ?? '',
    releaseType:    sp.get('release_type')   ?? '',
    label:          sp.get('label')          ?? '',
    artistType:     sp.get('artist_type')    ?? '',
    artistGender:   sp.get('artist_gender')  ?? '',
    artistCountry:  sp.get('artist_country') ?? '',
    language:       sp.get('language')       ?? '',
    bpmMin:         sp.get('bpm_min')        ?? '',
    bpmMax:         sp.get('bpm_max')        ?? '',
    titleLenMin:    sp.get('title_len_min')  ?? '',
    titleLenMax:    sp.get('title_len_max')  ?? '',
    artistLenMin:   sp.get('artist_len_min') ?? '',
    artistLenMax:   sp.get('artist_len_max') ?? '',
  };
}

export function buildUrl(q: string, f: Filters, pg: number, pp: number, s: string, am = false): string {
  const p = new URLSearchParams();
  if (q)                p.set('q',             q);
  if (am)               p.set('mode',          'artists');
  if (f.titleContains)  p.set('title',          f.titleContains);
  if (f.artistContains) p.set('artist',         f.artistContains);
  if (f.genre)          p.set('genre',          f.genre);
  if (f.yearFrom)       p.set('year_from',      f.yearFrom);
  if (f.yearTo)         p.set('year_to',        f.yearTo);
  if (f.releaseType)    p.set('release_type',   f.releaseType);
  if (f.label)          p.set('label',          f.label);
  if (f.artistType)     p.set('artist_type',    f.artistType);
  if (f.artistGender)   p.set('artist_gender',  f.artistGender);
  if (f.artistCountry)  p.set('artist_country', f.artistCountry);
  if (f.language)       p.set('language',       f.language);
  if (f.bpmMin)         p.set('bpm_min',        f.bpmMin);
  if (f.bpmMax)         p.set('bpm_max',        f.bpmMax);
  if (f.titleLenMin)    p.set('title_len_min',  f.titleLenMin);
  if (f.titleLenMax)    p.set('title_len_max',  f.titleLenMax);
  if (f.artistLenMin)   p.set('artist_len_min', f.artistLenMin);
  if (f.artistLenMax)   p.set('artist_len_max', f.artistLenMax);
  if (pg > 1)           p.set('page',           String(pg));
  if (pp !== 50)        p.set('per_page',       String(pp));
  if (s !== 'relevance') p.set('sort',          s);
  const qs = p.toString();
  return qs ? `/?${qs}` : '/';
}

export function activeCount(f: Filters): number {
  return [
    f.titleContains, f.artistContains, f.genre,
    f.yearFrom || f.yearTo,   // range counts as one filter
    f.releaseType, f.label, f.artistType, f.artistGender, f.artistCountry, f.language,
    f.bpmMin || f.bpmMax,           // range counts as one filter
    f.titleLenMin || f.titleLenMax, // range counts as one filter
    f.artistLenMin || f.artistLenMax,
  ].filter(Boolean).length;
}

/** Short labels for the collapsed advanced-search summary line. */
export function summaryFromFilters(f: Filters, exact: string, from: string, to: string): string[] {
  const s: string[] = [];
  if (f.titleContains)  s.push('Title');
  if (f.artistContains) s.push('Artist');
  if (exact.trim() || from.trim() || to.trim()) s.push('Duration');
  if (f.genre)          s.push('Genre');
  if (f.yearFrom || f.yearTo) s.push('Year');
  if (f.releaseType)    s.push('Type');
  if (f.label)          s.push('Label');
  if (f.artistType)     s.push('Artist type');
  if (f.artistGender)   s.push('Gender');
  if (f.artistCountry)  s.push('Country');
  if (f.language)       s.push('Language');
  if (f.bpmMin || f.bpmMax) s.push('BPM');
  if (f.titleLenMin || f.titleLenMax) s.push('Title length');
  if (f.artistLenMin || f.artistLenMax) s.push('Artist length');
  return s;
}

/** A removable active-filter chip. */
export function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 pl-2 pr-1 py-0.5 rounded-full">
      {label}
      <button
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
        title="Remove this filter"
        className="flex items-center justify-center w-4 h-4 rounded-full text-blue-400 hover:text-white hover:bg-red-500 transition-colors leading-none"
      >
        <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </span>
  );
}

/** "2" → "2:00", "10" → "10:00"; leaves "3:16", "3:16.423", "" unchanged. */
export function normalizeDuration(s: string): string {
  const t = s.trim();
  if (/^\d{1,2}$/.test(t)) return `${t}:00`;
  return t;
}
