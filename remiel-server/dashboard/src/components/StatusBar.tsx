import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export function StatusBar() {
  const { data } = useQuery({
    queryKey: ['enrichment-status'],
    queryFn: api.getEnrichmentStatus,
    refetchInterval: 10_000,
  });

  const queue = data?.queue ?? { pending: 0, processing: 0, done: 0, failed: 0 };

  return (
    <div className="h-8 px-4 flex items-center gap-4 text-[11px] text-muted-foreground border-t border-border bg-card shrink-0">
      <span className="font-medium uppercase tracking-[0.5px]">Enrichment</span>
      <span className="flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-status-pending" />
        {queue.pending} pending
      </span>
      <span className="flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-status-processing" />
        {queue.processing} processing
      </span>
      <span className="flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-status-done" />
        {queue.done} done
      </span>
      <span className="flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-status-failed" />
        {queue.failed} failed
      </span>
    </div>
  );
}
