// pnpm smoke:media — 对每个配音 provider 合成一句样例，报时长和耗时（不打印 key）；再查 ffmpeg / Chromium 是否就绪
import { ffmpegAvailable, FFMPEG_MISSING } from './runtime/media/ffmpeg.js';
import { probeTts, ttsProviders } from './runtime/media/tts.js';
import { sanitizeError } from './runtime/models.js';
import { chromiumAvailable } from './runtime/video_frame.js';

console.log(`ffmpeg    ${ffmpegAvailable() ? 'ok' : FFMPEG_MISSING}`);
console.log(`chromium  ${chromiumAvailable() ? 'ok' : '没有（pnpm exec playwright install chromium）'}`);

const list = ttsProviders();
if (list.length === 0) {
  console.log('没有配音 provider（在设置页「媒体」里加，或填 .env.local 的 AW_TTS_*；AW_ENABLE_MOCK=1 时有 mock）');
  process.exit(0);
}

for (const p of list) {
  try {
    const r = await probeTts(p);
    console.log(`${p.name}  ${p.protocol}  ${r.format}  duration=${r.duration}s  bytes=${r.audio.length}  latency=${r.ms}ms`);
  } catch (e) {
    console.log(`${p.name}  ERROR ${sanitizeError(e instanceof Error ? e.message : String(e))}`);
  }
}
