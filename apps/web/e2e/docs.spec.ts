import { expect, test } from '@playwright/test';

const api = 'http://127.0.0.1:8877';

async function mountDocs() {
  const proj = (await (await fetch(`${api}/api/projects/proj-aw`)).json()) as { workstations: { id: string; parentId: string | null; pluginId: string }[] };
  const parentId = proj.workstations.find((w) => w.parentId === null)!.id;
  const r = (await (await fetch(`${api}/api/projects/proj-aw/workstations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentId, pluginId: 'docs', name: `文档${Date.now()}` }) })).json()) as { id?: string };
  // singleton：别的用例已经挂过就复用它的文档台
  return r.id ?? proj.workstations.find((w) => w.pluginId === 'docs')!.id;
}

test('挂文档台 → 新建文档 → 预览 → 评论 → 请求核对唤醒事实核对', async ({ page }) => {
  const wsId = await mountDocs();
  await page.goto(`/projects/proj-aw/ws/${wsId}`);
  await expect(page.getByTestId('doc-studio')).toBeVisible();

  // 新建文档
  await page.getByTestId('doc-new').click();
  await page.getByTestId('doc-new-title').fill('E2E 接入指南');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByTestId('doc-canvas')).toBeVisible();
  await expect(page.getByTestId('doc-status')).toHaveText('草稿');

  // 预览渲染 markdown
  await expect(page.getByTestId('doc-preview').locator('h1')).toHaveText('E2E 接入指南');

  // 编辑器改动 → 保存出新版本
  await page.getByTestId('doc-mode-edit').click();
  await page.getByTestId('doc-editor').fill('# E2E 接入指南\n\n三步接入。\n');
  await page.getByTestId('doc-save').click();
  await page.getByTestId('doc-mode-preview').click();
  await expect(page.getByTestId('doc-preview')).toContainText('三步接入');

  // 留评论
  await page.getByTestId('doc-tab-comments').click();
  await page.getByTestId('doc-comment-input').fill('开头再直白一点');
  await page.getByTestId('doc-comment-submit').click();
  await expect(page.getByTestId('doc-comment-item')).toHaveCount(1);

  // 交接条件列出原因
  await page.getByTestId('doc-tab-gate').click();
  await expect(page.getByTestId('doc-gate-reason').first()).toBeVisible();

  // 请求核对：状态拨到核对中，事实核对被 @ 醒来回话（回话折在结论卡里）
  await page.getByTestId('doc-request-review').click();
  await expect(page.getByTestId('doc-status')).toHaveText('核对中');
  await page.getByRole('button', { name: /展开.*讨论/ }).click({ timeout: 20000 });
  await expect(page.getByText('收到（mock）。')).toBeVisible();
});

test('交给开发：人工放行走通，产出 dev.issue 任务', async ({ page }) => {
  const wsId = await mountDocs();
  await page.goto(`/projects/proj-aw/ws/${wsId}`);
  await page.getByTestId('doc-new').click();
  await page.getByTestId('doc-new-title').fill('E2E 交接文档');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByTestId('doc-canvas')).toBeVisible();

  // API 直接补上目标仓库/路径（UI 元信息表单在别处覆盖）
  const proj = (await (await fetch(`${api}/api/projects/proj-aw`)).json()) as { workstations: { id: string; pluginId: string }[] };
  const devId = proj.workstations.find((w) => w.pluginId === 'dev')!.id;
  const list = (await (await fetch(`${api}/api/workstations/${wsId}/docs`)).json()) as { docs: { id: string; title: string }[] };
  const doc = (await (await fetch(`${api}/api/docs/${list.docs.find((d) => d.title === 'E2E 交接文档')!.id}`)).json()) as { id: string; version: number };
  const patch = await fetch(`${api}/api/docs/${doc.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target_repo: devId, target_path: 'docs/e2e.md', baseVersion: doc.version }) });
  expect(patch.status).toBe(200);

  // 未核对 → 门禁不过 → 人工放行
  await page.reload();
  await page.getByTestId('doc-handoff-top').click();
  await expect(page.getByTestId('doc-handoff-dialog')).toBeVisible();
  await expect(page.getByTestId('doc-handoff-gate-reason').first()).toBeVisible();
  const submit = page.getByRole('button', { name: '创建开发任务' });
  await expect(submit).toBeDisabled();
  await page.getByTestId('doc-handoff-override').check();
  await page.getByTestId('doc-handoff-reason').fill('E2E 人工放行');
  await submit.click();
  await expect(page.getByTestId('doc-handoff-task-link')).toBeVisible({ timeout: 15000 });

  // 跳过去能看到写入任务
  await page.getByTestId('doc-handoff-task-link').click();
  await expect(page.getByText('写入文档：E2E 交接文档').first()).toBeVisible({ timeout: 15000 });
});

test('singleton：挂载对话框里已挂的文档台不可再选', async ({ page }) => {
  await mountDocs();
  await page.goto('/projects/proj-aw');
  await page.getByTestId('mount-button').click();
  await expect(page.getByTestId('mount-dialog')).toBeVisible();
  const opt = page.getByTestId('mount-plugin').locator('option[value="docs"]');
  await expect(opt).toHaveAttribute('disabled', '');
  await expect(opt).toContainText('已挂载');
});

test('文档健康：空态渲染、自动起草开关、发布说明对话框校验', async ({ page }) => {
  const wsId = await mountDocs();
  await page.goto(`/projects/proj-aw/ws/${wsId}?panel=health`);
  await expect(page.getByTestId('doc-health')).toBeVisible();
  await expect(page.getByText('过时文档')).toBeVisible();
  await expect(page.getByText('入库后被改')).toBeVisible();

  // 自动起草开关持久化
  await page.getByTestId('health-autodraft').selectOption('affected');
  await expect(page.getByTestId('health-autodraft')).toHaveValue('affected');

  // 发布说明对话框：时间范围没填「从」禁提交；空范围的错误显示在对话框里
  await page.getByTestId('release-notes-open').click();
  await expect(page.getByTestId('release-notes-dialog')).toBeVisible();
  await page.getByTestId('release-mode-range').click();
  const submit = page.getByTestId('release-notes-dialog').getByRole('button', { name: '起草' });
  await expect(submit).toBeDisabled();
  await page.getByTestId('release-since').fill('2999-01-01');
  await submit.click();
  await expect(page.getByTestId('release-notes-dialog')).toContainText('没有已合并的任务');
});
