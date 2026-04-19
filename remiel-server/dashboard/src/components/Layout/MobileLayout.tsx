import { useState } from 'react';
import { Hash, MessageSquare, FileText, Settings } from 'lucide-react';
import { ChannelList } from '../ChannelList';
import { MessageTimeline } from '../MessageTimeline';
import { MessageDetail } from '../MessageDetail';
import { StatusBar } from '../StatusBar';
import clsx from 'clsx';

type Tab = 'channels' | 'messages' | 'detail' | 'settings';

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
  { id: 'settings', icon: Settings, label: 'Settings' },
];

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

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
        {activeTab === 'channels' && (
          <ChannelList
            selectedId={selectedChannelId}
            onSelect={(id) => { onSelectChannel(id); setActiveTab('messages'); }}
          />
        )}
        {activeTab === 'messages' && (
          <MessageTimeline
            channelId={selectedChannelId}
            selectedMessageId={selectedMessageId}
            onSelectMessage={onSelectMessage}
            threadTs={threadTs}
            onEnterThread={onEnterThread}
            onExitThread={onExitThread}
          />
        )}
        {activeTab === 'detail' && (
          <MessageDetail
            channelId={selectedChannelId}
            messageId={selectedMessageId}
          />
        )}
        {activeTab === 'settings' && (
          <div className="p-4">
            <StatusBar />
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="h-14 flex items-center justify-around border-t border-border bg-card shrink-0">
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
