'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, LoaderCircle, RefreshCcw } from 'lucide-react';

import { MarkdownReport } from '@/components/markdown-report';
import { Button } from '@/components/ui/button';

export function RemoteReport({ date, reportsBaseUrl, workflowUrl }: { date: string; reportsBaseUrl: string; workflowUrl: string }) {
  const [markdown, setMarkdown] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const source = `${reportsBaseUrl}/${date}.md`;

  useEffect(() => {
    setStatus('loading');
    fetch(source, { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 404) return setStatus('missing');
        if (!response.ok) return setStatus('error');
        setMarkdown(await response.text());
        setStatus('ready');
      })
      .catch(() => setStatus('error'));
  }, [source]);

  return (
    <main className="min-h-screen bg-background px-4 py-5 text-foreground sm:px-6">
      <div className="mx-auto max-w-[1180px]">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <Button asChild variant="ghost" className="-ml-3 gap-2"><Link href="/"><ArrowLeft className="size-4" />返回报告库</Link></Button>
          {status === 'ready' ? (
            <div className="flex gap-2">
              <Button asChild variant="outline" className="gap-2"><a href={source} download><Download className="size-4" />下载MD</a></Button>
              <Button asChild variant="outline" className="gap-2"><a href={workflowUrl} target="_blank" rel="noreferrer"><RefreshCcw className="size-4" />重新生成</a></Button>
            </div>
          ) : null}
        </div>

        {status === 'loading' ? (
          <div className="grid min-h-80 place-items-center rounded-2xl border bg-card text-sm text-muted-foreground"><LoaderCircle className="mr-2 size-4 animate-spin" />正在读取 {date} 报告…</div>
        ) : null}
        {status === 'ready' ? <MarkdownReport markdown={markdown} /> : null}
        {status === 'missing' ? (
          <div className="rounded-2xl border border-dashed border-amber-300 bg-amber-50 p-8 text-center text-amber-950">
            <h1 className="text-lg font-semibold">{date} 尚未生成静态报告</h1>
            <p className="mt-2 text-sm">由仓库所有者手动生成后，报告会自动出现在这里。</p>
            <Button asChild className="mt-5"><a href={workflowUrl} target="_blank" rel="noreferrer">生成本日报告</a></Button>
          </div>
        ) : null}
        {status === 'error' ? <div className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">报告源暂时无法访问，请稍后刷新。</div> : null}
      </div>
    </main>
  );
}
