import { events } from '../events.js';

// 命令实时输出的内存注册表：channel（task:<id> / qa:<id>）→ 最近几条流
// live_* 事件不进 /api/stream 的失效前缀，前端走 /api/live/:channel 的专用 SSE

export interface LiveStream {
  id: string;
  label: string;
  startedAt: string;
  text: string;
  done: boolean;
  exitCode: number | null;
}

const TEXT_KEEP = 64 * 1024;
const MAX_STREAMS = 5;
const IDLE_MS = 30 * 60 * 1000;

const channels = new Map<string, LiveStream[]>();
const touched = new Map<string, number>();

export function liveSnapshot(channel: string): LiveStream[] {
  return channels.get(channel) ?? [];
}

export function startLive(channel: string, label: string) {
  cleanup();
  const stream: LiveStream = { id: crypto.randomUUID(), label, startedAt: new Date().toISOString(), text: '', done: false, exitCode: null };
  channels.set(channel, [...liveSnapshot(channel), stream].slice(-MAX_STREAMS));
  touched.set(channel, Date.now());
  events.emit('live_start', { channel, stream });
  return {
    id: stream.id,
    write(chunk: string) {
      if (stream.done) return;
      stream.text = (stream.text + chunk).slice(-TEXT_KEEP);
      touched.set(channel, Date.now());
      events.emit('live_output', { channel, streamId: stream.id, chunk });
    },
    finish(exitCode: number | null) {
      if (stream.done) return;
      stream.done = true;
      stream.exitCode = exitCode;
      events.emit('live_end', { channel, streamId: stream.id, exitCode });
    },
  };
}

// 懒清理：有新流时才把超过 30 分钟没动静的 channel 扔掉
function cleanup() {
  const cutoff = Date.now() - IDLE_MS;
  for (const [ch, t] of touched) {
    if (t >= cutoff) continue;
    channels.delete(ch);
    touched.delete(ch);
  }
}
