/**
 * Feishu Streaming Card - Card Kit streaming API for real-time text output
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import { fetchWithSsrFGuard } from "../runtime-api.js";
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
  thinkingText: string;
  thinkingExpanded: boolean;
  /** Whether the thinking panel has been injected into the card via full update. */
  thinkingInjected: boolean;
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

// Token cache (keyed by domain + appId)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function resolveApiBase(domain?: FeishuDomain): string {
  if (domain === "lark") {
    return "https://open.larksuite.com/open-apis";
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return "https://open.feishu.cn/open-apis";
}

function resolveAllowedHostnames(domain?: FeishuDomain): string[] {
  if (domain === "lark") {
    return ["open.larksuite.com"];
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    try {
      return [new URL(domain).hostname];
    } catch {
      return [];
    }
  }
  return ["open.feishu.cn"];
}

async function getToken(creds: Credentials): Promise<string> {
  const key = `${creds.domain ?? "feishu"}|${creds.appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const { response, release } = await fetchWithSsrFGuard({
    url: `${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    },
    policy: { allowedHostnames: resolveAllowedHostnames(creds.domain) },
    auditContext: "feishu.streaming-card.token",
  });
  if (!response.ok) {
    await release();
    throw new Error(`Token request failed with HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
  await release();
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Token error: ${data.msg}`);
  }
  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });
  return data.tenant_access_token;
}

function truncateSummary(text: string, max = 50): string {
  if (!text) {
    return "";
  }
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
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
  private creds: Credentials;
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

  constructor(client: Client, creds: Credentials, log?: (msg: string) => void) {
    this.client = client;
    this.creds = creds;
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

    const apiBase = resolveApiBase(this.creds.domain);
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

    // Create card entity
    const { response: createRes, release: releaseCreate } = await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) }),
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: "feishu.streaming-card.create",
    });
    if (!createRes.ok) {
      await releaseCreate();
      throw new Error(`Create card request failed with HTTP ${createRes.status}`);
    }
    const createData = (await createRes.json()) as {
      code: number;
      msg: string;
      data?: { card_id: string };
    };
    await releaseCreate();
    if (createData.code !== 0 || !createData.data?.card_id) {
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
      thinkingText: "",
      thinkingExpanded: true,
      thinkingInjected: false,
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
    const apiBase = resolveApiBase(this.creds.domain);
    // Snapshot the candidate sequence but only commit it to state on success,
    // so a failed renewal does not leave a permanent hole in the sequence.
    const nextSeq = this.state.sequence + 1;
    try {
      const { release } = await fetchWithSsrFGuard({
        url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/settings`,
        init: {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${await getToken(this.creds)}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            settings: JSON.stringify({ config: { streaming_mode: true } }),
            sequence: nextSeq,
            uuid: `r_${this.state.cardId}_${nextSeq}`,
          }),
        },
        policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
        auditContext: "feishu.streaming-card.renew",
      });
      await release();
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
    const apiBase = resolveApiBase(this.creds.domain);
    // Snapshot the candidate sequence but only commit it to state on success,
    // so a failed update does not leave a permanent hole in the sequence.
    const nextSeq = this.state.sequence + 1;
    let ok = true;
    await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/${elementId}/content`,
      init: {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: text,
          sequence: nextSeq,
          uuid: `s_${this.state.cardId}_${nextSeq}`,
        }),
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: `feishu.streaming-card.update.${elementId}`,
    })
      .then(async ({ release }) => {
        await release();
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
          title: { tag: "plain_text", content: "💭 Thinking" },
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
    const apiBase = resolveApiBase(this.creds.domain);
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
      const { release } = await fetchWithSsrFGuard({
        url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}`,
        init: {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${await getToken(this.creds)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            card: { type: "card_json", data: JSON.stringify(cardJson) },
            sequence: nextSeq,
            uuid: `u_${this.state.cardId}_${nextSeq}`,
          }),
        },
        policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
        auditContext: "feishu.streaming-card.full-update",
      });
      await release();
      this.state.sequence = nextSeq;
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

  /** Update thinking panel content (non-streaming, immediate).
   *  On first call, injects the collapsible_panel via full card update. */
  async updateThinking(text: string): Promise<void> {
    if (!this.state || this.closed || !text) {
      return;
    }
    this.state.thinkingText = text;
    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) {
        return;
      }
      if (!this.state.thinkingInjected) {
        // First thinking update — inject the collapsible_panel via full card update
        const ok = await this.updateCardFull(this.state.currentText, { keepStreaming: true });
        if (ok) {
          this.state.thinkingInjected = true;
        } else {
          // Injection failed — reset thinkingText so next call retries injection
          this.state.thinkingText = "";
          this.log?.("Thinking panel injection failed; will retry on next update");
        }
      } else {
        await this.updateElementContent("thinking_content", text, (e) =>
          this.log?.(`Thinking update failed: ${String(e)}`),
        );
      }
    });
    await this.queue;
  }

  /** Collapse the thinking panel via full card replacement. */
  async collapseThinking(finalThinkingText?: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    if (finalThinkingText !== undefined) {
      this.state.thinkingText = finalThinkingText;
    }
    this.state.thinkingExpanded = false;
    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) {
        return;
      }
      // Must use full card update to change the expanded property.
      // keepStreaming so that subsequent element API updates still work.
      const ok = await this.updateCardFull(this.state.currentText, { keepStreaming: true });
      if (ok) {
        this.state.thinkingInjected = true;
      }
    });
    await this.queue;
  }

  private async updateNoteContent(note: string): Promise<void> {
    if (!this.state || !this.state.hasNote) {
      return;
    }
    this.state.noteText = note;
    const apiBase = resolveApiBase(this.creds.domain);
    const nextSeq = this.state.sequence + 1;
    await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/note/content`,
      init: {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: `<font color='grey'>${note}</font>`,
          sequence: nextSeq,
          uuid: `n_${this.state.cardId}_${nextSeq}`,
        }),
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: "feishu.streaming-card.note-update",
    })
      .then(async ({ release }) => {
        await release();
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
    const text = finalText ? mergeStreamingText(pendingMerged, finalText) : pendingMerged;
    const apiBase = resolveApiBase(this.creds.domain);

    // Ensure thinking panel is collapsed in the final card
    this.state.thinkingExpanded = false;
    const previousText = this.state.currentText;
    if (text) {
      this.state.currentText = text;
    }

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
      if (text && text !== previousText) {
        const streamOk = await this.updateCardContent(text);
        if (!streamOk) {
          this.log?.("Streaming content update failed on close; falling back to full card update");
          await this.updateCardFull(text);
        }
      }
      if (options?.note) {
        await this.updateNoteContent(options.note);
      }
    }

    // Close streaming mode
    const closeSeq = this.state.sequence + 1;
    await fetchWithSsrFGuard({
      url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/settings`,
      init: {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${await getToken(this.creds)}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          settings: JSON.stringify({
            config: { streaming_mode: false, summary: { content: truncateSummary(text) } },
          }),
          sequence: closeSeq,
          uuid: `c_${this.state.cardId}_${closeSeq}`,
        }),
      },
      policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
      auditContext: "feishu.streaming-card.close",
    })
      .then(async ({ release }) => {
        await release();
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
      await this.client.im.v1.message.delete({
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
