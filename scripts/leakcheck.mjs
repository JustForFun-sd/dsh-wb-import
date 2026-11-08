import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TERM = 'Song' + 'Ding';   // 拆开写，避免本文件自我匹配
const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const hits = [];
for (const f of files) {
  if (f.startsWith('.github/')) continue;   // workflow 里必然出现搜索词
  try {
    const t = readFileSync(f, 'utf8');
    if (t.includes(TERM)) hits.push(f);
  } catch { /* binary or unreadable */ }
}
if (hits.length) {
  console.error('local username leaked into tracked files:');
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log(`checked ${files.length} tracked files, no local paths found`);
