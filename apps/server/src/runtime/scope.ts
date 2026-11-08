// 任务的改动范围：module 可写多个（逗号分隔，跨 Module 重构），"." 表示整个仓库（脚手架）
export interface TaskScope { modules: string[]; kind: string; whole: boolean }

const WHOLE = new Set(['', '.', './', '/', '*']);
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'npm-shrinkwrap.json'];

const norm = (x: string) => x.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

export function parseScope(inputJson: string | null): TaskScope {
  let input: { module?: unknown; kind?: unknown } = {};
  try { input = JSON.parse(inputJson ?? '{}') as typeof input; } catch { /* 无效输入按整个仓库处理 */ }
  const raw = Array.isArray(input.module) ? input.module.map(String) : String(input.module ?? '').split(',');
  const modules = raw.map(norm).filter((m) => !WHOLE.has(m));
  const whole = modules.length === 0 || raw.some((m) => WHOLE.has(m.trim()) && m.trim() !== '');
  return { modules: whole ? [] : modules, kind: String(input.kind ?? ''), whole };
}

export function inScope(p: string, s: TaskScope): boolean {
  if (s.whole) return true;
  const f = norm(p);
  // 依赖升级会动到仓库根的锁文件和各包的 package.json
  if (s.kind === 'deps' && (LOCKFILES.includes(f) || f === 'package.json' || f.endsWith('/package.json'))) return true;
  return s.modules.some((m) => f === m || f.startsWith(`${m}/`));
}

export const scopeLabel = (s: TaskScope) => (s.whole ? '整个仓库' : s.modules.join('、'));
