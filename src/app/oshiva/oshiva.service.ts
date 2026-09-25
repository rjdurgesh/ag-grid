import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { ApiDataService } from '../shared/api-data.service';
import { API } from '../shared/api-endpoints';
import { environment } from '../../environments/environment';
import { AuthService } from '../auth/auth.service';

/** One event from the agent's SSE stream (mirrors backend oshiva/agents/runner.py event types). */
export type OshivaEvent =
  | { type: 'start'; conversation_id: string; message_id: string }
  | { type: 'route'; agent: string; title: string }
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string }
  | { type: 'token'; text: string }
  | { type: 'final'; content: string }
  | { type: 'error'; detail: string }
  | { type: 'done'; conversation_id: string; message_id: string };

/** A prior turn sent back for context (kept short client-side). */
export interface ChatTurn { role: 'user' | 'assistant'; content: string; }

/**
 * Data access for OSHIVA (the OLS Hybrid Intelligence Virtual Assistant).
 *
 * {@link available} gates the launcher (server decides who may use it). {@link chat} streams the agent's
 * events over SSE — implemented with `fetch` + a stream reader (not HttpClient) so we can read the body
 * incrementally and still send the bearer token. {@link feedback} records 👍/👎.
 */
@Injectable({ providedIn: 'root' })
export class OshivaService {
  private readonly api = inject(ApiDataService);
  private readonly auth = inject(AuthService);

  /** Is the assistant enabled for this user? (false on any error → launcher stays hidden.) */
  available(): Observable<boolean> {
    return this.api
      .post<{ enabled?: boolean }>(API.assistant.available, { caller: this.caller() })
      .pipe(map((r) => !!r?.enabled));
  }

  /** Stream one question. Emits each {@link OshivaEvent}; completes on `done`/error. Unsubscribe aborts. */
  chat(message: string, history: ChatTurn[], conversationId?: string): Observable<OshivaEvent> {
    return new Observable<OshivaEvent>((sub) => {
      const controller = new AbortController();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = this.auth.token;
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      fetch(API.assistant.chat, {
        method: 'POST',
        headers,
        body: JSON.stringify({ caller: this.caller(), message, history, conversation_id: conversationId }),
        signal: controller.signal
      })
        .then(async (res) => {
          if (!res.ok || !res.body) {
            sub.next({ type: 'error', detail: `Assistant request failed (${res.status}).` });
            sub.complete();
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) { break; }
            buffer += decoder.decode(value, { stream: true });
            // SSE frames are separated by a blank line.
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const line = frame.split('\n').find((l) => l.startsWith('data:'));
              if (!line) { continue; }
              try {
                sub.next(JSON.parse(line.slice(5).trim()) as OshivaEvent);
              } catch { /* ignore a malformed frame */ }
            }
          }
          sub.complete();
        })
        .catch((err) => {
          if (controller.signal.aborted) { sub.complete(); return; }
          sub.next({ type: 'error', detail: 'Could not reach the assistant. Is the backend running?' });
          sub.complete();
        });
      return () => controller.abort();
    });
  }

  /** Record a thumbs up/down on an answer. */
  feedback(conversationId: string, messageId: string, vote: 'up' | 'down', comment?: string): Observable<unknown> {
    return this.api.post(API.assistant.feedback, {
      caller: this.caller(), conversation_id: conversationId, message_id: messageId, vote, comment
    });
  }

  /** Expire a conversation's server-side memory (called on "New chat"). */
  reset(conversationId: string): Observable<unknown> {
    return this.api.post(API.assistant.reset, { caller: this.caller(), conversation_id: conversationId });
  }

  private caller(): string {
    return this.auth.user()?.username || environment.username;
  }
}
