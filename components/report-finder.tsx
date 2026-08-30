'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarSearch, FilePlus2, LoaderCircle, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function ReportFinder({ availableDates, reportsBaseUrl, generatorUrl }: { availableDates: string[]; reportsBaseUrl: string; generatorUrl?: string }) {
  const router = useRouter();
  const [date, setDate] = useState(availableDates[0] ?? '');
  const [missing, setMissing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');

  const findReport = async () => {
    if (!date) return;
    if (availableDates.includes(date)) {
      router.push(`/reports/${date}`);
      return;
    }
    setChecking(true);
    try {
      const response = await fetch(`${reportsBaseUrl}/${date}.md`, { cache: 'no-store' });
      if (response.ok) {
        router.push(`/reports/view?date=${date}`);
        return;
      }
      setMissing(true);
    } catch {
      setMissing(true);
    } finally {
      setChecking(false);
    }
  };

  const generateReport = async () => {
    if (!date || !generatorUrl) return;
    setGenerating(true);
    setError('');
    try {
      const response = await fetch(`${generatorUrl}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date }),
      });
      const result = await response.json() as { ok?: boolean; error?: string; reportUrl?: string };
      if (!response.ok || !result.ok) throw new Error(result.error || '报告生成失败。');
      window.location.assign(result.reportUrl ?? `/reports/${date}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '报告生成失败。');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row lg:flex-col xl:flex-row xl:items-end">
        <label htmlFor="report-date" className="flex-1 text-xs font-medium text-muted-foreground">
          查询交易日
          <Input
            id="report-date"
            className="mt-2 h-10 bg-background"
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              setMissing(false);
              setError('');
            }}
          />
        </label>
        <Button className="h-10 gap-2" onClick={findReport} disabled={checking}>
          <CalendarSearch className="size-4" />
          {checking ? '查询中…' : '查看报告'}
        </Button>
      </div>

      {generatorUrl ? (
        <Button variant="outline" className="mt-3 h-10 w-full gap-2" onClick={generateReport} disabled={!date || generating || checking}>
          {generating ? <LoaderCircle className="size-4 animate-spin" /> : availableDates.includes(date) ? <RotateCcw className="size-4" /> : <FilePlus2 className="size-4" />}
          {generating ? `Codex正在生成 ${date}…` : availableDates.includes(date) ? '重新生成本日报告' : '使用Codex生成本日报告'}
        </Button>
      ) : null}

      {missing ? (
        <div className="mt-4 rounded-xl border border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <p className="font-medium">{date} 尚未生成报告。</p>
          <p className="mt-1 text-xs leading-5 text-amber-800">本地运行时可直接使用Codex生成；线上生成入口将在API模式接入后启用。</p>
        </div>
      ) : null}
      {error ? <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800">{error}</div> : null}
    </div>
  );
}
