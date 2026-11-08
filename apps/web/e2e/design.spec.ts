import { expect, test, type Page } from '@playwright/test';

const api = 'http://127.0.0.1:8877';

async function mountDesign() {
  const name = `设计${Date.now()}`;
  const proj = (await (await fetch(`${api}/api/projects/proj-aw`)).json()) as { workstations: { id: string; parentId: string | null }[] };
  const parentId = proj.workstations.find((w) => w.parentId === null)!.id;
  const r = (await (await fetch(`${api}/api/projects/proj-aw/workstations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentId, pluginId: 'design', name }) })).json()) as { id: string };
  return r.id;
}

const frame = (page: Page) => page.frameLocator('[data-testid="design-frame"]');

test('对话出稿 → 画布评论发回设计师 → 改字、旋钮、版本回看 → 交给开发台', async ({ page }) => {
  const wsId = await mountDesign();
  await page.goto(`/projects/proj-aw/ws/${wsId}`);
  await expect(page.getByTestId('design-empty')).toBeVisible();

  await page.getByTestId('design-starter').first().click();
  await expect(page.getByTestId('design-card')).toHaveCount(1, { timeout: 20000 });
  await page.getByTestId('design-card').click();
  await expect(page.getByTestId('design-canvas')).toBeVisible();
  await expect(frame(page).locator('h1')).toHaveText('Mock 落地页');

  // 圈选元素留评论，一起发回去；设计师改稿后评论关闭
  await page.getByTestId('模式-comment').click();
  await frame(page).locator('h1').click();
  await page.getByTestId('comment-input').fill('标题再大胆一点');
  await page.getByTestId('comment-save').click();
  await expect(page.getByTestId('design-comment')).toHaveCount(1);
  await page.getByTestId('comments-send').click();
  await expect(frame(page).locator('h1')).toHaveText('Mock 落地页（已修订）', { timeout: 20000 });
  await page.getByTestId('rail-comments').click();
  await expect(page.getByTestId('design-comment')).toHaveCount(0);

  // 就地改字直接产生新版本
  await page.getByTestId('模式-edit').click();
  await frame(page).locator('p').click();
  await page.keyboard.type('人工改的说明');
  await page.keyboard.press('Enter');
  await page.getByTestId('模式-view').click();
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

test('设计系统改令牌，画布上的稿子跟着变', async ({ page }) => {
  const wsId = await mountDesign();
  const html = '<!doctype html><html><head><style>h1{color:var(--color-primary)}</style></head><body><h1>令牌</h1></body></html>';
  const created = (await (await fetch(`${api}/api/workstations/${wsId}/designs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '令牌页', html }) })).json()) as { id: string };

  await page.goto(`/projects/proj-aw/ws/${wsId}?panel=system`);
  const row = page.getByTestId('token-row').filter({ has: page.locator('input[value="--color-primary"]') });
  await row.getByTestId('token-value').fill('#ff0000');
  await page.getByTestId('tokens-save').click();
  await expect(page.getByTestId('tokens-save')).toBeDisabled();

  await page.goto(`/projects/proj-aw/ws/${wsId}?design=${created.id}`);
  await expect.poll(() => frame(page).locator('h1').evaluate((h) => getComputedStyle(h).color)).toBe('rgb(255, 0, 0)');
});
