import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: 'https://www.fgi.ie', changeFrequency: 'weekly', priority: 1 },
    { url: 'https://www.fgi.ie/portal', changeFrequency: 'monthly', priority: 0.8 },
    { url: 'https://github.com/aiscimi-code/Leabhar', changeFrequency: 'weekly', priority: 0.6 },
  ];
}
