import { useMemo } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

// 文档是模型写的文本，按不可信处理：不放行 raw HTML，链接只开 http(s)/mailto/#/相对路径，图片渲染成链接不自动加载
const urlTransform = (url: string) =>
  /^https?:\/\//i.test(url) || /^mailto:/i.test(url) || url.startsWith('#') || !/^[a-z][a-z0-9+.-]*:/i.test(url) ? defaultUrlTransform(url) : '';

const FOOTNOTE_HREF = '#user-content-fn-';

const LINK = 'font-medium text-ink underline decoration-rule-2 underline-offset-[3px] hover:decoration-current';

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
              className="mx-px inline-flex h-[18px] items-center rounded-[5px] bg-cool-tag px-1.5 align-[2px] font-mono text-[11px] font-semibold leading-none text-cool-tag-ink hover:brightness-105"
              data-testid={`citation-${cid}`}
            >
              {children}
            </button>
          );
        }
        return (
          <a href={href} target="_blank" rel="noreferrer" className={LINK}>
            {children}
          </a>
        );
      },
      // 图片不自动加载：渲染成链接，人要开自己点
      img: ({ src, alt }) => (
        <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noreferrer" className={LINK}>
          {alt || src || '图片'}
        </a>
      ),
      h1: ({ children }) => <h1 className="text-h2 font-bold tracking-[-0.01em] text-ink">{children}</h1>,
      h2: ({ children }) => <h2 className="mt-3 text-title font-bold text-ink">{children}</h2>,
      h3: ({ children }) => <h3 className="mt-2 text-md font-bold text-ink">{children}</h3>,
      h4: ({ children }) => <h4 className="mt-1 text-sm font-bold text-ink">{children}</h4>,
      h5: ({ children }) => <h5 className="text-sm font-bold text-ink-2">{children}</h5>,
      h6: ({ children }) => <h6 className="text-sm font-bold text-muted">{children}</h6>,
      ul: ({ children, className: c }) => <ul className={cn('grid gap-1.5 pl-5', c === 'contains-task-list' ? 'list-none pl-1' : 'list-disc', 'marker:text-faint')}>{children}</ul>,
      ol: ({ children, start }) => <ol start={start} className="grid list-decimal gap-1.5 pl-5 marker:text-muted">{children}</ol>,
      li: ({ children }) => <li className="pl-0.5 [&>ol]:mt-1.5 [&>ul]:mt-1.5">{children}</li>,
      strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
      blockquote: ({ children }) => <blockquote className="grid gap-2 border-l-2 border-rule-2 pl-3.5 text-muted">{children}</blockquote>,
      pre: ({ children }) => (
        <pre className="overflow-x-auto rounded-ctl bg-code px-3.5 py-3 font-mono text-xs leading-[1.65] text-code-ink [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit">{children}</pre>
      ),
      hr: () => <hr className="my-1 border-rule" />,
      table: ({ children }) => (
        <div className="overflow-x-auto rounded-ctl shadow-[var(--shadow-card)]">
          <table className="w-full border-collapse text-sm">{children}</table>
        </div>
      ),
      th: ({ children, style }) => <th style={style} className="whitespace-nowrap border-b border-rule bg-paper-2 px-3 py-2 text-left text-xs font-semibold text-muted">{children}</th>,
      td: ({ children, style }) => <td style={style} className="border-b border-rule px-3 py-2 align-top text-ink-2 [tr:last-child>&]:border-b-0">{children}</td>,
      section: ({ className: cn2, ...props }) => (cn2 === 'footnotes' ? null : <section className={cn2} {...props} />),
    }),
    [onCitation],
  );
  return (
    <div className={cn('doc-md grid max-w-[72ch] gap-3 text-md leading-relaxed text-ink-2', className)} data-testid="doc-preview">
      <Markdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={components}>
        {doc}
      </Markdown>
    </div>
  );
}
