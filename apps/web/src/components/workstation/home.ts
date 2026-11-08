import { parseJson } from '@/lib/format';
import type { Block } from '@/lib/queries';

// 插件可以声明一个板块作为工作台的默认入口（设计台打开就是画布）
export const homeBlock = (blocks: Block[]) => blocks.find((b) => parseJson<{ home?: boolean }>(b.configJson, {}).home);
