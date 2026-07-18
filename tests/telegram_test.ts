import assert from "node:assert/strict";
import { TelegramApiError, TelegramClient } from "../src/telegram.ts";

Deno.test("sendMessage emits topic and reply parameters", async () => {
  let body: Record<string, unknown> | undefined;
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Promise.resolve(Response.json({ ok: true, result: { message_id: 9 } }));
  }) as typeof fetch;
  const client = new TelegramClient("token", fetcher, "https://example.test/bot");
  const sent = await client.sendMessage(1, "hello", {
    messageThreadId: 42,
    directMessagesTopicId: 43,
    replyToMessageId: 7,
    parseMode: "HTML",
  });
  assert.equal(body?.message_thread_id, 42);
  assert.equal(body?.direct_messages_topic_id, 43);
  assert.deepEqual(body?.reply_parameters, {
    message_id: 7,
    allow_sending_without_reply: true,
  });
  assert.equal(body?.parse_mode, "HTML");
  assert.equal(sent.message_id, 9);
});

Deno.test("webhook setup requests ordered Telegram delivery", async () => {
  let body: Record<string, unknown> | undefined;
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Promise.resolve(Response.json({ ok: true, result: true }));
  }) as typeof fetch;
  const client = new TelegramClient("token", fetcher, "https://example.test/bot");

  assert.equal(await client.setWebhook("https://bot.example/webhook", "secret"), true);
  assert.equal(body?.max_connections, 1);
});

Deno.test("HTTP 200 Telegram envelopes with ok:false are failures", async () => {
  const fetcher = (() =>
    Promise.resolve(
      Response.json({
        ok: false,
        error_code: 400,
        description: "Bad Request",
      }),
    )) as typeof fetch;
  const client = new TelegramClient("token", fetcher, "https://example.test/bot");
  await assert.rejects(
    () => client.sendMessage(1, "hello"),
    (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.status, 400);
      return true;
    },
  );
});

Deno.test("sendMessage surfaces the complete Telegram retry_after without sleeping", async () => {
  let calls = 0;
  const fetcher = (() => {
    calls++;
    return Promise.resolve(
      Response.json({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 30 },
      }),
    );
  }) as typeof fetch;
  const client = new TelegramClient(
    "token",
    fetcher,
    "https://example.test/bot",
    "https://example.test/file/bot",
    () => Promise.reject(new Error("sendMessage must not sleep on a rate limit")),
  );

  await assert.rejects(
    () => client.sendMessage(1, "hello"),
    (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 30_000);
      return true;
    },
  );
  assert.equal(calls, 1);
});

Deno.test("retryable Telegram methods honor the complete retry_after", async () => {
  let calls = 0;
  const delays: number[] = [];
  const fetcher = (() => {
    calls++;
    if (calls === 1) {
      return Promise.resolve(
        Response.json({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 17 },
        }),
      );
    }
    return Promise.resolve(Response.json({ ok: true, result: true }));
  }) as typeof fetch;
  const client = new TelegramClient(
    "token",
    fetcher,
    "https://example.test/bot",
    "https://example.test/file/bot",
    (milliseconds) => {
      delays.push(milliseconds);
      return Promise.resolve();
    },
  );

  assert.equal(await client.setMyCommands(), true);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [17_000]);
});

Deno.test("formatted message retries once as plain text after parse failure", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (bodies.length === 1) {
      return Promise.resolve(
        Response.json({ ok: false, error_code: 400, description: "can't parse" }),
      );
    }
    return Promise.resolve(Response.json({ ok: true, result: { message_id: 1 } }));
  }) as typeof fetch;
  const client = new TelegramClient("token", fetcher, "https://example.test/bot");
  await client.sendFormattedMessage(
    1,
    { text: "<code>x</code>", parseMode: "HTML" },
    "`x`",
  );
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]?.parse_mode, "HTML");
  assert.equal(bodies[1]?.parse_mode, undefined);
  assert.equal(bodies[1]?.text, "`x`");
});

Deno.test("image content-length is bounded before buffering", async () => {
  let calls = 0;
  const fetcher = (() => {
    calls++;
    if (calls === 1) {
      return Promise.resolve(
        Response.json({
          ok: true,
          result: { file_path: "photos/x.jpg", file_size: 100 },
        }),
      );
    }
    return Promise.resolve(
      new Response(new Uint8Array([1]), {
        headers: { "content-length": "101", "content-type": "image/jpeg" },
      }),
    );
  }) as typeof fetch;
  const client = new TelegramClient(
    "token",
    fetcher,
    "https://example.test/bot",
    "https://example.test/file/bot",
  );
  await assert.rejects(
    () => client.fetchImage({ fileId: "file" }, 100),
    /IMAGE_TOO_LARGE/,
  );
});

Deno.test("getFile surfaces retry_after without sleeping", async () => {
  let calls = 0;
  const fetcher = (() => {
    calls++;
    return Promise.resolve(
      Response.json({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 12 },
      }, { status: 429 }),
    );
  }) as typeof fetch;
  const client = new TelegramClient(
    "token",
    fetcher,
    "https://example.test/bot",
    "https://example.test/file/bot",
    () => Promise.reject(new Error("getFile must not sleep on a rate limit")),
  );

  await assert.rejects(
    () => client.fetchImage({ fileId: "file" }, 100),
    (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 12_000);
      return true;
    },
  );
  assert.equal(calls, 1);
});

Deno.test("getFile propagates an exhausted server failure", async () => {
  let calls = 0;
  const delays: number[] = [];
  const fetcher = (() => {
    calls++;
    return Promise.resolve(
      Response.json(
        { ok: false, error_code: 503, description: "Unavailable" },
        { status: 503 },
      ),
    );
  }) as typeof fetch;
  const client = new TelegramClient(
    "token",
    fetcher,
    "https://example.test/bot",
    "https://example.test/file/bot",
    (milliseconds) => {
      delays.push(milliseconds);
      return Promise.resolve();
    },
  );

  await assert.rejects(
    () => client.fetchImage({ fileId: "file" }, 100),
    (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.status, 503);
      return true;
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(delays, [250]);
});

Deno.test("getFile propagates an exhausted network failure", async () => {
  const networkError = new TypeError("connection reset");
  let calls = 0;
  const fetcher = (() => {
    calls++;
    return Promise.reject(networkError);
  }) as typeof fetch;
  const client = new TelegramClient(
    "token",
    fetcher,
    "https://example.test/bot",
    "https://example.test/file/bot",
    () => Promise.resolve(),
  );

  await assert.rejects(
    () => client.fetchImage({ fileId: "file" }, 100),
    (error: unknown) => error === networkError,
  );
  assert.equal(calls, 2);
});

Deno.test("file download surfaces Telegram retry_after", async () => {
  let calls = 0;
  const fetcher = (() => {
    calls++;
    if (calls === 1) {
      return Promise.resolve(
        Response.json({
          ok: true,
          result: { file_path: "photos/x.jpg", file_size: 100 },
        }),
      );
    }
    return Promise.resolve(
      Response.json({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 23 },
      }, { status: 429 }),
    );
  }) as typeof fetch;
  const client = new TelegramClient(
    "token",
    fetcher,
    "https://example.test/bot",
    "https://example.test/file/bot",
  );

  await assert.rejects(
    () => client.fetchImage({ fileId: "file" }, 100),
    (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 23_000);
      return true;
    },
  );
  assert.equal(calls, 2);
});

Deno.test("file download propagates network failures", async () => {
  const networkError = new TypeError("connection reset");
  let calls = 0;
  const fetcher = (() => {
    calls++;
    if (calls === 1) {
      return Promise.resolve(
        Response.json({
          ok: true,
          result: { file_path: "photos/x.jpg", file_size: 100 },
        }),
      );
    }
    return Promise.reject(networkError);
  }) as typeof fetch;
  const client = new TelegramClient(
    "token",
    fetcher,
    "https://example.test/bot",
    "https://example.test/file/bot",
  );

  await assert.rejects(
    () => client.fetchImage({ fileId: "file" }, 100),
    (error: unknown) => error === networkError,
  );
  assert.equal(calls, 2);
});
