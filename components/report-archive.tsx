'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Archive, FileText } from 'lucide-react';

import { Badge } from '@/components/ui/badge';

type Item = { date: string; displayDate: string; cycle: string; substate: string; temperature: number };

export function ReportArchive({ initial, reportsBaseUrl }: { initial: Item[]; reportsBaseUrl: string }) {
  const [remote, setRemote] = useState<Item[]>([]);

  useEffect(() => {
    fetch(`${reportsBaseUrl}/index.json`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : []))
      .then((items) => setRemote(Array.isArray(items) ? items : []))
      .catch(() => setRemote([]));
  }, [reportsBaseUrl]);

  const items = useMemo(() => {
    const merged = new Map(initial.map((item) => [item.date, item]));
    for (const item of remote) merged.set(item.date, item);
    return [...merged.values()].sort((a, b) => b.date.localeCompare(a.date));
  }, [initial, remote]);
  const localDates = new Set(initial.map((item) => item.date));

  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><Archive className="size-4 text-primary" />报告归档</h2>
      <div className="mt-3 space-y-2">
        {items.map((item, index) => (
          <Link key={item.date} href={localDates.has(item.date) ? `/reports/${item.date}` : `/reports/view?date=${item.date}`} className="flex items-center justify-between rounded-xl border p-3 transition hover:border-primary/40 hover:bg-muted/35">
            <div>
              <div className="text-sm font-medium">{item.date}</div>
              <div className="mt-1 text-xs text-muted-foreground">{item.cycle} · {item.temperature}°</div>
            </div>
            {index === 0 ? <Badge className="bg-red-100 text-red-800">最新</Badge> : <FileText className="size-4 text-muted-foreground" />}
          </Link>
        ))}
      </div>
    </div>
  );
}
