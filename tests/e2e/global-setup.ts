import { rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export default function globalSetup() {
  const root = resolve('data/e2e');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
}
