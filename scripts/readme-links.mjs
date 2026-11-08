import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const md = readFileSync('README.md', 'utf8');
const links = [...md.matchAll(/\]\((?!https?:)([^)#]+)/g)].map((m) => m[1]);
const unique = [...new Set(links)];
const missing = unique.filter((l) => !existsSync(resolve(l)));

if (missing.length) {
  console.error('README references missing files:');
  for (const m of missing) console.error('  ' + m);
  process.exit(1);
}
console.log(`README links ok (${unique.length} checked): ${unique.join(', ') || '(none)'}`);
