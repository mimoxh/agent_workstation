export interface Mentionable {
  id: string;
  name: string;
}

// 最长名优先：「@前端开发 #2」不能同时命中「前端开发」
export function extractMentions(content: string, members: readonly Mentionable[]): string[] {
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  const found: string[] = [];
  for (let i = content.indexOf('@'); i !== -1; i = content.indexOf('@', i + 1)) {
    const hit = byLength.find((m) => content.startsWith(m.name, i + 1));
    if (hit && !found.includes(hit.id)) found.push(hit.id);
  }
  return found;
}
