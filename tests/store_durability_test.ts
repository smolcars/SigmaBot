import assert from "node:assert/strict";
import { BotStore } from "../src/store.ts";
import type { IssueSubmissionCheckpoint, StoredMessage } from "../src/types.ts";
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

    const directChatId = -100;
    const directTopicId = 33;
    const directConversationKey = `${directChatId}:direct:${directTopicId}`;
    const legacyMessage = {
      ...stored(81, 1, "assistant", "old completed answer"),
      chatId: directChatId,
      directMessagesTopicId: directTopicId,
      reasoningChunkCount: 1,
    };
    await kv.set(["message", directConversationKey, 0, 81, 1], legacyMessage);
    await kv.set(
      ["message_reasoning", directConversationKey, 0, 81, 1, 0],
      "old completed reasoning",
    );
    const oldCompleted = (await store.getRecentMessages(
      directChatId,
      undefined,
      0,
      81,
      10,
      directTopicId,
    )).find((message) => message.updateId === 81);
    assert.equal(oldCompleted?.reasoningContent, "old completed reasoning");

    await store.resetConversation(directChatId, undefined, directTopicId);
    assert.equal(
      (await kv.get([
        "message_reasoning",
        directConversationKey,
        0,
        81,
        1,
        0,
      ])).value,
      null,
    );
  } finally {
    kv.close();
  }
});

Deno.test("issue checkpoints require the current job lease owner", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(makeUpdate(90), 1000);
    assert.equal((await store.claimJob(90, "old", 1000, 10)).result, "claimed");
    assert.equal((await store.claimJob(90, "new", 1011, 5000)).result, "claimed");

    await assert.rejects(
      () => store.saveIssueSubmission(90, "old", issueCheckpoint(), 1012),
      /lease was lost/,
    );
    assert.equal((await store.getJob(90))?.state, "pending");

    const saved = await store.saveIssueSubmission(
      90,
      "new",
      issueCheckpoint(),
      1013,
    );
    assert.deepEqual(saved.issueSubmission, issueCheckpoint());
  } finally {
    kv.close();
  }
});

Deno.test("issue checkpoints survive retries with a processable compact update", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    await store.acceptUpdate(
      makeUpdate(91, {
        text: "/issue blixt sensitive report details",
        message_thread_id: 42,
      }),
      1000,
    );
    await store.claimJob(91, "first", 1001, 5000);
    const checkpoint = issueCheckpoint({
      title: "Payment fails after scanning an invoice",
      inputTokens: 120,
      outputTokens: 45,
    });
    const saved = await store.saveIssueSubmission(91, "first", checkpoint, 1002);

    assert.equal(saved.state, "pending");
    assert.deepEqual(saved.issueSubmission, checkpoint);
    assert.deepEqual(saved.update, {
      update_id: 91,
      message: {
        message_id: 91,
        message_thread_id: 42,
        from: { id: 1, first_name: "" },
        chat: { id: 1, type: "private" },
      },
    });
    assert.equal(JSON.stringify(saved).includes("sensitive report details"), false);

    await store.releaseJob(91, "first", 1003);
    const retry = await store.claimJob(91, "retry", 1004, 5000);
    assert.equal(retry.result, "claimed");
    if (retry.result !== "claimed") assert.fail();
    assert.deepEqual(retry.job.issueSubmission, checkpoint);
    assert.equal(retry.job.update.message?.chat.id, 1);
    assert.equal(retry.job.update.message?.from?.id, 1);
    assert.equal(retry.job.update.message?.message_thread_id, 42);

    const repeated = await store.saveIssueSubmission(
      91,
      "retry",
      checkpoint,
      1005,
    );
    assert.deepEqual(repeated.issueSubmission, checkpoint);
    await assert.rejects(
      () =>
        store.saveIssueSubmission(
          91,
          "retry",
          issueCheckpoint({ marker: "different" }),
          1006,
        ),
      /already has an issue submission/,
    );
  } finally {
    kv.close();
  }
});

Deno.test("issue checkpoint writes preserve the active job deadline", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const recordedSets: RecordedSet[] = [];
    const store = new BotStore(recordingKv(kv, recordedSets));
    await store.acceptUpdate(makeUpdate(92), 1000);
    await store.claimJob(92, "owner", 1000 + JOB_TTL_MS - 5000, 4000);
    recordedSets.length = 0;

    await store.saveIssueSubmission(
      92,
      "owner",
      issueCheckpoint(),
      1000 + JOB_TTL_MS - 4000,
    );

    assert.deepEqual(
      recordedSets.map(({ key, expireIn }) => ({ key, expireIn })),
      [
        { key: ["job", 92], expireIn: 4000 },
        {
          key: ["conversation_pending", "1:main", 92],
          expireIn: 4000,
        },
      ],
    );
  } finally {
    kv.close();
  }
});

Deno.test("response and terminal transitions discard issue checkpoint content", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new BotStore(kv);
    const checkpoint = issueCheckpoint({ body: "private generated issue body" });
    await store.acceptUpdate(makeUpdate(93), 1000);
    await store.claimJob(93, "owner", 1001, 5000);
    await store.saveIssueSubmission(93, "owner", checkpoint, 1002);
    await store.saveJobResponse(93, "owner", {
      chatId: 1,
      messageId: 93,
      epoch: 0,
      text: "Created smolcars/blixt-wallet issue #123: https://example.com/123",
      storeAssistant: false,
    }, 1003);

    const ready = await store.getJob(93);
    assert.equal(ready?.state, "response_ready");
    if (ready?.state !== "response_ready") assert.fail();
    assert.equal(ready.issueSubmission, undefined);
    assert.equal(JSON.stringify(ready).includes(checkpoint.body), false);

    await store.completeDeliveredJob(93, "owner", 1004, "done");
    const completed = await store.getJob(93);
    assert.deepEqual(completed, {
      updateId: 93,
      state: "done",
      createdAt: 1000,
      updatedAt: 1004,
      attempts: 0,
    });
    assert.equal(JSON.stringify(completed).includes(checkpoint.marker), false);

    await store.acceptUpdate(makeUpdate(94), 2000);
    await store.claimJob(94, "owner", 2001, 5000);
    await store.saveIssueSubmission(94, "owner", checkpoint, 2002);
    await store.finishJob(94, "owner", "failed", 2003, "github_rejected");
    assert.equal(JSON.stringify(await store.getJob(94)).includes(checkpoint.body), false);
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

function issueCheckpoint(
  overrides: Partial<IssueSubmissionCheckpoint> = {},
): IssueSubmissionCheckpoint {
  return {
    alias: "blixt",
    repository: "smolcars/blixt-wallet",
    title: "Invoice payment fails",
    body: "## Description\n\nPayment fails after scanning an invoice.",
    marker: "00000000-0000-4000-8000-000000000090",
    ...overrides,
  };
}
