'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { SUPER_BOWL_HALFTIME_SONGS } from '@/lib/superBowlHalftime';

export default function SuperBowlHalftimePage() {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!normalizedQuery) return SUPER_BOWL_HALFTIME_SONGS;
    return SUPER_BOWL_HALFTIME_SONGS.filter(row =>
      `${row.performer} ${row.song}`.toLowerCase().includes(normalizedQuery),
    );
  }, [normalizedQuery]);

  const years = useMemo(() => {
    const groups = new Map<number, typeof filtered>();
    for (const row of filtered) {
      const group = groups.get(row.year) ?? [];
      group.push(row);
      groups.set(row.year, group);
    }
    return [...groups.entries()].sort((a, b) => b[0] - a[0]);
  }, [filtered]);

  return (
    <main className="min-h-screen bg-white">
      <div className="max-w-4xl mx-auto px-4 py-8 sm:py-12">
        <Link href="/" className="text-sm text-blue-600 hover:underline">
          &larr; Back to search
        </Link>

        <div className="mt-5 max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-wider text-blue-600">Curated search</p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 mt-2">
            Super Bowl halftime songs
          </h1>
          <p className="text-gray-600 mt-3 leading-relaxed">
            Search 418 curated song entries from Super Bowl halftime shows, 1967&ndash;2026.
            Each result keeps the useful context: who performed it, and when.
          </p>
        </div>

        <div className="mt-7 flex flex-col sm:flex-row gap-3 sm:items-center">
          <label className="sr-only" htmlFor="halftime-search">Search songs or performers</label>
          <input
            id="halftime-search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search songs or performers"
            className="flex-1 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-900 placeholder-gray-400 bg-white focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
          <div className="text-sm text-gray-500 sm:w-36 sm:text-right">
            {filtered.length.toLocaleString()} {filtered.length === 1 ? 'song' : 'songs'}
          </div>
        </div>

        <div className="mt-6 border-t border-gray-200">
          {years.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-500">No halftime songs match that search.</p>
          ) : years.map(([year, songs]) => (
            <section key={year} className="border-b border-gray-100 py-6">
              <div className="flex items-baseline justify-between gap-3 mb-1 px-3">
                <h2 className="text-lg font-semibold text-gray-900">{year}</h2>
                <span className="text-xs text-gray-400">Super Bowl {songs[0].bowl} &middot; {songs.length} songs</span>
              </div>
              <div>
                {songs.map((song, index) => {
                  const undocumented = song.song === 'NOT DOCUMENTED';
                  return (
                    <div key={`${song.year}-${song.song}-${song.performer}-${index}`} className="group flex items-center gap-3 sm:gap-4 py-3 px-3 rounded-lg hover:bg-gray-50 transition-colors">
                      <div className="w-20 sm:w-24 flex-shrink-0 text-right font-mono text-xs sm:text-sm text-gray-400 tabular-nums">
                        {song.bowl}
                      </div>
                      <div className="w-px h-10 bg-gray-200 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-900 leading-snug">
                        {undocumented ? (
                          <span className="text-gray-400 italic">Song not documented</span>
                        ) : (
                          <Link href={`/?q=${encodeURIComponent(song.song)}`} className="hover:text-blue-600">
                            {song.song}
                          </Link>
                        )}
                        </div>
                        <div className="text-sm text-gray-600 mt-0.5 truncate">{song.performer}</div>
                      </div>
                      {!undocumented && (
                        <Link href={`/?q=${encodeURIComponent(song.song)}`} aria-label={`Search for ${song.song}`} title="Search this song" className="flex-shrink-0 text-gray-300 group-hover:text-blue-500 text-lg leading-none">
                          &rarr;
                        </Link>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-8 pt-5 border-t border-gray-100 text-sm text-gray-500 leading-relaxed">
          The archive is a curated list of halftime performances. Some early shows and
          ensemble segments do not have a documented song list. Shortened songs, snippets,
          medleys, and instrumental or taped material are labeled where the source list identifies them.
          <span className="mx-2">·</span>
          <Link href="/" className="text-blue-600 hover:underline">Search the full song database</Link>
        </div>

        <div className="mt-5 text-xs text-gray-400 leading-relaxed">
          Cross-checked against the{' '}
          <a href="https://www.nfl.info/nflmedia/Postseason/2005%20Postseason/Postseason%20Media/SuperBowl.pdf" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-600">NFL&rsquo;s historical record</a>,{' '}
          <a href="https://en.wikipedia.org/wiki/List_of_Super_Bowl_halftime_shows" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-600">the compiled show list</a>, and independent performance/setlist coverage from{' '}
          <a href="https://time.com/6693288/usher-super-bowl-halftime-show-2024-highlights/" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-600">TIME</a>,{' '}
          <a href="https://apnews.com/article/2b52ec750c4822efa4c6b2dedd5fc7d7" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-600">AP</a>,{' '}
          <a href="https://www.cbssports.com/nfl/news/super-bowl-2026-halftime-show-bad-bunny-setlist-guests-best-moments/" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-600">CBS Sports</a>, and{' '}
          <a href="https://www.setlist.fm/setlist/bad-bunny/2026/levis-stadium-santa-clara-ca-73412ec9.html" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-600">Setlist.fm</a>.
        </div>
      </div>
    </main>
  );
}
