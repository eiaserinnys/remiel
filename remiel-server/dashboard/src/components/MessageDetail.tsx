import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Bot, User, MessageSquare, Brain } from 'lucide-react';
import { api } from '../api/client';
import type { Message, Interpretation } from '../api/client';

interface MessageDetailProps {
  channelId: string | null;
  messageId: string | null;
}

export function MessageDetail({ channelId, messageId }: MessageDetailProps) {
  // Find the selected message from the messages query cache
  const { data: messages = [] } = useQuery({
    queryKey: ['messages', channelId],
    queryFn: () => api.getMessages(channelId!, { limit: 200 }),
    enabled: !!channelId,
  });

  const message = messages.find((m: Message) => m.id === messageId);

  // Fetch thread if message has thread_ts
  const threadTs = message?.thread_ts ?? message?.ts;
  const { data: thread = [] } = useQuery({
    queryKey: ['thread', channelId, threadTs],
    queryFn: () => api.getThread(channelId!, threadTs!),
    enabled: !!channelId && !!threadTs && !!message,
  });

  // Fetch interpretations
  const { data: interpretations = [] } = useQuery({
    queryKey: ['interpretations', messageId],
    queryFn: () => api.getInterpretations(messageId!),
    enabled: !!messageId,
  });

  if (!messageId || !message) {
    return (
      <div className="flex flex-col h-full">
        <div className="h-10 px-4 flex items-center shrink-0 border-b border-border">
          <span className="text-xs font-semibold uppercase tracking-[0.5px] text-muted-foreground">
            Detail
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          Select a message
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="h-10 px-4 flex items-center shrink-0 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-[0.5px] text-muted-foreground">
          Detail
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Message content */}
        <div className="px-4 py-4 border-b border-border">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-full flex items-center justify-center bg-muted">
              {message.is_bot ? <Bot size={16} className="text-muted-foreground" /> : <User size={16} className="text-muted-foreground" />}
            </div>
            <div>
              <div className="text-sm font-semibold">{message.user_name}</div>
              <div className="text-[11px] text-muted-foreground">
                {new Date(message.created_at || message.ts).toLocaleString()}
              </div>
            </div>
          </div>
          <div className="prose-remiel text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
              {message.content}
            </ReactMarkdown>
          </div>
          {message.reactions && message.reactions.length > 0 && (
            <div className="flex gap-1.5 mt-3 flex-wrap">
              {message.reactions.map((r, i) => (
                <span key={i} className="text-xs bg-muted border border-border px-2 py-1 rounded-[8px]">
                  {r.emoji} {r.users.length}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Thread replies */}
        {thread.length > 1 && (
          <div className="border-b border-border">
            <div className="px-4 py-2 flex items-center gap-1.5">
              <MessageSquare size={14} className="text-muted-foreground" />
              <span className="text-xs font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                Thread ({thread.length - 1} replies)
              </span>
            </div>
            {thread.slice(1).map((reply: Message) => (
              <div key={reply.id} className="px-4 py-2.5 border-t border-border/30">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium">{reply.user_name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(reply.created_at || reply.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground">{reply.content}</div>
              </div>
            ))}
          </div>
        )}

        {/* Interpretations */}
        {interpretations.length > 0 && (
          <div>
            <div className="px-4 py-2 flex items-center gap-1.5">
              <Brain size={14} className="text-muted-foreground" />
              <span className="text-xs font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                Interpretations ({interpretations.length})
              </span>
            </div>
            {interpretations.map((interp: Interpretation) => (
              <div key={interp.id} className="px-4 py-3 border-t border-border/30">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[11px] font-medium text-brand bg-brand/10 px-2 py-0.5 rounded-[5px]">
                    {interp.type}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(interp.created_at).toLocaleString()}
                  </span>
                </div>
                <div className="prose-remiel text-sm">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                    {interp.content}
                  </ReactMarkdown>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
