import assert from "node:assert/strict";
import { BotStore } from "../src/store.ts";
import type { StoredMessage } from "../src/types.ts";
import { makeUpdate } from "./test_utils.ts";

Deno.test("update acceptance and claims are atomic", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    const accepted = await Promise.all(
      Array.from({ length: 10 }, () => store.acceptUpdate(makeUpdate(1), 1000)),
    );
    assert.equal(accepted.filter(Boolean).length, 1);
    assert.equal((await store.claimJob(1, "a", 1000, 5000)).result, "claimed");
    assert.equal((await store.claimJob(1, "b", 1001, 5000)).result, "busy");
  } finally {
    kv.close();
  }
});

Deno.test("the configured message ceiling fits in one KV job value", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    const update = makeUpdate(3, { text: "界".repeat(12_000) });
    assert.equal(await store.acceptUpdate(update, 1000), true);
    const job = await store.getJob(3);
    assert.equal(
      job?.state === "pending" ? job.update.message?.text?.length : undefined,
      12_000,
    );
  } finally {
    kv.close();
  }
});

Deno.test("assistant history is committed with delivered job completion", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(makeUpdate(2), 1000);
    assert.equal((await store.claimJob(2, "owner", 1000, 5000)).result, "claimed");
    await store.saveJobResponse(2, "owner", {
      chatId: 1,
      messageId: 2,
      epoch: 0,
      text: "answer",
      storeAssistant: true,
    }, 1001);
    assert.equal((await store.getRecentMessages(1, undefined, 0, 2, 10)).length, 0);
    const message = stored(2, 1, "assistant", "answer");
    await store.completeDeliveredJob(2, "owner", 1002, "done", message);
    assert.deepEqual(await store.getJob(2), {
      updateId: 2,
      state: "done",
      createdAt: 1000,
      updatedAt: 1002,
      attempts: 0,
    });
    assert.equal(await store.acceptUpdate(makeUpdate(2), 1003), false);
    assert.equal((await store.claimJob(2, "duplicate", 1003, 5000)).result, "terminal");
    assert.deepEqual(
      (await store.getRecentMessages(1, undefined, 0, 2, 10)).map((item) => item.text),
      ["answer"],
    );
  } finally {
    kv.close();
  }
});

Deno.test("finishJob compacts checkpoint payloads and keeps failure metadata", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(makeUpdate(4, { text: "sensitive user text" }), 1000);
    await store.claimJob(4, "owner", 1001, 5000);
    await store.saveJobResponse(4, "owner", {
      chatId: 1,
      messageId: 4,
      epoch: 0,
      text: "sensitive assistant text",
      storeAssistant: false,
    }, 1002);

    await store.finishJob(4, "owner", "failed", 1003, "attempts_exhausted", true);

    assert.deepEqual(await store.getJob(4), {
      updateId: 4,
      state: "failed",
      createdAt: 1000,
      updatedAt: 1003,
      attempts: 1,
      errorCode: "attempts_exhausted",
    });
  } finally {
    kv.close();
  }
});

Deno.test("delivered image prompts are bound by conversation, epoch, message, and user", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(
      makeUpdate(5, {
        message_thread_id: 42,
        photo: [{ file_id: "bound-photo" }],
        text: undefined,
      }),
      1000,
    );
    await store.claimJob(5, "owner", 1001, 5000);
    await store.saveJobResponse(5, "owner", {
      chatId: 1,
      messageId: 5,
      messageThreadId: 42,
      epoch: 3,
      text: "question",
      storeAssistant: false,
      imagePrompt: { image: { fileId: "bound-photo" }, userId: 7 },
    }, 1002);
    await store.completeDeliveredJob(5, "owner", 1003, "done", undefined, 100, 99);

    assert.equal(
      (await store.getImageForPrompt(1, 42, 3, 99, 7, 1004))?.fileId,
      "bound-photo",
    );
    assert.equal(await store.getImageForPrompt(1, 41, 3, 99, 7, 1004), null);
    assert.equal(await store.getImageForPrompt(1, 42, 2, 99, 7, 1004), null);
    assert.equal(await store.getImageForPrompt(1, 42, 3, 98, 7, 1004), null);
    assert.equal(await store.getImageForPrompt(1, 42, 3, 99, 8, 1004), null);
    assert.equal(await store.getImageForPrompt(1, 42, 3, 99, 7, 601_003), null);
  } finally {
    kv.close();
  }
});

Deno.test("rate limiting is atomic and idempotent by update", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    const results = await Promise.all(
      Array.from(
        { length: 12 },
        (_, index) => store.takeRateLimit(index + 1, 1, 1, 60_000, 3),
      ),
    );
    assert.equal(results.filter(Boolean).length, 3);
    assert.equal(await store.takeRateLimit(1, 1, 1, 60_001, 3), results[0]);
  } finally {
    kv.close();
  }
});

Deno.test("reset advances epoch and removes only the selected topic history", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.storeMessage(stored(1, 0, "user", "main"), 100);
    await store.storeMessage(
      { ...stored(2, 0, "user", "topic"), messageThreadId: 42 },
      100,
    );
    assert.equal(await store.resetConversation(1), 1);
    assert.equal((await store.getRecentMessages(1, undefined, 1, 10, 10)).length, 0);
    assert.equal((await store.getRecentMessages(1, 42, 0, 10, 10)).length, 1);
  } finally {
    kv.close();
  }
});

Deno.test("history query excludes messages after the target update", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.storeMessage(stored(10, 0, "user", "first"), 100);
    await store.storeMessage(stored(12, 0, "user", "future"), 100);
    assert.deepEqual(
      (await store.getRecentMessages(1, undefined, 0, 10, 10)).map((item) => item.text),
      ["first"],
    );
  } finally {
    kv.close();
  }
});

Deno.test("an expired worker cannot mutate a job after the newer owner releases it", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(makeUpdate(20), 1000);
    assert.equal((await store.claimJob(20, "old", 1000, 10)).result, "claimed");
    assert.equal((await store.claimJob(20, "new", 1011, 100)).result, "claimed");
    await store.releaseJob(20, "new", 1012);
    await assert.rejects(
      () =>
        store.saveJobResponse(20, "old", {
          chatId: 1,
          messageId: 20,
          epoch: 0,
          text: "stale",
          storeAssistant: true,
        }, 1013),
      /lease was lost/,
    );
    assert.equal((await store.getJob(20))?.state, "pending");
  } finally {
    kv.close();
  }
});

Deno.test("conversation pending index advances only after the head completes", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(makeUpdate(30), 1000);
    await store.acceptUpdate(makeUpdate(31), 1001);
    assert.equal(await store.isConversationHead("1:main", 30), true);
    assert.equal(await store.isConversationHead("1:main", 31), false);
    await store.claimJob(30, "owner", 1002, 1000);
    await store.finishJob(30, "owner", "done", 1003);
    assert.equal(await store.isConversationHead("1:main", 31), true);
  } finally {
    kv.close();
  }
});

Deno.test("only actual failures consume the job attempt budget", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(makeUpdate(35), 1000);
    for (let index = 0; index < 6; index++) {
      const owner = `waiting-${index}`;
      assert.equal((await store.claimJob(35, owner, 1001 + index, 1000)).result, "claimed");
      await store.releaseJob(35, owner, 1001 + index, "waiting_for_prior_update");
    }
    assert.equal((await store.getJob(35))?.attempts, 0);

    assert.equal((await store.claimJob(35, "failure", 1010, 1000)).result, "claimed");
    await store.releaseJobAfterFailure(35, "failure", 1011, "NetworkError");
    assert.equal((await store.getJob(35))?.attempts, 1);
  } finally {
    kv.close();
  }
});

Deno.test("deferred jobs cannot be reclaimed before their retry deadline", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(makeUpdate(36), 1000);
    assert.equal((await store.claimJob(36, "owner", 1001, 1000)).result, "claimed");
    await store.deferJob(36, "owner", 1002, 2000, "telegram_429");
    assert.deepEqual(await store.claimJob(36, "early", 1999, 1000), {
      result: "deferred",
      retryNotBefore: 2000,
    });
    assert.equal((await store.claimJob(36, "due", 2000, 1000)).result, "claimed");
    assert.equal((await store.getJob(36))?.attempts, 0);
  } finally {
    kv.close();
  }
});

Deno.test("reset epoch and response checkpoint commit together", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.storeMessage(stored(39, 0, "user", "old context"), 100);
    await store.acceptUpdate(makeUpdate(40, { text: "/reset" }), 1000);
    await store.claimJob(40, "owner", 1001, 1000);
    const response = await store.prepareResetJob(40, "owner", 1, undefined, {
      chatId: 1,
      messageId: 40,
      text: "cleared",
      storeAssistant: false,
    }, 1002);
    assert.equal(response.epoch, 1);
    assert.equal(response.resetHistoryBeforeEpoch, 1);
    assert.equal(await store.getConversationEpoch(1), 1);
    assert.equal((await store.getJob(40))?.state, "response_ready");
    assert.equal((await store.getRecentMessages(1, undefined, 0, 40, 10)).length, 1);
    await store.releaseJob(40, "owner", 1003);
    await store.claimJob(40, "new", 1004, 1000);
    await assert.rejects(
      () =>
        store.prepareResetJob(40, "new", 1, undefined, {
          chatId: 1,
          messageId: 40,
          text: "cleared",
          storeAssistant: false,
        }, 1005),
      /state was lost/,
    );
    assert.equal(await store.getConversationEpoch(1), 1);
  } finally {
    kv.close();
  }
});

function stored(
  updateId: number,
  order: 0 | 1,
  role: "user" | "assistant",
  text: string,
): StoredMessage {
  return {
    updateId,
    order,
    chatId: 1,
    epoch: 0,
    role,
    text,
    createdAt: updateId,
  };
}
Deno.test("job and conversation lease renewal never shortens an existing lease", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(makeUpdate(3), 1000);
    assert.equal((await store.claimJob(3, "owner", 1000, 10_000)).result, "claimed");

    await store.renewJobLease(3, "owner", 2000, 100);
    assert.equal((await store.getJob(3))?.leaseUntil, 11_000);

    assert.equal(
      await store.acquireConversationLease("1:main", "owner", 1000, 10_000),
      true,
    );
    assert.equal(
      await store.acquireConversationLease("1:main", "owner", 2000, 100),
      true,
    );
    assert.deepEqual(
      (await kv.get(["conversation_lease", "1:main"])).value,
      { owner: "owner", leaseUntil: 11_000 },
    );
  } finally {
    kv.close();
  }
});

Deno.test("long reasoning moves from job chunks into hydrated assistant history", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    const reasoning = "step \u{1f9e0} ".repeat(5000);
    const assistantHistory = { content: "answer", reasoningContent: reasoning };
    await store.acceptUpdate(makeUpdate(6), 1000);
    await store.claimJob(6, "owner", 1001, 5000);
    const response = await store.saveJobResponse(
      6,
      "owner",
      {
        chatId: 1,
        messageId: 6,
        epoch: 0,
        text: "answer",
        storeAssistant: true,
      },
      1002,
      assistantHistory,
    );

    assert.ok((response.assistantContentChunkCount ?? 0) > 0);
    assert.ok((response.reasoningChunkCount ?? 0) > 1);
    assert.equal(
      typeof (await kv.get(["assistant_payload", 6, "reasoning", 0])).value,
      "string",
    );
    assert.equal(JSON.stringify(await store.getJob(6)).includes(reasoning), false);

    await store.completeDeliveredJob(
      6,
      "owner",
      1003,
      "done",
      stored(6, 1, "assistant", "answer"),
      100,
      undefined,
      assistantHistory,
    );

    for (let index = 0; index < (response.reasoningChunkCount ?? 0); index++) {
      assert.equal(
        typeof (await kv.get(["assistant_payload", 6, "reasoning", index])).value,
        "string",
      );
    }
    const [message] = await store.getRecentMessages(1, undefined, 0, 6, 10);
    assert.equal(message.reasoningContent, reasoning);
    assert.equal(message.reasoningChunkCount, response.reasoningChunkCount);
  } finally {
    kv.close();
  }
});

Deno.test("an oversized assistant payload omits the entire history turn", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(makeUpdate(60), 1000);
    await store.storeMessage(stored(60, 0, "user", "question"), 100);
    await store.claimJob(60, "owner", 1001, 5000);
    const response = await store.saveJobResponse(
      60,
      "owner",
      {
        chatId: 1,
        messageId: 60,
        epoch: 0,
        text: "answer",
        storeAssistant: true,
      },
      1002,
      { content: "answer", reasoningContent: "x".repeat(700_000) },
    );

    assert.equal(response.storeAssistant, false);
    assert.equal(response.omitHistoryTurn, true);
    assert.equal(response.reasoningChunkCount, undefined);
    assert.equal((await kv.get(["assistant_payload", 60, "reasoning", 0])).value, null);
    await store.completeDeliveredJob(60, "owner", 1003, "done");
    assert.deepEqual(await store.getRecentMessages(1, undefined, 0, 60, 10), []);
    assert.equal((await store.getJob(60))?.state, "done");
  } finally {
    kv.close();
  }
});

Deno.test("terminal failure deletes pending assistant payload chunks", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(makeUpdate(4), 1000);
    await store.claimJob(4, "owner", 1001, 5000);
    const assistantHistory = {
      content: "answer",
      reasoningContent: "sensitive hidden reasoning".repeat(1000),
    };
    const response = await store.saveJobResponse(
      4,
      "owner",
      {
        chatId: 1,
        messageId: 4,
        epoch: 0,
        text: "answer",
        storeAssistant: true,
      },
      1002,
      assistantHistory,
    );

    assert.ok((response.reasoningChunkCount ?? 0) > 1);
    assert.equal(
      typeof (await kv.get(["assistant_payload", 4, "reasoning", 0])).value,
      "string",
    );
    await store.finishJob(4, "owner", "failed", 1003, "attempts_exhausted", true);
    for (let index = 0; index < (response.reasoningChunkCount ?? 0); index++) {
      assert.equal(
        (await kv.get(["assistant_payload", 4, "reasoning", index])).value,
        null,
      );
    }
  } finally {
    kv.close();
  }
});

Deno.test("assistant payload chunks are deleted when history is pruned or reset", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    const reasoning = "hidden ".repeat(4000);
    const firstHistory = { content: "first", reasoningContent: reasoning };

    await store.acceptUpdate(makeUpdate(7), 1000);
    await store.claimJob(7, "owner-7", 1001, 5000);
    const firstResponse = await store.saveJobResponse(
      7,
      "owner-7",
      {
        chatId: 1,
        messageId: 7,
        epoch: 0,
        text: "first",
        storeAssistant: true,
      },
      1002,
      firstHistory,
    );
    await store.completeDeliveredJob(
      7,
      "owner-7",
      1003,
      "done",
      stored(7, 1, "assistant", "first"),
      100,
      undefined,
      firstHistory,
    );

    await store.acceptUpdate(makeUpdate(8), 1004);
    await store.claimJob(8, "owner-8", 1005, 5000);
    await store.saveJobResponse(8, "owner-8", {
      chatId: 1,
      messageId: 8,
      epoch: 0,
      text: "second",
      storeAssistant: true,
    }, 1006);
    await store.completeDeliveredJob(
      8,
      "owner-8",
      1007,
      "done",
      stored(8, 1, "assistant", "second"),
      1,
      undefined,
      { content: "second" },
    );

    assert.equal((await kv.get(["message", "1:main", 0, 7, 1])).value, null);
    for (let index = 0; index < (firstResponse.reasoningChunkCount ?? 0); index++) {
      assert.equal(
        (await kv.get(["assistant_payload", 7, "reasoning", index])).value,
        null,
      );
    }

    await store.acceptUpdate(makeUpdate(9), 1008);
    await store.claimJob(9, "owner-9", 1009, 5000);
    const resetResponse = await store.saveJobResponse(
      9,
      "owner-9",
      {
        chatId: 1,
        messageId: 9,
        epoch: 0,
        text: "before reset",
        storeAssistant: true,
      },
      1010,
      { content: "before reset", reasoningContent: reasoning },
    );
    await store.completeDeliveredJob(
      9,
      "owner-9",
      1011,
      "done",
      stored(9, 1, "assistant", "before reset"),
      100,
      undefined,
      { content: "before reset", reasoningContent: reasoning },
    );

    await store.resetConversation(1);
    assert.equal((await kv.get(["message", "1:main", 0, 9, 1])).value, null);
    for (let index = 0; index < (resetResponse.reasoningChunkCount ?? 0); index++) {
      assert.equal(
        (await kv.get(["assistant_payload", 9, "reasoning", index])).value,
        null,
      );
    }
  } finally {
    kv.close();
  }
});
