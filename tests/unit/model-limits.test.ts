import { describe, test, expect } from "bun:test";
import { ModelInfoMap } from "llm-info";

const CURSOR_TO_LLM_INFO_MAP: Record<string, string> = {
  "sonnet-4.5": "claude-sonnet-4-5-20250929",
  "sonnet-4.5-thinking": "claude-sonnet-4-5-20250929",
  "opus-4.5": "claude-opus-4-5-20251101",
  "opus-4.5-thinking": "claude-opus-4-5-20251101",
  "opus-4.1": "claude-opus-4-1-20250805",
  "gemini-3-pro": "gemini-3-pro-preview",
  "gemini-3-flash": "gemini-2.5-flash",
  "gpt-5.2": "gpt-5.2",
  "gpt-5.2-high": "gpt-5.2",
  "gpt-5.1": "gpt-5",
  "gpt-5.1-high": "gpt-5",
  "gpt-5.1-codex": "gpt-5",
  "gpt-5.1-codex-high": "gpt-5",
  "gpt-5.1-codex-max": "gpt-5",
  "gpt-5.1-codex-max-high": "gpt-5",
  "grok": "grok-4",
};

const DEFAULT_LIMITS = { context: 128000, output: 16384 };

function getModelLimits(cursorModelId: string): { context: number; output: number } {
  const llmInfoId = CURSOR_TO_LLM_INFO_MAP[cursorModelId];
  if (!llmInfoId) return DEFAULT_LIMITS;

  const info = (ModelInfoMap as Record<string, { contextWindowTokenLimit?: number; outputTokenLimit?: number }>)[
    llmInfoId
  ];
  if (!info) return DEFAULT_LIMITS;

  return {
    context: info.contextWindowTokenLimit ?? DEFAULT_LIMITS.context,
    output: info.outputTokenLimit ?? DEFAULT_LIMITS.output,
  };
}

describe("Model Limits", () => {
  describe("getModelLimits", () => {
    test("returns correct limits for Claude sonnet-4.5", () => {
      const limits = getModelLimits("sonnet-4.5");
      expect(limits.context).toBe(200000);
      expect(limits.output).toBe(64000);
    });

    test("returns correct limits for Claude opus-4.5", () => {
      const limits = getModelLimits("opus-4.5");
      expect(limits.context).toBe(200000);
      expect(limits.output).toBe(64000);
    });

    test("returns correct limits for GPT-5.2", () => {
      const limits = getModelLimits("gpt-5.2");
      expect(limits.context).toBe(400000);
      expect(limits.output).toBe(128000);
    });

    test("returns correct limits for GPT-5.1", () => {
      const limits = getModelLimits("gpt-5.1");
      expect(limits.context).toBe(400000);
      expect(limits.output).toBe(128000);
    });

    test("returns correct limits for Gemini 3 Pro", () => {
      const limits = getModelLimits("gemini-3-pro");
      expect(limits.context).toBe(1048576);
      expect(limits.output).toBe(65536);
    });

    test("returns correct limits for Grok", () => {
      const limits = getModelLimits("grok");
      expect(limits.context).toBe(256000);
      expect(limits.output).toBe(32768);
    });

    test("returns default limits for unknown models", () => {
      const limits = getModelLimits("unknown-model");
      expect(limits.context).toBe(DEFAULT_LIMITS.context);
      expect(limits.output).toBe(DEFAULT_LIMITS.output);
    });

    test("returns default limits for auto model", () => {
      const limits = getModelLimits("auto");
      expect(limits.context).toBe(DEFAULT_LIMITS.context);
      expect(limits.output).toBe(DEFAULT_LIMITS.output);
    });

    test("thinking variants use same limits as base model", () => {
      const sonnetLimits = getModelLimits("sonnet-4.5");
      const sonnetThinkingLimits = getModelLimits("sonnet-4.5-thinking");
      expect(sonnetThinkingLimits).toEqual(sonnetLimits);

      const opusLimits = getModelLimits("opus-4.5");
      const opusThinkingLimits = getModelLimits("opus-4.5-thinking");
      expect(opusThinkingLimits).toEqual(opusLimits);
    });

    test("high variants use same limits as base model", () => {
      const gpt52Limits = getModelLimits("gpt-5.2");
      const gpt52HighLimits = getModelLimits("gpt-5.2-high");
      expect(gpt52HighLimits).toEqual(gpt52Limits);
    });
  });

  describe("CURSOR_TO_LLM_INFO_MAP validity", () => {
    test("all mapped llm-info IDs exist in ModelInfoMap", () => {
      for (const [cursorId, llmInfoId] of Object.entries(CURSOR_TO_LLM_INFO_MAP)) {
        const info = (ModelInfoMap as Record<string, unknown>)[llmInfoId];
        expect(info).toBeDefined();
      }
    });
  });
});
