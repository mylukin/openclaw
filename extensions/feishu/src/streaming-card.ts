/**
 * Feishu Streaming Card - Card Kit streaming API for real-time text output
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import { resolveFeishuCardTemplate, type CardHeaderConfig } from "./send.js";
import type { FeishuDomain } from "./types.js";

type Credentials = { appId: string; appSecret: string; domain?: FeishuDomain };
type CardState = {
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
  hasNote: boolean;
  noteText: string;
  header?: StreamingCardHeader;
  thinkingTitle: string;
  thinkingText: string;
  thinkingExpanded: boolean;
  thinkingPanelRendered: boolean;
};

/** Options for customising the initial streaming card appearance. */
export type StreamingCardOptions = {
  /** Optional header with title and color template. */
  header?: CardHeaderConfig;
  /** Optional grey note footer text. */
  note?: string;
};

/** Optional header for streaming cards (title bar with color template) */
export type StreamingCardHeader = {
  title: string;
  /** Color template: blue, green, red, orange, purple, indigo, wathet, turquoise, yellow, grey, carmine, violet, lime */
  template?: string;
};

type StreamingStartOptions = {
  replyToMessageId?: string;
  replyInThread?: boolean;
  rootId?: string;
  header?: StreamingCardHeader;
};

function truncateSummary(text: string, max = 50): string {
  if (!text) {
    return "";
  }
  const clean = stripHtmlTagsToText(text).replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}

function stripHtmlTagsToText(text: string): string {
  if (!text) {
    return "";
  }
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function mergeStreamingText(
  previousText: string | undefined,
  nextText: string | undefined,
): string {
  const previous = typeof previousText === "string" ? previousText : "";
  const next = typeof nextText === "string" ? nextText : "";
  if (!next) {
    return previous;
  }
  if (!previous || next === previous) {
    return next;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.startsWith(next)) {
    return previous;
  }
  if (next.includes(previous)) {
    return next;
  }
  if (previous.includes(next)) {
    return previous;
  }

  // Merge partial overlaps, e.g. "这" + "这是" => "这是".
  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.slice(-overlap) === next.slice(0, overlap)) {
      return `${previous}${next.slice(overlap)}`;
    }
  }
  // Fallback for fragmented partial chunks: append as-is to avoid losing tokens.
  return `${previous}${next}`;
}

export function resolveStreamingCardSendMode(options?: StreamingStartOptions) {
  if (options?.replyToMessageId) {
    return "reply";
  }
  if (options?.rootId) {
    return "root_create";
  }
  return "create";
}

/** Streaming card session manager */
export class FeishuStreamingSession {
  private client: Client;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private log?: (msg: string) => void;
  private lastUpdateTime = 0;
  private pendingText: string | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private updateThrottleMs = 100; // Throttle updates to max 10/sec
  private lastStreamingModeRenewAt = 0;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  // Feishu auto-closes streaming_mode 10 min after last open; renew at 8 min to stay ahead.
  private static readonly STREAMING_MODE_RENEW_INTERVAL_MS = 8 * 60 * 1000;

  constructor(client: Client, _creds: Credentials, log?: (msg: string) => void) {
    this.client = client;
    this.log = log;
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: StreamingCardOptions & StreamingStartOptions,
  ): Promise<void> {
    if (this.state) {
      return;
    }

    const elements: Record<string, unknown>[] = [
      { tag: "markdown", content: "⏳ Thinking...", element_id: "content" },
    ];
    if (options?.note) {
      elements.push({ tag: "hr" });
      elements.push({
        tag: "markdown",
        content: `<font color='grey'>${options.note}</font>`,
        element_id: "note",
      });
    }
    const cardJson: Record<string, unknown> = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 1 } },
      },
      body: { elements },
    };
    if (options?.header) {
      cardJson.header = {
        title: { tag: "plain_text", content: options.header.title },
        template: resolveFeishuCardTemplate(options.header.template) ?? "blue",
      };
    }

    // Create card entity via SDK
    const createData = await this.client.cardkit.v1.card.create({
      data: {
        type: "card_json",
        data: JSON.stringify(cardJson),
      },
    });
    if ((createData.code ?? 0) !== 0 || !createData.data?.card_id) {
      throw new Error(`Create card failed: ${createData.msg}`);
    }
    const cardId = createData.data.card_id;
    const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });

    // Prefer message.reply when we have a reply target — reply_in_thread
    // reliably routes streaming cards into Feishu topics, whereas
    // message.create with root_id may silently ignore root_id for card
    // references (card_id format).
    let sendRes;
    const sendOptions = options ?? {};
    const sendMode = resolveStreamingCardSendMode(sendOptions);
    if (sendMode === "reply") {
      sendRes = await this.client.im.message.reply({
        path: { message_id: sendOptions.replyToMessageId! },
        data: {
          msg_type: "interactive",
          content: cardContent,
          ...(sendOptions.replyInThread ? { reply_in_thread: true } : {}),
        },
      });
    } else if (sendMode === "root_create") {
      // root_id is undeclared in the SDK types but accepted at runtime
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: Object.assign(
          { receive_id: receiveId, msg_type: "interactive", content: cardContent },
          { root_id: sendOptions.rootId },
        ),
      });
    } else {
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: "interactive",
          content: cardContent,
        },
      });
    }
    if (sendRes.code !== 0 || !sendRes.data?.message_id) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }

    this.state = {
      cardId,
      messageId: sendRes.data.message_id,
      sequence: 1,
      currentText: "",
      hasNote: !!options?.note,
      noteText: options?.note ?? "",
      header: options?.header,
      thinkingTitle: "💭 Thinking",
      thinkingText: "",
      thinkingExpanded: true,
      thinkingPanelRendered: false,
    };
    this.lastStreamingModeRenewAt = Date.now();
    this.startRenewTimer();
    this.log?.(`Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}`);
  }

  /** Proactive timer -- renews streaming_mode even when no content updates are flowing. */
  private startRenewTimer(): void {
    this.stopRenewTimer();
    this.renewTimer = setInterval(() => {
      this.renewStreamingMode().catch(() => {});
    }, FeishuStreamingSession.STREAMING_MODE_RENEW_INTERVAL_MS);
    this.renewTimer.unref();
  }

  private stopRenewTimer(): void {
    if (this.renewTimer !== null) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }

  private async renewStreamingMode(): Promise<void> {
    if (!this.state) {
      return;
    }
    if (
      Date.now() - this.lastStreamingModeRenewAt <
      FeishuStreamingSession.STREAMING_MODE_RENEW_INTERVAL_MS
    ) {
      return;
    }
    // Snapshot the candidate sequence but only commit it to state on success,
    // so a failed renewal does not leave a permanent hole in the sequence.
    const nextSeq = this.state.sequence + 1;
    try {
      const response = await this.client.cardkit.v1.card.settings({
        path: { card_id: this.state.cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: true } }),
          sequence: nextSeq,
          uuid: `r_${this.state.cardId}_${nextSeq}`,
        },
      });
      if ((response.code ?? 0) !== 0) {
        throw new Error(response.msg || `code ${response.code}`);
      }
      this.state.sequence = nextSeq;
      this.lastStreamingModeRenewAt = Date.now();
      this.log?.(`Renewed streaming mode: cardId=${this.state.cardId}`);
    } catch (e) {
      this.log?.(`Renew streaming mode failed: ${String(e)}`);
    }
  }

  /** Push text to any element via the streaming element API. Returns true on success, false on failure. */
  private async updateElementContent(
    elementId: string,
    text: string,
    onError?: (error: unknown) => void,
  ): Promise<boolean> {
    if (!this.state) {
      return false;
    }
    await this.renewStreamingMode();
    // Snapshot the candidate sequence but only commit it to state on success,
    // so a failed update does not leave a permanent hole in the sequence.
    const nextSeq = this.state.sequence + 1;
    let ok = true;
    await this.client.cardkit.v1.cardElement
      .content({
        path: {
          card_id: this.state.cardId,
          element_id: elementId,
        },
        data: {
          content: text,
          sequence: nextSeq,
          uuid: `s_${this.state.cardId}_${nextSeq}`,
        },
      })
      .then((response) => {
        if ((response.code ?? 0) !== 0) {
          throw new Error(response.msg || `code ${response.code}`);
        }
        this.state!.sequence = nextSeq;
      })
      .catch((error) => {
        ok = false;
        onError?.(error);
      });
    return ok;
  }

  /** Push text via the streaming element API for the main content element. */
  private async updateCardContent(
    text: string,
    onError?: (error: unknown) => void,
  ): Promise<boolean> {
    return this.updateElementContent("content", text, onError);
  }

  /** Build the full elements array for full card updates, including thinking panel. */
  private buildFullElements(text: string, options?: { note?: string }): Record<string, unknown>[] {
    const elements: Record<string, unknown>[] = [];
    // Include thinking panel if there's thinking content
    if (this.state?.thinkingText) {
      elements.push({
        tag: "collapsible_panel",
        expanded: this.state.thinkingExpanded,
        element_id: "thinking",
        header: {
          title: { tag: "plain_text", content: this.state.thinkingTitle || "💭 Thinking" },
        },
        border: { color: "grey" },
        vertical_spacing: "2px",
        padding: "4px 12px",
        elements: [
          { tag: "markdown", content: this.state.thinkingText, element_id: "thinking_content" },
        ],
      });
    }
    elements.push({ tag: "markdown", content: text, element_id: "content" });
    if (this.state?.hasNote) {
      elements.push({ tag: "hr" });
      const noteSource = options?.note ?? this.state.noteText;
      const noteContent = noteSource ? `<font color='grey'>${noteSource}</font>` : "";
      elements.push({ tag: "markdown", content: noteContent, element_id: "note" });
    }
    return elements;
  }

  /**
   * Fallback: full card replacement via card update API.
   * Works regardless of streaming_mode state -- used when the streaming
   * element API fails (e.g. after the 10-minute auto-close).
   *
   * When `keepStreaming` is true, the card retains streaming_mode so that
   * subsequent element-level updates (e.g. content streaming) still work.
   */
  private async updateCardFull(
    text: string,
    options?: { keepStreaming?: boolean; note?: string },
  ): Promise<boolean> {
    if (!this.state) {
      return false;
    }
    const config: Record<string, unknown> = { update_multi: true };
    if (options?.keepStreaming) {
      config.streaming_mode = true;
    }
    const cardJson: Record<string, unknown> = {
      schema: "2.0",
      config,
      body: { elements: this.buildFullElements(text, { note: options?.note }) },
    };
    if (this.state.header) {
      cardJson.header = {
        title: { tag: "plain_text", content: this.state.header.title },
        template: resolveFeishuCardTemplate(this.state.header.template) ?? "blue",
      };
    }
    const nextSeq = this.state.sequence + 1;
    try {
      const response = await this.client.cardkit.v1.card.update({
        path: { card_id: this.state.cardId },
        data: {
          card: { type: "card_json", data: JSON.stringify(cardJson) },
          sequence: nextSeq,
          uuid: `u_${this.state.cardId}_${nextSeq}`,
        },
      });
      if ((response.code ?? 0) !== 0) {
        throw new Error(response.msg || `code ${response.code}`);
      }
      this.state.sequence = nextSeq;
      this.state.thinkingPanelRendered = Boolean(this.state.thinkingText);
      return true;
    } catch (e) {
      this.log?.(`Full card update failed: ${String(e)}`);
      return false;
    }
  }

  async update(text: string, options?: { replace?: boolean }): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    const resolvedInput = options?.replace
      ? text
      : mergeStreamingText(this.pendingText ?? this.state.currentText, text);
    if (!resolvedInput || resolvedInput === this.state.currentText) {
      return;
    }

    // Throttle: skip if updated recently, but remember pending text
    const now = Date.now();
    if (now - this.lastUpdateTime < this.updateThrottleMs) {
      this.pendingText = resolvedInput;
      // Schedule a flush so throttled updates don't get stranded
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          if (this.pendingText !== null && this.state && !this.closed) {
            const pending = this.pendingText;
            this.pendingText = null;
            this.lastUpdateTime = Date.now();
            const r = options?.replace === true;
            this.queue = this.queue.then(async () => {
              if (!this.state || this.closed) return;
              const merged = r ? pending : mergeStreamingText(this.state.currentText, pending);
              if (!merged || merged === this.state.currentText) return;
              this.state.currentText = merged;
              await this.updateCardContent(merged, (e) =>
                this.log?.(`Update failed: ${String(e)}`),
              );
            });
          }
        }, this.updateThrottleMs);
      }
      return;
    }
    this.pendingText = null;
    this.lastUpdateTime = now;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const replace = options?.replace === true;
    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) {
        return;
      }
      const finalText = replace
        ? resolvedInput
        : mergeStreamingText(this.state.currentText, resolvedInput);
      if (!finalText || finalText === this.state.currentText) {
        return;
      }
      this.state.currentText = finalText;
      await this.updateCardContent(finalText, (e) => this.log?.(`Update failed: ${String(e)}`));
    });
    await this.queue;
  }

  /** Update thinking content — shows in the content element during streaming
   *  via a live collapsible panel, then is collapsed on close(). */
  async updateThinking(text: string, options?: { title?: string }): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    const normalized = text.trim();
    const previousText = this.state.thinkingText;
    const previousTitle = this.state.thinkingTitle;
    const nextTitle = options?.title?.trim() || this.state.thinkingTitle || "💭 Thinking";
    if (!normalized || (normalized === previousText && nextTitle === previousTitle)) {
      return;
    }
    const previousPanelRendered = this.state.thinkingPanelRendered;
    this.state.thinkingTitle = nextTitle;
    this.state.thinkingText = normalized;
    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) return;
      const requiresFullCardUpdate =
        !this.state.thinkingPanelRendered || nextTitle !== previousTitle;
      if (requiresFullCardUpdate) {
        const fullCardUpdated = await this.updateCardFull(this.state.currentText, {
          keepStreaming: true,
        });
        if (!fullCardUpdated && !this.state.currentText) {
          const contentUpdated = await this.updateCardContent(normalized, (e) =>
            this.log?.(`Thinking content update failed: ${String(e)}`),
          );
          if (contentUpdated) {
            return;
          }
        }
        if (!fullCardUpdated) {
          this.state.thinkingTitle = previousTitle;
          this.state.thinkingText = previousText;
          this.state.thinkingPanelRendered = previousPanelRendered;
        }
        return;
      }
      const updated = await this.updateElementContent("thinking_content", normalized, (e) =>
        this.log?.(`Thinking content update failed: ${String(e)}`),
      );
      if (!updated) {
        this.state.thinkingTitle = previousTitle;
        this.state.thinkingText = previousText;
        this.state.thinkingPanelRendered = previousPanelRendered;
      }
    });
    await this.queue;
  }

  private async updateNoteContent(note: string): Promise<void> {
    if (!this.state || !this.state.hasNote) {
      return;
    }
    this.state.noteText = note;
    const nextSeq = this.state.sequence + 1;
    await this.client.cardkit.v1.cardElement
      .content({
        path: {
          card_id: this.state.cardId,
          element_id: "note",
        },
        data: {
          content: `<font color='grey'>${note}</font>`,
          sequence: nextSeq,
          uuid: `n_${this.state.cardId}_${nextSeq}`,
        },
      })
      .then((response) => {
        if ((response.code ?? 0) !== 0) {
          throw new Error(response.msg || `code ${response.code}`);
        }
        this.state!.sequence = nextSeq;
      })
      .catch((e) => this.log?.(`Note update failed: ${String(e)}`));
  }

  async close(finalText?: string, options?: { note?: string }): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.stopRenewTimer();
    await this.queue;

    const pendingMerged = mergeStreamingText(this.state.currentText, this.pendingText ?? undefined);
    // `finalText` is a full final snapshot from the caller, not a delta. When
    // present, treat it as authoritative instead of merging it with the last
    // streamed preview, otherwise stale status/preview text can be duplicated
    // into the terminal card content.
    const text = finalText !== undefined ? finalText : pendingMerged;

    // Ensure thinking panel is collapsed in the final card
    this.state.thinkingExpanded = false;
    const previousText = this.state.currentText;
    // If no content was ever streamed, clear the initial placeholder
    const resolvedText = text || "";
    this.state.currentText = resolvedText;

    // When thinking content exists, use a single full card update to collapse
    // the thinking panel and set final content + note in one shot. This avoids
    // the issue where a full card update overwrites the note element to empty
    // and then a subsequent element API note update fails because streaming
    // mode was disabled by the full card update.
    if (this.state.thinkingText) {
      await this.updateCardFull(this.state.currentText, {
        note: options?.note,
      });
    } else {
      // No thinking panel — use element API for content, then note.
      if (resolvedText !== previousText) {
        const streamOk = await this.updateCardContent(resolvedText);
        if (!streamOk) {
          this.log?.("Streaming content update failed on close; falling back to full card update");
          await this.updateCardFull(resolvedText);
        }
      }
      if (options?.note) {
        await this.updateNoteContent(options.note);
      }
    }

    // Close streaming mode
    const closeSeq = this.state.sequence + 1;
    await this.client.cardkit.v1.card
      .settings({
        path: { card_id: this.state.cardId },
        data: {
          settings: JSON.stringify({
            config: { streaming_mode: false, summary: { content: truncateSummary(resolvedText) } },
          }),
          sequence: closeSeq,
          uuid: `c_${this.state.cardId}_${closeSeq}`,
        },
      })
      .then((response) => {
        if ((response.code ?? 0) !== 0) {
          throw new Error(response.msg || `code ${response.code}`);
        }
      })
      .catch((e) => this.log?.(`Close failed: ${String(e)}`));
    const finalState = this.state;
    this.state = null;
    this.pendingText = null;

    this.log?.(`Closed streaming: cardId=${finalState.cardId}`);
  }

  /** Discard the streaming card by deleting the message entirely. */
  async discard(): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.stopRenewTimer();
    await this.queue;

    const messageId = this.state.messageId;
    this.state = null;
    this.pendingText = null;

    try {
      await this.client.im.message.delete({
        path: { message_id: messageId },
      });
      this.log?.(`Discarded streaming message: ${messageId}`);
    } catch (e) {
      this.log?.(`Discard failed: ${String(e)}`);
    }
  }

  getMessageId(): string | undefined {
    return this.state?.messageId;
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }
}
