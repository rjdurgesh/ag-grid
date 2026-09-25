import {
  Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Subscription } from 'rxjs';

import { OshivaService, ChatTurn } from './oshiva.service';
import { OshivaRobotComponent } from './oshiva-robot.component';

/** One rendered chat message. */
interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  agent?: string;             // which agent the coordinator routed to (e.g. "Ops agent")
  tools: string[];            // tool names invoked this turn (the trace)
  streaming: boolean;
  messageId?: string;         // server id (for feedback)
  vote?: 'up' | 'down';
  error?: boolean;
  at: number;                 // client timestamp
  copied?: boolean;
}

/**
 * OSHIVA widget — a premium floating launcher + chat drawer, mounted once in the default layout.
 *
 * Self-gating (only renders for allow-listed users). Streams the agent's answer token-by-token with a
 * live tool trace, auto-scroll + jump-to-latest, stop/copy/feedback, an auto-growing composer, and focus
 * management. Zoneless (all state is signals). Every animation has a complete static fallback so it stays
 * fully usable under `prefers-reduced-motion: reduce` (office default).
 */
@Component({
  selector: 'app-oshiva-widget',
  standalone: true,
  imports: [FormsModule, OshivaRobotComponent],
  templateUrl: './oshiva-widget.component.html',
  styleUrls: ['./oshiva-widget.component.scss'],
  host: { '(document:keydown.escape)': 'onEsc()' }
})
export class OshivaWidgetComponent {
  private readonly svc = inject(OshivaService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly destroyRef = inject(DestroyRef);

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly composer = viewChild<ElementRef<HTMLTextAreaElement>>('composer');

  readonly enabled = signal(false);
  readonly open = signal(false);
  readonly busy = signal(false);
  readonly draft = signal('');
  readonly messages = signal<ChatMsg[]>([]);
  readonly atBottom = signal(true);

  private conversationId?: string;
  private streamSub?: Subscription;
  private readonly reduceMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  readonly canSend = computed(() => !this.busy() && this.draft().trim().length > 0);
  readonly isEmpty = computed(() => this.messages().length === 0);
  readonly status = computed(() => (this.busy() ? 'Thinking…' : 'Online'));

  readonly suggestions = [
    { icon: 'server',  text: 'List the CIB Windows servers' },
    { icon: 'pulse',   text: 'Service status on SRV-CIB-07' },
    { icon: 'db',      text: 'Blocking sessions on the CIB batch DB' }
  ];

  constructor() {
    this.svc.available().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ok) => this.enabled.set(ok),
      error: () => this.enabled.set(false)
    });
    // Auto-scroll to the newest content as messages/tokens change (only if the user is at the bottom).
    effect(() => {
      this.messages();
      if (this.open() && this.atBottom()) { this.scrollToBottomSoon(); }
    });
    // Focus the composer when the panel opens.
    effect(() => {
      if (this.open()) { queueMicrotask(() => this.composer()?.nativeElement.focus()); }
    });
  }

  toggle(): void { this.open.set(!this.open()); }

  onEsc(): void { if (this.open()) { this.open.set(false); } }

  ask(text: string): void { this.draft.set(text); this.send(); }

  send(): void {
    const text = this.draft().trim();
    if (!text || this.busy()) { return; }
    this.draft.set('');
    this.resetComposerHeight();

    const userMsg: ChatMsg = { id: rid(), role: 'user', content: text, tools: [], streaming: false, at: Date.now() };
    const botMsg: ChatMsg = { id: rid(), role: 'assistant', content: '', tools: [], streaming: true, at: Date.now() };
    this.messages.update((m) => [...m, userMsg, botMsg]);
    this.busy.set(true);
    this.atBottom.set(true);

    const history: ChatTurn[] = this.messages()
      .filter((m) => !m.streaming && !m.error && m.id !== userMsg.id && m.id !== botMsg.id)
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));

    this.streamSub = this.svc.chat(text, history, this.conversationId)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (ev) => {
          switch (ev.type) {
            case 'start':
              this.conversationId = ev.conversation_id;
              this.patch(botMsg.id, (m) => (m.messageId = ev.message_id));
              break;
            case 'route':
              this.patch(botMsg.id, (m) => (m.agent = ev.title));
              break;
            case 'tool':
              this.patch(botMsg.id, (m) => { if (!m.tools.includes(ev.name)) { m.tools = [...m.tools, ev.name]; } });
              break;
            case 'token':
              this.patch(botMsg.id, (m) => (m.content += ev.text));
              break;
            case 'final':
              this.patch(botMsg.id, (m) => (m.content = ev.content || m.content));
              break;
            case 'error':
              this.patch(botMsg.id, (m) => { m.content = ev.detail; m.error = true; });
              break;
            case 'done':
              this.patch(botMsg.id, (m) => (m.streaming = false));
              this.busy.set(false);
              break;
          }
        },
        error: () => {
          this.patch(botMsg.id, (m) => { m.content = 'Something went wrong.'; m.error = true; m.streaming = false; });
          this.busy.set(false);
        },
        complete: () => {
          this.patch(botMsg.id, (m) => (m.streaming = false));
          this.busy.set(false);
        }
      });
  }

  /** Cancel an in-flight stream (aborts the fetch via the service's teardown). */
  stop(): void {
    this.streamSub?.unsubscribe();
    this.streamSub = undefined;
    this.messages.update((list) => list.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
    this.busy.set(false);
  }

  vote(msg: ChatMsg, vote: 'up' | 'down'): void {
    if (!msg.messageId || msg.vote) { return; }
    this.patch(msg.id, (m) => (m.vote = vote));
    this.svc.feedback(this.conversationId ?? '', msg.messageId, vote)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ error: () => {} });
  }

  copy(msg: ChatMsg): void {
    navigator.clipboard?.writeText(msg.content).then(() => {
      this.patch(msg.id, (m) => (m.copied = true));
      setTimeout(() => this.patch(msg.id, (m) => (m.copied = false)), 1400);
    }).catch(() => {});
  }

  newChat(): void {
    this.stop();
    const prev = this.conversationId;
    if (prev) {
      // Expire the old conversation's server-side memory (fire-and-forget).
      this.svc.reset(prev).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ error: () => {} });
    }
    this.conversationId = undefined;
    this.messages.set([]);
    queueMicrotask(() => this.composer()?.nativeElement.focus());
  }

  onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); this.send(); }
  }

  /** Auto-grow the composer up to a cap. */
  onInput(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  onScroll(el: HTMLElement): void {
    this.atBottom.set(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }

  jumpToLatest(): void { this.atBottom.set(true); this.scrollToBottomSoon(); }

  /** Escape then apply **bold** and `code`; newlines kept by CSS `white-space: pre-wrap`. Safe: escaped first. */
  render(content: string): SafeHtml {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // 1) Pull out fenced ``` code blocks first (SQL, aligned tables) → a scrollable monospace <pre>, and
    //    protect their content from the inline transforms below via placeholders.
    const blocks: string[] = [];
    let html = (content ?? '').replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, (_m, code) => {
      blocks.push('<pre style="margin:.4rem 0;padding:.5rem;background:rgba(127,127,127,.14);'
        + 'border-radius:6px;overflow-x:auto;font-size:12px;line-height:1.45;white-space:pre">'
        + `<code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
      return `\u0000B${blocks.length - 1}\u0000`;
    });
    // 2) escape the rest, then inline code / bold / links.
    html = esc(html)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((\/[^)\s]+|https?:\/\/[^)\s]+)\)/g, (_m, txt, url) => {
        const ext = /^https?:/.test(url);
        const attr = ext ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<a href="${url}"${attr}>${txt}</a>`;
      })
      .replace(/(^|[^"(=])(https?:\/\/[^\s<]+)/g,
        (_m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    // 3) restore the fenced blocks.
    html = html.replace(/\u0000B(\d+)\u0000/g, (_m, i) => blocks[+i]);
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  toolLabel(name: string): string {
    return ({ list_servers: 'Listing servers', service_status: 'Checking service status',
      blocking_sessions: 'Checking blocking sessions' } as Record<string, string>)[name] || name;
  }

  /** Full, locale-independent stamp: "23-Sep-2026 08:52 AM". */
  time(ts: number): string {
    try {
      const d = new Date(ts);
      const day = String(d.getDate()).padStart(2, '0');
      const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
      const ampm = d.getHours() < 12 ? 'AM' : 'PM';
      const hh = String(((d.getHours() + 11) % 12) + 1).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${day}-${mon}-${d.getFullYear()} ${hh}:${mm} ${ampm}`;
    } catch { return ''; }
  }

  private patch(id: string, fn: (m: ChatMsg) => void): void {
    this.messages.update((list) => list.map((m) => {
      if (m.id !== id) { return m; }
      const copy = { ...m };
      fn(copy);
      return copy;
    }));
  }

  private scrollToBottomSoon(): void {
    requestAnimationFrame(() => {
      const el = this.scroller()?.nativeElement;
      if (el) { el.scrollTo({ top: el.scrollHeight, behavior: this.reduceMotion ? 'auto' : 'smooth' }); }
    });
  }

  private resetComposerHeight(): void {
    const el = this.composer()?.nativeElement;
    if (el) { el.style.height = 'auto'; }
  }
}

function rid(): string { return Math.random().toString(36).slice(2, 10); }
