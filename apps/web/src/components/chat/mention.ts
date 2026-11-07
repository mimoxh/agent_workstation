// @ 之后到光标前的片段，没有则不弹候选
export function mentionQuery(text: string, cursor: number): string | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor));
  return m ? (m[1] ?? '') : null;
}
