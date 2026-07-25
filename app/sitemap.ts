import type { MetadataRoute } from 'next';

// Single-page app for now (search is one route). When per-song pages are added
// (audit item #24), enumerate the popular ones here.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://howlongisthissong.com',
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1,
    },
    {
      url: 'https://howlongisthissong.com/help',
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: 'https://howlongisthissong.com/legal',
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 0.1,
    },
  ];
}
