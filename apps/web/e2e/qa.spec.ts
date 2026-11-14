import { expect, test } from '@playwright/test';

const api = 'http://127.0.0.1:8877';

// 质量板块在开发台里（D32）；每个用例挂一台绑定同一仓库的新开发台，免得和其他用例的套件、运行互相干扰
async function mountDev() {
  const proj = (await (await fetch(`${api}/api/projects/proj-aw`)).json()) as { workstations: { id: string; parentId: string | null; pluginId: string }[] };
  const parentId = proj.workstations.find((w) => w.parentId === null)!.id;
  const seeded = proj.workstations.find((w) => w.pluginId === 'dev')!.id;
  const { source } = (await (await fetch(`${api}/api/workstations/${seeded}/qa/overview`)).json()) as { source: { repoPath: string; targetBranch: string } };
  const r = (await (await fetch(`${api}/api/projects/proj-aw/workstations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentId, pluginId: 'dev', name: `开发${Date.now()}`, settings: { repoPath: source.repoPath, targetBranch: source.targetBranch } }) })).json()) as { id: string };
  return r.id;
}

test('配套件 → 运行 → 看失败 → AI 分析 → 建缺陷 → 生成修复任务', async ({ page }) => {
  const wsId = await mountDev();
  await page.goto(`/projects/proj-aw/ws/${wsId}`);
  // 开发台默认仍是任务看板，质量板块在侧栏「测试」分组里
  await expect(page.getByTestId('side-panel-任务看板')).toBeVisible();
  await page.getByTestId('side-panel-质量总览').click();
  await expect(page.getByTestId('qa-empty')).toBeVisible();

  await page.getByTestId('qa-go-suites').click();
  await page.getByTestId('qa-suite-name').fill('登录单测');
  await page.getByTestId('qa-suite-command').fill('npx evil');
  await page.getByTestId('qa-suite-report').fill('junit.xml');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('qa-suite-dialog')).toContainText('环境或依赖');
  await page.getByTestId('qa-suite-command').fill('node qa-run.js');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('qa-suite-row')).toHaveCount(1);

  await page.getByTestId('运行页-runs').click();
  await page.getByTestId('qa-run-new').click();
  await page.getByRole('button', { name: '开始运行' }).click();
  await expect(page.getByTestId('qa-run-status')).toHaveText('失败', { timeout: 30000 });
  await expect(page.getByTestId('qa-run-counts')).toContainText('1 通过 · 1 失败');
  await expect(page.getByTestId('qa-cluster')).toContainText('expected 200 to be 400');

  await page.getByTestId('qa-run-triage').click();
  await expect(page.getByTestId('qa-triage-badge')).toContainText('产品缺陷', { timeout: 20000 });

  await page.getByTestId('qa-cluster-bug').click();
  await page.getByTestId('qa-bug-severity').selectOption('p1');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByTestId('qa-bug-detail')).toBeVisible();
  await expect(page.getByTestId('qa-bug-status')).toHaveText('待修');

  await page.getByTestId('qa-bug-handoff').click();
  await page.getByTestId('qa-handoff-module').fill('src/');
  await expect(page.getByTestId('qa-handoff-target')).toHaveValue(wsId);
  await page.getByRole('button', { name: '创建开发任务' }).click();
  await expect(page.getByTestId('qa-bug-status')).toHaveText('修复中');

  await page.goto(`/projects/proj-aw/ws/${wsId}?panel=board`);
  await expect(page.getByRole('main').getByRole('link', { name: /^修复缺陷：/ })).toBeVisible();

  await page.goto(`/projects/proj-aw/ws/${wsId}?panel=overview`);
  await expect(page.getByTestId('qa-verdict')).toHaveAttribute('data-level', 'blocked');
  await expect(page.getByTestId('qa-trend')).toBeVisible();
});

test('测试计划：手工执行并签字冻结报告', async ({ page }) => {
  const wsId = await mountDev();
  const post = (body: unknown) => fetch(`${api}/api/workstations/${wsId}/entities`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post({ entityType: 'TestCase', data: { title: '手机号登录', status: 'active', priority: 'p1', steps: [{ action: '输入手机号', expected: '收到验证码' }] } });
  await page.goto(`/projects/proj-aw/ws/${wsId}?panel=plans`);
  await page.getByTestId('qa-plan-new').click();
  await page.getByTestId('qa-plan-name').fill('v1 验收');
  await page.getByTestId('qa-plan-pick').first().check();
  await page.getByRole('button', { name: '创建' }).click();

  await expect(page.getByTestId('qa-plan-detail')).toBeVisible();
  await expect(page.getByTestId('qa-plan-sign')).toBeDisabled();
  await page.getByTestId('qa-manual-passed').click();
  await expect(page.getByTestId('qa-plan-sign')).toBeEnabled();
  await page.getByTestId('qa-plan-sign').click();
  await page.getByTestId('qa-sign-note').fill('手工验收通过');
  await page.getByRole('button', { name: '签字', exact: true }).last().click();
  await expect(page.getByTestId('qa-plan-report')).toContainText('手工验收通过');
  await expect(page.getByTestId('qa-manual-passed')).toHaveCount(0);
});
