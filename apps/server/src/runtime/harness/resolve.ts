import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// 只认原生可执行文件：node-pty 直接起进程，不经过 cmd.exe，参数里的引号和换行才不会被改写
export function resolveOnPath(name: string, override?: string | undefined): string | null {
  if (override) return existsSync(override) ? override : null;
  const exts = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

export function versionOf(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : (stdout.toString().trim().split('\n')[0] ?? '').trim() || null);
    });
  });
}
