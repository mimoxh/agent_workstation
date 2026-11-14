import { expect, test, type Page } from '@playwright/test';

const api = 'http://127.0.0.1:8877';

async function devWs() {
  const proj = (await (await fetch(`${api}/api/projects/proj-aw`)).json()) as { workstations: { id: string; pluginId: string }[] };
  return proj.workstations.find((w) => w.pluginId === 'dev')!.id;
}

const frame = (page: Page) => page.frameLocator('[data-testid="design-frame"]');

test('对话出稿 → 画布评论发回设计师 → 改字、旋钮、版本回看 → 生成实现任务', async ({ page }) => {
  const wsId = await devWs();
  await page.goto(`/projects/proj-aw/ws/${wsId}?panel=canvas`);
  await expect(page.getByTestId('design-empty')).toBeVisible();
  // 设计侧栏固定和设计师说话：只有会话切换，没有 Agent 选择
  await expect(page.getByTestId('design-chat')).toBeVisible();
  await expect(page.getByTestId('chat-rail-target')).toHaveCount(0);

  await page.getByTestId('design-starter').first().click();
  await expect(page.getByTestId('design-card')).toHaveCount(1, { timeout: 20000 });
  await page.getByTestId('design-card').click();
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await expect(frame(page).locator('h1')).toHaveText('Mock 落地页');

  // 圈选元素留评论，一起发回去；设计师改稿后评论关闭
  await page.getByTestId('canvas-mode-comment').click();
  await frame(page).locator('h1').click();
  await page.getByTestId('comment-input').fill('标题再大胆一点');
  await page.getByTestId('comment-save').click();
  await expect(page.getByTestId('design-comment')).toHaveCount(1);
  await page.getByTestId('comments-send').click();
  await expect(frame(page).locator('h1')).toHaveText('Mock 落地页（已修订）', { timeout: 20000 });
  await page.getByTestId('rail-comments').click();
  await expect(page.getByTestId('design-comment')).toHaveCount(0);

  // 就地改字直接产生新版本
  await page.getByTestId('canvas-mode-edit').click();
  await frame(page).locator('p').click();
  await page.keyboard.type('人工改的说明');
  await page.keyboard.press('Enter');
  await page.getByTestId('canvas-mode-view').click();
  await expect(frame(page).locator('p')).toHaveText('人工改的说明');
  await expect(page.getByTestId('version-button')).toHaveText('v3');

  // 旋钮实时生效，不重载 iframe；保存后成为新版本
  await page.getByTestId('rail-tweaks').click();
  await page.getByTestId('tweak-pad').fill('24');
  await expect.poll(() => frame(page).locator('button').evaluate((b) => getComputedStyle(b).paddingTop)).toBe('24px');
  await page.getByTestId('tweaks-save').click();
  await expect(page.getByTestId('version-button')).toHaveText('v4');

  // 回看旧版本并恢复
  await page.getByTestId('version-button').click();
  await page.getByTestId('version-item').last().click();
  await expect(page.getByTestId('version-banner')).toBeVisible();
  await expect(frame(page).locator('h1')).toHaveText('Mock 落地页');
  await page.getByTestId('version-restore').click();
  await expect(page.getByTestId('version-banner')).toBeHidden();
  await expect(page.getByTestId('version-button')).toHaveText('v5');

  // 沙箱：稿子访问不到平台接口
  const reached = await frame(page).locator('body').evaluate(async () => {
    try {
      await fetch('/api/health');
      return true;
    } catch {
      return false;
    }
  });
  expect(reached).toBe(false);

  await page.getByTestId('canvas-handoff').click();
  await page.getByTestId('handoff-module').fill('src/board');
  await page.getByRole('button', { name: '创建开发任务' }).click();
  await expect(page.getByTestId('task-header')).toContainText('实现设计稿：Mock 落地页');
});

test('设计师会话：新建会话并切换，消息进所选会话', async ({ page }) => {
  const wsId = await devWs();
  await page.goto(`/projects/proj-aw/ws/${wsId}?panel=canvas`);
  await expect(page.getByTestId('design-chat')).toBeVisible();
  const sel = page.getByTestId('design-chat-thread');
  await expect(sel).toBeVisible();
  await expect(page.getByTestId('chat-rail-target')).toHaveCount(0);
  const before = await sel.locator('option').count();
  const first = await sel.inputValue();

  await page.getByTestId('design-chat-new').click();
  await expect(sel.locator('option')).toHaveCount(before + 1);
  await expect.poll(async () => sel.inputValue()).not.toBe(first);

  const cardsBefore = await page.getByTestId('design-card').count();
  await page.getByTestId('thread-input').fill('做一个价格页');
  await page.getByTestId('thread-send').click();
  await expect(page.getByText('设计稿已更新（mock）。')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('design-card')).toHaveCount(cardsBefore + 1, { timeout: 20000 });
});

test('开发台侧栏没有设计系统板块', async ({ page }) => {
  const wsId = await devWs();
  await page.goto(`/projects/proj-aw/ws/${wsId}`);
  await expect(page.getByTestId('side-panel-设计画布')).toBeVisible();
  await expect(page.getByTestId('side-panel-设计系统')).toHaveCount(0);
});

test('选择模式圈选元素 → 发给设计师 → 设计师改稿出新版本', async ({ page }) => {
  const wsId = await devWs();
  const html = '<!doctype html><html><head><style>:root{--c:#123}</style></head><body><h1>圈选页</h1><p>内容</p></body></html>';
  const created = (await (await fetch(`${api}/api/workstations/${wsId}/designs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '圈选页', html }) })).json()) as { id: string };

  await page.goto(`/projects/proj-aw/ws/${wsId}?panel=canvas&design=${created.id}`);
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await expect(frame(page).locator('h1')).toHaveText('圈选页');

  await page.getByTestId('canvas-mode-select').click();
  await frame(page).locator('h1').click();
  await expect(page.getByTestId('design-selection')).toBeVisible();
  await expect(page.getByTestId('design-selection')).toContainText('已选 1 个元素');
  await expect(page.getByTestId('design-selection')).toContainText('圈选页');

  await page.getByTestId('thread-input').fill('把标题改醒目一点');
  await page.getByTestId('thread-send').click();
  await expect(frame(page).locator('h1')).toHaveText('圈选页（已修订）', { timeout: 20000 });
  await expect(page.getByTestId('design-selection')).toHaveCount(0);
  await expect(page.getByTestId('version-button')).toHaveText('v2');
});

test('删除设计稿：画布菜单和列表卡片都能删，取消确认不删', async ({ page }) => {
  const wsId = await devWs();
  const create = async (title: string) => ((await (await fetch(`${api}/api/workstations/${wsId}/designs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, html: `<!doctype html><html><body><h1>${title}</h1></body></html>` }) })).json()) as { id: string }).id;
  const a = await create('待删稿 A');
  const b = await create('待删稿 B');

  await page.goto(`/projects/proj-aw/ws/${wsId}?panel=canvas&design=${a}`);
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  page.once('dialog', (d) => void d.dismiss());
  await page.getByTestId('canvas-more').click();
  await page.getByTestId('canvas-delete').click();
  await expect(page.getByTestId('design-canvas')).toBeVisible();

  page.once('dialog', (d) => {
    expect(d.message()).toContain('待删稿 A');
    void d.accept();
  });
  await page.getByTestId('canvas-more').click();
  await page.getByTestId('canvas-delete').click();
  await expect(page.getByTestId('design-gallery')).toBeVisible();
  await expect(page.getByTestId('design-card').filter({ hasText: '待删稿 A' })).toHaveCount(0);

  await expect(page.getByTestId('design-card').filter({ hasText: '待删稿 B' })).toHaveCount(1);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: '待删稿 B 的更多操作' }).click();
  await page.getByTestId('design-card-delete').click();
  await expect(page.getByTestId('design-card').filter({ hasText: '待删稿 B' })).toHaveCount(0);

  const left = (await (await fetch(`${api}/api/workstations/${wsId}/designs`)).json()) as { id: string }[];
  expect(left.map((d) => d.id)).not.toContain(a);
  expect(left.map((d) => d.id)).not.toContain(b);
});

test('拖拽调整设计侧栏宽度并记住', async ({ page }) => {
  const wsId = await devWs();
  await page.goto(`/projects/proj-aw/ws/${wsId}?panel=canvas`);
  await expect(page.getByTestId('design-chat')).toBeVisible();
  const aside = page.locator('aside[aria-label="和设计师对话"]');
  const before = (await aside.boundingBox())!.width;
  const handle = page.getByTestId('design-chat-resize');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const after = (await aside.boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 40);

  await page.reload();
  await expect(page.getByTestId('design-chat')).toBeVisible();
  const persisted = (await page.locator('aside[aria-label="和设计师对话"]').boundingBox())!.width;
  expect(Math.abs(persisted - after)).toBeLessThan(2);

  // 双击复位到初始宽度
  await page.getByTestId('design-chat-resize').dblclick();
  const reset = (await page.locator('aside[aria-label="和设计师对话"]').boundingBox())!.width;
  expect(Math.abs(reset - 352)).toBeLessThan(2);
});

