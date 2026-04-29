const getBaseUrl = () => {
    const url = import.meta.env.VITE_GATEWAY_URL || '';
    return url.endsWith('/') ? url.slice(0, -1) : url;
};

export interface BaseSSEEvent {
  node_id: string;
  agent_name: string;
  progress: number;
  timestamp: number;
}

export interface NodeStartEvent extends BaseSSEEvent {
  event: 'node_start';
  content: string;
}

export interface NodeCompleteEvent extends BaseSSEEvent {
  event: 'node_complete';
  content: string;
}

export interface SynthesisEvent extends BaseSSEEvent {
  event: 'synthesis';
  content: string;
}

export interface HitlPauseEvent extends BaseSSEEvent {
  event: 'hitl_pause';
  content: string;
  pause_id: string;
}

export interface HitlApprovedEvent extends BaseSSEEvent {
  event: 'hitl_approved';
  content: string;
}

export interface HitlRejectedEvent extends BaseSSEEvent {
  event: 'hitl_rejected';
  content: string;
}

export interface HitlTimeoutEvent extends BaseSSEEvent {
  event: 'hitl_timeout';
  content: string;
}

export interface DeliveryEvent extends BaseSSEEvent {
  event: 'delivery';
  content: string; // JSON representation 
}

export interface DoneEvent extends BaseSSEEvent {
  event: 'done';
  content: string; // JSON representation 
}

export interface ErrorEvent extends BaseSSEEvent {
  event: 'error';
  content: string;
}

export type AnyGraphSSEEvent = 
  | NodeStartEvent
  | NodeCompleteEvent
  | SynthesisEvent
  | HitlPauseEvent
  | HitlApprovedEvent
  | HitlRejectedEvent
  | HitlTimeoutEvent
  | DeliveryEvent
  | DoneEvent
  | ErrorEvent;

export class GraphSSEClient {
  private abortController: AbortController | null = null;
  
  async execute(
    payload: { graph: { nodes: any[], edges: any[] }, tenant_id: string, model?: string, session_id?: string },
    handlers: { 
        onEvent: (event: AnyGraphSSEEvent) => void, 
        onError: (error: Error) => void, 
        onComplete: () => void 
    }
  ) {
    this.abortController = new AbortController();
    
    try {
      const response = await fetch(`${getBaseUrl()}/graph/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Execution Failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('ReadableStream no soportado.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || ''; // El último trozo suele estar incompleto, lo dejamos en el buffer
        
        for (const line of lines) {
          if (line.trim().startsWith('data:')) {
            const dataStr = line.replace('data:', '').trim();
            if (dataStr === '[DONE]') continue;
            
            if (dataStr) {
               try {
                   const parsed = JSON.parse(dataStr) as AnyGraphSSEEvent;
                   handlers.onEvent(parsed);
               } catch(e) {
                   console.error("Parse JSON error for event:", e, dataStr);
               }
            }
          }
        }
      }
      handlers.onComplete();
    } catch (e: any) {
      if (e.name === 'AbortError') {
         console.log("Graph Execution Stream aborted by user.");
      } else {
         handlers.onError(e);
      }
    }
  }

  stop() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
