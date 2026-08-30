import Link from 'next/link';
import { ArrowDownRight, ArrowLeft, ArrowUpRight, CalendarDays, Download, Flame } from 'lucide-react';

import { MarkdownReport } from '@/components/markdown-report';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { Report } from '@/lib/report-types';

const number = new Intl.NumberFormat('zh-CN');

export function ReportView({ report, markdown, embedded = false }: { report: Report; markdown: string; embedded?: boolean }) {
  const markdownPath = `/reports/${report.date}.md`;
  const pdfPath = `/reports/${report.date}.pdf`;

  return (
    <main className={embedded ? '' : 'min-h-screen bg-background text-foreground'}>
      <div className={embedded ? '' : 'mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-6 lg:px-8'}>
        {!embedded ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <Button asChild variant="ghost" className="-ml-3 gap-2">
              <Link href="/"><ArrowLeft className="size-4" />返回报告库</Link>
            </Button>
            <Badge variant="outline" className="bg-card"><CalendarDays className="size-3.5" />{report.displayDate}</Badge>
          </div>
        ) : null}

        <section className="relative overflow-hidden rounded-3xl bg-ink px-5 py-7 text-white shadow-[0_24px_80px_rgba(51,31,18,.15)] sm:px-8 lg:px-10">
          <div className="absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(circle_at_center,rgba(229,70,58,.24),transparent_66%)]" />
          <div className="relative grid gap-6 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-white/55">
                <Badge className="border-red-400/20 bg-red-500/15 text-red-200">静态Markdown终版</Badge>
                <span>{report.displayDate}</span>
              </div>
              <h1 className="mt-4 font-serif-cn text-3xl font-semibold tracking-tight sm:text-5xl">{report.conclusion.cycle}</h1>
              <p className="mt-2 text-base text-red-200 sm:text-lg">{report.conclusion.substate}</p>
              <p className="mt-5 max-w-4xl text-sm leading-7 text-white/70">{report.conclusion.summary}</p>
            </div>
            <div className="flex items-end justify-between gap-6 rounded-2xl border border-white/10 bg-white/5 p-4 lg:block lg:min-w-44">
              <div>
                <div className="text-xs text-white/50">情绪温度</div>
                <div className="mt-1 font-mono text-5xl font-semibold text-red-400">{report.conclusion.temperature}</div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 lg:flex-col">
                <Button asChild className="gap-2 bg-red-600 hover:bg-red-500">
                  <a href={pdfPath} download><Download className="size-4" />下载PDF</a>
                </Button>
                <Button asChild variant="outline" className="gap-2 border-white/20 bg-white/5 text-white hover:bg-white/10 hover:text-white">
                  <a href={markdownPath} download><Download className="size-4" />下载Markdown</a>
                </Button>
              </div>
            </div>
          </div>
        </section>

        <section className="my-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {[
            ['上涨', number.format(report.market.up), true],
            ['下跌', number.format(report.market.down), false],
            ['涨停 / 跌停', `${report.market.limitUp} / ${report.market.limitDown}`, true],
            ['连板 / 最高板', `${report.market.connected} / ${report.market.highestBoard}`, true],
            ['昨日红开率', `${report.yesterdayFeedback.redOpenRate}%`, true],
            ['昨日晋级率', `${report.yesterdayFeedback.continuedLimitRate}%`, true],
          ].map(([label, value, positive]) => (
            <Card key={String(label)} className="gap-2 py-4 ring-border/70">
              <CardContent>
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className={`mt-2 flex items-center gap-1 font-mono text-xl font-semibold ${positive ? 'text-market-up' : 'text-market-down'}`}>
                  {positive ? <ArrowUpRight className="size-4" /> : <ArrowDownRight className="size-4" />}{value}
                </div>
              </CardContent>
            </Card>
          ))}
        </section>

        <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-950">
          <Flame className="size-4 shrink-0" />{report.effects.relayDifficulty}
        </div>

        <MarkdownReport markdown={markdown} />

        <footer className="mt-4 rounded-xl border border-dashed bg-card/70 p-4 text-xs leading-5 text-muted-foreground">
          {report.sources.note} 客观行情主链：{report.sources.objective.join(' → ')}；题材：{report.sources.themes.join(' → ')}；市场叙事：{report.sources.narratives.join(' → ')}。
        </footer>
      </div>
    </main>
  );
}
