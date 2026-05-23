/**
 * Seed ~70 well-known sample tracks for development and testing.
 *
 * Usage: npm run seed
 *
 * Requires .env.local with:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env.local') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

// Helper: duration in ms from (minutes, seconds)
const ms = (m: number, s: number) => m * 60_000 + s * 1000;

interface SeedTrack {
  title: string;
  artist?: string;
  album?: string;
  version?: string;
  release_year?: number;
  duration_ms: number;
  source: string;
}

const TRACKS: SeedTrack[] = [
  // ── Ultra-short ──────────────────────────────────────────
  { title: 'Her Majesty',     artist: 'The Beatles',    album: 'Abbey Road',                release_year: 1969, duration_ms: ms(0, 23),  source: 'sample' },
  { title: 'Blitzkrieg Bop', artist: 'Ramones',         album: 'Ramones',                   release_year: 1976, duration_ms: ms(2, 14),  source: 'sample' },

  // ── 2:00 – 3:00 ──────────────────────────────────────────
  { title: 'Hound Dog',       artist: 'Elvis Presley',  album: 'Elvis Presley',             release_year: 1956, duration_ms: ms(2, 14),  source: 'sample' },
  { title: 'Johnny B. Goode', artist: 'Chuck Berry',    album: 'Chuck Berry Is on Top',     release_year: 1958, duration_ms: ms(2, 42),  source: 'sample' },
  { title: 'Be My Baby',      artist: 'The Ronettes',   album: 'Presenting the Fabulous Ronettes', release_year: 1963, duration_ms: ms(2, 37), source: 'sample' },
  { title: 'Respect',         artist: 'Aretha Franklin',album: "I Never Loved a Man the Way I Love You", release_year: 1967, duration_ms: ms(2, 28), source: 'sample' },
  { title: 'HUMBLE.',         artist: 'Kendrick Lamar', album: 'DAMN.',                     release_year: 2017, duration_ms: ms(2, 57),  source: 'sample' },
  { title: 'As It Was',       artist: 'Harry Styles',   album: "Harry's House",             release_year: 2022, duration_ms: ms(2, 47),  source: 'sample' },
  { title: 'We Will Rock You',artist: 'Queen',          album: 'News of the World',         release_year: 1977, duration_ms: ms(2, 2),   source: 'sample' },
  { title: 'Jolene',          artist: 'Dolly Parton',   album: 'Jolene',                    release_year: 1973, duration_ms: ms(2, 42),  source: 'sample' },
  { title: "I Will Always Love You", artist: 'Dolly Parton', album: 'Jolene',              release_year: 1973, duration_ms: ms(2, 42),  source: 'sample' },

  // ── 3:00 – 4:00 ──────────────────────────────────────────
  { title: 'Mr. Brightside',  artist: 'The Killers',    album: 'Hot Fuss',                  release_year: 2003, duration_ms: ms(3, 42),  source: 'sample' },
  { title: 'Take On Me',      artist: 'a-ha',           album: 'Hunting High and Low',      release_year: 1985, duration_ms: ms(3, 46),  source: 'sample' },
  { title: 'Good Vibrations', artist: 'The Beach Boys', album: 'Smiley Smile',              release_year: 1966, duration_ms: ms(3, 35),  source: 'sample' },
  { title: "What's Going On", artist: 'Marvin Gaye',    album: "What's Going On",           release_year: 1971, duration_ms: ms(3, 53),  source: 'sample' },
  { title: 'Shape of You',    artist: 'Ed Sheeran',     album: '÷',                         release_year: 2017, duration_ms: ms(3, 53),  source: 'sample' },
  { title: 'Rolling in the Deep', artist: 'Adele',      album: '21',                        release_year: 2010, duration_ms: ms(3, 48),  source: 'sample' },
  { title: 'Blinding Lights', artist: 'The Weeknd',     album: 'After Hours',               release_year: 2019, duration_ms: ms(3, 20),  source: 'sample' },
  { title: 'Flowers',         artist: 'Miley Cyrus',    album: 'Endless Summer Vacation',   release_year: 2023, duration_ms: ms(3, 20),  source: 'sample' },
  { title: "God's Plan",      artist: 'Drake',          album: 'Scorpion',                  release_year: 2018, duration_ms: ms(3, 19),  source: 'sample' },
  { title: 'We Are the Champions', artist: 'Queen',     album: 'News of the World',         release_year: 1977, duration_ms: ms(3, 0),   source: 'sample' },
  { title: 'Achy Breaky Heart', artist: 'Billy Ray Cyrus', album: 'Some Gave All',          release_year: 1992, duration_ms: ms(3, 24),  source: 'sample' },
  { title: 'We Found Love',   artist: 'Rihanna ft. Calvin Harris', album: 'Talk That Talk', release_year: 2011, duration_ms: ms(3, 35),  source: 'sample' },
  { title: 'Long Away',       artist: 'Queen',          album: 'A Day at the Races',        release_year: 1976, duration_ms: ms(3, 33),  source: 'sample' },
  { title: 'Drivers License', artist: 'Olivia Rodrigo', album: 'SOUR',                      release_year: 2021, duration_ms: ms(4, 2),   source: 'sample' },

  // ── 4:00 – 5:00 ──────────────────────────────────────────
  { title: "Don't Stop Believin'", artist: 'Journey',   album: 'Escape',                    release_year: 1981, duration_ms: ms(4, 9),   source: 'sample' },
  { title: 'Eye of the Tiger', artist: 'Survivor',      album: 'Eye of the Tiger',          release_year: 1982, duration_ms: ms(4, 4),   source: 'sample' },
  { title: "Livin' on a Prayer", artist: 'Bon Jovi',    album: 'Slippery When Wet',         release_year: 1986, duration_ms: ms(4, 9),   source: 'sample' },
  { title: 'Wonderwall',      artist: 'Oasis',          album: "(What's the Story) Morning Glory?", release_year: 1995, duration_ms: ms(4, 18), source: 'sample' },
  { title: 'Beat It',         artist: 'Michael Jackson',album: 'Thriller',                  release_year: 1983, duration_ms: ms(4, 18),  source: 'sample' },
  { title: 'Pour Some Sugar on Me', artist: 'Def Leppard', album: 'Hysteria',               release_year: 1987, duration_ms: ms(4, 26),  source: 'sample' },
  { title: 'Born to Run',     artist: 'Bruce Springsteen', album: 'Born to Run',            release_year: 1975, duration_ms: ms(4, 30),  source: 'sample' },
  { title: 'Uptown Funk',     artist: 'Mark Ronson ft. Bruno Mars', album: 'Uptown Special',release_year: 2014, duration_ms: ms(4, 30),  source: 'sample' },
  { title: 'Billie Jean',     artist: 'Michael Jackson',album: 'Thriller',                  release_year: 1983, duration_ms: ms(4, 54),  source: 'sample' },
  { title: 'Africa',          artist: 'Toto',           album: 'Toto IV',                   release_year: 1982, duration_ms: ms(4, 55),  source: 'sample' },
  { title: 'Thinking Out Loud', artist: 'Ed Sheeran',   album: 'X',                         release_year: 2014, duration_ms: ms(4, 41),  source: 'sample' },
  { title: "I Will Always Love You", artist: 'Whitney Houston', album: 'The Bodyguard',     release_year: 1992, duration_ms: ms(4, 31),  source: 'sample' },
  { title: 'Starboy',         artist: 'The Weeknd ft. Daft Punk', album: 'Starboy',         release_year: 2016, duration_ms: ms(3, 50),  source: 'sample' },

  // ── Friends in Low Places — multiple versions ─────────────
  { title: 'Friends in Low Places', artist: 'Garth Brooks', album: 'No Fences',            release_year: 1990, duration_ms: ms(3, 41),  source: 'sample' },
  { title: 'Friends in Low Places', artist: 'Garth Brooks', album: 'No Fences', version: 'Live from Red Rocks', release_year: 1990, duration_ms: ms(4, 13), source: 'sample' },
  { title: 'Friends in Low Places', artist: 'Garth Brooks', album: 'No Fences', version: 'Uncensored (3rd Verse)', release_year: 1990, duration_ms: ms(4, 51), source: 'sample' },

  // ── Bohemian Rhapsody — multiple versions ─────────────────
  { title: 'Bohemian Rhapsody', artist: 'Queen',        album: 'A Night at the Opera',      release_year: 1975, duration_ms: ms(5, 55),  source: 'sample' },
  { title: 'Bohemian Rhapsody', artist: 'Queen',        album: 'Absolute Greatest', version: 'Radio Edit', release_year: 2009, duration_ms: ms(4, 55), source: 'sample' },
  { title: 'Bohemian Rhapsody', artist: 'Queen',        album: 'A Night at the Opera', version: '2011 Remaster', release_year: 1975, duration_ms: ms(5, 54), source: 'sample' },

  // ── 5:00 – 7:00 ──────────────────────────────────────────
  { title: 'Smells Like Teen Spirit', artist: 'Nirvana',album: 'Nevermind',                 release_year: 1991, duration_ms: ms(5, 1),   source: 'sample' },
  { title: 'Sweet Child O\' Mine', artist: "Guns N' Roses", album: 'Appetite for Destruction', release_year: 1988, duration_ms: ms(5, 55), source: 'sample' },
  { title: 'Thriller',        artist: 'Michael Jackson',album: 'Thriller',                  release_year: 1982, duration_ms: ms(5, 57),  source: 'sample' },
  { title: 'Lose Yourself',   artist: 'Eminem',         album: '8 Mile Soundtrack',         release_year: 2002, duration_ms: ms(5, 26),  source: 'sample' },
  { title: 'Take Five',       artist: 'Dave Brubeck Quartet', album: 'Time Out',            release_year: 1959, duration_ms: ms(5, 24),  source: 'sample' },
  { title: 'Clair de Lune',   artist: 'Claude Debussy', album: 'Suite bergamasque',         release_year: 1905, duration_ms: ms(5, 11),  source: 'sample' },
  { title: 'Sweet Home Alabama', artist: 'Lynyrd Skynyrd', album: 'Second Helping',         release_year: 1974, duration_ms: ms(4, 40),  source: 'sample' },
  { title: 'Money',           artist: 'Pink Floyd',     album: 'The Dark Side of the Moon', release_year: 1973, duration_ms: ms(6, 22),  source: 'sample' },
  { title: 'Like a Rolling Stone', artist: 'Bob Dylan', album: 'Highway 61 Revisited',      release_year: 1965, duration_ms: ms(6, 13),  source: 'sample' },
  { title: 'Comfortably Numb', artist: 'Pink Floyd',    album: 'The Wall',                  release_year: 1979, duration_ms: ms(6, 21),  source: 'sample' },
  { title: 'Time',            artist: 'Pink Floyd',     album: 'The Dark Side of the Moon', release_year: 1973, duration_ms: ms(6, 53),  source: 'sample' },
  { title: 'Hotel California',artist: 'Eagles',         album: 'Hotel California',          release_year: 1976, duration_ms: ms(6, 30),  source: 'sample' },
  { title: 'Layla',           artist: 'Derek and the Dominos', album: 'Layla and Other Assorted Love Songs', release_year: 1970, duration_ms: ms(7, 10), source: 'sample' },

  // ── 7:00+ ─────────────────────────────────────────────────
  { title: 'Stairway to Heaven', artist: 'Led Zeppelin',album: 'Led Zeppelin IV',           release_year: 1971, duration_ms: ms(8, 2),   source: 'sample' },
  { title: 'American Pie',    artist: 'Don McLean',     album: 'American Pie',              release_year: 1971, duration_ms: ms(8, 33),  source: 'sample' },
  { title: 'Purple Rain',     artist: 'Prince',         album: 'Purple Rain',               release_year: 1984, duration_ms: ms(8, 41),  source: 'sample' },
  { title: 'November Rain',   artist: "Guns N' Roses",  album: 'Use Your Illusion I',       release_year: 1991, duration_ms: ms(8, 57),  source: 'sample' },
  { title: 'Free Bird',       artist: 'Lynyrd Skynyrd', album: 'Pronounced Leh-Nerd Skin-Nerd', release_year: 1973, duration_ms: ms(9, 8), source: 'sample' },
  { title: 'So What',         artist: 'Miles Davis',    album: 'Kind of Blue',              release_year: 1959, duration_ms: ms(9, 22),  source: 'sample' },
];

async function seed() {
  console.log(`Seeding ${TRACKS.length} sample tracks…`);

  // Clear existing sample data so re-runs don't duplicate
  const { error: deleteError } = await supabase
    .from('tracks')
    .delete()
    .eq('source', 'sample');

  if (deleteError) {
    console.error('Failed to clear existing sample data:', deleteError.message);
    process.exit(1);
  }

  const { error } = await supabase.from('tracks').insert(TRACKS);

  if (error) {
    console.error('Insert error:', error.message);
    process.exit(1);
  }

  console.log(`Done! ${TRACKS.length} tracks seeded.`);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
