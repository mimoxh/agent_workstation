import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const g = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', ...args], { cwd, windowsHide: true, stdio: 'pipe' });

// 临时 git fixture：main 分支最小项目，acceptance = node check.js
export function createFixtureRepo(): string {
  const dir = path.join(tmpdir(), `aw-fixture-${Date.now()}-${Math.floor(Math.random() * 1e4)}`);
  mkdirSync(path.join(dir, 'src', 'board'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { build: 'node check.js', test: 'node check.js' } }, null, 2));
  writeFileSync(path.join(dir, 'check.js'), 'process.exit(0);\n');
  writeFileSync(path.join(dir, 'src', 'board', 'index.txt'), 'board placeholder\n');
  writeFileSync(path.join(dir, '.gitignore'), 'data/\n');
  g(dir, ['init', '-b', 'main']);
  g(dir, ['add', '-A']);
  g(dir, ['-c', 'user.name=fixture', '-c', 'user.email=f@f.local', 'commit', '-m', 'init']);
  return dir;
}
