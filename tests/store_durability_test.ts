import assert from "node:assert/strict";
import { BotStore } from "../src/store.ts";
import type { StoredMessage } from "../src/types.ts";
import { makeUpdate } from "./test_utils.ts";

const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

Deno.test("assistant history preserves exact provider content separately from delivery", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    const assistantHistory = {
      content: "  **provider markdown** [source](https://example.com)\n",
      reasoningContent: "  hidden provider state \n",
    };

    await store.acceptUpdate(makeUpdate(70), 1000);
    await store.claimJob(70, "owner", 1001, 5000);
    const response = await store.saveJobResponse(
      70,
      "owner",
      {
        chatId: 1,
        messageId: 70,
        epoch: 0,
        text: "provider markdown source",
        storeAssistant: true,
      },
      1002,
      assistantHistory,
    );
    await store.releaseJob(70, "owner", 1003);
    assert.equal((await store.claimJob(70, "retry", 1004, 5000)).result, "claimed");
    const restoredHistory = await store.readJobAssistantHistory(70, response);
    assert.deepEqual(restoredHistory, assistantHistory);
    await store.completeDeliveredJob(
      70,
      "retry",
      1005,
      "done",
      stored(70, 1, "assistant", "provider markdown source"),
      100,
      undefined,
      restoredHistory,
    );

    const messages = await store.getRecentMessages(1, undefined, 0, 70, 10);
    assert.equal(messages.at(-1)?.text, assistantHistory.content);
    assert.equal(
      messages.at(-1)?.reasoningContent,
      assistantHistory.reasoningContent,
    );
  } finally {
    kv.close();
  }
});

Deno.test("reasoning larger than the old 400 KB ceiling round-trips exactly", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    const assistantHistory = {
      content: "answer",
      reasoningContent: "r".repeat(450_000),
    };

    await store.acceptUpdate(makeUpdate(71), 1000);
    await store.claimJob(71, "owner", 1001, 5000);
    await store.saveJobResponse(
      71,
      "owner",
      {
        chatId: 1,
        messageId: 71,
        epoch: 0,
        text: "answer",
        storeAssistant: true,
      },
      1002,
      assistantHistory,
    );
    await store.completeDeliveredJob(
      71,
      "owner",
      1003,
      "done",
      stored(71, 1, "assistant", "answer"),
      100,
      undefined,
      assistantHistory,
    );

    const messages = await store.getRecentMessages(1, undefined, 0, 71, 10);
    assert.equal(messages.at(-1)?.text, assistantHistory.content);
    assert.equal(
      messages.at(-1)?.reasoningContent,
      assistantHistory.reasoningContent,
    );
  } finally {
    kv.close();
  }
});

Deno.test("an unpersistable assistant payload omits the whole conversation turn", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    const assistantHistory = {
      content: "answer",
      reasoningContent: "r".repeat(700_000),
    };

    await store.acceptUpdate(makeUpdate(72), 1000);
    await store.storeMessage(stored(72, 0, "user", "question"), 100);
    await store.claimJob(72, "owner", 1001, 5000);
    const response = await store.saveJobResponse(
      72,
      "owner",
      {
        chatId: 1,
        messageId: 72,
        epoch: 0,
        text: "answer",
        storeAssistant: true,
      },
      1002,
      assistantHistory,
    );

    assert.equal(response.storeAssistant, false);
    await store.completeDeliveredJob(72, "owner", 1003, "done");
    assert.deepEqual(
      await store.getRecentMessages(1, undefined, 0, 72, 10),
      [],
    );
  } finally {
    kv.close();
  }
});

Deno.test("active job writes align the job and pending-marker lifetime", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const recordedSets: RecordedSet[] = [];
    const store = new BotStore(recordingKv(kv, recordedSets));
    await store.acceptUpdate(makeUpdate(73), 1000);
    recordedSets.length = 0;

    await store.claimJob(73, "owner", 1000 + JOB_TTL_MS - 5000, 4000);

    assert.deepEqual(
      recordedSets.map(({ key, expireIn }) => ({ key, expireIn })),
      [
        { key: ["job", 73], expireIn: 5000 },
        {
          key: ["conversation_pending", "1:main", 73],
          expireIn: 5000,
        },
      ],
    );
  } finally {
    kv.close();
  }
});

Deno.test("jobs too close to expiry become deduplicating tombstones", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(makeUpdate(76), 1000);

    assert.deepEqual(
      await store.claimJob(76, "owner", 1000 + JOB_TTL_MS - 123, 5000),
      { result: "expired" },
    );
    assert.deepEqual(await store.getJob(76), {
      updateId: 76,
      state: "ignored",
      createdAt: 1000,
      updatedAt: 1000 + JOB_TTL_MS - 123,
      attempts: 0,
      errorCode: "expired",
    });
    assert.equal(
      (await kv.get(["conversation_pending", "1:main", 76])).value,
      null,
    );
  } finally {
    kv.close();
  }
});

Deno.test("near-expiry cleanup does not interrupt a live foreign lease", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(makeUpdate(77), 1000);
    assert.equal(
      (await store.claimJob(77, "working", 1000 + JOB_TTL_MS - 6000, 5000)).result,
      "claimed",
    );

    assert.deepEqual(
      await store.claimJob(77, "duplicate", 1000 + JOB_TTL_MS - 4500, 5000),
      { result: "busy" },
    );
    const job = await store.getJob(77);
    assert.equal(job?.state, "pending");
    assert.equal(job?.state === "pending" ? job.leaseOwner : undefined, "working");
  } finally {
    kv.close();
  }
});

Deno.test("conversation head lookup removes orphaned pending markers", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await kv.set(["conversation_pending", "1:main", 74], true);
    await store.acceptUpdate(makeUpdate(75), 1000);

    assert.equal(await store.getConversationHeadUpdateId("1:main"), 75);
    assert.equal(
      (await kv.get(["conversation_pending", "1:main", 74])).value,
      null,
    );
  } finally {
    kv.close();
  }
});

Deno.test("legacy reasoning layouts remain readable and migrate on completion", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(makeUpdate(80), 1000);
    await store.claimJob(80, "owner", 1001, 5000);
    const response = await store.saveJobResponse(
      80,
      "owner",
      {
        chatId: 1,
        messageId: 80,
        epoch: 0,
        text: "legacy delivery text",
        storeAssistant: true,
      },
      1002,
      { content: "raw provider text", reasoningContent: "legacy reasoning" },
    );
    const ready = await store.getJob(80);
    assert.equal(ready?.state, "response_ready");
    if (ready?.state !== "response_ready" || !ready.response) assert.fail();
    const { assistantContentChunkCount: _assistantCount, ...legacyResponse } =
      ready.response;
    let operation = kv.atomic().set(
      ["job", 80],
      { ...ready, response: legacyResponse },
    );
    for (let index = 0; index < (response.assistantContentChunkCount ?? 0); index++) {
      operation = operation.delete(["assistant_payload", 80, "content", index]);
    }
    for (let index = 0; index < (response.reasoningChunkCount ?? 0); index++) {
      operation = operation.delete(["assistant_payload", 80, "reasoning", index]);
    }
    await operation.set(["job_reasoning", 80, 0], "legacy reasoning").commit();

    assert.deepEqual(await store.readJobAssistantHistory(80, legacyResponse), {
      content: "legacy delivery text",
      reasoningContent: "legacy reasoning",
    });
    await store.completeDeliveredJob(
      80,
      "owner",
      1003,
      "done",
      stored(80, 1, "assistant", "legacy delivery text"),
    );
    assert.equal((await kv.get(["job_reasoning", 80, 0])).value, null);
    const migrated = (await store.getRecentMessages(1, undefined, 0, 80, 10)).at(-1);
    assert.equal(migrated?.text, "legacy delivery text");
    assert.equal(migrated?.reasoningContent, "legacy reasoning");

    const legacyMessage = {
      ...stored(81, 1, "assistant", "old completed answer"),
      reasoningChunkCount: 1,
    };
    await kv.set(["message", "1:main", 0, 81, 1], legacyMessage);
    await kv.set(
      ["message_reasoning", "1:main", 0, 81, 1, 0],
      "old completed reasoning",
    );
    const oldCompleted = (await store.getRecentMessages(1, undefined, 0, 81, 10))
      .find((message) => message.updateId === 81);
    assert.equal(oldCompleted?.reasoningContent, "old completed reasoning");

    await store.resetConversation(1);
    assert.equal(
      (await kv.get(["message_reasoning", "1:main", 0, 81, 1, 0])).value,
      null,
    );
  } finally {
    kv.close();
  }
});

interface RecordedSet {
  key: Deno.KvKey;
  expireIn?: number;
}

function recordingKv(kv: Deno.Kv, recordedSets: RecordedSet[]): Deno.Kv {
  return new Proxy(kv, {
    get(target, property) {
      if (property === "atomic") {
        return () => {
          const operation = target.atomic();
          const wrapper = {
            check(...checks: Parameters<typeof operation.check>) {
              operation.check(...checks);
              return wrapper;
            },
            set(...args: Parameters<typeof operation.set>) {
              recordedSets.push({
                key: args[0],
                expireIn: args[2]?.expireIn,
              });
              operation.set(...args);
              return wrapper;
            },
            delete(...args: Parameters<typeof operation.delete>) {
              operation.delete(...args);
              return wrapper;
            },
            commit() {
              return operation.commit();
            },
          };
          return wrapper as unknown as Deno.AtomicOperation;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Deno.Kv;
}

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
