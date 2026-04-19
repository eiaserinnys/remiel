import { useState } from 'react';
import { Hash, MessageSquare, FileText, ArrowLeft } from 'lucide-react';
import { ChannelList } from '../ChannelList';
import { MessageTimeline } from '../MessageTimeline';
import { MessageDetail } from '../MessageDetail';
import { StatusBar } from '../StatusBar';
import clsx from 'clsx';

type Tab = 'channels' | 'messages' | 'detail';

interface MobileLayoutProps {
  selectedChannelId: string | null;
  selectedMessageId: string | null;
  onSelectChannel: (id: string | null) => void;
  onSelectMessage: (id: string | null) => void;
  threadTs?: string | null;
  onEnterThread?: (ts: string) => void;
  onExitThread?: () => void;
}

const tabs: { id: Tab; icon: typeof Hash; label: string }[] = [
  { id: 'channels', icon: Hash, label: 'Channels' },
  { id: 'messages', icon: MessageSquare, label: 'Messages' },
  { id: 'detail', icon: FileText, label: 'Detail' },
];

const TAB_INDEX: Record<Tab, number> = { channels: 0, messages: 1, detail: 2 };

function getDirection(tab: Tab, activeTab: Tab): 'left' | 'right' {
  return TAB_INDEX[tab] < TAB_INDEX[activeTab] ? 'left' : 'right';
}

export function MobileLayout({
  selectedChannelId,
  selectedMessageId,
  onSelectChannel,
  onSelectMessage,
  threadTs,
  onEnterThread,
  onExitThread,
}: MobileLayoutProps) {
  const [activeTab, setActiveTab] = useState<Tab>('channels');

  // 메시지 선택 시 detail 탭으로 자동 전환
  function handleSelectMessage(id: string | null) {
    onSelectMessage(id);
    if (id) {
      setActiveTab('detail');
    }
  }

  // Detail 패널에서 뒤로가기
  function handleBackFromDetail() {
    onSelectMessage(null);
    setActiveTab('messages');
  }

  return (
    <div className="flex flex-col h-full">
      {/* 패널 영역 — 모든 패널 항상 마운트, CSS 전환으로 토글 */}
      <div className="flex-1 overflow-hidden relative">
        {/* Channels 패널 */}
        <div
          className="absolute inset-0 flex flex-col mobile-panel"
          data-active={activeTab === 'channels'}
          data-direction={getDirection('channels', activeTab)}
        >
          <ChannelList
            selectedId={selectedChannelId}
            onSelect={(id) => {
              onSelectChannel(id);
              setActiveTab('messages');
            }}
          />
        </div>

        {/* Messages 패널 */}
        <div
          className="absolute inset-0 flex flex-col mobile-panel"
          data-active={activeTab === 'messages'}
          data-direction={getDirection('messages', activeTab)}
        >
          <MessageTimeline
            channelId={selectedChannelId}
            selectedMessageId={selectedMessageId}
            onSelectMessage={handleSelectMessage}
            threadTs={threadTs}
            onEnterThread={onEnterThread}
            onExitThread={onExitThread}
          />
        </div>

        {/* Detail 패널 */}
        <div
          className="absolute inset-0 flex flex-col mobile-panel"
          data-active={activeTab === 'detail'}
          data-direction={getDirection('detail', activeTab)}
        >
          {/* 백버튼 헤더 */}
          <div className="h-10 px-4 flex items-center gap-2 shrink-0 border-b border-border">
            <button
              onClick={handleBackFromDetail}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft size={14} />
              Back
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <MessageDetail
              channelId={selectedChannelId}
              messageId={selectedMessageId}
            />
          </div>
          <StatusBar />
        </div>
      </div>

      {/* Tab bar — safe-area-inset-bottom 대응 */}
      <div
        className="flex items-center justify-around border-t border-border bg-card shrink-0"
        style={{
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)',
          minHeight: '56px',
        }}
      >
        {tabs.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={clsx(
              'flex flex-col items-center gap-0.5 px-3 py-1 text-[11px] transition-colors',
              activeTab === id ? 'text-brand' : 'text-muted-foreground',
            )}
          >
            <Icon size={20} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
