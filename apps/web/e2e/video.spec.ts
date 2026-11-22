import { expect, test } from '@playwright/test';

const api = 'http://127.0.0.1:8877';
const json = { 'content-type': 'application/json' };

async function mountVideo() {
  const proj = (await (await fetch(`${api}/api/projects/proj-aw`)).json()) as { workstations: { id: string; parentId: string | null; pluginId: string }[] };
  const parentId = proj.workstations.find((w) => w.parentId === null)!.id;
  const r = (await (await fetch(`${api}/api/projects/proj-aw/workstations`, { method: 'POST', headers: json, body: JSON.stringify({ parentId, pluginId: 'video', name: `视频${Date.now()}` }) })).json()) as { id?: string };
  // singleton：别的用例已经挂过就复用它的视频台
  return r.id ?? proj.workstations.find((w) => w.pluginId === 'video')!.id;
}

const BOX = (label: string) => `<!doctype html><html><head><style>body{margin:0;background:#202020;color:#fff;font:600 64px system-ui}#box{position:absolute;left:0;top:80px;width:120px;height:120px;background:#3a7;animation:go 2s linear forwards}@keyframes go{to{transform:translateX(600px)}}</style></head><body><div id="box"></div><h1 style="position:absolute;top:300px;left:80px;margin:0">${label}</h1></body></html>`;

async function seedVideo(wsId: string, title: string) {
  const v = (await (await fetch(`${api}/api/workstations/${wsId}/videos`, { method: 'POST', headers: json, body: JSON.stringify({ title, resolution: '720p' }) })).json()) as { id: string };
  const sb = await fetch(`${api}/api/videos/${v.id}/storyboard`, {
    method: 'PUT',
    headers: json,
    body: JSON.stringify({ shots: [
      { title: '甲镜头', narration: '第一句字幕。', duration: 2, html: BOX('甲') },
      { title: '乙镜头', narration: '第二句字幕。', duration: 2, html: BOX('乙'), transition: 'fade' },
      { title: '丙镜头', narration: '第三句字幕。', duration: 2 },
    ] }),
  });
  expect(sb.status).toBe(200);
  return v.id;
}

test('挂视频台 → 新建视频 → 编导写稿、拆分镜 → 动画师出画面', async ({ page }) => {
  const wsId = await mountVideo();
  await page.goto(`/projects/proj-aw/ws/${wsId}`);
  await expect(page.getByTestId('video-studio')).toBeVisible();

  await page.getByTestId('video-new').click();
  await page.getByTestId('video-new-title').fill('E2E 讲解视频');
  await page.getByTestId('video-new-brief').fill('讲清楚部署流程');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByTestId('video-editor')).toBeVisible();
  await expect(page.getByTestId('video-status')).toHaveText('草稿');
  await expect(page).toHaveURL(/video=/);

  await page.getByTestId('video-ask-director').click();
  await expect(page.getByTestId('video-script-preview')).toContainText('第一段：提出问题', { timeout: 20000 });
  await expect(page.getByTestId('video-ask-director')).toHaveText('请编导拆分镜');

  await page.getByTestId('video-ask-director').click();
  await expect(page.getByTestId('video-status')).toHaveText('已分镜', { timeout: 20000 });
  await page.getByTestId('video-tab-storyboard').click();
  await expect(page.getByTestId('video-shot-1')).toContainText('提出问题（mock）');
  await expect(page.getByTestId('video-shot-2')).toContainText('给出答案（mock）');
  await expect(page.getByTestId('video-shot-missing')).toHaveCount(2);

  await page.getByTestId('video-ask-motion').click();
  await expect(page.getByTestId('video-shot-missing')).toHaveCount(0, { timeout: 20000 });
  const frame = page.getByTestId('video-player-frame');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(page.frameLocator('[data-testid="video-player-frame"]').getByText('mock 画面')).toHaveCount(1);
});

test('播放器：播放推进时间、字幕跟着镜头走、拖进度切镜头', async ({ page }) => {
  const wsId = await mountVideo();
  const id = await seedVideo(wsId, `E2E 播放 ${Date.now()}`);
  await page.goto(`/projects/proj-aw/ws/${wsId}?video=${id}`);
  await page.getByTestId('video-tab-play').click();
  await expect(page.getByTestId('video-player')).toBeVisible();
  await expect(page.getByTestId('video-current-shot')).toHaveText('甲镜头');
  await expect(page.getByTestId('video-subtitle')).toHaveText('第一句字幕');
  await expect(page.frameLocator('[data-testid="video-player-frame"]').locator('h1')).toHaveText('甲');

  await page.getByTestId('video-seek').fill('2.5');
  await expect(page.getByTestId('video-current-shot')).toHaveText('乙镜头');
  await expect(page.getByTestId('video-subtitle')).toHaveText('第二句字幕');
  await expect(page.frameLocator('[data-testid="video-player-frame"]').locator('h1')).toHaveText('乙');

  await page.getByTestId('video-seek').fill('0');
  await page.getByTestId('video-play').click();
  await expect(page.getByTestId('video-current-shot')).toHaveText('乙镜头', { timeout: 8000 });
  await page.getByTestId('video-play').click();
  const paused = await page.getByTestId('video-time').textContent();
  await page.waitForTimeout(400);
  await expect(page.getByTestId('video-time')).toHaveText(paused ?? '');

  // 淡入：交叠的 0.5 秒里两层画面叠着，上层透明度跟着走
  await page.getByTestId('video-seek').fill('1.75');
  await expect(page.getByTestId('video-current-shot')).toHaveText('乙镜头');
  await expect(page.getByTestId('video-player-frame-under')).toHaveCount(1);
  await expect(page.getByTestId('video-player-frame')).toHaveCSS('opacity', '0.5');
  await expect(page.frameLocator('[data-testid="video-player-frame-under"]').locator('h1')).toHaveText('甲');

  // 缺画面的镜头走占位画面，时间线照常走
  await page.getByTestId('video-seek').fill('5');
  await expect(page.getByTestId('video-current-shot')).toHaveText('丙镜头');
  await expect(page.frameLocator('[data-testid="video-player-frame"]').getByText('画面还没做')).toHaveCount(1);
});

test('分镜：调整顺序、删除镜头、改时长', async ({ page }) => {
  const wsId = await mountVideo();
  const id = await seedVideo(wsId, `E2E 分镜 ${Date.now()}`);
  await page.goto(`/projects/proj-aw/ws/${wsId}?video=${id}`);
  await page.getByTestId('video-tab-storyboard').click();
  await expect(page.getByTestId('video-shot-1')).toContainText('甲镜头');

  await page.getByTestId('video-shot-down-1').click();
  await expect(page.getByTestId('video-shot-1')).toContainText('乙镜头');
  await expect(page.getByTestId('video-shot-2')).toContainText('甲镜头');

  await page.getByTestId('video-shot-delete-3').click();
  await expect(page.getByTestId('video-shot-3')).toHaveCount(0);
  await expect(page.getByTestId('video-total')).toHaveText('0:04.0');

  await page.getByTestId('video-shot-edit-1').click();
  await page.getByTestId('video-shot-duration').fill('5');
  await page.getByTestId('video-shot-dialog').getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('video-total')).toHaveText('0:07.0');
});

test('配音 → 出片 → 成片面板：进度、播放、下载 mp4 / srt', async ({ page }) => {
  test.setTimeout(180_000);
  const wsId = await mountVideo();
  const id = await seedVideo(wsId, `E2E 出片 ${Date.now()}`);
  await page.goto(`/projects/proj-aw/ws/${wsId}?video=${id}`);
  await page.getByTestId('video-tab-storyboard').click();

  await page.getByTestId('video-voice').click();
  await expect(page.getByTestId('video-voice-dialog')).toBeVisible();
  await page.getByTestId('video-voice-dialog').getByRole('button', { name: '生成配音' }).click();
  await expect(page.getByTestId('video-voice-dialog')).toHaveCount(0);
  await expect(page.getByTestId('video-shot-audio')).toHaveCount(3);

  await page.getByTestId('video-render').click();
  const dialog = page.getByTestId('video-render-dialog');
  await expect(dialog.getByTestId('video-render-blocking')).toContainText('还没有画面');
  await expect(dialog.getByRole('button', { name: '开始出片' })).toBeDisabled();
  // 预览和成片同一条时间线：3 个 2 秒镜头、一个淡入交叠 0.5 秒
  await expect(dialog.getByTestId('video-render-total')).toContainText('0:05.5');
  await expect(page.getByTestId('video-total')).toHaveText('0:05.5');
  await dialog.getByTestId('video-render-allow-placeholders').click();
  // 没审片：门禁不过，人填原因才能越过
  await expect(dialog.getByTestId('video-gate-review')).toHaveAttribute('data-ok', '0');
  await expect(dialog.getByTestId('video-gate-voice')).toHaveAttribute('data-ok', '1');
  await expect(dialog.getByRole('button', { name: '开始出片' })).toBeDisabled();
  await dialog.getByTestId('video-render-override').click();
  await expect(dialog.getByRole('button', { name: '越过门禁出片' })).toBeDisabled();
  await dialog.getByTestId('video-render-override-reason').fill('E2E 先出一版看看');
  await dialog.getByRole('radio', { name: '外挂' }).click();
  await dialog.getByRole('button', { name: '越过门禁出片' }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByTestId('side-panel-成片').click();
  await expect(page.getByTestId('video-renders')).toBeVisible();
  await expect(page.getByTestId('video-render-status')).toHaveText('已完成', { timeout: 150_000 });
  await expect(page.getByTestId('video-render-player')).toBeVisible();
  await expect(page.getByTestId('live-stream-text')).toContainText('完成');

  const mp4 = await page.getByTestId('video-render-download').getAttribute('href');
  const head = await fetch(`${api}${mp4}`, { headers: { range: 'bytes=0-1023' } });
  expect(head.status).toBe(206);
  expect(head.headers.get('content-type')).toBe('video/mp4');
  expect(head.headers.get('content-disposition')).toContain('.mp4');
  const srt = await page.getByTestId('video-render-srt').getAttribute('href');
  expect(await (await fetch(`${api}${srt}`)).text()).toContain('第一句字幕');
  const played = await page.getByTestId('video-render-player').evaluate((el: HTMLVideoElement) => new Promise<number>((resolve) => {
    if (el.readyState >= 1) resolve(el.duration);
    else el.addEventListener('loadedmetadata', () => resolve(el.duration), { once: true });
  }));
  expect(played).toBeGreaterThan(5.3);
  expect(played).toBeLessThan(5.7);
});

const SHOTS_READY = (id: string) => fetch(`${api}/api/videos/${id}/storyboard`, {
  method: 'PUT',
  headers: json,
  body: JSON.stringify({ shots: [
    { title: '甲镜头', narration: '第一句字幕。', duration: 2, html: BOX('甲') },
    { title: '乙镜头', narration: '第二句字幕。', duration: 2, html: BOX('乙'), transition: 'fade' },
  ] }),
});

test('请求审片 → 审片留评论并通过 → 门禁放行 → 出片', async ({ page }) => {
  test.setTimeout(180_000);
  const wsId = await mountVideo();
  const id = await seedVideo(wsId, `E2E 审片 ${Date.now()}`);
  expect((await SHOTS_READY(id)).status).toBe(200);
  expect((await fetch(`${api}/api/videos/${id}/voice`, { method: 'POST', headers: json, body: '{}' })).status).toBe(200);
  await page.goto(`/projects/proj-aw/ws/${wsId}?video=${id}`);
  await expect(page.getByTestId('video-status')).toHaveText('已分镜');

  await page.getByTestId('video-rail-tab-review').click();
  await expect(page.getByTestId('video-rail-gate').getByTestId('video-gate-review')).toHaveAttribute('data-ok', '0');
  await page.getByTestId('video-request-review').click();
  await expect(page.getByTestId('video-status')).toHaveText('已通过', { timeout: 30_000 });
  await page.getByTestId('video-rail-tab-review').click();
  await expect(page.getByTestId('video-review-verdict')).toHaveText('通过');
  await expect(page.getByTestId('video-rail-gate').getByTestId('video-gate-review')).toHaveAttribute('data-ok', '1');

  await page.getByTestId('video-rail-tab-comments').click();
  await expect(page.getByTestId('video-comments')).toContainText('标题字号可以再大一点（mock）');

  await page.getByTestId('video-render').click();
  const dialog = page.getByTestId('video-render-dialog');
  await expect(dialog.getByTestId('video-render-gate').locator('[data-ok="0"]')).toHaveCount(0);
  await expect(dialog.getByTestId('video-render-override')).toHaveCount(0);
  await dialog.getByRole('button', { name: '开始出片' }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByTestId('side-panel-成片').click();
  await expect(page.getByTestId('video-render-status').first()).toHaveText('已完成', { timeout: 150_000 });
  await page.goto(`/projects/proj-aw/ws/${wsId}?video=${id}`);
  await expect(page.getByTestId('video-status')).toHaveText('已出片');
});

test('人在播放器当前时刻留评论（圈选元素），点评论跳回那个镜头和时间', async ({ page }) => {
  const wsId = await mountVideo();
  const id = await seedVideo(wsId, `E2E 评论 ${Date.now()}`);
  await page.goto(`/projects/proj-aw/ws/${wsId}?video=${id}`);
  await page.getByTestId('video-tab-play').click();
  await page.getByTestId('video-seek').fill('2.5');
  await expect(page.getByTestId('video-current-shot')).toHaveText('乙镜头');

  await page.getByTestId('video-rail-tab-comments').click();
  await page.getByTestId('video-comment-new').click();
  await expect(page.getByTestId('video-comment-at')).toContainText('镜头内 0:01.0');
  await expect(page.getByTestId('video-comment-at')).toContainText('全片 0:02.5');
  await page.getByTestId('video-comment-pick').click();
  await expect(page.getByTestId('video-picking')).toBeVisible();
  await page.frameLocator('[data-testid="video-player-frame"]').locator('h1').click();
  await expect(page.getByTestId('video-comment-picked')).toContainText('乙');
  await page.getByTestId('video-comment-body').fill('这里的字太靠左了');
  await page.getByTestId('video-comment-submit').click();
  const item = page.getByTestId('video-comments').getByText('这里的字太靠左了');
  await expect(item).toBeVisible();
  await expect(page.getByTestId('video-comments')).toContainText('圈选：乙');

  await page.getByTestId('video-seek').fill('0');
  await expect(page.getByTestId('video-current-shot')).toHaveText('甲镜头');
  await item.click();
  await expect(page.getByTestId('video-time')).toHaveText('0:02.5 / 0:05.5');
  await expect(page.getByTestId('video-current-shot')).toHaveText('乙镜头');

  await page.getByTestId('video-tab-storyboard').click();
  await expect(page.getByTestId('video-shot-2').getByTestId('video-shot-comments')).toHaveText('1');
});

test('风格面板：改调色板，预览和视频画面都用上新颜色', async ({ page }) => {
  const wsId = await mountVideo();
  const id = await seedVideo(wsId, `E2E 风格 ${Date.now()}`);
  await page.goto(`/projects/proj-aw/ws/${wsId}`);
  await page.getByTestId('side-panel-风格').click();
  await expect(page.getByTestId('video-style')).toBeVisible();
  await page.getByTestId('video-style-color-bg').fill('#123456');
  await expect(page.getByTestId('video-style-preview')).toHaveAttribute('srcdoc', /--aw-bg:#123456/);
  await page.getByTestId('video-style-save').click();
  await expect(page.getByText('风格已保存')).toBeVisible();

  await page.goto(`/projects/proj-aw/ws/${wsId}?video=${id}`);
  await page.getByTestId('video-tab-play').click();
  await expect(page.getByTestId('video-player-frame')).toHaveAttribute('srcdoc', /--aw-bg:#123456/);
  await expect(page.frameLocator('[data-testid="video-player-frame"]').locator('html')).toHaveCSS('background-color', 'rgb(18, 52, 86)');
});

test('素材面板：上传图片 → 片段申请等人批 → 批准后生成的片段接到镜头上', async ({ page }) => {
  test.setTimeout(90_000);
  const wsId = await mountVideo();
  const id = await seedVideo(wsId, `E2E 素材 ${Date.now()}`);
  await page.goto(`/projects/proj-aw/ws/${wsId}`);
  await page.getByTestId('side-panel-素材').click();
  await expect(page.getByTestId('video-assets')).toBeVisible();

  const name = `e2e-${Date.now()}`;
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 320, height: 180 } });
  await page.getByTestId('asset-file-input').setInputFiles({ name: `${name}.png`, mimeType: 'image/png', buffer: png });
  await expect(page.locator('[data-testid^="asset-card-"]').filter({ hasText: name })).toContainText('320×180');

  const v = (await (await fetch(`${api}/api/videos/${id}`)).json()) as { shots: { id: string }[] };
  const res = await fetch(`${api}/api/videos/${id}/clip-requests`, { method: 'POST', headers: json, body: JSON.stringify({ shotId: v.shots[0]!.id, prompt: 'E2E 海边日落，航拍缓慢推进', duration: 2 }) });
  expect(res.status).toBe(201);
  const req = (await res.json()) as { id: string; status: string };
  expect(req.status).toBe('pending');

  const card = page.getByTestId(`clip-request-${req.id}`);
  await expect(card).toContainText('E2E 海边日落', { timeout: 10_000 });
  await page.getByTestId(`clip-approve-${req.id}`).click();
  await expect(card).toHaveCount(0, { timeout: 30_000 });
  await page.getByTestId('asset-source-generated').click();
  await expect(page.locator('[data-testid^="asset-card-"]').filter({ hasText: '甲镜头 片段' }).first()).toBeVisible();

  const after = (await (await fetch(`${api}/api/videos/${id}`)).json()) as { shots: { visual: string; asset: string | null }[] };
  expect(after.shots[0]).toMatchObject({ visual: 'generated' });
  expect(after.shots[0]!.asset).toBeTruthy();
});
