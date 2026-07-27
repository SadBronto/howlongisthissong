import { Suspense } from 'react';
import SearchPage from '@/components/SearchPage';

// useSearchParams() inside SearchPage requires a Suspense boundary
export default function Home() {
  return (
    <>
      {/* Server-rendered primary heading. SearchPage is a client component behind a
          Suspense boundary, so its markup isn't in the initial HTML - this H1 ensures
          scanners and search engines see the page's purpose immediately. The visible
          "HowLongIsThisSong.com" wordmark is the logo; this states what the page offers. */}
      <h1 className="sr-only">Search millions of songs by length, BPM &amp; more</h1>
      <Suspense>
        <SearchPage />
      </Suspense>
    </>
  );
}
