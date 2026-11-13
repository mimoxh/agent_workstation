import { useMemo } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

// 文档是模型写的文本，按不可信处理：不放行 raw HTML，链接只开 http(s)/mailto/#/相对路径，图片渲染成链接不自动加载
const urlTransform = (url: string) =>
  /^https?:\/\//i.test(url) || /^mailto:/i.test(url) || url.startsWith('#') || !/^[a-z][a-z0-9+.-]*:/i.test(url) ? defaultUrlTransform(url) : '';

const FOOTNOTE_HREF = '#user-content-fn-';

// [^id] 脚注标记只在有定义时才渲染成链接：给已登记、但正文没写定义的引用补一份定义，再藏掉脚注区
function withCitationDefs(content: string, citationIds: string[]): string {
  const defined = new Set([...content.matchAll(/^\s*\[\^([^\]]+)\]\s*:/gm)].map((m) => m[1]!));
  const missing = citationIds.filter((id) => !defined.has(id));
  return missing.length ? `${content}\n\n${missing.map((id) => `[^${id}]: ·`).join('\n')}` : content;
}

export function DocMarkdown({ content, citationIds, onCitation, className }: { content: string; citationIds?: string[] | undefined; onCitation?: ((id: string) => void) | undefined; className?: string }) {
  const doc = useMemo(() => withCitationDefs(content, citationIds ?? []), [content, citationIds]);
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const cid = href?.startsWith(FOOTNOTE_HREF) ? decodeURIComponent(href.slice(FOOTNOTE_HREF.length)) : null;
        if (cid && onCitation) {
          return (
            <button
              type="button"
              onClick={() => onCitation(cid)}
              title={`查看引用 ${cid}`}
              className="mx-0.5 inline-flex translate-y-[-0.2em] items-center rounded-chip bg-cool-tag px-1 text-[0.75em] font-medium text-cool-tag-ink hover:opacity-80"
              data-testid={`citation-${cid}`}
            >
              {children}
            </button>
          );
        }
        return (
          <a href={href} target="_blank" rel="noreferrer" className="text-cool underline decoration-cool/40 underline-offset-2">
            {children}
          </a>
        );
      },
      // 图片不自动加载：渲染成链接，人要开自己点
      img: ({ src, alt }) => (
        <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noreferrer" className="text-cool underline decoration-cool/40 underline-offset-2">
          {alt || src || '图片'}
        </a>
      ),
      section: ({ className: cn2, ...props }) => (cn2 === 'footnotes' ? null : <section className={cn2} {...props} />),
    }),
    [onCitation],
  );
  return (
    <div className={cn('doc-md text-sm leading-6 text-ink', className)} data-testid="doc-preview">
      <Markdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={components}>
        {doc}
      </Markdown>
    </div>
  );
}
