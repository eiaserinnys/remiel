import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Bot, User, Paperclip, ArrowDown, ArrowLeft, RefreshCw, MessageSquare } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../api/client';
import type { Message, MessagesPage } from '../api/client';

interface MessageTimelineProps {
  channelId: string | null;
  selectedMessageId: string | null;
  onSelectMessage: (id: string | null) => void;
  threadTs?: string | null;
  onEnterThread?: (ts: string) => void;
  onExitThread?: () => void;
}

const PAGE_SIZE = 50;
const ESTIMATED_ROW_HEIGHT = 72;
const OVERSCAN = 8;
/** 맨 위에서 N px 이내로 접근하면 다음(과거) 페이지 프리패치. */
const NEAR_TOP_THRESHOLD = 200;
/** scrollTop+clientHeight가 scrollHeight에서 N px 이내면 "맨 아래"로 간주. */
const AT_BOTTOM_THRESHOLD = 50;

type Row =
  | { kind: 'date'; key: string; label: string }
  | { kind: 'message'; key: string; msg: Message };

function formatTime(ts: string): string {
  try {
    const date = new Date(ts);
    if (isNaN(date.getTime())) {
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

function buildRows(messages: Message[]): Row[] {
  const rows: Row[] = [];
  let currentDate = '';
  for (const msg of messages) {
    const d = formatDate(msg.created_at || msg.ts);
    if (d !== currentDate) {
      currentDate = d;
      rows.push({ kind: 'date', key: `date-${d}`, label: d });
    }
    rows.push({ kind: 'message', key: msg.id, msg });
  }
  return rows;
}

/**
 * MessageTimeline: 채널 메시지 목록과 스레드 뷰를 전환하는 래퍼.
 *
 * threadTs가 null이면 ChannelView(가상 스크롤), non-null이면 ThreadView(일반 스크롤).
 * 채널 뷰의 스크롤 위치는 channelScrollRef로 보존한다.
 */
export function MessageTimeline({
  channelId,
  selectedMessageId,
  onSelectMessage,
  threadTs = null,
  onEnterThread,
  onExitThread,
}: MessageTimelineProps) {
  // 채널 뷰 스크롤 위치 보존: 스레드 진입 전 scrollTop을 저장, 복귀 시 복원.
  const channelScrollRef = useRef<{ scrollTop: number }>({ scrollTop: 0 });

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

  if (threadTs) {
    return (
      <ThreadView
        channelId={channelId}
        threadTs={threadTs}
        selectedMessageId={selectedMessageId}
        onSelectMessage={onSelectMessage}
        onExitThread={onExitThread}
      />
    );
  }

  return (
    <ChannelView
      channelId={channelId}
      selectedMessageId={selectedMessageId}
      onSelectMessage={onSelectMessage}
      onEnterThread={onEnterThread}
      channelScrollRef={channelScrollRef}
    />
  );
}

// ═══════════════════════════════════════════
// ChannelView — 가상 스크롤 채널 메시지 목록
// ═══════════════════════════════════════════

interface ChannelViewProps {
  channelId: string;
  selectedMessageId: string | null;
  onSelectMessage: (id: string | null) => void;
  onEnterThread?: (ts: string) => void;
  channelScrollRef: React.MutableRefObject<{ scrollTop: number }>;
}

function ChannelView({
  channelId,
  selectedMessageId,
  onSelectMessage,
  onEnterThread,
  channelScrollRef,
}: ChannelViewProps) {
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<MessagesPage, Error>({
    queryKey: ['messages', channelId],
    queryFn: ({ pageParam }) =>
      api.getMessages(channelId, {
        limit: PAGE_SIZE,
        ...(pageParam ? { before: pageParam as string } : {}),
      }),
    enabled: true,
    initialPageParam: undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMoreOlder && lastPage.oldestCursor ? lastPage.oldestCursor : undefined,
    staleTime: Infinity,
  });

  // 페이지 순서: pages[0]=최신, pages[1]=이전, ...
  // 화면은 시간 오름차순이므로 역순 concat + dedup.
  const messages = useMemo<Message[]>(() => {
    if (!data) return [];
    const seen = new Set<string>();
    const flat: Message[] = [];
    for (let i = data.pages.length - 1; i >= 0; i--) {
      for (const m of data.pages[i].messages) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        flat.push(m);
      }
    }
    return flat;
  }, [data]);

  const rows = useMemo(() => buildRows(messages), [messages]);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN,
    measureElement: (el) => el.getBoundingClientRect().height,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  // ——— 스크롤 상태 & 새 메시지 토스트 ———
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [pendingNewCount, setPendingNewCount] = useState(0);
  const prevMessageCountRef = useRef(0);

  useEffect(() => {
    prevMessageCountRef.current = 0;
    setPendingNewCount(0);
    setIsAtBottom(true);
  }, [channelId]);

  useEffect(() => {
    const prev = prevMessageCountRef.current;
    const curr = messages.length;
    if (curr > prev && prev > 0 && !isAtBottom) {
      setPendingNewCount((n) => n + (curr - prev));
    }
    prevMessageCountRef.current = curr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // ——— 초기 맨 아래 스크롤 또는 저장된 위치 복원 ———
  const initialScrolledRef = useRef(false);
  useEffect(() => {
    initialScrolledRef.current = false;
  }, [channelId]);

  useLayoutEffect(() => {
    if (initialScrolledRef.current) return;
    if (!data || data.pages.length === 0) return;
    if (rows.length === 0) return;
    const el = parentRef.current;
    if (!el) return;

    // 저장된 스크롤 위치가 있으면 복원, 없으면 맨 아래.
    if (channelScrollRef.current.scrollTop > 0) {
      el.scrollTop = channelScrollRef.current.scrollTop;
    } else {
      el.scrollTop = el.scrollHeight;
    }
    initialScrolledRef.current = true;
    setIsAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - AT_BOTTOM_THRESHOLD);
  }, [data, rows.length, channelScrollRef]);

  // ——— 이전 페이지 로드 후 스크롤 위치 보정 ———
  const prevTotalSizeRef = useRef(0);
  const prevPageCountRef = useRef(0);
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const pageCount = data?.pages.length ?? 0;
    if (pageCount > prevPageCountRef.current && prevPageCountRef.current > 0) {
      const delta = totalSize - prevTotalSizeRef.current;
      if (delta > 0) {
        el.scrollTop = el.scrollTop + delta;
      }
    }
    prevTotalSizeRef.current = totalSize;
    prevPageCountRef.current = pageCount;
  }, [data?.pages.length, totalSize]);

  // ——— onScroll 핸들러 ———
  function handleScroll() {
    const el = parentRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;

    // 스크롤 위치 저장 (스레드 진입 시 복원용)
    channelScrollRef.current.scrollTop = scrollTop;

    const atBottom = scrollTop + clientHeight >= scrollHeight - AT_BOTTOM_THRESHOLD;
    if (atBottom !== isAtBottom) {
      setIsAtBottom(atBottom);
      if (atBottom) setPendingNewCount(0);
    }

    if (scrollTop < NEAR_TOP_THRESHOLD && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }

  function scrollToBottom() {
    const el = parentRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPendingNewCount(0);
    setIsAtBottom(true);
  }

  function handleMessageClick(msg: Message) {
    if (msg.reply_count > 0 && onEnterThread) {
      // 스레드가 있는 메시지: 스레드 진입
      onEnterThread(msg.ts);
    } else {
      // 스레드가 없는 메시지: 디테일 패널 선택
      onSelectMessage(msg.id);
    }
  }

  return (
    <div className="flex flex-col h-full relative">
      <div className="h-10 px-4 flex items-center shrink-0 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-[0.5px] text-muted-foreground">
          Messages
        </span>
        <span className="ml-auto text-xs text-muted-foreground">{messages.length}</span>
      </div>

      {isError && (
        <div className="px-4 py-2 flex items-center gap-2 text-xs text-destructive bg-destructive/10 border-b border-destructive/30">
          <span className="flex-1 truncate">메시지를 불러오지 못했습니다: {error?.message ?? 'Unknown error'}</span>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1 px-2 py-1 rounded bg-background hover:bg-accent border border-border"
          >
            <RefreshCw size={12} />
            재시도
          </button>
        </div>
      )}

      <div
        ref={parentRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto relative"
      >
        {isLoading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">No messages</div>
        ) : (
          <>
            {isFetchingNextPage && (
              <div className="absolute top-0 left-0 right-0 z-10 flex justify-center py-1 text-[11px] text-muted-foreground bg-background/80 backdrop-blur-sm pointer-events-none">
                이전 메시지 불러오는 중...
              </div>
            )}
            <div
              style={{
                height: totalSize,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualItems.map((virtualRow) => {
                const row = rows[virtualRow.index];
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {row.kind === 'date' ? (
                      <div className="px-4 py-1.5 text-[11px] font-medium text-muted-foreground bg-background/90 border-b border-border/50">
                        {row.label}
                      </div>
                    ) : (
                      <MessageRow
                        msg={row.msg}
                        selected={selectedMessageId === row.msg.id}
                        onClick={handleMessageClick}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {pendingNewCount > 0 && !isAtBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-brand text-white shadow-lg hover:bg-brand/90 transition-colors"
        >
          <ArrowDown size={12} />
          {pendingNewCount}개 새 메시지
        </button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// ThreadView — 일반 스크롤 스레드 메시지 목록
// ═══════════════════════════════════════════

interface ThreadViewProps {
  channelId: string;
  threadTs: string;
  selectedMessageId: string | null;
  onSelectMessage: (id: string | null) => void;
  onExitThread?: () => void;
}

function ThreadView({
  channelId,
  threadTs,
  selectedMessageId,
  onSelectMessage,
  onExitThread,
}: ThreadViewProps) {
  const { data: thread = [], isLoading } = useQuery({
    queryKey: ['thread', channelId, threadTs],
    queryFn: () => api.getThread(channelId, threadTs),
    enabled: true,
  });

  const rootMessage = thread[0];
  const replies = thread.slice(1);

  return (
    <div className="flex flex-col h-full">
      {/* 스레드 헤더 + 뒤로가기 버튼 */}
      <div className="h-10 px-4 flex items-center gap-2 shrink-0 border-b border-border">
        <button
          onClick={onExitThread}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <span className="text-xs font-semibold uppercase tracking-[0.5px] text-muted-foreground">
          Thread
        </span>
        {replies.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">{replies.length} replies</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading...</div>
        ) : thread.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">No messages</div>
        ) : (
          <>
            {/* 루트 메시지 */}
            {rootMessage && (
              <div
                className={clsx(
                  'px-4 py-3 border-b border-border cursor-pointer transition-colors',
                  selectedMessageId === rootMessage.id ? 'bg-brand/10' : 'hover:bg-accent',
                )}
                onClick={() => onSelectMessage(rootMessage.id)}
              >
                <div className="flex items-center gap-2 mb-2">
                  {rootMessage.avatar_url ? (
                    <img src={rootMessage.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" />
                  ) : (
                    <div className="w-8 h-8 rounded-full flex items-center justify-center bg-muted">
                      {rootMessage.is_bot ? <Bot size={14} className="text-muted-foreground" /> : <User size={14} className="text-muted-foreground" />}
                    </div>
                  )}
                  <div>
                    <span className="text-sm font-semibold">{rootMessage.user_name}</span>
                    <span className="text-[11px] text-muted-foreground ml-2">
                      {formatTime(rootMessage.created_at || rootMessage.ts)}
                    </span>
                  </div>
                </div>
                <div className="prose-remiel text-sm">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                    {rootMessage.content}
                  </ReactMarkdown>
                </div>
                {rootMessage.reactions && rootMessage.reactions.length > 0 && (
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {rootMessage.reactions.map((r, i) => (
                      <span key={i} className="text-[11px] bg-muted px-1.5 py-0.5 rounded-[5px]">
                        {r.emoji} {r.users.length}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 답글 구분선 */}
            {replies.length > 0 && (
              <div className="px-4 py-1.5 text-[11px] font-medium text-muted-foreground bg-background/90 border-b border-border/50">
                {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
              </div>
            )}

            {/* 답글 목록 — 1-depth 들여쓰기 */}
            {replies.map((reply) => (
              <div
                key={reply.id}
                className={clsx(
                  'pl-10 pr-4 py-2.5 border-b border-border/30 cursor-pointer transition-colors',
                  selectedMessageId === reply.id ? 'bg-brand/10' : 'hover:bg-accent',
                )}
                onClick={() => onSelectMessage(reply.id)}
              >
                <div className="flex items-center gap-2 mb-1">
                  {reply.avatar_url ? (
                    <img src={reply.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover" />
                  ) : (
                    <div className="w-5 h-5 rounded-full flex items-center justify-center bg-muted">
                      {reply.is_bot ? <Bot size={12} className="text-muted-foreground" /> : <User size={12} className="text-muted-foreground" />}
                    </div>
                  )}
                  <span className="text-xs font-medium">{reply.user_name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {formatTime(reply.created_at || reply.ts)}
                  </span>
                  {reply.enrichment_count > 0 && (
                    <span className="text-muted-foreground shrink-0" title={`${reply.enrichment_count} enrichment(s)`}>
                      <Paperclip size={12} />
                    </span>
                  )}
                </div>
                <div className="text-sm text-muted-foreground">{reply.content}</div>
                {reply.reactions && reply.reactions.length > 0 && (
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {reply.reactions.map((r, i) => (
                      <span key={i} className="text-[11px] bg-muted px-1.5 py-0.5 rounded-[5px]">
                        {r.emoji} {r.users.length}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// MessageRow — 채널 뷰의 메시지 행
// ═══════════════════════════════════════════

interface MessageRowProps {
  msg: Message;
  selected: boolean;
  onClick: (msg: Message) => void;
}

function MessageRow({ msg, selected, onClick }: MessageRowProps) {
  return (
    <button
      onClick={() => onClick(msg)}
      className={clsx(
        'w-full px-4 py-2.5 flex items-start gap-2.5 text-left transition-colors border-b border-border/30',
        selected ? 'bg-brand/10' : 'hover:bg-accent',
      )}
    >
      {msg.avatar_url ? (
        <img src={msg.avatar_url} alt="" className="w-6 h-6 rounded-full shrink-0 mt-0.5 object-cover" />
      ) : (
        <div className="w-6 h-6 rounded-full flex items-center justify-center bg-muted shrink-0 mt-0.5">
          {msg.is_bot ? (
            <Bot size={14} className="text-muted-foreground" />
          ) : (
            <User size={14} className="text-muted-foreground" />
          )}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={clsx(
              'text-sm font-medium truncate',
              selected ? 'text-brand' : 'text-foreground',
            )}
          >
            {msg.user_name}
          </span>
          <span className="text-[11px] text-muted-foreground shrink-0">
            {formatTime(msg.created_at || msg.ts)}
          </span>
          {msg.enrichment_count > 0 && (
            <span className="text-muted-foreground shrink-0" title={`${msg.enrichment_count} enrichment(s)`}>
              <Paperclip size={12} />
            </span>
          )}
          {msg.reply_count > 0 && (
            <span
              className="flex items-center gap-0.5 text-[10px] text-brand bg-brand/10 px-1.5 py-0.5 rounded-[5px] shrink-0"
              title={`${msg.reply_count} reply(ies)`}
            >
              <MessageSquare size={10} />
              {msg.reply_count}
            </span>
          )}
        </div>
        <div className="text-sm text-muted-foreground line-clamp-2 mt-0.5">{msg.content}</div>
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
  );
}
