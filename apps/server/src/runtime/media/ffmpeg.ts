import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';

// ffmpeg / ffprobe：AW_FFMPEG / AW_FFPROBE 指定可执行文件，否则走 PATH
export const ffmpegBin = () => process.env.AW_FFMPEG || 'ffmpeg';
export const ffprobeBin = () => process.env.AW_FFPROBE || 'ffprobe';

export const FFMPEG_MISSING = '本机没有 ffmpeg：安装 ffmpeg 并加入 PATH（或用 AW_FFMPEG / AW_FFPROBE 指向可执行文件）后重试';

const checked = new Map<string, boolean>();

function works(bin: string) {
  const hit = checked.get(bin);
  if (hit !== undefined) return hit;
  const r = spawnSync(bin, ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
  const ok = r.status === 0;
  checked.set(bin, ok);
  return ok;
}

export const ffmpegAvailable = () => works(ffmpegBin()) && works(ffprobeBin());

export class MediaEnvError extends Error {}

export interface FfmpegRun {
  child: ChildProcessWithoutNullStreams;
  done: Promise<void>;
  kill: () => void;
}

const STDERR_KEEP = 4000;

// 起一个 ffmpeg：失败时把 stderr 尾巴带进错误；signal 中止时强杀
export function startFfmpeg(args: string[], opts: { signal?: AbortSignal | undefined; onStdout?: ((chunk: string) => void) | undefined } = {}): FfmpegRun {
  const child = spawn(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args.filter((a) => a !== '-nostdin')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let tail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => { tail = (tail + d).slice(-STDERR_KEEP); });
  child.stdout.setEncoding('utf8');
  if (opts.onStdout) child.stdout.on('data', opts.onStdout);
  else child.stdout.resume();
  child.stdin.on('error', () => {});
  const kill = () => { if (child.exitCode === null && !child.killed) child.kill('SIGKILL'); };
  const onAbort = () => kill();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (e: NodeJS.ErrnoException) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e.code === 'ENOENT' ? new MediaEnvError(FFMPEG_MISSING) : e);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(opts.signal?.aborted ? '已取消' : `ffmpeg 退出码 ${code ?? '—'}：${tail.trim().split('\n').slice(-3).join(' ').slice(0, 600)}`));
    });
  });
  return { child, done, kill };
}

export async function runFfmpeg(args: string[], opts: { signal?: AbortSignal | undefined; onStdout?: ((chunk: string) => void) | undefined } = {}) {
  const r = startFfmpeg(args, opts);
  r.child.stdin.end();
  await r.done;
}

export interface ProbeStream { codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; duration?: string; sample_rate?: string; channels?: number }
export interface ProbeResult { format: { duration?: string; format_name?: string; size?: string }; streams: ProbeStream[] }

export function ffprobe(file: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobeBin(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true });
    let out = '';
    let errText = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { out += d; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { errText = (errText + d).slice(-STDERR_KEEP); });
    child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? new MediaEnvError(FFMPEG_MISSING) : e));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe 失败：${errText.trim().slice(0, 400)}`));
      try {
        resolve(JSON.parse(out) as ProbeResult);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

export async function probeDuration(file: string): Promise<number> {
  const r = await ffprobe(file);
  const d = Number(r.format.duration ?? r.streams.find((s) => s.duration)?.duration);
  if (!Number.isFinite(d) || d <= 0) throw new Error('读不出音频时长');
  return d;
}
