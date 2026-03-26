import { appendFile, readFile, writeFile } from "fs/promises";
import { join } from "path";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface TimingEntry {
  ts: string;        // ISO timestamp of the log write
  msgTs: string;     // Slack message ts
  user: string;      // userName
  text: string;      // message text (first 80 chars)
  received: 0;       // always 0 — baseline anchor
  dequeued: number;  // ms after received
  claudeStart: number;
  claudeDone: number;
  posted: number | null;
  skipped: boolean;
}

export interface TimingContext {
  receivedAt: number;
  msgTs: string;
  user: string;
  text: string;
}

export class TimingLogger {
  private readonly logPath: string;
  private lastCleanup = 0;

  constructor(workspaceDir: string) {
    this.logPath = join(workspaceDir, "timing.log");
  }

  /** Call once at startup, then the periodic cleanup runs automatically. */
  async initialize(): Promise<void> {
    await this.cleanup();
    this.schedulePeriodicCleanup();
  }

  /** Record a completed timing entry. Failures are isolated — never throws. */
  async record(
    ctx: TimingContext,
    dequeuedAt: number,
    claudeStartAt: number,
    claudeDoneAt: number,
    postedAt: number | null,
    skipped: boolean,
  ): Promise<void> {
    const base = ctx.receivedAt;
    const entry: TimingEntry = {
      ts: new Date().toISOString(),
      msgTs: ctx.msgTs,
      user: ctx.user,
      text: ctx.text.slice(0, 80),
      received: 0,
      dequeued: dequeuedAt - base,
      claudeStart: claudeStartAt - base,
      claudeDone: claudeDoneAt - base,
      posted: postedAt !== null ? postedAt - base : null,
      skipped,
    };

    try {
      await appendFile(this.logPath, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
      console.warn(`[Timing] Failed to write log entry:`, err);
    }
  }

  private async cleanup(): Promise<void> {
    this.lastCleanup = Date.now();
    try {
      const raw = await readFile(this.logPath, "utf8").catch(() => "");
      if (!raw.trim()) return;

      const cutoff = Date.now() - RETENTION_MS;
      const kept = raw
        .split("\n")
        .filter((line) => {
          if (!line.trim()) return false;
          try {
            const entry = JSON.parse(line) as { ts: string };
            return new Date(entry.ts).getTime() >= cutoff;
          } catch {
            return false; // discard malformed lines
          }
        })
        .join("\n");

      await writeFile(this.logPath, kept ? kept + "\n" : "", "utf8");
    } catch (err) {
      console.warn(`[Timing] Cleanup failed:`, err);
    }
  }

  private schedulePeriodicCleanup(): void {
    const tick = () => {
      this.cleanup().finally(() => {
        setTimeout(tick, CLEANUP_INTERVAL_MS).unref();
      });
    };
    setTimeout(tick, CLEANUP_INTERVAL_MS).unref();
  }
}
