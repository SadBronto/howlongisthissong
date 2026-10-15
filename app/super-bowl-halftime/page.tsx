import type { Metadata } from 'next';
import SuperBowlHalftimePage from '@/components/SuperBowlHalftimePage';

export const metadata: Metadata = {
  title: 'Super Bowl halftime songs by year · HowLongIsThisSong.com',
  description:
    'Browse Super Bowl halftime songs by year from 1967 through 2026. Search the archive by performer or song, then find each track on HowLongIsThisSong.com.',
  alternates: { canonical: '/super-bowl-halftime' },
  openGraph: {
    title: 'Super Bowl halftime songs by year',
    description: 'A year-by-year archive of Super Bowl halftime songs and performers.',
    url: 'https://howlongisthissong.com/super-bowl-halftime',
    type: 'website',
  },
};

export default function SuperBowlHalftimeRoute() {
  return <SuperBowlHalftimePage />;
}
