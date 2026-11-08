// 任务的改动范围：module 可写多个（逗号分隔，跨 Module 重构），"." 表示整个仓库（脚手架）
// 没声明或解析不了 = 没有可写范围（invalid），不能当成整个仓库放开
export interface TaskScope { modules: string[]; kind: string; whole: boolean; invalid: boolean }

const WHOLE = new Set(['.', './', '/', '*']);
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'npm-shrinkwrap.json'];

const norm = (x: string) => x.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

export function parseScope(inputJson: string | null): TaskScope {
  let input: { module?: unknown; kind?: unknown };
  try { input = JSON.parse(inputJson ?? '{}') as typeof input; } catch { return { modules: [], kind: '', whole: false, invalid: true }; }
  const kind = String(input?.kind ?? '');
  const raw = (Array.isArray(input?.module) ? input.module.map(String) : typeof input?.module === 'string' ? input.module.split(',') : []).map((m) => m.trim()).filter(Boolean);
  const whole = raw.some((m) => WHOLE.has(m));
  const modules = whole ? [] : raw.map(norm).filter((m) => m && !m.startsWith('..') && !m.startsWith('/'));
  return { modules, kind, whole, invalid: !whole && modules.length === 0 };
}

export function inScope(p: string, s: TaskScope): boolean {
  if (s.invalid) return false;
  if (s.whole) return true;
  const f = norm(p);
  // 依赖升级会动到仓库根的锁文件和各包的 package.json
  if (s.kind === 'deps' && (LOCKFILES.includes(f) || f === 'package.json' || f.endsWith('/package.json'))) return true;
  return s.modules.some((m) => f === m || f.startsWith(`${m}/`));
}

export const scopeLabel = (s: TaskScope) => (s.invalid ? '任务没有声明 module，不能写入' : s.whole ? '整个仓库' : s.modules.join('、'));

// 只读工具（检索 / 列文件）的路径规格：没声明范围时退回整个仓库，读不会越权
export const readSpecs = (s: TaskScope) => (s.whole || s.invalid ? ['.'] : s.modules);
