import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => <a href={href} onClick={(event) => {
            event.preventDefault();
            if (href) void window.forgex.openExternal(href);
          }}>{children}</a>,
          table: ({ children }) => <div className="markdown-table-wrap"><table>{children}</table></div>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
