import { parseJson } from '@/lib/format';
import type { Block } from '@/lib/queries';

// 插件可以声明一个板块作为工作台的默认入口
export const homeBlock = (blocks: Block[]) => blocks.find((b) => parseJson<{ home?: boolean }>(b.configJson, {}).home);

// 侧栏分组：板块声明 config.group 的归到同名分组，其余留在「功能」；分组按首次出现的顺序排
export function panelGroups(blocks: Block[]) {
  const groups: { title: string; blocks: Block[] }[] = [{ title: '功能', blocks: [] }];
  for (const b of blocks) {
    const title = parseJson<{ group?: string }>(b.configJson, {}).group || '功能';
    let g = groups.find((x) => x.title === title);
    if (!g) groups.push((g = { title, blocks: [] }));
    g.blocks.push(b);
  }
  return groups.filter((g, i) => i === 0 || g.blocks.length > 0);
}
