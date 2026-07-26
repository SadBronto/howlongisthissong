import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Legal · HowLongIsThisSong.com',
  description: 'Copyright, trademarks, and attribution for HowLongIsThisSong.com.',
  alternates: { canonical: '/legal' },
};

const UPDATED = 'July 25, 2026';

export default function LegalPage() {
  return (
    <main className="min-h-screen bg-white text-gray-700">
      <div className="max-w-2xl mx-auto px-5 py-12">
        <a href="/" className="text-sm text-blue-600 hover:underline">&larr; Back to search</a>

        <h1 className="mt-6 text-2xl font-bold text-gray-900">Legal</h1>
        <p className="mt-1 text-sm text-gray-400">Last updated {UPDATED}</p>

        <p className="mt-6 text-sm leading-relaxed">
          This page covers copyright, trademarks, and attribution for HowLongIsThisSong.com. See
          also our{' '}
          <a href="/privacy" className="text-blue-600 hover:underline">Privacy Policy</a> and{' '}
          <a href="/terms" className="text-blue-600 hover:underline">Terms of Use</a>.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Data sources</h2>
        <ul className="mt-3 space-y-3 text-sm leading-relaxed list-disc pl-5">
          <li>
            Track and release metadata is provided by{' '}
            <a href="https://musicbrainz.org" target="_blank" rel="noopener noreferrer"
              className="text-blue-600 hover:underline">MusicBrainz</a>{' '}
            and{' '}
            <a href="https://acousticbrainz.org" target="_blank" rel="noopener noreferrer"
              className="text-blue-600 hover:underline">AcousticBrainz</a>, used under their
            respective licenses.
          </li>
          <li>
            Popularity data is derived from{' '}
            <a href="https://www.last.fm" target="_blank" rel="noopener noreferrer"
              className="text-blue-600 hover:underline">Last.fm</a>{' '}
            and{' '}
            <a href="https://listenbrainz.org" target="_blank" rel="noopener noreferrer"
              className="text-blue-600 hover:underline">ListenBrainz</a>.
          </li>
        </ul>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Copyright</h2>
        <p className="mt-3 text-sm leading-relaxed">
          &copy; 2026 HowLongIsThisSong.com. The original design, layout, code, and written copy
          of the Site are protected by copyright and other applicable laws. You may not copy,
          reproduce, or use them to create a competing or confusingly similar service without
          permission. Song and release metadata is owned by its respective sources and is used
          under their licenses.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Trademarks</h2>
        <p className="mt-3 text-sm leading-relaxed">
          Artist names, song and album titles, record labels, service names, and other third-party
          names, logos, and trademarks referenced on the Site belong to their respective owners.
          Their appearance here is for identification and reference only and does not imply any
          affiliation with, or endorsement by, those owners.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Contact</h2>
        <p className="mt-3 text-sm leading-relaxed">
          For copyright, trademark, or other legal questions, email{' '}
          <a href="mailto:legal@howlongisthissong.com" className="text-blue-600 hover:underline">
            legal@howlongisthissong.com</a>.
        </p>

        <nav className="mt-12 pt-6 border-t border-gray-100 text-sm text-gray-400">
          <a href="/privacy" className="text-blue-600 hover:underline">Privacy</a>
          <span className="mx-2">·</span>
          <a href="/terms" className="text-blue-600 hover:underline">Terms</a>
          <span className="mx-2">·</span>
          <a href="/legal" className="text-blue-600 hover:underline">Legal</a>
          <span className="mx-2">·</span>
          <a href="/" className="text-blue-600 hover:underline">Back to search</a>
        </nav>
      </div>
    </main>
  );
}
