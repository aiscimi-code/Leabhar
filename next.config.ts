import type { NextConfig } from 'next';

const config: NextConfig = {
  serverExternalPackages: ['better-sqlite3', 'pdfjs-dist', 'exceljs'],
  experimental: { typedRoutes: false },
};

export default config;
