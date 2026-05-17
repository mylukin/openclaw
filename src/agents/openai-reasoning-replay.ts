type ReasoningReplayItem = Record<string, unknown> & {
  type?: unknown;
  id?: unknown;
};

function isReasoningType(value: unknown): value is "reasoning" | `reasoning.${string}` {
  return typeof value === "string" && (value === "reasoning" || value.startsWith("reasoning."));
}

function isStoredReasoningId(value: unknown): value is string {
  return typeof value === "string" && value.trim().startsWith("rs_");
}

function isItemReferenceType(value: unknown): value is "item_reference" {
  return value === "item_reference";
}

function hasStatelessReasoningPayload(record: ReasoningReplayItem): boolean {
  return (
    (typeof record.encrypted_content === "string" && record.encrypted_content.length > 0) ||
    (typeof record.content === "string" && record.content.length > 0) ||
    (typeof record.summary === "string" && record.summary.length > 0) ||
    (Array.isArray(record.summary) && record.summary.length > 0)
  );
}

/**
 * `store:false` Responses requests cannot refer to server-persisted reasoning
 * item ids (`rs_*`). Keep any stateless payload (for example encrypted_content)
 * but remove the id so fallback/replay requests do not 404.
 */
export function stripStoredReasoningIdForStatelessReplay<T>(item: T): T | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }
  const record = item as ReasoningReplayItem;
  // item_reference always points at server-persisted state, which doesn't exist
  // when store !== true. Drop unconditionally; partial whitelists miss prefixes
  // (call_, fcr_, ig_, ...) and still 404 on replay.
  if (isItemReferenceType(record.type)) {
    return undefined;
  }
  if (!isReasoningType(record.type)) {
    return item;
  }
  if (!isStoredReasoningId(record.id)) {
    return hasStatelessReasoningPayload(record) || record.id !== undefined ? item : undefined;
  }
  if (!hasStatelessReasoningPayload(record)) {
    return undefined;
  }
  const { id: _id, ...rest } = record;
  return rest as T;
}

export function sanitizeStatelessReasoningReplayPayload(payload: Record<string, unknown>): void {
  if (payload.store === true || !Array.isArray(payload.input)) {
    return;
  }
  payload.input = payload.input.flatMap((item) => {
    const sanitized = stripStoredReasoningIdForStatelessReplay(item);
    return sanitized === undefined ? [] : [sanitized];
  });
}
