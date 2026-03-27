export interface QueuedMessage {
  channelId: string;
  threadTs: string;
  userId: string;
  userName: string;
  text: string;
  isBot: boolean;
  receivedAt: number; // Date.now() ms when the message entered the queue
}

type MessageHandler = (message: QueuedMessage) => Promise<void>;

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private processing = false;
  private handler: MessageHandler;

  constructor(handler: MessageHandler) {
    this.handler = handler;
  }

  enqueue(message: QueuedMessage): void {
    this.queue.push(message);
    if (!this.processing) {
      this.drain();
    }
  }

  private async drain(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const message = this.queue.shift()!;
      try {
        await this.handler(message);
      } catch (error) {
        console.error(`[Queue] Error processing message:`, error);
      }
    }
    this.processing = false;
  }
}
