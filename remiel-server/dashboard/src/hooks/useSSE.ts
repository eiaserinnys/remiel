import { useEffect, useRef, useCallback } from 'react';

export interface SSEEvent {
  type: string;
  data: unknown;
  timestamp: string;
}

export function useSSE(onEvent: (event: SSEEvent) => void) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    const es = new EventSource('/events');
    es.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data) as SSEEvent;
        onEventRef.current(parsed);
      } catch {
        // ignore malformed events
      }
    };
    es.onerror = () => {
      es.close();
      setTimeout(connect, 3000);
    };
    return es;
  }, []);

  useEffect(() => {
    const es = connect();
    return () => es.close();
  }, [connect]);
}
