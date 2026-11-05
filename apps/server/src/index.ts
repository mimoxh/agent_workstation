import { serve } from '@hono/node-server';
import { createDb, migrateDb } from './db/client.js';
import { seed } from './db/seed.js';
import { createApp } from './app.js';
import { loadPlugins } from './plugins.js';

loadPlugins(); // 校验失败直接抛错退出

const { db, sqlite } = createDb();
migrateDb(sqlite);
await seed(db);

const { app } = createApp(db);
const port = Number(process.env.AW_PORT ?? 8787);
const hostname = process.env.AW_HOST ?? '127.0.0.1';
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`server listening on http://${info.address}:${info.port}`);
});
