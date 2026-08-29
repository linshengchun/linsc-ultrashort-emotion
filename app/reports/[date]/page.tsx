import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ReportView } from '@/components/report-view';
import { reportByDate, reportMarkdown, reports } from '@/lib/generated-reports';

const repositoryUrl = process.env.NEXT_PUBLIC_REPOSITORY_URL ?? 'https://github.com/linshengchun/linsc-ultrashort-emotion';

export function generateStaticParams() {
  return reports.map((report) => ({ date: report.date }));
}

export async function generateMetadata({ params }: { params: Promise<{ date: string }> }): Promise<Metadata> {
  const { date } = await params;
  const report = reportByDate.get(date);
  if (!report) return {};
  return {
    title: `${report.displayDate}｜LINSC超短情绪复盘`,
    description: `${report.conclusion.cycle}：${report.conclusion.substate}。${report.conclusion.summary}`,
    openGraph: { images: [] },
    twitter: { images: [] },
  };
}

export default async function ReportPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  const report = reportByDate.get(date);
  if (!report) notFound();
  return <ReportView report={report} markdown={reportMarkdown[date]} workflowUrl={`${repositoryUrl}/actions/workflows/manual-report.yml`} />;
}
