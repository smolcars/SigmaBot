import assert from "node:assert/strict";
import { AIProviderError } from "../src/ai.ts";
import { BotApplication } from "../src/bot.ts";
import { BotStore } from "../src/store.ts";
import { TelegramApiError } from "../src/telegram.ts";
import {
  FakeAI,
  FakeTelegram,
  makeUpdate,
  testConfig,
  webhookRequest,
} from "./test_utils.ts";

async function fixture(overrides = {}) {
  const kv = await Deno.openKv(":memory:");
  const store = new BotStore(kv);
  const telegram = new FakeTelegram();
  const ai = new FakeAI();
  let now = 1_000_000;
  let id = 0;
  const app = new BotApplication(
    testConfig(overrides),
    store,
    telegram,
    ai,
    { now: () => now++, randomUUID: () => `owner-${++id}` },
  );
  return {
    kv,
    store,
    telegram,
    ai,
    app,
    advanceTime: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

Deno.test("webhook authentication happens before parsing", async () => {
  const { kv, app } = await fixture();
  try {
    const response = await app.fetch(
      new Request("http://localhost/api/telegram-webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "wrong",
        },
        body: "not json",
      }),
    );
    assert.equal(response.status, 401);
  } finally {
    kv.close();
  }
});

Deno.test("default UUID generator remains callable through BotApplication", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new BotStore(kv);
  const telegram = new FakeTelegram();
  const app = new BotApplication(
    testConfig(),
    store,
    telegram,
    new FakeAI(),
    { now: () => 1_000_000 },
  );

  try {
    const response = await app.fetch(webhookRequest(makeUpdate(1_000)));
    assert.equal(response.status, 200);
    assert.equal(telegram.messages.length, 1);
  } finally {
    kv.close();
  }
});

Deno.test("private message is answered once and stored only after delivery", async () => {
  const { kv, app, store, telegram, ai } = await fixture();
  try {
    const update = makeUpdate(1);
    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal(ai.calls.length, 1);
    assert.equal(telegram.messages.length, 1);
    assert.equal(telegram.messages[0]?.plainText, "AI response");
    assert.deepEqual(
      (await store.getRecentMessages(1, undefined, 0, 1, 10)).map((item) => item.role),
      ["user", "assistant"],
    );

    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal(ai.calls.length, 1);
    assert.equal(telegram.messages.length, 1);
  } finally {
    kv.close();
  }
});

Deno.test("retryable AI failures recover on webhook redelivery", async () => {
  const { kv, app, store, telegram, ai } = await fixture();
  try {
    const update = makeUpdate(105);
    ai.error = new AIProviderError("AI provider unavailable", true, 503);

    assert.equal((await app.fetch(webhookRequest(update))).status, 500);
    assert.equal((await store.getJob(105))?.state, "pending");
    assert.equal(telegram.messages.length, 0);

    delete ai.error;
    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal(ai.calls.length, 2);
    assert.equal(telegram.messages.length, 1);
    assert.deepEqual(
      (await store.getRecentMessages(1, undefined, 0, 105, 10)).map((item) => item.role),
      ["user", "assistant"],
    );
  } finally {
    kv.close();
  }
});

Deno.test("assistant reasoning survives delivery into the next AI turn", async () => {
  const { kv, app, store, ai } = await fixture();
  try {
    const reasoning = "  hidden provider state \n";
    ai.response = {
      text: "first answer",
      reasoningContent: reasoning,
    };
    assert.equal((await app.fetch(webhookRequest(makeUpdate(101)))).status, 200);
    const storedMessages = await store.getRecentMessages(1, undefined, 0, 101, 10);
    assert.equal(storedMessages.at(-1)?.reasoningContent, reasoning);

    ai.response = { text: "second answer" };
    assert.equal((await app.fetch(webhookRequest(makeUpdate(102)))).status, 200);
    assert.equal(ai.calls.length, 2);
    const priorAssistant = ai.calls[1]?.messages.find((message) =>
      message.role === "assistant"
    );
    assert.equal(priorAssistant?.reasoningContent, reasoning);
  } finally {
    kv.close();
  }
});

Deno.test("provider history remains exact when Telegram delivery text is transformed", async () => {
  const { kv, app, ai } = await fixture();
  try {
    ai.response = {
      text: "  first answer \n",
      reasoningContent: "hidden provider state",
    };
    assert.equal((await app.fetch(webhookRequest(makeUpdate(103)))).status, 200);

    ai.response = { text: "second answer" };
    assert.equal((await app.fetch(webhookRequest(makeUpdate(104)))).status, 200);
    const priorAssistant = ai.calls[1]?.messages.find((message) =>
      message.role === "assistant"
    );
    assert.equal(priorAssistant?.content, "  first answer \n");
    assert.equal(priorAssistant?.reasoningContent, "hidden provider state");
  } finally {
    kv.close();
  }
});

Deno.test("Telegram delivery retry resumes response without a second AI call", async () => {
  const { kv, app, store, telegram, ai } = await fixture();
  try {
    telegram.failMessages = 1;
    const update = makeUpdate(2);
    assert.equal((await app.fetch(webhookRequest(update))).status, 500);
    assert.equal(ai.calls.length, 1);
    assert.equal((await store.getJob(2))?.state, "response_ready");
    assert.deepEqual(
      (await store.getRecentMessages(1, undefined, 0, 2, 10)).map((item) => item.role),
      ["user"],
    );

    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal(ai.calls.length, 1);
    assert.equal(telegram.messages.length, 1);
    assert.deepEqual(
      (await store.getRecentMessages(1, undefined, 0, 2, 10)).map((item) => item.role),
      ["user", "assistant"],
    );
  } finally {
    kv.close();
  }
});

Deno.test("oversized web metadata is checkpointed once and remains clickable", async () => {
  const { kv, app, store, telegram, ai } = await fixture();
  try {
    const citations = Array.from({ length: 30 }, (_, index) => {
      const prefix = `https://example.com/source-${index}/`;
      return {
        url: prefix + "a".repeat(2_048 - prefix.length),
        title: `Source ${index} ${"t".repeat(245)}`,
      };
    });
    ai.response = {
      text: `${"界".repeat(3_600)}[1]`,
      webSearchQueries: Array.from(
        { length: 30 },
        (_, index) => `query-${index}-${"q".repeat(2_000)}`,
      ),
      webCitations: citations,
      webSearchCount: 47,
    };
    telegram.failMessages = 1;
    const update = makeUpdate(3, { text: "界".repeat(12_000) });

    assert.equal((await app.fetch(webhookRequest(update))).status, 500);
    assert.equal(ai.calls.length, 1);
    assert.equal(telegram.messageAttempts, 1);
    const checkpoint = await store.getJob(3);
    assert.equal(checkpoint?.state, "response_ready");
    assert.equal(
      checkpoint?.state === "response_ready" ? checkpoint.update.message?.text : "",
      undefined,
    );
    assert.equal(
      checkpoint?.state === "response_ready" ? checkpoint.response?.webSearchCount : 0,
      47,
    );
    assert.ok(checkpoint?.state === "response_ready" && checkpoint.response?.formatted);
    assert.equal(
      checkpoint?.state === "response_ready" && checkpoint.response
        ? "webCitations" in checkpoint.response
        : true,
      false,
    );
    assert.equal(
      checkpoint?.state === "response_ready" && checkpoint.response
        ? "webSearchQueries" in checkpoint.response
        : true,
      false,
    );

    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal(ai.calls.length, 1);
    assert.equal(telegram.messageAttempts, 2);
    assert.equal(telegram.messages.length, 1);
    assert.ok(telegram.messages[0]?.formatted.text.includes(citations[0]!.url));
    assert.match(telegram.messages[0]?.plainText ?? "", /Sources:/);
    assert.ok(telegram.messages[0]?.plainText.includes(citations[0]!.url));
    assert.equal(
      (await store.getRecentMessages(1, undefined, 0, 3, 10)).at(-1)?.text,
      ai.response.text,
    );
  } finally {
    kv.close();
  }
});

Deno.test("allowed group chatter is context but only mentions trigger AI", async () => {
  const { kv, app, store, telegram, ai } = await fixture();
  try {
    const passive = makeUpdate(10, {
      chat: { id: -100, type: "supergroup", title: "Group" },
      from: { id: 7, first_name: "Bob" },
      text: "background context",
    });
    assert.equal((await app.fetch(webhookRequest(passive))).status, 200);
    assert.equal(ai.calls.length, 0);
    assert.equal(telegram.messages.length, 0);

    const mention = makeUpdate(11, {
      chat: { id: -100, type: "supergroup", title: "Group" },
      from: { id: 7, first_name: "Bob" },
      text: "@sigmabot what do you think?",
    });
    assert.equal((await app.fetch(webhookRequest(mention))).status, 200);
    assert.equal(ai.calls.length, 1);
    assert.deepEqual(
      (await store.getRecentMessages(-100, undefined, 0, 11, 10)).map((item) => item.text),
      ["background context", "what do you think?", "AI response"],
    );
  } finally {
    kv.close();
  }
});

Deno.test("help excludes issue creation and reset clears only its topic", async () => {
  const { kv, app, store, telegram, ai } = await fixture();
  try {
    await app.fetch(webhookRequest(makeUpdate(20, {
      message_thread_id: 42,
      text: "topic context",
    })));
    assert.equal((await store.getRecentMessages(1, 42, 0, 20, 10)).length, 2);

    await app.fetch(webhookRequest(makeUpdate(21, {
      message_thread_id: 42,
      text: "/reset",
    })));
    assert.equal(await store.getConversationEpoch(1, 42), 1);
    assert.equal((await store.getRecentMessages(1, 42, 1, 21, 10)).length, 0);

    await app.fetch(webhookRequest(makeUpdate(22, { text: "/help" })));
    const help = telegram.messages.at(-1)?.plainText ?? "";
    assert.match(help, /\/reset/);
    assert.doesNotMatch(help, /issue/i);
    assert.equal(ai.calls.length, 1);
  } finally {
    kv.close();
  }
});

Deno.test("legacy issue command has no issue or AI behavior", async () => {
  const { kv, app, store, telegram, ai } = await fixture();
  try {
    assert.equal(
      (await app.fetch(webhookRequest(makeUpdate(30, { text: "/issue make one" })))).status,
      200,
    );
    assert.equal(ai.calls.length, 0);
    assert.equal(telegram.messages.length, 0);
    assert.deepEqual(
      (await store.getRecentMessages(1, undefined, 0, 30, 10)).map((item) => item.text),
      ["/issue make one"],
    );
  } finally {
    kv.close();
  }
});

Deno.test("bare image asks for a question without invoking AI", async () => {
  const { kv, app, telegram, ai } = await fixture();
  try {
    const update = makeUpdate(40, {
      text: undefined,
      photo: [{ file_id: "photo", file_size: 100 }],
    });
    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal(ai.calls.length, 0);
    assert.equal(ai.imageSupportCalls, 0);
    assert.match(telegram.messages[0]?.plainText ?? "", /What should I look for/);
  } finally {
    kv.close();
  }
});

Deno.test("unsupported captioned image is rejected before download", async () => {
  const { kv, app, telegram, ai } = await fixture();
  try {
    ai.imageSupport = false;
    const update = makeUpdate(48, {
      text: undefined,
      caption: "Describe this",
      photo: [{ file_id: "unsupported-photo", file_size: 100 }],
    });

    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal(ai.imageSupportCalls, 1);
    assert.equal(ai.calls.length, 0);
    assert.equal(telegram.fetchedImages.length, 0);
    assert.match(telegram.messages[0]?.plainText ?? "", /isn't supported/);
  } finally {
    kv.close();
  }
});

Deno.test("unsupported image formats are rejected without invoking AI", async () => {
  const { kv, app, telegram, ai } = await fixture();
  try {
    const update = makeUpdate(49, {
      text: undefined,
      caption: "Describe this",
      document: {
        file_id: "unsupported-image",
        file_size: 100,
        mime_type: "image/tiff",
      },
    });

    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal(ai.imageSupportCalls, 0);
    assert.equal(ai.calls.length, 0);
    assert.equal(telegram.fetchedImages.length, 0);
    assert.match(
      telegram.messages[0]?.plainText ?? "",
      /JPEG, PNG, GIF, or WebP/,
    );
  } finally {
    kv.close();
  }
});

Deno.test("Grok accepts JPEG and PNG but rejects GIF and WebP images", async () => {
  const declared = await fixture({ aiProvider: "grok" });
  try {
    const update = makeUpdate(491, {
      text: undefined,
      caption: "Describe this",
      document: {
        file_id: "declared-webp",
        file_size: 100,
        mime_type: "image/webp",
      },
    });

    assert.equal((await declared.app.fetch(webhookRequest(update))).status, 200);
    assert.equal(declared.telegram.fetchedImages.length, 0);
    assert.equal(declared.ai.calls.length, 0);
    assert.match(declared.telegram.messages[0]?.plainText ?? "", /JPEG or PNG/);
  } finally {
    declared.kv.close();
  }

  const downloaded = await fixture({ aiProvider: "grok" });
  try {
    downloaded.telegram.image = {
      mediaType: "image/webp",
      bytes: new Uint8Array([1, 2, 3]),
    };
    const update = makeUpdate(492, {
      text: undefined,
      caption: "Describe this",
      photo: [{ file_id: "downloaded-webp", file_size: 100 }],
    });

    assert.equal((await downloaded.app.fetch(webhookRequest(update))).status, 200);
    assert.equal(downloaded.telegram.fetchedImages.length, 1);
    assert.equal(downloaded.ai.calls.length, 0);
    assert.match(downloaded.telegram.messages[0]?.plainText ?? "", /JPEG or PNG/);
  } finally {
    downloaded.kv.close();
  }

  const jpeg = await fixture({ aiProvider: "grok" });
  try {
    const update = makeUpdate(493, {
      text: undefined,
      caption: "Describe this",
      photo: [{ file_id: "jpeg", file_size: 100 }],
    });

    assert.equal((await jpeg.app.fetch(webhookRequest(update))).status, 200);
    assert.equal(jpeg.ai.calls.length, 1);
  } finally {
    jpeg.kv.close();
  }
});

Deno.test("transient image download failures remain retryable", async () => {
  const cases = [
    {
      name: "rate limit",
      error: new TelegramApiError("Too Many Requests", 429, 429, 15_000),
      expectedStatus: 503,
      expectedAttempts: 0,
    },
    {
      name: "server failure",
      error: new TelegramApiError("Bad Gateway", 502, 502),
      expectedStatus: 500,
      expectedAttempts: 1,
    },
    {
      name: "network failure",
      error: new TypeError("network unavailable"),
      expectedStatus: 500,
      expectedAttempts: 1,
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const { kv, app, store, telegram, ai } = await fixture();
    try {
      telegram.fetchImage = () => Promise.reject(testCase.error);
      const updateId = 50 + index;
      const update = makeUpdate(updateId, {
        text: undefined,
        caption: "Describe this",
        photo: [{ file_id: `transient-${index}`, file_size: 100 }],
      });

      const response = await app.fetch(webhookRequest(update));
      assert.equal(response.status, testCase.expectedStatus, testCase.name);
      assert.equal(ai.calls.length, 0, testCase.name);
      assert.equal(telegram.messages.length, 0, testCase.name);
      const job = await store.getJob(updateId);
      assert.equal(job?.state, "pending", testCase.name);
      assert.equal(job?.attempts, testCase.expectedAttempts, testCase.name);
      if (testCase.expectedStatus === 503) {
        assert.equal(response.headers.get("retry-after"), "15", testCase.name);
        assert.ok((job?.retryNotBefore ?? 0) > 1_000_000, testCase.name);
      }
    } finally {
      kv.close();
    }
  }
});
Deno.test("unrelated private messages do not reuse a recent image", async () => {
  const { kv, app, ai } = await fixture();
  try {
    await app.fetch(webhookRequest(makeUpdate(41, {
      text: undefined,
      photo: [{ file_id: "photo", file_size: 100 }],
    })));
    assert.equal((await app.fetch(webhookRequest(makeUpdate(42)))).status, 200);
    assert.equal(ai.calls.length, 1);
    assert.equal(
      ai.calls[0]?.messages.every((message) => typeof message.content === "string"),
      true,
    );
  } finally {
    kv.close();
  }
});

Deno.test("replying to an image prompt attaches its referenced image", async () => {
  const { kv, app, telegram, ai } = await fixture();
  try {
    await app.fetch(webhookRequest(makeUpdate(43, {
      text: undefined,
      photo: [{ file_id: "photo-a", file_size: 100 }],
    })));
    const prompt = telegram.messages[0]?.plainText ?? "";
    await app.fetch(webhookRequest(makeUpdate(44, {
      text: undefined,
      photo: [{ file_id: "photo-b", file_size: 100 }],
    })));
    assert.equal(
      (await app.fetch(webhookRequest(makeUpdate(45, {
        text: "What is shown?",
        reply_to_message: {
          message_id: 1,
          chat: { id: 1, type: "private" },
          from: {
            id: 999,
            is_bot: true,
            first_name: "SigmaBot",
            username: "sigmabot",
          },
          text: prompt,
        },
      })))).status,
      200,
    );
    assert.equal(ai.calls.length, 1);
    const content = ai.calls[0]?.messages.findLast((message) =>
      Array.isArray(message.content)
    )?.content;
    assert.ok(Array.isArray(content));
    assert.equal(content.some((part) => part.type === "image"), true);
    assert.deepEqual(telegram.fetchedImages.map((image) => image.fileId), ["photo-a"]);
  } finally {
    kv.close();
  }
});

Deno.test("image prompt association survives delivery retry", async () => {
  const { kv, app, store, telegram, ai } = await fixture();
  try {
    telegram.failMessages = 1;
    const image = makeUpdate(46, {
      text: undefined,
      photo: [{ file_id: "retry-photo", file_size: 100 }],
    });
    assert.equal((await app.fetch(webhookRequest(image))).status, 500);
    const checkpoint = await store.getJob(46);
    assert.equal(checkpoint?.state, "response_ready");
    assert.equal(
      checkpoint?.state === "response_ready"
        ? checkpoint.response?.imagePrompt?.image.fileId
        : undefined,
      "retry-photo",
    );

    assert.equal((await app.fetch(webhookRequest(image))).status, 200);
    const prompt = telegram.messages[0]?.plainText ?? "";
    assert.equal(
      (await app.fetch(webhookRequest(makeUpdate(47, {
        text: "Describe this",
        reply_to_message: {
          message_id: 1,
          chat: { id: 1, type: "private" },
          from: {
            id: 999,
            is_bot: true,
            first_name: "SigmaBot",
            username: "sigmabot",
          },
          text: prompt,
        },
      })))).status,
      200,
    );
    assert.equal(ai.calls.length, 1);
    assert.deepEqual(telegram.fetchedImages.map((item) => item.fileId), ["retry-photo"]);
  } finally {
    kv.close();
  }
});

Deno.test("invalid and unauthorized updates have no side effects", async () => {
  const { kv, app, telegram, ai } = await fixture();
  try {
    assert.equal((await app.fetch(webhookRequest({ message: {} }))).status, 200);
    assert.equal(
      (await app.fetch(webhookRequest({
        ...makeUpdate(49),
        message: { ...makeUpdate(49).message, text: 123 },
      }))).status,
      200,
    );
    assert.equal(
      (await app.fetch(webhookRequest(makeUpdate(50, {
        chat: { id: 999, type: "private" },
        from: { id: 999, first_name: "Unknown" },
      })))).status,
      200,
    );
    assert.equal(ai.calls.length, 0);
    assert.equal(telegram.messages.length, 0);
  } finally {
    kv.close();
  }
});

Deno.test("permanent Telegram delivery errors terminalize the job", async () => {
  const { kv, app, store, telegram, ai } = await fixture();
  try {
    telegram.messageError = new TelegramApiError("bot was blocked", 403, 403);
    const update = makeUpdate(60);
    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal((await store.getJob(60))?.state, "failed");
    assert.equal(ai.calls.length, 1);
    assert.equal(telegram.messageAttempts, 1);
    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal(telegram.messageAttempts, 1);
  } finally {
    kv.close();
  }
});

Deno.test("a response from an earlier epoch is suppressed after reset", async () => {
  const { kv, app, store, telegram, ai } = await fixture();
  try {
    telegram.failMessages = 1;
    const update = makeUpdate(70);
    assert.equal((await app.fetch(webhookRequest(update))).status, 500);
    assert.equal((await store.getJob(70))?.state, "response_ready");
    await store.resetConversation(1);
    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal((await store.getJob(70))?.state, "ignored");
    assert.equal(ai.calls.length, 1);
    assert.equal(telegram.messages.length, 0);
  } finally {
    kv.close();
  }
});

Deno.test("Telegram redelivery resumes a rate-limited checkpoint without a cron", async () => {
  const { kv, app, store, telegram, ai, advanceTime } = await fixture();
  try {
    telegram.messageError = new TelegramApiError(
      "Too Many Requests",
      429,
      429,
      30_000,
    );
    const update = makeUpdate(80);
    const deferredResponse = await app.fetch(webhookRequest(update));
    assert.equal(deferredResponse.status, 503);
    assert.equal(deferredResponse.headers.get("retry-after"), "30");
    const deferred = await store.getJob(80);
    assert.equal(deferred?.state, "response_ready");
    assert.equal(deferred?.attempts, 0);
    assert.ok((deferred?.retryNotBefore ?? 0) > 1_000_000);
    assert.equal(ai.calls.length, 1);
    assert.equal(telegram.messageAttempts, 1);

    const earlyRetry = await app.fetch(webhookRequest(update));
    assert.equal(earlyRetry.status, 503);
    assert.equal(earlyRetry.headers.get("retry-after"), "30");
    assert.equal(telegram.messageAttempts, 1);

    telegram.messageError = undefined;
    advanceTime(30_001);
    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal((await store.getJob(80))?.state, "done");
    assert.equal((await store.getJob(80))?.attempts, 0);
    assert.equal(ai.calls.length, 1);
    assert.equal(telegram.messages.length, 1);
  } finally {
    kv.close();
  }
});

Deno.test("reset cleanup resumes from a response checkpoint after worker loss", async () => {
  const { kv, app, store, telegram, ai } = await fixture();
  try {
    assert.equal((await app.fetch(webhookRequest(makeUpdate(90)))).status, 200);
    assert.equal((await store.getRecentMessages(1, undefined, 0, 90, 10)).length, 2);

    const reset = makeUpdate(91, { text: "/reset" });
    await store.acceptUpdate(reset, 2_000_000);
    assert.equal(
      (await store.claimJob(91, "crashed", 2_000_001, 10_000)).result,
      "claimed",
    );
    await store.prepareResetJob(91, "crashed", 1, undefined, {
      chatId: 1,
      messageId: 91,
      text: "Conversation history cleared.",
      storeAssistant: false,
    }, 2_000_002);
    await store.releaseJob(91, "crashed", 2_000_003);
    assert.equal((await store.getRecentMessages(1, undefined, 0, 91, 10)).length, 2);

    assert.equal((await app.fetch(webhookRequest(reset))).status, 200);
    assert.equal((await store.getRecentMessages(1, undefined, 0, 91, 10)).length, 0);
    assert.equal((await store.getJob(91))?.state, "done");
    assert.equal(ai.calls.length, 1);
    assert.match(telegram.messages.at(-1)?.plainText ?? "", /history cleared/i);
  } finally {
    kv.close();
  }
});

Deno.test("direct message topics isolate history and route replies", async () => {
  const { kv, app, telegram, ai } = await fixture();
  try {
    const chat = { id: -100, type: "supergroup", is_direct_messages: true };
    const topicUpdate = (updateId: number, text: string, topicId: number) =>
      makeUpdate(updateId, {
        chat,
        direct_messages_topic: { topic_id: topicId },
        text,
      });

    assert.equal(
      (await app.fetch(webhookRequest(topicUpdate(120, "topic one", 11)))).status,
      200,
    );
    assert.equal(
      (await app.fetch(webhookRequest(topicUpdate(121, "topic two", 22)))).status,
      200,
    );
    assert.deepEqual(ai.calls[1]?.messages, [
      { role: "user", content: "[Alice]: topic two" },
    ]);

    assert.equal(
      (await app.fetch(webhookRequest(topicUpdate(122, "follow up", 11)))).status,
      200,
    );
    assert.deepEqual(
      ai.calls[2]?.messages.map((message) => message.content),
      ["[Alice]: topic one", "AI response", "[Alice]: follow up"],
    );
    assert.deepEqual(
      telegram.messages.map((message) => message.options?.directMessagesTopicId),
      [11, 22, 11],
    );
    assert.equal(telegram.actions.length, 0);
  } finally {
    kv.close();
  }
});

Deno.test("a newer webhook recovers one abandoned conversation head before retrying", async () => {
  const { kv, app, store, telegram, ai } = await fixture();
  try {
    const older = makeUpdate(200, { text: "older" });
    const newer = makeUpdate(201, { text: "newer" });
    await store.acceptUpdate(older, 1_000_000);

    const recovery = await app.fetch(webhookRequest(newer));
    assert.equal(recovery.status, 503);
    assert.equal(recovery.headers.get("retry-after"), "2");
    assert.equal((await store.getJob(200))?.state, "done");
    assert.equal((await store.getJob(201))?.state, "pending");
    assert.equal(ai.calls.length, 1);
    assert.equal(telegram.messages[0]?.options?.replyToMessageId, 200);

    assert.equal((await app.fetch(webhookRequest(newer))).status, 200);
    assert.equal(ai.calls.length, 2);
    assert.equal(telegram.messages[1]?.options?.replyToMessageId, 201);

    assert.equal((await app.fetch(webhookRequest(older))).status, 200);
    assert.equal(ai.calls.length, 2);
  } finally {
    kv.close();
  }
});
