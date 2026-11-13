import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// markdown → 独立 HTML 文档。不放 raw HTML（allowDangerousHtml 关着），
// 正文里的 <script> 会被转义成文本，导出物可以直接进仓库或打印
export async function docToHtml(md: string, title: string): Promise<string> {
  const body = String(await unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeStringify).process(md));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { max-width: 46rem; margin: 2.5rem auto; padding: 0 1.25rem; color: #1c1b19; font: 15px/1.7 system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  h1, h2, h3, h4 { line-height: 1.3; margin: 1.6em 0 0.6em; }
  h1 { font-size: 1.7rem; border-bottom: 1px solid #e4e2dc; padding-bottom: 0.3em; }
  h2 { font-size: 1.35rem; }
  h3 { font-size: 1.15rem; }
  code { font: 0.9em ui-monospace, "Cascadia Mono", Consolas, monospace; background: #f3f1ec; padding: 0.1em 0.35em; border-radius: 4px; }
  pre { background: #f3f1ec; padding: 0.9rem 1rem; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 1em 0; padding: 0.1em 0 0.1em 1em; border-left: 3px solid #e4e2dc; color: #6f6c66; }
  table { border-collapse: collapse; margin: 1em 0; }
  th, td { border: 1px solid #e4e2dc; padding: 0.35em 0.7em; }
  a { color: #1f4d3f; }
  img { max-width: 100%; }
  hr { border: 0; border-top: 1px solid #e4e2dc; margin: 2em 0; }
  .footnotes { font-size: 0.85em; color: #6f6c66; border-top: 1px solid #e4e2dc; margin-top: 2em; padding-top: 0.8em; }
  @media print { body { margin: 0 auto; } a { color: inherit; text-decoration: none; } }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
