import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Search guide · HowLongIsThisSong.com',
  description:
    'How to search HowLongIsThisSong.com: exact times, ranges, open-ended durations, ' +
    'wildcards, whole-word matching, and every advanced filter (genre, BPM, year, length, and more).',
  alternates: { canonical: '/help' },
};

function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[0.9em] bg-gray-100 text-gray-800 px-1.5 py-0.5 rounded">{children}</code>;
}

function Row({ ex, desc }: { ex: string; desc: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3 py-1.5 border-b border-gray-100 last:border-0">
      <div className="sm:w-52 flex-shrink-0"><Code>{ex}</Code></div>
      <div className="text-sm text-gray-600">{desc}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-gray-900 mb-3">{title}</h2>
      {children}
    </section>
  );
}

export default function HelpPage() {
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-2xl mx-auto px-4 py-10">
        {/* Header */}
        <Link href="/" className="text-sm text-blue-600 hover:underline">&larr; Back to search</Link>
        <h1 className="text-3xl font-bold text-gray-900 mt-4">Search guide</h1>
        <p className="text-gray-500 mt-2">
          Everything you can do with HowLongIsThisSong.com&rsquo;s search, from a plain song
          title to a five-filter deep dive.
        </p>

        <Section title="The basics">
          <p className="text-sm text-gray-600 mb-3">
            Type a song title, an artist, or both. The search reads the title, artist, and album.
          </p>
          <Row ex="bohemian rhapsody" desc="Find a song by its title." />
          <Row ex="pink floyd" desc="Find songs by an artist." />
          <Row ex="hey jude beatles" desc="Title and artist together." />
        </Section>

        <Section title="Searching by length">
          <p className="text-sm text-gray-600 mb-3">
            This is the site&rsquo;s specialty. Times use <Code>minutes:seconds</Code>, and you can add
            milliseconds.
          </p>
          <Row ex="3:16" desc="Exact duration (with a small tolerance you can widen with the slider)." />
          <Row ex="3:16.423" desc="Millisecond precision." />
          <Row ex="3:00 to 4:00" desc="A range. Also written “between 3:00 and 4:00”." />
          <Row ex="&gt;10:00" desc="Longer than 10 minutes." />
          <Row ex="&lt;3:00" desc="Shorter than 3 minutes." />
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">
            Note: open-ended searches need the full time with a colon. <Code>&gt;10:00</Code> means
            &ldquo;longer than 10 minutes&rdquo;; <Code>&gt;10</Code> on its own is read as the text
            &ldquo;10&rdquo;, not a duration.
          </p>
        </Section>

        <Section title="Combining words and time">
          <p className="text-sm text-gray-600 mb-3">Mix a keyword with a duration in one search.</p>
          <Row ex="love 4:20" desc="Songs with “love” in the name that are 4:20 long." />
          <Row ex="symphony &gt;30:00" desc="Long pieces with “symphony” in the name." />
        </Section>

        <Section title="Wildcards &amp; whole words">
          <p className="text-sm text-gray-600 mb-3">
            By default a plain word matches the <strong>whole word</strong> (so <Code>cup</Code> finds
            &ldquo;Cup&rdquo; and &ldquo;Cups&rdquo;, not &ldquo;Cupid&rdquo;). Add <Code>*</Code> to
            match parts of words:
          </p>
          <Row ex="con*" desc="Starts with “con” (Conan, Connect, Console…)." />
          <Row ex="*tion" desc="Ends with “tion” (Nation, Action…)." />
          <Row ex="*love*" desc="Contains “love” anywhere, even inside a word (Glove, Lover…)." />
          <p className="text-xs text-gray-500 mt-3">
            The whole-word and &ldquo;starts-with&rdquo; searches are instant. The ones that start with
            <Code>*</Code> (&ldquo;ends with&rdquo; / &ldquo;contains&rdquo;) have to read the whole
            library, so they can take a while, and the site will tell you it&rsquo;s still working.
          </p>
        </Section>

        <Section title="Advanced search">
          <p className="text-sm text-gray-600 mb-3">
            Open <strong>Advanced search</strong> under the search box to combine any of these. They all
            stack together.
          </p>
          <Row ex="Title / Artist" desc="Match the song title or the artist (wildcards work here too)." />
          <Row ex="Genre" desc="rock, jazz, hip-hop, and so on." />
          <Row ex="Year / Decade" desc="A year range, or tap a decade chip (80s, 90s…)." />
          <Row ex="BPM" desc="Tempo range. (Algorithmically detected, treat as approximate.)" />
          <Row ex="Title / Artist length" desc="Number of characters, e.g. songs under 10 letters." />
          <Row ex="Label · Country · Language" desc="Record label, artist country, ISO language code." />
          <Row ex="Release type" desc="Album, Single, EP, Broadcast, Other." />
        </Section>

        <Section title="Artists only">
          <p className="text-sm text-gray-600">
            Tick <strong>Artists only</strong> to get a list of artist names instead of songs,
            handy for &ldquo;which bands have a one-word name&rdquo; type questions. Sort by popularity
            or alphabetically.
          </p>
        </Section>

        <Section title="Where the data comes from">
          <p className="text-sm text-gray-600">
            Song and artist data come from{' '}
            <a href="https://musicbrainz.org" className="text-blue-600 hover:underline">MusicBrainz</a>;
            audio details (BPM, key, loudness) from{' '}
            <a href="https://acousticbrainz.org" className="text-blue-600 hover:underline">AcousticBrainz</a>;
            and popularity from{' '}
            <a href="https://www.last.fm" className="text-blue-600 hover:underline">Last.fm</a> and{' '}
            <a href="https://listenbrainz.org" className="text-blue-600 hover:underline">ListenBrainz</a>.
            Popularity, genre, and audio data are still filling in, so the most-searched songs get
            enriched first, and the index improves every day.
          </p>
        </Section>

        <Section title="Why is a search slow sometimes?">
          <p className="text-sm text-gray-600">
            We don&rsquo;t run the heavy search hardware the big sites do. Most searches are instant, but
            ones that have to scan the whole library (a wildcard that starts with <Code>*</Code>,
            or filters with no keyword) genuinely take time. They still return real results;
            adding a plain word from the title or artist makes them fast again.
          </p>
        </Section>

        <div className="mt-12 pt-6 border-t border-gray-100">
          <Link href="/" className="text-sm font-medium text-blue-600 hover:underline">
            &larr; Start searching
          </Link>
        </div>
      </div>
    </div>
  );
}
