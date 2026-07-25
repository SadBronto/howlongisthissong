import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Legal — Terms, Privacy & Attribution · HowLongIsThisSong.com',
  description: 'Terms of use, privacy policy, and data/image attributions for HowLongIsThisSong.com.',
  alternates: { canonical: '/legal' },
  robots: { index: true, follow: true },
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
          HowLongIsThisSong.com (&ldquo;the Site&rdquo;) is a free tool for looking up song
          durations and related metadata. By using the Site you agree to the terms below.
        </p>

        {/* ── Terms of Use ─────────────────────────────────────────────── */}
        <h2 className="mt-10 text-lg font-semibold text-gray-900">Terms of Use</h2>
        <ul className="mt-3 space-y-3 text-sm leading-relaxed list-disc pl-5">
          <li>
            The Site is provided free of charge, <strong>&ldquo;as is&rdquo; and
            &ldquo;as available,&rdquo;</strong> for personal and informational use, with no
            warranty of any kind.
          </li>
          <li>
            Song data (durations, BPM, titles, artists, years, and other metadata) is aggregated
            from third-party sources and <strong>may be inaccurate, incomplete, or out of
            date.</strong> Do not rely on it for any purpose where accuracy matters.
          </li>
          <li>
            To the fullest extent permitted by law, the Site and its operator are not liable for
            any damages or losses arising from your use of, or inability to use, the Site.
          </li>
          <li>
            Please use the Site reasonably. Automated scraping, bulk harvesting, or activity that
            places excessive load on the service is not permitted, and requests are rate-limited.
          </li>
          <li>
            The Site may be changed, limited, or discontinued at any time without notice. These
            terms may be updated; continued use means you accept the current version.
          </li>
          <li>
            All third-party names, data, and trademarks belong to their respective owners.
          </li>
        </ul>

        {/* ── Privacy ──────────────────────────────────────────────────── */}
        <h2 className="mt-10 text-lg font-semibold text-gray-900">Privacy</h2>
        <ul className="mt-3 space-y-3 text-sm leading-relaxed list-disc pl-5">
          <li>
            <strong>No accounts, no personal data.</strong> The Site does not ask for or require
            any personal information, and there is nothing to sign up for.
          </li>
          <li>
            When you run a search, your query is sent to our search service to return results.
            Standard, non-identifying request information (such as IP address and timing) may be
            processed transiently by our infrastructure providers for reliability, security, and
            abuse prevention. We do not use this to build a profile of you.
          </li>
          <li>
            We keep only <strong>aggregate, anonymous counts</strong> &mdash; for example, a
            running total of searches performed &mdash; which are not linked to any individual.
          </li>
          <li>
            <strong>No advertising or tracking cookies.</strong> We do not sell or share personal
            data (we do not collect any to begin with).
          </li>
          <li>
            The Site is hosted on Netlify and its search runs on Cloudflare Workers; those
            providers process requests under their own privacy policies.
          </li>
          <li>
            The Site is intended for a general audience and is not directed at children.
          </li>
        </ul>

        {/* ── Attribution ──────────────────────────────────────────────── */}
        <h2 className="mt-10 text-lg font-semibold text-gray-900">Attribution &amp; Data Sources</h2>
        <ul className="mt-3 space-y-3 text-sm leading-relaxed list-disc pl-5">
          <li>
            The site logo incorporates the &ldquo;Stopwatch Silhouette and Line Art Icon&rdquo;
            from{' '}
            <a href="https://www.vecteezy.com" target="_blank" rel="noopener noreferrer"
              className="text-blue-600 hover:underline">Vecteezy.com</a>.
          </li>
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

        <div className="mt-10">
          <a href="/" className="text-sm text-blue-600 hover:underline">&larr; Back to search</a>
        </div>
      </div>
    </main>
  );
}
