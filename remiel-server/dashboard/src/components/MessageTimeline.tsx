import { useQuery } from '@tanstack/react-query';
import { Bot, User } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../api/client';
import type { Message } from '../api/client';

interface MessageTimelineProps {
  channelId: string | null;
  selectedMessageId: string | null;
  onSelectMessage: (id: string | null) => void;
}

function formatTime(ts: string): string {
  try {
    const date = new Date(ts);
    if (isNaN(date.getTime())) {
      // ts might be a Slack-style timestamp (seconds.microseconds)
      const epochMs = parseFloat(ts) * 1000;
      const d = new Date(epochMs);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}

function formatDate(ts: string): string {
  try {
    const date = new Date(ts);
    if (isNaN(date.getTime())) {
      const epochMs = parseFloat(ts) * 1000;
      const d = new Date(epochMs);
      return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}

export function MessageTimeline({ channelId, selectedMessageId, onSelectMessage }: MessageTimelineProps) {
  const { data: messages = [], isLoading } = useQuery({
    queryKey: ['messages', channelId],
    queryFn: () => api.getMessages(channelId!, { limit: 200 }),
    enabled: !!channelId,
    refetchInterval: 15_000,
  });

  if (!channelId) {
    return (
      <div className="flex flex-col h-full">
        <div className="h-10 px-4 flex items-center shrink-0 border-b border-border">
          <span className="text-xs font-semibold uppercase tracking-[0.5px] text-muted-foreground">
            Messages
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          Select a channel
        </div>
      </div>
    );
  }

  // Group messages by date
  const grouped: { date: string; messages: Message[] }[] = [];
  let currentDate = '';
  for (const msg of messages) {
    const d = formatDate(msg.created_at || msg.ts);
    if (d !== currentDate) {
      currentDate = d;
      grouped.push({ date: d, messages: [] });
    }
    grouped[grouped.length - 1].messages.push(msg);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-10 px-4 flex items-center shrink-0 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-[0.5px] text-muted-foreground">
          Messages
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {messages.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading...</div>
        ) : messages.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">No messages</div>
        ) : (
          grouped.map((group) => (
            <div key={group.date}>
              <div className="sticky top-0 px-4 py-1.5 text-[11px] font-medium text-muted-foreground bg-background/90 backdrop-blur-sm border-b border-border/50">
                {group.date}
              </div>
              {group.messages.map((msg) => (
                <button
                  key={msg.id}
                  onClick={() => onSelectMessage(msg.id)}
                  className={clsx(
                    'w-full px-4 py-2.5 flex items-start gap-2.5 text-left transition-colors border-b border-border/30',
                    selectedMessageId === msg.id
                      ? 'bg-brand/10'
                      : 'hover:bg-accent',
                  )}
                >
                  <div className="w-6 h-6 rounded-full flex items-center justify-center bg-muted shrink-0 mt-0.5">
                    {msg.is_bot ? <Bot size={14} className="text-muted-foreground" /> : <User size={14} className="text-muted-foreground" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={clsx(
                        'text-sm font-medium truncate',
                        selectedMessageId === msg.id ? 'text-brand' : 'text-foreground',
                      )}>
                        {msg.user_name}
                      </span>
                      <span className="text-[11px] text-muted-foreground shrink-0">
                        {formatTime(msg.created_at || msg.ts)}
                      </span>
                      {msg.thread_ts && msg.thread_ts !== msg.ts && (
                        <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-[5px] shrink-0">
                          thread
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground line-clamp-2 mt-0.5">
                      {msg.content}
                    </div>
                    {msg.reactions && msg.reactions.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {msg.reactions.map((r, i) => (
                          <span key={i} className="text-[11px] bg-muted px-1.5 py-0.5 rounded-[5px]">
                            {r.emoji} {r.users.length}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
