import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/drizzle/**',
      '**/data/**',
      '**/routeTree.gen.ts',
      '**/test-results/**',
      '**/playwright-report/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // ARCHITECTURE §2 硬规则：domain 不得依赖框架或运行时
    files: ['packages/domain/src/**/*.ts', 'packages/plugin-spec/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['hono', '@hono/*'], message: 'domain 不得依赖框架' },
            { group: ['react', 'react-dom'], message: 'domain 不得依赖框架' },
            { group: ['drizzle-orm', 'drizzle-orm/*', 'better-sqlite3'], message: 'domain 不得依赖运行时' },
            { group: ['ai', '@ai-sdk/*'], message: 'domain 不得依赖运行时' },
            { group: ['node:*'], message: 'domain 不得依赖运行时' },
          ],
        },
      ],
    },
  },
);
