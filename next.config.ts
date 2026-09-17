import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3', 'pdfjs-dist', 'exceljs'],
  // Local-first app served over localhost: HTTP compression is pure CPU
  // overhead and its Gzip stream leaks 'drain' listeners on streamed
  // Server Action responses. See issue #78.
  compress: false,
  experimental: {
    serverActions: {
      // A single scanned invoice is routinely larger than the 1 MB default,
      // and uploads batch several files into one Server Action request.
      bodySizeLimit: '64mb',
    },
  },
};

export default config;
