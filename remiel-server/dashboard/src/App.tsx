import { useState, useCallback } from 'react';
import { Login } from './Login';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { ThreePanelLayout } from './components/Layout/ThreePanelLayout';
import { MobileLayout } from './components/Layout/MobileLayout';
import { ChannelList } from './components/ChannelList';
import { MessageTimeline } from './components/MessageTimeline';
import { MessageDetail } from './components/MessageDetail';
import { StatusBar } from './components/StatusBar';
import { ThemeToggle } from './components/ThemeToggle';
import { useMobile } from './hooks/useMobile';
import { useSSE } from './hooks/useSSE';
import type { SSEEvent } from './hooks/useSSE';
import type { Message, MessagesPage } from './api/client';

type MessagesInfiniteData = InfiniteData<MessagesPage>;

/**
 * `pages[0]`(최신 페이지)의 끝에 새 메시지를 append.
 * 이미 동일 id가 존재하면 append하지 않고 기존 항목을 교체한다(dup 방지).
 * 새 메시지의 커서(`ts:id`)로 `newestCursor`를 갱신한다.
 */
function appendMessage(
  data: MessagesInfiniteData | undefined,
  msg: Message,
): MessagesInfiniteData | undefined {
  if (!data || data.pages.length === 0) return data;
  const pages = data.pages.slice();
  const latest = pages[0];
  const existingIdx = latest.messages.findIndex((m) => m.id === msg.id);
  const newestCursor = `${msg.ts}:${msg.id}`;
  if (existingIdx >= 0) {
    const newMessages = latest.messages.slice();
    newMessages[existingIdx] = msg;
    pages[0] = { ...latest, messages: newMessages };
  } else {
    pages[0] = {
      ...latest,
      messages: [...latest.messages, msg],
      newestCursor,
    };
  }
  return { ...data, pages };
}

/** 부모 메시지의 reply_count를 낙관적으로 증분. thread_ts로 부모를 검색한다. */
function incrementReplyCount(
  data: MessagesInfiniteData | undefined,
  threadTs: string,
): MessagesInfiniteData | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    const idx = page.messages.findIndex((m) => m.ts === threadTs);
    if (idx < 0) return page;
    changed = true;
    const newMessages = page.messages.slice();
    newMessages[idx] = { ...newMessages[idx], reply_count: (newMessages[idx].reply_count || 0) + 1 };
    return { ...page, messages: newMessages };
  });
  return changed ? { ...data, pages } : data;
}

/** 모든 페이지에서 id가 일치하는 메시지를 찾아 제자리 교체. */
function replaceMessage(
  data: MessagesInfiniteData | undefined,
  msg: Message,
): MessagesInfiniteData | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    const idx = page.messages.findIndex((m) => m.id === msg.id);
    if (idx < 0) return page;
    changed = true;
    const newMessages = page.messages.slice();
    newMessages[idx] = msg;
    return { ...page, messages: newMessages };
  });
  return changed ? { ...data, pages } : data;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      gcTime: 1000 * 60 * 30, // 30분간 가비지 컬렉션 방지
      retry: 1,
    },
  },
});

function AppInner() {
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [threadTs, setThreadTs] = useState<string | null>(null);
  const isMobile = useMobile();

  const handleSelectChannel = useCallback((id: string | null) => {
    setSelectedChannelId(id);
    setSelectedMessageId(null);
    setThreadTs(null);
  }, []);

  const handleSelectMessage = useCallback((id: string | null) => {
    setSelectedMessageId(id);
  }, []);

  const handleEnterThread = useCallback((ts: string) => {
    setThreadTs(ts);
    setSelectedMessageId(null);
  }, []);

  const handleExitThread = useCallback(() => {
    setThreadTs(null);
  }, []);

  // SSE: 서버 이벤트를 받아 캐시를 직접 갱신한다.
  // - message:created → pages[0] append (+ 채널 목록은 count 때문에 invalidate)
  // - message:updated → 모든 페이지에서 찾아 replace
  // 스크롤 위치/가상화 상태를 깨지 않기 위해 invalidateQueries는 메시지 갱신에 사용하지 않는다.
  useSSE(useCallback((event: SSEEvent) => {
    switch (event.type) {
      case 'message:created': {
        const msg = event.data as Message;
        if (!msg?.channel_id) return;

        if (msg.thread_ts && msg.thread_ts !== msg.ts) {
          // 스레드 답글: 타임라인에 추가하지 않고 부모의 reply_count 증가
          queryClient.setQueryData<MessagesInfiniteData>(
            ['messages', msg.channel_id],
            (prev) => incrementReplyCount(prev, msg.thread_ts!),
          );
          // 스레드 캐시 무효화 (스레드 뷰가 열려있으면 자동 갱신)
          queryClient.invalidateQueries({ queryKey: ['thread', msg.channel_id, msg.thread_ts] });
        } else {
          // 채널 메시지: 기존 로직대로 타임라인에 append
          queryClient.setQueryData<MessagesInfiniteData>(
            ['messages', msg.channel_id],
            (prev) => appendMessage(prev, msg),
          );
        }
        // 의도적: 스레드 답글도 채널의 최신 활동 시간을 갱신하므로 channels 재조회
        queryClient.invalidateQueries({ queryKey: ['channels'] });
        break;
      }
      case 'message:updated': {
        const msg = event.data as Message;
        if (!msg?.channel_id) return;
        queryClient.setQueryData<MessagesInfiniteData>(
          ['messages', msg.channel_id],
          (prev) => replaceMessage(prev, msg),
        );
        break;
      }
      case 'enrichment:completed':
      case 'enrichment:failed':
        queryClient.invalidateQueries({ queryKey: ['enrichment-status'] });
        queryClient.invalidateQueries({ queryKey: ['enrichments'] });
        break;
      case 'interpretation:created':
        queryClient.invalidateQueries({ queryKey: ['interpretations'] });
        break;
    }
  }, []));

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      {/* Top bar */}
      <div
        className="h-12 flex items-center gap-4 px-4 shrink-0"
        style={{
          background: 'rgba(0, 0, 0, 0.8)',
          backdropFilter: 'saturate(180%) blur(20px)',
          WebkitBackdropFilter: 'saturate(180%) blur(20px)',
        }}
      >
        <span className="text-sm font-semibold text-white tracking-[-0.28px] font-sans shrink-0">
          remiel
        </span>
        <div className="flex-1" />
        <ThemeToggle />
      </div>

      {/* Layout */}
      <div className="flex-1 overflow-hidden">
        {isMobile ? (
          <MobileLayout
            selectedChannelId={selectedChannelId}
            selectedMessageId={selectedMessageId}
            onSelectChannel={handleSelectChannel}
            onSelectMessage={handleSelectMessage}
            threadTs={threadTs}
            onEnterThread={handleEnterThread}
            onExitThread={handleExitThread}
          />
        ) : (
          <ThreePanelLayout
            left={
              <ChannelList
                selectedId={selectedChannelId}
                onSelect={handleSelectChannel}
              />
            }
            center={
              <MessageTimeline
                channelId={selectedChannelId}
                selectedMessageId={selectedMessageId}
                onSelectMessage={handleSelectMessage}
                threadTs={threadTs}
                onEnterThread={handleEnterThread}
                onExitThread={handleExitThread}
              />
            }
            right={
              <MessageDetail
                channelId={selectedChannelId}
                messageId={selectedMessageId}
              />
            }
          />
        )}
      </div>

      {/* Status bar */}
      {!isMobile && <StatusBar />}
    </div>
  );
}

function App() {
  if (window.location.pathname === '/login') {
    return <Login />;
  }
  return (
    <QueryClientProvider client={queryClient}>
      <AppInner />
    </QueryClientProvider>
  );
}

export default App;
