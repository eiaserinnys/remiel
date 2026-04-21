import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Save, Loader2, Check, ArrowLeft } from 'lucide-react';
import { api } from '../api/client';
import type { InterpretationPrompt } from '../api/client';

export function PromptsPage({ onBack }: { onBack: () => void }) {
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);

  const { data: prompts = [], isLoading } = useQuery({
    queryKey: ['prompts'],
    queryFn: api.getPrompts,
  });

  const { data: prompt } = useQuery({
    queryKey: ['prompt', selectedKey],
    queryFn: () => api.getPrompt(selectedKey!),
    enabled: !!selectedKey,
  });

  const mutation = useMutation({
    mutationFn: ({ key, content }: { key: string; content: string }) =>
      api.updatePrompt(key, content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompts'] });
      queryClient.invalidateQueries({ queryKey: ['prompt', selectedKey] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  function handleSelect(key: string) {
    setSelectedKey(key);
    setSaved(false);
    // Load content from cache or wait for query
    const cached = queryClient.getQueryData<InterpretationPrompt>(['prompt', key]);
    if (cached) {
      setDraft(cached.content);
    } else {
      setDraft('');
    }
  }

  // Sync draft when prompt data arrives
  if (prompt && selectedKey && draft === '' && prompt.key === selectedKey) {
    setDraft(prompt.content);
  }

  const isDirty = prompt ? draft !== prompt.content : false;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-10 px-4 flex items-center gap-2 shrink-0 border-b border-border">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <span className="text-xs font-semibold uppercase tracking-[0.5px] text-muted-foreground">
          Interpretation Prompts
        </span>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: prompt list */}
        <div className="w-56 shrink-0 border-r border-border overflow-y-auto">
          {isLoading ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading...</div>
          ) : prompts.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">No prompts</div>
          ) : (
            prompts.map((p: InterpretationPrompt) => (
              <button
                key={p.key}
                onClick={() => handleSelect(p.key)}
                className={`w-full px-4 py-3 text-left transition-colors border-b border-border/30 ${
                  selectedKey === p.key ? 'bg-brand/10 text-brand' : 'hover:bg-accent'
                }`}
              >
                <div className="flex items-center gap-2">
                  <FileText size={14} className="shrink-0 opacity-60" />
                  <span className="text-sm font-medium truncate">{p.key}</span>
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {new Date(p.updated_at).toLocaleString()}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Right: editor */}
        <div className="flex-1 flex flex-col">
          {!selectedKey ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Select a prompt to edit
            </div>
          ) : (
            <>
              <div className="px-4 py-2 flex items-center gap-2 border-b border-border shrink-0">
                <span className="text-sm font-medium flex-1">{selectedKey}</span>
                <button
                  onClick={() => {
                    if (selectedKey && isDirty) {
                      mutation.mutate({ key: selectedKey, content: draft });
                    }
                  }}
                  disabled={!isDirty || mutation.isPending}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] text-xs font-medium transition-colors ${
                    saved
                      ? 'bg-green-500/10 text-green-600'
                      : isDirty
                        ? 'bg-brand text-white hover:bg-brand/90'
                        : 'bg-muted text-muted-foreground cursor-not-allowed'
                  }`}
                >
                  {mutation.isPending ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : saved ? (
                    <Check size={12} />
                  ) : (
                    <Save size={12} />
                  )}
                  {saved ? 'Saved' : 'Save'}
                </button>
              </div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="flex-1 p-4 text-sm font-mono bg-background resize-none focus:outline-none"
                spellCheck={false}
                placeholder="Prompt content..."
              />
              {mutation.isError && (
                <div className="px-4 py-2 text-xs text-destructive bg-destructive/10 border-t border-destructive/30">
                  {mutation.error?.message ?? 'Failed to save'}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
