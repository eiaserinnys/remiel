import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Bot, User, MessageSquare, Brain, Paperclip, Link, FileText, Image, Loader2, AlertCircle } from 'lucide-react';
import { api } from '../api/client';
import type { Message, Interpretation, EnrichmentItem, CrawlResult, AttachmentResult } from '../api/client';

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

  // Fetch enrichments
  const { data: enrichments = [] } = useQuery({
    queryKey: ['enrichments', messageId],
    queryFn: () => api.getEnrichments(messageId!),
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

        {/* Enrichments */}
        {enrichments.length > 0 && (
          <div className="border-b border-border">
            <div className="px-4 py-2 flex items-center gap-1.5">
              <Paperclip size={14} className="text-muted-foreground" />
              <span className="text-xs font-semibold uppercase tracking-[0.5px] text-muted-foreground">
                Enrichments ({enrichments.length})
              </span>
            </div>
            {enrichments.map((item: EnrichmentItem) => (
              <EnrichmentCard key={item.id} item={item} />
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

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileName(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/');
    return decodeURIComponent(parts[parts.length - 1] || url);
  } catch {
    return url;
  }
}

function isCrawlResult(result: unknown): result is CrawlResult {
  return result != null && typeof result === 'object' && 'fetched_at' in result && 'title' in result;
}

function isAttachmentResult(result: unknown): result is AttachmentResult {
  return result != null && typeof result === 'object' && 'verified_at' in result && 'content_type' in result;
}

function EnrichmentCard({ item }: { item: EnrichmentItem }) {
  if (item.status === 'pending' || item.status === 'processing') {
    return (
      <div className="px-4 py-2.5 border-t border-border/30 flex items-center gap-2">
        <Loader2 size={14} className="text-muted-foreground animate-spin" />
        <span className="text-xs text-muted-foreground">{getFileName(item.target)}</span>
        <span className="text-[11px] text-muted-foreground/60">{item.status}</span>
      </div>
    );
  }

  if (item.status === 'failed') {
    return (
      <div className="px-4 py-2.5 border-t border-border/30">
        <div className="flex items-center gap-2">
          <AlertCircle size={14} className="text-destructive" />
          <span className="text-xs truncate flex-1">{getFileName(item.target)}</span>
        </div>
        {item.error && (
          <div className="text-[11px] text-destructive/80 mt-1 ml-[22px]">{item.error}</div>
        )}
      </div>
    );
  }

  // done
  if (item.type === 'link_crawl' && isCrawlResult(item.result)) {
    const r = item.result;
    return (
      <div className="px-4 py-2.5 border-t border-border/30">
        <div className="flex items-start gap-2">
          <Link size={14} className="text-muted-foreground mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <a href={item.target} target="_blank" rel="noopener noreferrer"
              className="text-xs font-medium text-brand hover:underline leading-tight block truncate">
              {r.title || getFileName(item.target)}
            </a>
            {r.description && (
              <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{r.description}</div>
            )}
            {r.excerpt && !r.description && (
              <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{r.excerpt}</div>
            )}
          </div>
          {r.image && (
            <img src={r.image} alt="" className="w-16 h-12 rounded object-cover shrink-0" />
          )}
        </div>
      </div>
    );
  }

  if (item.type === 'attachment' && isAttachmentResult(item.result)) {
    const r = item.result;
    const isImage = r.content_type?.startsWith('image/');
    return (
      <div className="px-4 py-2.5 border-t border-border/30">
        <div className="flex items-center gap-2">
          {isImage ? <Image size={14} className="text-muted-foreground" /> : <FileText size={14} className="text-muted-foreground" />}
          <a href={item.target} target="_blank" rel="noopener noreferrer"
            className="text-xs font-medium text-brand hover:underline truncate flex-1">
            {getFileName(item.target)}
          </a>
        </div>
        <div className="flex items-center gap-3 mt-1 ml-[22px]">
          {r.content_type && (
            <span className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{r.content_type}</span>
          )}
          <span className="text-[11px] text-muted-foreground">{formatFileSize(r.content_length)}</span>
        </div>
      </div>
    );
  }

  // Fallback for unexpected result shapes
  return (
    <div className="px-4 py-2.5 border-t border-border/30 flex items-center gap-2">
      <Paperclip size={14} className="text-muted-foreground" />
      <span className="text-xs truncate">{getFileName(item.target)}</span>
      <span className="text-[11px] text-muted-foreground/60">{item.type}</span>
    </div>
  );
}
