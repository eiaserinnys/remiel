import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bot, User, Paperclip, ArrowDown, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../api/client';
import type { Message, MessagesPage } from '../api/client';

interface MessageTimelineProps {
  channelId: string | null;
  selectedMessageId: string | null;
  onSelectMessage: (id: string | null) => void;
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

export function MessageTimeline({ channelId, selectedMessageId, onSelectMessage }: MessageTimelineProps) {
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
      api.getMessages(channelId!, {
        limit: PAGE_SIZE,
        ...(pageParam ? { before: pageParam as string } : {}),
      }),
    enabled: !!channelId,
    initialPageParam: undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMoreOlder && lastPage.oldestCursor ? lastPage.oldestCursor : undefined,
    // SSE로 증분 갱신하므로 stale 기반 자동 refetch는 막는다.
    staleTime: Infinity,
  });

  // 페이지 순서: pages[0]=최신, pages[1]=이전, pages[2]=더 이전...
  // 화면은 시간 오름차순(오래된→최신)이므로 역순 concat하며 id 기준 dedup.
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
    // 가변 높이를 실측으로 반영.
    measureElement: (el) => el.getBoundingClientRect().height,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  // ——— 스크롤 상태 & 새 메시지 토스트 ———
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [pendingNewCount, setPendingNewCount] = useState(0);
  const prevMessageCountRef = useRef(0);

  // 채널 전환 시 페치 완료 상태 등을 리셋.
  useEffect(() => {
    prevMessageCountRef.current = 0;
    setPendingNewCount(0);
    setIsAtBottom(true);
  }, [channelId]);

  // 메시지 수 증가 감지: 맨 아래 상태가 아니면 미확인 카운터 증가.
  useEffect(() => {
    const prev = prevMessageCountRef.current;
    const curr = messages.length;
    if (curr > prev && prev > 0 && !isAtBottom) {
      setPendingNewCount((n) => n + (curr - prev));
    }
    prevMessageCountRef.current = curr;
    // isAtBottom은 ref가 아닌 state라 의존성에서 제외 — 최신 값을 사용하기 위해 참조.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // ——— 초기 맨 아래 스크롤 ———
  const initialScrolledRef = useRef(false);
  useEffect(() => {
    // 채널 전환 시 플래그 리셋.
    initialScrolledRef.current = false;
  }, [channelId]);

  useLayoutEffect(() => {
    if (initialScrolledRef.current) return;
    if (!data || data.pages.length === 0) return;
    if (rows.length === 0) return;
    const el = parentRef.current;
    if (!el) return;
    // 가상화 측정 사이클 직후 스크롤을 이동.
    el.scrollTop = el.scrollHeight;
    initialScrolledRef.current = true;
    setIsAtBottom(true);
  }, [data, rows.length]);

  // ——— 이전 페이지 로드 후 스크롤 위치 보정 ———
  const prevTotalSizeRef = useRef(0);
  const prevPageCountRef = useRef(0);
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const pageCount = data?.pages.length ?? 0;
    // 과거 페이지가 '앞쪽'(오래된 쪽)에 추가되면 totalSize가 증가한다.
    // 최초 로드(prevPageCount=0 → 1)는 초기 스크롤 로직이 처리하므로 제외.
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

    // 맨 아래 감지.
    const atBottom = scrollTop + clientHeight >= scrollHeight - AT_BOTTOM_THRESHOLD;
    if (atBottom !== isAtBottom) {
      setIsAtBottom(atBottom);
      if (atBottom) setPendingNewCount(0);
    }

    // 맨 위 근처 + 더 불러올 게 있음 → 이전 페이지 프리패치.
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

  // ——— 렌더 ———
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

  return (
    <div className="flex flex-col h-full relative">
      <div className="h-10 px-4 flex items-center shrink-0 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-[0.5px] text-muted-foreground">
          Messages
        </span>
        <span className="ml-auto text-xs text-muted-foreground">{messages.length}</span>
      </div>

      {/* 페치 실패 배너 */}
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
            {/* 이전 페이지 프리패치 중 상단 표시 */}
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
                        onSelect={onSelectMessage}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* '↓ N개 새 메시지' 토스트 */}
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

interface MessageRowProps {
  msg: Message;
  selected: boolean;
  onSelect: (id: string | null) => void;
}

function MessageRow({ msg, selected, onSelect }: MessageRowProps) {
  return (
    <button
      onClick={() => onSelect(msg.id)}
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
          {msg.thread_ts && msg.thread_ts !== msg.ts && (
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-[5px] shrink-0">
              thread
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
