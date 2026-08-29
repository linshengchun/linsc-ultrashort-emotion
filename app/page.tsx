import Link from 'next/link';
import { Archive, Clock3, Radar } from 'lucide-react';

import { ReportArchive } from '@/components/report-archive';
import { ReportFinder } from '@/components/report-finder';
import { ReportView } from '@/components/report-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { latestReport, reportMarkdown, reports } from '@/lib/generated-reports';

const repositoryUrl = process.env.NEXT_PUBLIC_REPOSITORY_URL ?? 'https://github.com/linshengchun/linsc-ultrashort-emotion';
const reportsBaseUrl = process.env.NEXT_PUBLIC_REPORTS_RAW_BASE ?? 'https://raw.githubusercontent.com/linshengchun/linsc-ultrashort-emotion/main/public/reports';

export default function Home() {
  const workflowUrl = `${repositoryUrl}/actions/workflows/manual-report.yml`;

  return (
    <>
      <header className="border-b bg-card/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground shadow-[0_8px_24px_rgba(198,48,43,.22)]"><Radar className="size-5" /></div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-semibold tracking-tight">LINSC · 超短情绪台</h1>
                <Badge className="bg-red-100 text-red-800">静态报告库</Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">盘中看变化，盘后看结构；报告缺失时手动生成</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="h-8 bg-background px-3"><Clock3 className="size-3.5" />最新：{latestReport.displayDate}</Badge>
            <Button asChild variant="outline" size="sm" className="gap-2"><Link href="#archive"><Archive className="size-4" />历史归档</Link></Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1480px] gap-4 px-4 py-5 sm:px-6 lg:grid-cols-[330px_minmax(0,1fr)] lg:px-8">
        <aside id="archive" className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <ReportFinder availableDates={reports.map((report) => report.date)} workflowUrl={workflowUrl} reportsBaseUrl={reportsBaseUrl} />
          <ReportArchive
            reportsBaseUrl={reportsBaseUrl}
            initial={reports.map((report) => ({ date: report.date, displayDate: report.displayDate, cycle: report.conclusion.cycle, substate: report.conclusion.substate, temperature: report.conclusion.temperature }))}
          />
        </aside>
        <div className="min-w-0"><ReportView report={latestReport} markdown={reportMarkdown[latestReport.date]} workflowUrl={workflowUrl} embedded /></div>
      </div>
    </>
  );
}
