import { RemoteReport } from '@/components/remote-report';

const repositoryUrl = process.env.NEXT_PUBLIC_REPOSITORY_URL ?? 'https://github.com/linshengchun/linsc-ultrashort-emotion';
const reportsBaseUrl = process.env.NEXT_PUBLIC_REPORTS_RAW_BASE ?? 'https://raw.githubusercontent.com/linshengchun/linsc-ultrashort-emotion/main/public/reports';

export default async function RemoteReportPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date = '' } = await searchParams;
  return <RemoteReport date={date} reportsBaseUrl={reportsBaseUrl} workflowUrl={`${repositoryUrl}/actions/workflows/manual-report.yml`} />;
}
