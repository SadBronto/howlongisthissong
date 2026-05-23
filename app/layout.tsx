import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'HowLongIsThisSong.com',
  description:
    "The internet's best searchable song-duration database. Find songs by exact runtime, duration range, title, or artist.",
  keywords: ['song length', 'song duration', 'how long is this song', 'music runtime', 'song time database'],
  openGraph: {
    title: 'HowLongIsThisSong.com',
    description: 'Search songs by duration. Find any song by runtime.',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
