import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownReport({ markdown }: { markdown: string }) {
  return (
    <article className="rounded-2xl border bg-card px-4 py-6 shadow-sm sm:px-7 lg:px-10 lg:py-9">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => <h1 className="font-serif-cn text-2xl font-semibold leading-tight tracking-tight text-foreground sm:text-3xl" {...props} />,
          h2: (props) => <h2 className="mt-10 border-l-4 border-primary pl-3 font-serif-cn text-xl font-semibold text-foreground first:mt-0" {...props} />,
          h3: (props) => <h3 className="mt-7 text-base font-semibold text-primary" {...props} />,
          p: (props) => <p className="mt-3 text-sm leading-7 text-foreground/85" {...props} />,
          ul: (props) => <ul className="mt-3 space-y-1.5 pl-5 text-sm leading-7 marker:text-primary" {...props} />,
          ol: (props) => <ol className="mt-3 space-y-1.5 pl-5 text-sm leading-7 marker:text-primary" {...props} />,
          li: (props) => <li className="pl-1" {...props} />,
          strong: (props) => <strong className="font-semibold text-foreground" {...props} />,
          blockquote: (props) => <blockquote className="mt-5 rounded-r-xl border-l-4 border-primary bg-red-50 px-4 py-3 text-sm leading-7 text-red-950 [&>p]:mt-0" {...props} />,
          table: (props) => (
            <div className="mt-4 overflow-x-auto rounded-xl border">
              <table className="min-w-full border-collapse text-left text-xs" {...props} />
            </div>
          ),
          thead: (props) => <thead className="bg-primary text-primary-foreground" {...props} />,
          th: (props) => <th className="whitespace-nowrap border-r border-white/15 px-3 py-2.5 font-medium last:border-r-0" {...props} />,
          td: (props) => <td className="min-w-24 border-r border-t px-3 py-2 align-top leading-5 last:border-r-0" {...props} />,
          a: (props) => <a className="font-medium text-primary underline underline-offset-4" target="_blank" rel="noreferrer" {...props} />,
          hr: () => <hr className="my-8 border-border" />,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  );
}
