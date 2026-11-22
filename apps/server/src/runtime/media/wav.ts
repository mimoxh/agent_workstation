// 纯 JS 的 16 位 PCM WAV：mock 配音和分段拼接都用它，不依赖 ffmpeg
export function writeWav(samples: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

interface WavInfo { fmt: Buffer; byteRate: number; data: Buffer }

export function parseWav(buf: Buffer): WavInfo | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt: Buffer | null = null;
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = buf.subarray(at + 8, Math.min(buf.length, at + 8 + size));
    if (id === 'fmt ') fmt = body;
    if (id === 'data' && fmt) return { fmt, byteRate: fmt.readUInt32LE(8), data: body };
    at += 8 + size + (size % 2);
  }
  return null;
}

export function wavDuration(buf: Buffer): number | null {
  const w = parseWav(buf);
  return w && w.byteRate > 0 ? w.data.length / w.byteRate : null;
}

// 同一格式的几段 WAV 首尾相接；格式不一致返回 null 交给 ffmpeg
export function concatWav(parts: Buffer[]): Buffer | null {
  const infos = parts.map(parseWav);
  if (infos.some((i) => !i) || infos.length === 0) return null;
  const first = infos[0]!;
  if (infos.some((i) => !i!.fmt.equals(first.fmt))) return null;
  const data = Buffer.concat(infos.map((i) => i!.data));
  const h = Buffer.alloc(20);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(4 + 8 + first.fmt.length + 8 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(first.fmt.length, 16);
  const dh = Buffer.alloc(8);
  dh.write('data', 0, 'ascii');
  dh.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, first.fmt, dh, data]);
}

// mock 配音：低音量正弦，时长就是要的秒数
export function toneWav(seconds: number, sampleRate = 24000): Buffer {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 1600);
  return writeWav(s, sampleRate);
}
