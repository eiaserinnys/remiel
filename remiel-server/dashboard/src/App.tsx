import { useState, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 1,
    },
  },
});

function AppInner() {
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const isMobile = useMobile();

  const handleSelectChannel = useCallback((id: string | null) => {
    setSelectedChannelId(id);
    setSelectedMessageId(null);
  }, []);

  const handleSelectMessage = useCallback((id: string | null) => {
    setSelectedMessageId(id);
  }, []);

  // SSE: invalidate relevant queries on server events
  useSSE(useCallback((event: SSEEvent) => {
    switch (event.type) {
      case 'message:created':
      case 'message:updated':
        queryClient.invalidateQueries({ queryKey: ['messages'] });
        queryClient.invalidateQueries({ queryKey: ['channels'] });
        break;
      case 'enrichment:completed':
      case 'enrichment:failed':
        queryClient.invalidateQueries({ queryKey: ['enrichment-status'] });
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
  return (
    <QueryClientProvider client={queryClient}>
      <AppInner />
    </QueryClientProvider>
  );
}

export default App;
