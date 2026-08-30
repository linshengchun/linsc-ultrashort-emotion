'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarSearch } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function ReportFinder({ availableDates, reportsBaseUrl }: { availableDates: string[]; reportsBaseUrl: string }) {
  const router = useRouter();
  const [date, setDate] = useState(availableDates[0] ?? '');
  const [missing, setMissing] = useState(false);
  const [checking, setChecking] = useState(false);

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

  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row lg:flex-col xl:flex-row xl:items-end">
        <label className="flex-1 text-xs font-medium text-muted-foreground">
          查询交易日
          <Input
            className="mt-2 h-10 bg-background"
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              setMissing(false);
            }}
          />
        </label>
        <Button className="h-10 gap-2" onClick={findReport} disabled={checking}>
          <CalendarSearch className="size-4" />
          {checking ? '查询中…' : '查看报告'}
        </Button>
      </div>

      {missing ? (
        <div className="mt-4 rounded-xl border border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <p className="font-medium">{date} 尚未上传静态报告。</p>
          <p className="mt-1 text-xs leading-5 text-amber-800">请在本地完成取数、Markdown/PDF生成后，将报告文件上传到 GitHub，再刷新本站。</p>
        </div>
      ) : null}
    </div>
  );
}
