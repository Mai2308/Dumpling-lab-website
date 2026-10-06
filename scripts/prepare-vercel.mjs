import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve(root, 'public');
const staticFiles = [
  'index.html',
  'styles.css',
  'order-enhancements.css',
  'hero-copy.css',
  'offers.css',
  'menu-customization.css',
  'app.js'
];

mkdirSync(output, { recursive: true });
for (const file of staticFiles) copyFileSync(resolve(root, file), resolve(output, file));

const sourceAssets = resolve(root, 'assets');
const outputAssets = resolve(output, 'assets');
mkdirSync(outputAssets, { recursive: true });
for (const file of readdirSync(sourceAssets)) {
  if (file.startsWith('_')) continue;
  copyFileSync(resolve(sourceAssets, file), resolve(outputAssets, file));
}

console.info(`Prepared ${staticFiles.length} frontend files and public assets for Vercel.`);
