import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-v1-messages-format-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const route = await import("../../src/app/api/v1/messages/route.ts");

const originalFetch = globalThis.fetch;

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedFireworksConnection() {
  return providersDb.createProviderConnection({
    provider: "fireworks",
    authType: "apikey",
    name: "fireworks-messages-test",
    apiKey: "fw-test",
    isActive: true,
    testStatus: "active",
  });
}

function makeMessagesRequest(extra = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(extra.headers || {}),
  };

  const body = {
    model: "fireworks/accounts/fireworks/models/deepseek-v3p1",
    max_tokens: 32,
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly OK" }] }],
    ...extra.body,
  };

  return new Request("http://localhost/api/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeOpenAIChatCompletion(content) {
  return {
    id: "chatcmpl-v1-messages-test",
    object: "chat.completion",
    created: 1_775_199_729,
    model: "accounts/fireworks/models/deepseek-v3p1",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8,
    },
  };
}

test.beforeEach(async () => {
  globalThis.fetch = originalFetch;
  await resetStorage();
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("POST /api/v1/messages returns Claude JSON for non-streaming OpenAI upstream responses", async () => {
  await seedFireworksConnection();
  globalThis.fetch = async () => Response.json(makeOpenAIChatCompletion("OK"));

  const response = await route.POST(
    makeMessagesRequest({
      body: {
        stream: false,
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly OK" }] }],
      },
    })
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.type, "message");
  assert.equal(payload.role, "assistant");
  assert.equal(payload.stop_reason, "end_turn");
  assert.deepEqual(payload.content, [{ type: "text", text: "OK" }]);
  assert.equal(payload.choices, undefined);
});

test("POST /api/v1/messages unwraps OpenAI-style envelopes before converting to Claude JSON", async () => {
  await seedFireworksConnection();
  globalThis.fetch = async () =>
    Response.json({
      response: makeOpenAIChatCompletion("Wrapped OK"),
    });

  const response = await route.POST(
    makeMessagesRequest({
      body: {
        stream: false,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Reply with exactly Wrapped OK" }],
          },
        ],
      },
    })
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.type, "message");
  assert.deepEqual(payload.content, [{ type: "text", text: "Wrapped OK" }]);
  assert.equal(payload.object, undefined);
  assert.equal(payload.response, undefined);
});

test("POST /api/v1/messages streams Claude SSE events instead of OpenAI chunks", async () => {
  await seedFireworksConnection();

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"id":"chatcmpl-v1-messages-test","object":"chat.completion.chunk","model":"accounts/fireworks/models/deepseek-v3p1","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'
        )
      );
      controller.enqueue(
        encoder.encode(
          'data: {"id":"chatcmpl-v1-messages-test","object":"chat.completion.chunk","model":"accounts/fireworks/models/deepseek-v3p1","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n'
        )
      );
      controller.enqueue(
        encoder.encode(
          'data: {"id":"chatcmpl-v1-messages-test","object":"chat.completion.chunk","model":"accounts/fireworks/models/deepseek-v3p1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n'
        )
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  globalThis.fetch = async () =>
    new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
      },
    });

  const response = await route.POST(
    makeMessagesRequest({
      headers: { Accept: "text/event-stream" },
      body: {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Reply with exactly streaming OK" }],
          },
        ],
      },
    })
  );
  const payload = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.match(payload, /event: message_start/);
  assert.match(payload, /event: content_block_delta/);
  assert.match(payload, /event: message_stop/);
  assert.match(payload, /data: \[DONE\]/);
  assert.doesNotMatch(payload, /chat\.completion\.chunk/);
});
