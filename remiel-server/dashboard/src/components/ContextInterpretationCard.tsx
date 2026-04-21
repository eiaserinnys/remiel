import type { Interpretation } from '../api/client';

interface Addressee {
  id: string;
  name: string;
}

interface ContextInterpretation {
  message_id: string;
  addressees: Addressee[];
  intent: string;
  summary: string;
  confidence: number;
  adversarial_note?: string;
}

function tryParseContext(interp: Interpretation): ContextInterpretation | null {
  if (interp.type !== 'context') return null;
  try {
    const meta = interp.metadata as Record<string, unknown>;
    if (!meta || typeof meta !== 'object') return null;
    return {
      message_id: (meta.message_id as string) ?? interp.message_id ?? '',
      addressees: Array.isArray(meta.addressees)
        ? (meta.addressees as unknown[]).map((a): Addressee => {
            if (a && typeof a === 'object' && 'id' in a) {
              const obj = a as Record<string, unknown>;
              return { id: String(obj.id), name: String(obj.name ?? obj.id) };
            }
            // 하위 호환: 문자열(user_id만 저장된 이전 데이터)
            return { id: String(a), name: String(a) };
          })
        : [],
      intent: (meta.intent as string) ?? '',
      summary: (meta.summary as string) ?? interp.content,
      confidence: typeof meta.confidence === 'number' ? meta.confidence : 0,
      adversarial_note: (meta.adversarial_note as string) ?? undefined,
    };
  } catch {
    return null;
  }
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    value >= 0.8 ? 'bg-green-500' :
    value >= 0.5 ? 'bg-yellow-500' :
    'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] text-muted-foreground tabular-nums">{pct}%</span>
    </div>
  );
}

interface Props {
  interpretation: Interpretation;
}

export function ContextInterpretationCard({ interpretation }: Props) {
  const ctx = tryParseContext(interpretation);

  if (!ctx) {
    // Fallback: render content as plain text
    return (
      <div className="px-4 py-3 border-t border-border/30">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[11px] font-medium text-brand bg-brand/10 px-2 py-0.5 rounded-[5px]">
            context
          </span>
          <span className="text-[11px] text-muted-foreground">
            {new Date(interpretation.created_at).toLocaleString()}
          </span>
        </div>
        <div className="text-sm text-muted-foreground">{interpretation.content}</div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-t border-border/30 space-y-2">
      {/* Header: type badge + intent + timestamp */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-medium text-brand bg-brand/10 px-2 py-0.5 rounded-[5px]">
          context
        </span>
        {ctx.intent && (
          <span className="text-[11px] font-medium text-foreground bg-accent px-2 py-0.5 rounded-[5px]">
            {ctx.intent}
          </span>
        )}
        <span className="text-[11px] text-muted-foreground ml-auto">
          {new Date(interpretation.created_at).toLocaleString()}
        </span>
      </div>

      {/* Summary */}
      <div className="text-sm">{ctx.summary}</div>

      {/* Addressees */}
      {ctx.addressees.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-muted-foreground">To:</span>
          {ctx.addressees.map((a, i) => (
            <span key={i} className="text-[11px] bg-muted px-1.5 py-0.5 rounded-[5px]" title={a.id}>
              {a.name}
            </span>
          ))}
        </div>
      )}

      {/* Confidence */}
      <ConfidenceBar value={ctx.confidence} />

      {/* Adversarial note */}
      {ctx.adversarial_note && (
        <div className="text-[11px] text-muted-foreground bg-muted/50 px-2.5 py-1.5 rounded-[6px] border border-border/50">
          {ctx.adversarial_note}
        </div>
      )}
    </div>
  );
}
