import { Suspense } from 'react';
import SearchPage from '@/components/SearchPage';

// useSearchParams() inside SearchPage requires a Suspense boundary
export default function Home() {
  return (
    <Suspense>
      <SearchPage />
    </Suspense>
  );
}
