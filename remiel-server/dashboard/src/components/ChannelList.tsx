import { useQuery } from '@tanstack/react-query';
import { Hash, Search } from 'lucide-react';
import { useState } from 'react';
import clsx from 'clsx';
import { api } from '../api/client';
import type { Channel } from '../api/client';

interface ChannelListProps {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function ChannelList({ selectedId, onSelect }: ChannelListProps) {
  const [filter, setFilter] = useState('');
  const { data: channels = [], isLoading } = useQuery({
    queryKey: ['channels'],
    queryFn: api.getChannels,
    refetchInterval: 30_000,
  });

  const filtered = filter
    ? channels.filter((c: Channel) => c.name.toLowerCase().includes(filter.toLowerCase()))
    : channels;

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="h-10 px-4 flex items-center shrink-0 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-[0.5px] text-muted-foreground">
          Channels
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {channels.length}
        </span>
      </div>

      {/* Search */}
      <div className="px-3 py-2 shrink-0">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter channels..."
            className="w-full rounded-[8px] px-[14px] py-[10px] pl-8 text-sm bg-input border border-input-border focus:border-brand focus:outline-none transition-colors"
          />
        </div>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">No channels</div>
        ) : (
          filtered.map((channel: Channel) => (
            <button
              key={channel.id}
              onClick={() => onSelect(channel.id)}
              className={clsx(
                'w-full px-4 py-2.5 flex items-center gap-2.5 text-left transition-colors',
                selectedId === channel.id
                  ? 'bg-brand/10 text-brand'
                  : 'hover:bg-accent text-foreground',
              )}
            >
              <Hash size={16} className="shrink-0 opacity-50" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{channel.name}</div>
                <div className="text-xs text-muted-foreground">
                  {channel.message_count} messages
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
