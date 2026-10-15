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
          <p className="text-xs font-semibold uppercase tracking-wider text-blue-600">The halftime archive</p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 mt-2">
            Super Bowl halftime songs
          </h1>
          <p className="text-gray-600 mt-3 leading-relaxed">
            A year-by-year list of songs performed during the Super Bowl halftime show,
            from 1967 through 2026. Search the archive by song or performer, then jump
            straight to HowLongIsThisSong&rsquo;s track search.
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

        <div className="mt-8 border-t border-gray-200">
          {years.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-500">No halftime songs match that search.</p>
          ) : years.map(([year, songs]) => (
            <section key={year} className="border-b border-gray-100 py-6">
              <div className="flex items-baseline justify-between gap-3 mb-3">
                <h2 className="text-xl font-semibold text-gray-900">{year}</h2>
                <span className="text-xs text-gray-400">Super Bowl {songs[0].bowl} · {songs.length} songs</span>
              </div>
              <div className="divide-y divide-gray-100">
                {songs.map((song, index) => {
                  const undocumented = song.song === 'NOT DOCUMENTED';
                  return (
                    <div key={`${song.year}-${song.song}-${song.performer}-${index}`} className="py-3 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-1 sm:gap-4 sm:items-center">
                      <div className="font-medium text-gray-900">
                        {undocumented ? (
                          <span className="text-gray-400 italic">Song not documented</span>
                        ) : (
                          <Link href={`/?q=${encodeURIComponent(song.song)}`} className="hover:text-blue-600 hover:underline">
                            {song.song}
                          </Link>
                        )}
                      </div>
                      <div className="text-sm text-gray-600">{song.performer}</div>
                      {!undocumented && (
                        <Link href={`/?q=${encodeURIComponent(song.song)}`} className="text-xs text-blue-600 hover:underline sm:text-right">
                          Search song &rarr;
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
          ensemble segments do not have a documented song list.
          <span className="mx-2">·</span>
          <Link href="/" className="text-blue-600 hover:underline">Search the full song database</Link>
        </div>
      </div>
    </main>
  );
}
