import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

// Origin of the search worker, used to warm up the connection before the first search.
const WORKER_ORIGIN = (() => {
  try {
    return process.env.NEXT_PUBLIC_WORKER_URL
      ? new URL(process.env.NEXT_PUBLIC_WORKER_URL).origin
      : null;
  } catch { return null; }
})();

const DESCRIPTION =
  "The internet's premium song search. Find any song by exact length, duration range, " +
  'BPM, title, artist, year, and more — across millions of tracks.';

export const metadata: Metadata = {
  metadataBase: new URL('https://howlongisthissong.com'),
  title: 'HowLongIsThisSong.com — search songs by length, BPM & more',
  description: DESCRIPTION,
  keywords: [
    'song length', 'song duration', 'how long is this song', 'song runtime',
    'search songs by length', 'search songs by bpm', 'song time database',
  ],
  alternates: { canonical: '/' },
  openGraph: {
    title: 'HowLongIsThisSong.com',
    description: DESCRIPTION,
    url: 'https://howlongisthissong.com',
    siteName: 'HowLongIsThisSong.com',
    type: 'website',
    images: [{ url: '/logo.png', width: 1024, height: 1238, alt: 'HowLongIsThisSong.com logo' }],
  },
  twitter: {
    card: 'summary',
    title: 'HowLongIsThisSong.com',
    description: DESCRIPTION,
    images: ['/logo.png'],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        {WORKER_ORIGIN && <link rel="preconnect" href={WORKER_ORIGIN} crossOrigin="anonymous" />}
        {WORKER_ORIGIN && <link rel="dns-prefetch" href={WORKER_ORIGIN} />}
        {children}
      </body>
    </html>
  );
}
