import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Use · HowLongIsThisSong.com',
  description: 'The terms that govern your use of HowLongIsThisSong.com.',
  alternates: { canonical: '/terms' },
};

const UPDATED = 'July 25, 2026';

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-white text-gray-700">
      <div className="max-w-2xl mx-auto px-5 py-12">
        <a href="/" className="text-sm text-blue-600 hover:underline">&larr; Back to search</a>

        <h1 className="mt-6 text-2xl font-bold text-gray-900">Terms of Use</h1>
        <p className="mt-1 text-sm text-gray-400">Last updated {UPDATED}</p>

        <p className="mt-6 text-sm leading-relaxed">
          These Terms of Use (&ldquo;Terms&rdquo;) govern your use of HowLongIsThisSong.com
          (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;). By using the Site, you agree
          to these Terms. If you do not agree, do not use the Site.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">The service</h2>
        <p className="mt-3 text-sm leading-relaxed">
          HowLongIsThisSong.com is a free tool for searching songs by length, BPM, title, artist,
          year, and other metadata. It is provided free of charge and is under active development.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Accuracy of data</h2>
        <p className="mt-3 text-sm leading-relaxed">
          Song data is aggregated from third-party sources and <strong>may be inaccurate,
          incomplete, or out of date.</strong> It is provided for general information only. Do not
          rely on it for any purpose where accuracy matters.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Acceptable use</h2>
        <p className="mt-3 text-sm leading-relaxed">You agree not to:</p>
        <ul className="mt-3 space-y-3 text-sm leading-relaxed list-disc pl-5">
          <li>Scrape, crawl, or systematically harvest the Site or its API through automated means.</li>
          <li>Place excessive load on the service. Requests are rate-limited.</li>
          <li>Attempt to gain unauthorized access to any part of the service or its infrastructure.</li>
          <li>Use the Site in any way that could damage, disable, or impair its operation.</li>
        </ul>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Intellectual property</h2>
        <p className="mt-3 text-sm leading-relaxed">
          The Site&rsquo;s original design, layout, and code are protected by copyright. Song
          metadata belongs to its respective sources and is used under their licenses (see{' '}
          <a href="/legal" className="text-blue-600 hover:underline">Legal</a>). Third-party names
          and trademarks belong to their respective owners.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Service availability</h2>
        <p className="mt-3 text-sm leading-relaxed">
          We provide the Site on an <strong>&ldquo;as-is&rdquo; and &ldquo;as-available&rdquo;</strong>{' '}
          basis. We do not guarantee uninterrupted availability, and we may modify, limit, or
          discontinue any part of the service at any time, with or without notice.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Limitation of liability</h2>
        <p className="mt-3 text-sm leading-relaxed">
          To the fullest extent permitted by law, we are not liable for any damages or losses
          arising from your use of, or inability to use, the Site.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Changes to these Terms</h2>
        <p className="mt-3 text-sm leading-relaxed">
          We may update these Terms from time to time. Continued use of the Site after changes
          means you accept the current version.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Contact</h2>
        <p className="mt-3 text-sm leading-relaxed">
          Questions about these Terms? Email{' '}
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
