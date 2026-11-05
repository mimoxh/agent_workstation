import { createDb, migrateDb } from './client.js';

// pnpm db:migrate：生成迁移文件后执行（见 package.json scripts）
const { sqlite } = createDb();
migrateDb(sqlite);
console.log('migrate 完成');
