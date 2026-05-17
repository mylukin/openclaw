import { describe, expect, it } from "vitest";
import {
  isMiniMaxModelNotFoundErrorMessage,
  isModelNotFoundErrorMessage,
} from "./live-model-errors.js";

describe("live model error helpers", () => {
  it("detects generic model-not-found messages", () => {
    expect(isModelNotFoundErrorMessage('{"code":404,"message":"model not found"}')).toBe(true);
    expect(isModelNotFoundErrorMessage("model: MiniMax-M2.7-highspeed not found")).toBe(true);
    expect(
      isModelNotFoundErrorMessage(
        "HTTP 400 not_found_error: model: claude-3-5-haiku-20241022 (request_id: req_123)",
      ),
    ).toBe(true);
    expect(isModelNotFoundErrorMessage("request ended without sending any chunks")).toBe(false);
  });

  it("does not misclassify stateless reasoning replay 404s as model_not_found", () => {
    expect(
      isModelNotFoundErrorMessage(
        "HTTP 404: Item with id 'rs_03f10b4d36884444016a09051bfea0819681d7a1339cd4d965' not found. Items are not persisted when `store` is set to false. Try again with `store` set to true, or remove this item from your input.",
      ),
    ).toBe(false);
    expect(isModelNotFoundErrorMessage("404 Item with id 'rs_abc' not found")).toBe(false);
    expect(isModelNotFoundErrorMessage("Items are not persisted when store is set to false")).toBe(
      false,
    );
  });

  it("still classifies real model-not-found 404s when reference is the model id", () => {
    expect(isModelNotFoundErrorMessage("404 model gpt-5.5 not found")).toBe(true);
    expect(isModelNotFoundErrorMessage("404 engine gpt-5.5 not found")).toBe(true);
    expect(
      isModelNotFoundErrorMessage(
        "HTTP 404: The model `gpt-5.5` does not exist or you do not have access",
      ),
    ).toBe(true);
  });

  it("classifies real model-404s that incidentally mention 'item' words", () => {
    // Bare `item` word should not blanket-suppress a real model 404. Only the
    // canonical Responses "Item with id" / "Items are not persisted" phrases do.
    expect(isModelNotFoundErrorMessage("404 model gpt-item-xl not found")).toBe(true);
  });

  it("detects bare minimax 404 page-not-found responses", () => {
    expect(isMiniMaxModelNotFoundErrorMessage("404 page not found")).toBe(true);
    expect(isMiniMaxModelNotFoundErrorMessage("Error: 404 404 page not found")).toBe(true);
    expect(isMiniMaxModelNotFoundErrorMessage("request ended without sending any chunks")).toBe(
      false,
    );
  });
});
