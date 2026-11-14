import { expect, test } from '@playwright/test';

const api = 'http://127.0.0.1:8877';

test('右侧栏：改动审阅 / 文件树 / 页面预览和主区同屏，跨页面保持，旧链接转到右侧栏', async ({ page }) => {
  const proj = (await (await fetch(`${api}/api/projects/proj-aw`)).json()) as { workstations: { id: string; pluginId: string }[] };
  const dev = proj.workstations.find((w) => w.pluginId === 'dev')!;

  await page.goto(`/projects/proj-aw/ws/${dev.id}`);
  await expect(page.getByTestId('dock')).toHaveCount(0);
  await page.getByTestId('dock-tab-改动审阅').click();
  await expect(page.getByTestId('dock-panel-changes')).toBeVisible();
  // 主区仍是大群
  await expect(page.getByTestId('thread-input')).toBeVisible();

  // 切左侧栏板块，右侧栏不动
  await page.getByTestId('side-panel-任务看板').click();
  await expect(page.getByTestId('dock-panel-changes')).toBeVisible();

  // 切到文件树；再点一次当前标签收起
  await page.getByTestId('dock-tab-文件树').click();
  await expect(page.getByTestId('dock-panel-files')).toBeVisible();
  await expect(page.getByTestId('file-tree')).toBeVisible();
  await page.getByTestId('dock-tab-文件树').click();
  await expect(page.getByTestId('dock')).toHaveCount(0);

  // 旧链接 ?panel=preview：打开右侧栏，地址栏去掉 panel
  await page.goto(`/projects/proj-aw/ws/${dev.id}?panel=preview`);
  await expect(page.getByTestId('dock-panel-preview')).toBeVisible();
  await expect(page).not.toHaveURL(/panel=/);

  // 刷新后记住；键盘拖宽（拖拽柄在左边缘，← 变宽）
  await page.reload();
  await expect(page.getByTestId('dock-panel-preview')).toBeVisible();
  const handle = page.getByTestId('dock-resize');
  const before = Number(await handle.getAttribute('aria-valuenow'));
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', String(before + 16));

  await page.getByTestId('dock-close').click();
  await expect(page.getByTestId('dock')).toHaveCount(0);
});
