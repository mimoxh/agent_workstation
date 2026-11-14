import { and, eq } from 'drizzle-orm';
import type { DesignToken } from '@aw/domain';
import type { DB } from '../db/client.js';
import { entity, entityVersion, eventLog } from '../db/schema.js';
import { logEvent } from './core.js';

const HUMAN = { type: 'human', id: 'local' } as const;

// 只给迁移用：没有保存过设计系统的旧台按这套默认令牌冻结；新稿子不再注入
export const LEGACY_DEFAULT_TOKENS: DesignToken[] = [
  { name: '--color-bg', value: '#faf9f6', description: '页面背景' },
  { name: '--color-surface', value: '#ffffff', description: '卡片、面板' },
  { name: '--color-text', value: '#1c1b19', description: '正文' },
  { name: '--color-muted', value: '#6f6c66', description: '次要文字' },
  { name: '--color-border', value: '#e4e2dc', description: '分隔线' },
  { name: '--color-primary', value: '#1f4d3f', description: '主操作' },
  { name: '--color-on-primary', value: '#ffffff', description: '主操作上的文字' },
  { name: '--color-accent', value: '#d9622b', description: '强调' },
  { name: '--font-sans', value: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif', description: '正文字体' },
  { name: '--font-display', value: 'Georgia, "Songti SC", "SimSun", serif', description: '标题字体' },
  { name: '--radius-sm', value: '4px' },
  { name: '--radius-md', value: '8px' },
  { name: '--radius-lg', value: '16px' },
  { name: '--space-1', value: '4px' },
  { name: '--space-2', value: '8px' },
  { name: '--space-3', value: '16px' },
  { name: '--space-4', value: '24px' },
  { name: '--space-5', value: '40px' },
  { name: '--space-6', value: '64px' },
  { name: '--shadow-card', value: '0 1px 2px rgb(0 0 0 / 0.06), 0 8px 24px rgb(0 0 0 / 0.06)' },
];

interface FrozenData { html?: string; legacyTokens?: DesignToken[] | undefined }

// 老稿子的 :root 令牌原来由设计系统注入；设计系统下线前把它冻结进每份稿子（含历史版本），渲染不变。
// 只跑一次：跑完记一条 system 级 design_tokens_frozen 事件做全局标记——之后新写的稿子没有
// legacyTokens 键且自己也用 var(--，没有标记的话下次启动会被误注入旧令牌。
export async function freezeDesignTokens(db: DB) {
  const done = await db.select({ id: eventLog.id }).from(eventLog)
    .where(and(eq(eventLog.action, 'design_tokens_frozen'), eq(eventLog.targetType, 'system')));
  if (done.length > 0) return;
  const designs = await db.select().from(entity).where(eq(entity.entityType, 'Design'));
  const perWs = new Map<string, number>();
  for (const row of designs) {
    const data = JSON.parse(row.dataJson ?? '{}') as FrozenData;
    if (data.legacyTokens !== undefined) continue;
    const sys = (await db.select().from(entity).where(eq(entity.workstationId, row.workstationId))).find((e) => e.entityType === 'DesignSystem');
    const sysTokens = (sys ? (JSON.parse(sys.dataJson ?? '{}') as { tokens?: DesignToken[] }).tokens : undefined) ?? LEGACY_DEFAULT_TOKENS;
    // 每个版本按自己的 html 判断：用了 var(-- 才需要旧令牌
    const tokensFor = (html: string | undefined) => ((html ?? '').includes('var(--') ? sysTokens : []);
    data.legacyTokens = tokensFor(data.html);
    await db.update(entity).set({ dataJson: JSON.stringify(data) }).where(eq(entity.id, row.id));
    const versions = await db.select().from(entityVersion).where(eq(entityVersion.entityId, row.id));
    for (const v of versions) {
      const vd = JSON.parse(v.dataJson ?? '{}') as FrozenData;
      if (vd.legacyTokens !== undefined) continue;
      vd.legacyTokens = tokensFor(vd.html);
      await db.update(entityVersion).set({ dataJson: JSON.stringify(vd) }).where(eq(entityVersion.id, v.id));
    }
    perWs.set(row.workstationId, (perWs.get(row.workstationId) ?? 0) + 1);
  }
  for (const [wsId, count] of perWs) {
    await logEvent(db, HUMAN, 'design_tokens_frozen', 'workstation', wsId, { count });
  }
  await logEvent(db, HUMAN, 'design_tokens_frozen', 'system', 'design_tokens_frozen', { count: perWs.size });
}
