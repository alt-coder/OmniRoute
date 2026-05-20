import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyLiteCompression,
  collapseWhitespace,
  dedupSystemPrompt,
  compressToolResults,
  removeRedundantContent,
  replaceImageUrls,
} from "../../../open-sse/services/compression/lite.ts";
import { applyCompression } from "../../../open-sse/services/compression/strategySelector.ts";

describe("collapseWhitespace", () => {
  it("collapses 3+ newlines to 2", () => {
    const body = { messages: [{ role: "user", content: "hello\n\n\n\nworld" }] };
    const result = collapseWhitespace(body);
    assert.equal(result.applied, true);
    assert.equal(result.body.messages![0].content as string, "hello\n\nworld");
  });

  it("does not modify already-normal whitespace", () => {
    const body = { messages: [{ role: "user", content: "hello\n\nworld" }] };
    const result = collapseWhitespace(body);
    assert.equal(result.applied, false);
  });

  it("trims trailing spaces", () => {
    const body = { messages: [{ role: "user", content: "hello   " }] };
    const result = collapseWhitespace(body);
    assert.equal(result.applied, true);
    assert.equal(result.body.messages![0].content as string, "hello");
  });

  it("returns unchanged when no messages", () => {
    const body = {};
    const result = collapseWhitespace(body);
    assert.equal(result.applied, false);
  });

  it("skips non-string content", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
    const result = collapseWhitespace(body);
    assert.equal(result.applied, false);
  });
});

describe("dedupSystemPrompt", () => {
  it("removes duplicate system prompts", () => {
    const body = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
      ],
    };
    const result = dedupSystemPrompt(body);
    assert.equal(result.applied, true);
    assert.equal(result.body.messages!.length, 2);
  });

  it("keeps different system prompts", () => {
    const body = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "system", content: "Be concise." },
      ],
    };
    const result = dedupSystemPrompt(body);
    assert.equal(result.applied, false);
    assert.equal(result.body.messages!.length, 2);
  });

  it("returns unchanged when no messages", () => {
    const result = dedupSystemPrompt({});
    assert.equal(result.applied, false);
  });
});

describe("compressToolResults", () => {
  it("truncates long tool results", () => {
    const longContent = "x".repeat(3000);
    const body = { messages: [{ role: "tool", content: longContent }] };
    const result = compressToolResults(body);
    assert.equal(result.applied, true);
    const content = result.body.messages![0].content as string;
    assert.ok(content.length < 3000);
    assert.ok(content.includes("[truncated]"));
  });

  it("keeps short tool results unchanged", () => {
    const body = { messages: [{ role: "tool", content: "short result" }] };
    const result = compressToolResults(body);
    assert.equal(result.applied, false);
  });

  it("skips non-tool messages", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(3000) }] };
    const result = compressToolResults(body);
    assert.equal(result.applied, false);
  });
});

describe("removeRedundantContent", () => {
  it("removes consecutive duplicate messages", () => {
    const body = {
      messages: [
        { role: "user", content: "hello" },
        { role: "user", content: "hello" },
      ],
    };
    const result = removeRedundantContent(body);
    assert.equal(result.applied, true);
    assert.equal(result.body.messages!.length, 1);
  });

  it("keeps non-duplicate messages", () => {
    const body = {
      messages: [
        { role: "user", content: "hello" },
        { role: "user", content: "world" },
      ],
    };
    const result = removeRedundantContent(body);
    assert.equal(result.applied, false);
    assert.equal(result.body.messages!.length, 2);
  });

  it("only removes same-role consecutive duplicates", () => {
    const body = {
      messages: [
        { role: "system", content: "hello" },
        { role: "user", content: "hello" },
      ],
    };
    const result = removeRedundantContent(body);
    assert.equal(result.applied, false);
  });
});

describe("replaceImageUrls", () => {
  it("replaces base64 images when supportsVision is explicitly false", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }],
        },
      ],
    };
    const result = replaceImageUrls(body, { supportsVision: false });
    assert.equal(result.applied, true);
    const content = result.body.messages![0].content as Array<Record<string, unknown>>;
    assert.equal(content[0].type, "text");
    assert.ok((content[0].text as string).includes("[image:"));
  });

  it("keeps images when supportsVision is true", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }],
        },
      ],
    };
    const result = replaceImageUrls(body, { supportsVision: true });
    assert.equal(result.applied, false);
  });

  it("keeps images for unknown models (safe default — no stripping)", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }],
        },
      ],
    };
    // Unknown models like kimi-k2.6, deepseek-v4, glm-5, custom providers
    // should NOT have their images stripped (supportsVision defaults to null/unknown)
    const result = replaceImageUrls(body, { supportsVision: null });
    assert.equal(result.applied, false);
  });

  it("keeps images when supportsVision is undefined (unknown)", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }],
        },
      ],
    };
    const result = replaceImageUrls(body, {});
    assert.equal(result.applied, false);
  });

  it("skips non-image content", () => {
    const body = {
      messages: [{ role: "user", content: "just text" }],
    };
    const result = replaceImageUrls(body, { supportsVision: false });
    assert.equal(result.applied, false);
  });

  it("keeps images for vision-capable model names via modelSupportsVision", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }],
        },
      ],
    };
    // Known vision models should not have images stripped
    const result = replaceImageUrls(body, "gpt-4o");
    assert.equal(result.applied, false);
  });
});

describe("modelSupportsVision regression (new provider models)", () => {
  // These models were previously broken because modelSupportsVision used
  // a hardcoded whitelist that only matched "vision", "gpt-4", "4o", "claude-3", "gemini".
  // The fix uses getResolvedModelCapabilities, which returns null (unknown)
  // for unlisted models, and we treat null as vision-capable (safe default).
  const newProviderModels = [
    "kimi-k2.6-precision",
    "kimi-k2.5",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "glm-5.1",
    "glm-4.7",
    "mimo-v2.5-pro",
    "qwen3.6-27b",
    "minimax-m2.5",
  ];

  for (const model of newProviderModels) {
    it(`does not strip images from ${model}`, () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image" },
              { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } },
            ],
          },
        ],
      };
      const result = replaceImageUrls(body, model);
      // Unknown models should NOT have images stripped
      assert.equal(result.applied, false);
    });
  }
});

describe("applyLiteCompression", () => {
  it("applies all techniques that match", () => {
    const body = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello\n\n\n\nworld" },
        { role: "user", content: "hello\n\n\n\nworld" },
      ],
    };
    const result = applyLiteCompression(body);
    assert.equal(result.compressed, true);
    assert.ok(result.stats);
    assert.ok(result.stats.techniquesUsed.length >= 2);
    assert.ok(result.stats.savingsPercent > 0);
  });

  it("preserves system prompt text when preserveSystemPrompt is enabled", () => {
    const body = {
      messages: [
        { role: "system", content: "Policy.   Keep exact.\n\n\nDo not change." },
        { role: "user", content: "Please   normalize this.\n\n\nThanks." },
      ],
    };
    const result = applyCompression(body, "lite", {
      config: {
        enabled: true,
        defaultMode: "lite",
        autoTriggerTokens: 0,
        cacheMinutes: 5,
        preserveSystemPrompt: true,
        comboOverrides: {},
      },
    });
    const messages = result.body.messages as typeof body.messages;
    assert.equal(messages[0].content, body.messages[0].content);
    assert.notEqual(messages[1].content, body.messages[1].content);
  });

  it("returns no compression for clean input", () => {
    const body = {
      messages: [{ role: "user", content: "clean message" }],
    };
    const result = applyLiteCompression(body);
    assert.equal(result.compressed, false);
    assert.equal(result.stats, null);
  });

  it("handles empty messages array", () => {
    const body = { messages: [] };
    const result = applyLiteCompression(body);
    assert.equal(result.compressed, false);
  });
});
