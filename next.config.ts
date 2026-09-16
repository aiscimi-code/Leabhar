import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3', 'pdfjs-dist', 'exceljs'],
};

export default config;
