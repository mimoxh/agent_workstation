export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      cur = { path: m?.[1] ?? line.slice(11), additions: 0, deletions: 0, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    const h = HUNK.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      cur.lines.push({ kind: 'hunk', text: line, oldLine: null, newLine: null });
    } else if (cur.lines.length === 0) {
      continue;
    } else if (line.startsWith('+')) {
      cur.additions += 1;
      cur.lines.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: newNo++ });
    } else if (line.startsWith('-')) {
      cur.deletions += 1;
      cur.lines.push({ kind: 'del', text: line.slice(1), oldLine: oldNo++, newLine: null });
    } else if (line.startsWith(' ')) {
      cur.lines.push({ kind: 'ctx', text: line.slice(1), oldLine: oldNo++, newLine: newNo++ });
    }
  }
  return files;
}
