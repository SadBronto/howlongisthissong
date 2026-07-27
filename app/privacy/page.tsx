import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy · HowLongIsThisSong.com',
  description: 'What HowLongIsThisSong.com collects, how it is used, and your choices.',
  alternates: { canonical: '/privacy' },
};

const UPDATED = 'July 25, 2026';

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-white text-gray-700">
      <div className="max-w-2xl mx-auto px-5 py-12">
        <a href="/" className="text-sm text-blue-600 hover:underline">&larr; Back to search</a>

        <h1 className="mt-6 text-2xl font-bold text-gray-900">Privacy Policy</h1>
        <p className="mt-1 text-sm text-gray-400">Last updated {UPDATED}</p>

        <p className="mt-6 text-sm leading-relaxed">
          HowLongIsThisSong.com (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) is a
          free tool for looking up song durations and related metadata. This Privacy Policy
          describes what we collect, how we use it, and your choices. By using the Site, you agree
          to this policy.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Information we collect</h2>
        <ul className="mt-3 space-y-3 text-sm leading-relaxed list-disc pl-5">
          <li>
            <strong>Search queries.</strong> The words and filters you enter are sent to our
            search service to return results. They are not tied to your identity. There are
            no accounts, and we don&rsquo;t build a profile of you.
          </li>
          <li>
            <strong>Technical data.</strong> Standard server logs (such as IP address, browser
            type, and timing) are collected automatically by our infrastructure providers to
            operate and secure the service and to prevent abuse.
          </li>
          <li>
            <strong>Aggregate counts.</strong> We keep anonymous totals (for example, a
            running count of searches performed) that are not linked to any individual.
          </li>
        </ul>
        <p className="mt-3 text-sm leading-relaxed">
          We do not ask for or store names, email addresses, passwords, or payment information.
          There is nothing to sign up for.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">How we use your information</h2>
        <ul className="mt-3 space-y-3 text-sm leading-relaxed list-disc pl-5">
          <li>To provide the service: running your search and returning results.</li>
          <li>To keep the service reliable and secure, and to prevent abuse.</li>
          <li>To maintain simple aggregate statistics, such as the total number of searches.</li>
        </ul>
        <p className="mt-3 text-sm leading-relaxed">
          We do not sell your personal information, and we do not use it for advertising.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Service providers we use</h2>
        <ul className="mt-3 space-y-3 text-sm leading-relaxed list-disc pl-5">
          <li>
            <strong>Cloudflare</strong>: runs our search backend and database and provides
            network security. Subject to Cloudflare&rsquo;s privacy policy.
          </li>
          <li>
            <strong>Netlify</strong>: website hosting and content delivery. Subject to
            Netlify&rsquo;s privacy policy.
          </li>
        </ul>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Cookies &amp; tracking</h2>
        <p className="mt-3 text-sm leading-relaxed">
          We do not use advertising or tracking cookies. Your current search is kept in the page
          URL so results can be shared and bookmarked, not in any tracking cookie.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Data retention</h2>
        <p className="mt-3 text-sm leading-relaxed">
          We do not maintain personal accounts or profiles, so there is no personal data to
          retain. Standard server logs are held only briefly by our providers for security and
          reliability.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Children</h2>
        <p className="mt-3 text-sm leading-relaxed">
          The Site is intended for a general audience and is not directed to children under 13.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Your choices</h2>
        <p className="mt-3 text-sm leading-relaxed">
          Because we don&rsquo;t collect personal information or maintain accounts, there is no
          personal profile to access, correct, or delete.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Changes to this policy</h2>
        <p className="mt-3 text-sm leading-relaxed">
          We may update this policy from time to time. Material changes will be reflected by the
          &ldquo;Last updated&rdquo; date above.
        </p>

        <h2 className="mt-10 text-lg font-semibold text-gray-900">Contact</h2>
        <p className="mt-3 text-sm leading-relaxed">
          Please don&rsquo;t.
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
