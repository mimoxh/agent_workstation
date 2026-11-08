// 容器沙箱：工作台配置了镜像后，Agent 能触发的命令都在一次性容器里跑，只挂载当前 worktree
export interface SandboxConfig { image: string; memory?: string | undefined; cpus?: number | undefined }
export type SandboxNetwork = 'none' | 'bridge';

export const SANDBOX_WORKDIR = '/workspace';
export const SANDBOX_IMAGE = /^[a-zA-Z0-9][\w.\-/:@]*$/;

export const dockerBin = () => process.env.AW_DOCKER_BIN ?? 'docker';

export function dockerRunArgs(o: {
  name: string;
  sandbox: SandboxConfig;
  cwd: string;
  argv: string[];
  env?: Record<string, string> | undefined;
  network: SandboxNetwork;
  publish?: string[] | undefined;
  // worktree 的 .git 是指向宿主仓库的文件；可写的话容器能把它改指恶意 gitdir，下次宿主 git 就会执行里面的钩子
  gitFile: boolean;
  user?: string | undefined;
}): string[] {
  return [
    'run', '--rm', '--init', '--name', o.name,
    '--network', o.network,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '512',
    '--memory', o.sandbox.memory ?? '2g',
    '--cpus', String(o.sandbox.cpus ?? 2),
    '--read-only',
    '--tmpfs', '/tmp:rw,exec,size=1g',
    '-v', `${o.cwd}:${SANDBOX_WORKDIR}`,
    ...(o.gitFile ? ['-v', `${o.cwd}/.git:${SANDBOX_WORKDIR}/.git:ro`] : []),
    '-w', SANDBOX_WORKDIR,
    ...(o.user ? ['--user', o.user] : []),
    '-e', 'HOME=/tmp',
    '-e', 'CI=1',
    ...Object.entries(o.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...(o.publish ?? []).flatMap((p) => ['-p', `127.0.0.1:${p}:${p}`]),
    o.sandbox.image,
    ...o.argv,
  ];
}

// 容器里的 .git 指向宿主路径，用不了；git 留在宿主上跑，所以只放行只读子命令，并挡掉能写文件或执行外部程序的参数
const GIT_READONLY = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep', 'blame']);
const GIT_DENIED_ARGS = ['--output', '--ext-diff', '--open-files-in-pager', '--exec', '--upload-pack', '--receive-pack', '-O'];

export function sandboxGitDenied(argv: string[]): string | null {
  const [, sub, ...rest] = argv;
  if (!sub || !GIT_READONLY.has(sub)) return `沙箱模式下 run_command 只能跑只读 git（${[...GIT_READONLY].join(' / ')}）；提交和同步用 git_commit、sync_branch`;
  const bad = rest.find((a) => GIT_DENIED_ARGS.some((d) => a === d || a.startsWith(d)));
  return bad ? `沙箱模式下不允许 git 参数 ${bad}` : null;
}
