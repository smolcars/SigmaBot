import assert from "node:assert/strict";
import { AIProviderError } from "../src/ai.ts";
import { BotApplication } from "../src/bot.ts";
import type { AppConfig, GitHubConfig } from "../src/config.ts";
import { GitHubApiError } from "../src/github.ts";
import { BotStore } from "../src/store.ts";
import { TelegramApiError } from "../src/telegram.ts";
import {
  FakeAI,
  FakeGitHub,
  FakeTelegram,
  makeUpdate,
  testConfig,
  webhookRequest,
} from "./test_utils.ts";

function githubConfig(overrides: Partial<GitHubConfig> = {}): GitHubConfig {
  return {
    appId: "1",
    installationId: "2",
    privateKey: "test-private-key",
    repositories: new Map([
      ["sigmabot", "smolcars/SigmaBot"],
      ["blixt", "smolcars/blixt-wallet"],
    ]),
    allowedUserIds: new Set(["1"]),
    ...overrides,
  };
}

function issueDraft(
  title = "Fix the reported problem",
  body =
    "## Description\nProblem details.\n\n## Context\nObserved in chat.\n\n## Expected Behavior\nIt works.",
): string {
  return JSON.stringify({ title, body, relevant: true });
}

async function fixture(
  overrides: Partial<AppConfig> = {},
  github = new FakeGitHub(),
) {
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
    { now: () => now++, randomUUID: () => `owner-${++id}`, github },
  );
  return {
    kv,
    store,
    telegram,
    ai,
    github,
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

Deno.test("ordinary Markdown links stay clickable across delivery retry", async () => {
  const { kv, app, store, telegram, ai } = await fixture();
  try {
    ai.response = {
      text: "Read [the docs](https://example.com/path).",
    };
    telegram.failMessages = 1;
    const update = makeUpdate(106);

    assert.equal((await app.fetch(webhookRequest(update))).status, 500);
    assert.equal(ai.calls.length, 1);
    assert.equal(telegram.messageAttempts, 1);

    const checkpoint = await store.getJob(106);
    assert.equal(checkpoint?.state, "response_ready");
    if (checkpoint?.state !== "response_ready" || !checkpoint.response) {
      assert.fail("response checkpoint was not saved");
    }
    const formatted = checkpoint.response.formatted;
    assert.ok(formatted);
    assert.equal(formatted.parseMode, "HTML");
    assert.equal(
      formatted.text,
      'Read <a href="https://example.com/path">the docs</a>.',
    );
    assert.equal(
      checkpoint.response.text,
      "Read the docs (https://example.com/path).",
    );

    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal(ai.calls.length, 1);
    assert.equal(telegram.messageAttempts, 2);
    assert.equal(telegram.messages.length, 1);
    assert.deepEqual(telegram.messages[0]?.formatted, formatted);
    assert.equal(telegram.messages[0]?.plainText, checkpoint.response.text);
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

Deno.test("disabled issue command returns a configuration error without history", async () => {
  const { kv, app, store, telegram, ai, github } = await fixture();
  try {
    assert.equal(
      (await app.fetch(webhookRequest(makeUpdate(30, { text: "/issue make one" })))).status,
      200,
    );
    assert.equal(ai.calls.length, 0);
    assert.equal(github.findCalls.length, 0);
    assert.equal(github.createCalls.length, 0);
    assert.match(telegram.messages[0]?.plainText ?? "", /isn't configured/);
    assert.deepEqual(await store.getRecentMessages(1, undefined, 0, 30, 10), []);
    assert.equal((await store.getJob(30))?.state, "failed");
  } finally {
    kv.close();
  }
});

Deno.test("help advertises issue creation only when GitHub is enabled", async () => {
  const { kv, app, telegram, ai, github } = await fixture({ github: githubConfig() });
  try {
    assert.equal(
      (await app.fetch(webhookRequest(makeUpdate(31, { text: "/help" })))).status,
      200,
    );
    assert.match(
      telegram.messages[0]?.plainText ?? "",
      /\/issue <repo> \[description\] - Create a GitHub issue/,
    );
    assert.equal(ai.calls.length, 0);
    assert.equal(github.findCalls.length, 0);
  } finally {
    kv.close();
  }
});

Deno.test("GitHub configuration requires an injected gateway", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    assert.throws(
      () =>
        new BotApplication(
          testConfig({ github: githubConfig() }),
          new BotStore(kv),
          new FakeTelegram(),
          new FakeAI(),
        ),
      /no GitHub gateway/i,
    );
  } finally {
    kv.close();
  }
});

Deno.test("issue authorization is separate and fail-closed", async () => {
  const { kv, app, store, telegram, ai, github } = await fixture({
    allowedUserIds: new Set(["1", "2"]),
    github: githubConfig({ allowedUserIds: new Set(["1"]) }),
  });
  try {
    const update = makeUpdate(32, {
      from: { id: 2, first_name: "Denied User" },
      text: "/issue blixt create this",
    });
    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.match(telegram.messages[0]?.plainText ?? "", /aren't allowed/);
    assert.equal(ai.calls.length, 0);
    assert.equal(github.findCalls.length, 0);
    assert.equal(github.createCalls.length, 0);
    assert.deepEqual(await store.getRecentMessages(1, undefined, 0, 32, 10), []);
  } finally {
    kv.close();
  }
});

Deno.test("issue aliases are required, sorted, and restricted to configuration", async () => {
  const { kv, app, store, telegram, ai, github } = await fixture({
    github: githubConfig(),
  });
  try {
    assert.equal(
      (await app.fetch(webhookRequest(makeUpdate(33, { text: "/issue" })))).status,
      200,
    );
    assert.equal(
      (await app.fetch(webhookRequest(makeUpdate(34, {
        text: "/issue smolcars/other arbitrary repo",
      })))).status,
      200,
    );
    for (const sent of telegram.messages) {
      assert.equal(sent.plainText, "Usage: /issue <blixt|sigmabot> [description]");
    }
    assert.equal(ai.calls.length, 0);
    assert.equal(github.findCalls.length, 0);
    assert.equal(github.createCalls.length, 0);
    assert.deepEqual(await store.getRecentMessages(1, undefined, 0, 34, 10), []);
  } finally {
    kv.close();
  }
});

Deno.test("overlong issue commands are rejected before AI generation", async () => {
  const { kv, app, store, telegram, ai, github } = await fixture({
    github: githubConfig(),
    maxMessageChars: 24,
  });
  try {
    const update = makeUpdate(35, { text: `/issue blixt ${"x".repeat(30)}` });
    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.match(telegram.messages[0]?.plainText ?? "", /too long/i);
    assert.equal(ai.calls.length, 0);
    assert.equal(github.findCalls.length, 0);
    assert.deepEqual(await store.getRecentMessages(1, undefined, 0, 35, 10), []);
  } finally {
    kv.close();
  }
});

Deno.test("alias-only issue creation requires prior topic context", async () => {
  const { kv, app, store, telegram, ai, github } = await fixture({
    github: githubConfig(),
  });
  try {
    const update = makeUpdate(36, { text: "/issue blixt" });
    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.match(telegram.messages[0]?.plainText ?? "", /enough context/i);
    assert.equal(ai.calls.length, 0);
    assert.equal(github.findCalls.length, 0);
    assert.deepEqual(await store.getRecentMessages(1, undefined, 0, 36, 10), []);
  } finally {
    kv.close();
  }
});

Deno.test("issue command routes a configured alias without web search or history", async () => {
  const github = new FakeGitHub();
  github.createdIssue = {
    number: 77,
    url: "https://github.com/smolcars/blixt-wallet/issues/77",
  };
  const { kv, app, store, telegram, ai } = await fixture(
    { github: githubConfig(), webSearch: true },
    github,
  );
  try {
    ai.response = {
      text: issueDraft("Wallet fails to start"),
      inputTokens: 44,
      outputTokens: 12,
    };
    const update = makeUpdate(37, {
      chat: {
        id: -100,
        type: "supergroup",
        is_direct_messages: true,
      },
      direct_messages_topic: { topic_id: 700 },
      text: "/issue@sigmabot blixt Wallet fails to start",
    });
    assert.equal((await app.fetch(webhookRequest(update))).status, 200);

    assert.equal(ai.calls.length, 1);
    assert.deepEqual(ai.calls[0]?.options, { webSearch: false });
    assert.match(ai.calls[0]?.systemPrompt ?? "", /GitHub issue drafts/);
    assert.equal(
      ai.calls[0]?.messages.every((item) => typeof item.content === "string"),
      true,
    );
    assert.match(
      String(ai.calls[0]?.messages.at(-1)?.content),
      /Wallet fails to start/,
    );
    assert.deepEqual(github.findCalls, [{
      repository: "smolcars/blixt-wallet",
      marker: github.createCalls[0]?.marker,
    }]);
    assert.deepEqual(github.createCalls[0], {
      repository: "smolcars/blixt-wallet",
      title: "Wallet fails to start",
      body: JSON.parse(ai.response.text).body,
      marker: github.findCalls[0]?.marker,
    });
    assert.equal(
      telegram.messages[0]?.plainText,
      "Created smolcars/blixt-wallet issue #77: " +
        "https://github.com/smolcars/blixt-wallet/issues/77",
    );
    assert.equal(telegram.messages[0]?.options?.directMessagesTopicId, 700);
    assert.equal(telegram.actions.length, 0);
    assert.deepEqual(
      await store.getRecentMessages(-100, undefined, 0, 37, 10, 700),
      [],
    );
  } finally {
    kv.close();
  }
});

Deno.test("alias-only issue context is topic-scoped and anonymized", async () => {
  const { kv, app, store, telegram, ai, github } = await fixture({
    github: githubConfig(),
  });
  try {
    ai.response = {
      text: "same-topic assistant context",
      reasoningContent: "hidden provider reasoning",
    };
    assert.equal(
      (await app.fetch(webhookRequest(makeUpdate(38, {
        message_thread_id: 10,
        text: "same-topic failure details",
        reply_to_message: {
          message_id: 1,
          chat: { id: 1, type: "private" },
          from: { id: 8, first_name: "Bob" },
          text: "original report",
        },
      })))).status,
      200,
    );
    ai.response = { text: "cross-topic assistant context" };
    assert.equal(
      (await app.fetch(webhookRequest(makeUpdate(39, {
        message_thread_id: 20,
        from: { id: 1, first_name: "Charlie" },
        text: "cross-topic details",
      })))).status,
      200,
    );

    ai.calls.length = 0;
    ai.response = { text: issueDraft("Same-topic failure") };
    assert.equal(
      (await app.fetch(webhookRequest(makeUpdate(40, {
        message_thread_id: 10,
        from: { id: 1, first_name: "Alice" },
        text: "/issue sigmabot",
      })))).status,
      200,
    );

    assert.equal(ai.calls.length, 1);
    const suppliedContext = JSON.stringify(ai.calls[0]?.messages);
    assert.match(suppliedContext, /\[User\]:/);
    assert.match(suppliedContext, /Replying to another message/);
    assert.match(suppliedContext, /same-topic failure details/);
    assert.doesNotMatch(suppliedContext, /Alice|Bob|Charlie/);
    assert.doesNotMatch(suppliedContext, /cross-topic|hidden provider reasoning/);
    assert.equal(github.createCalls[0]?.repository, "smolcars/SigmaBot");
    assert.equal(telegram.messages.at(-1)?.options?.messageThreadId, 10);
    assert.deepEqual(
      (await store.getRecentMessages(1, 10, 0, 40, 10)).map((item) => item.text),
      [
        '[Replying to Bob: "original report"]\nsame-topic failure details',
        "same-topic assistant context",
      ],
    );
  } finally {
    kv.close();
  }
});

Deno.test("irrelevant, malformed, and secret-bearing drafts never reach GitHub", async () => {
  const cases = [
    {
      name: "irrelevant",
      response: JSON.stringify({ title: "", body: "", relevant: false }),
      expectedMessage: /enough context/i,
      expectedState: "done",
    },
    {
      name: "malformed",
      response: "not JSON",
      expectedMessage: /safe GitHub issue/i,
      expectedState: "failed",
    },
    {
      name: "secret",
      response: issueDraft(
        "Leaked token",
        "## Description\nghp_abcdefghijklmnopqrstuvwxyz123456\n\n" +
          "## Context\nFound in logs.\n\n## Expected Behavior\nRedacted.",
      ),
      expectedMessage: /safe GitHub issue/i,
      expectedState: "failed",
    },
  ] as const;

  for (const [index, testCase] of cases.entries()) {
    const { kv, app, store, telegram, ai, github } = await fixture({
      github: githubConfig(),
    });
    try {
      ai.response = { text: testCase.response };
      const updateId = 41 + index;
      assert.equal(
        (await app.fetch(webhookRequest(makeUpdate(updateId, {
          text: "/issue blixt enough detail to generate a draft",
        })))).status,
        200,
        testCase.name,
      );
      assert.equal(ai.calls.length, 1, testCase.name);
      assert.equal(github.findCalls.length, 0, testCase.name);
      assert.equal(github.createCalls.length, 0, testCase.name);
      assert.match(
        telegram.messages[0]?.plainText ?? "",
        testCase.expectedMessage,
        testCase.name,
      );
      assert.equal((await store.getJob(updateId))?.state, testCase.expectedState);
      assert.deepEqual(
        await store.getRecentMessages(1, undefined, 0, updateId, 10),
        [],
        testCase.name,
      );
    } finally {
      kv.close();
    }
  }
});

Deno.test("a retryable create reconciles its marker without regenerating or reposting", async () => {
  const github = new FakeGitHub();
  github.createError = new GitHubApiError("ambiguous failure", 503, true);
  const { kv, app, store, telegram, ai } = await fixture(
    { github: githubConfig() },
    github,
  );
  try {
    ai.response = { text: issueDraft("Recover submission"), inputTokens: 20 };
    const update = makeUpdate(44, { text: "/issue blixt recover this failure" });

    assert.equal((await app.fetch(webhookRequest(update))).status, 500);
    assert.equal(ai.calls.length, 1);
    assert.equal(github.findCalls.length, 1);
    assert.equal(github.createCalls.length, 1);
    assert.equal(telegram.messages.length, 0);
    const checkpointed = await store.getJob(44);
    assert.equal(checkpointed?.state, "pending");
    assert.ok(checkpointed?.state === "pending" && checkpointed.issueSubmission);
    assert.equal(
      checkpointed?.state === "pending" ? checkpointed.update.message?.text : "present",
      undefined,
    );

    github.createError = undefined;
    github.foundIssue = {
      number: 88,
      url: "https://github.com/smolcars/blixt-wallet/issues/88",
    };
    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal(ai.calls.length, 1);
    assert.equal(github.findCalls.length, 2);
    assert.equal(github.createCalls.length, 1);
    assert.equal(github.findCalls[0]?.marker, github.findCalls[1]?.marker);
    assert.match(telegram.messages[0]?.plainText ?? "", /issue #88/);
    assert.equal((await store.getJob(44))?.state, "done");
  } finally {
    kv.close();
  }
});

Deno.test("GitHub retry-after defers the checkpoint and clamps zero to one second", async () => {
  const github = new FakeGitHub();
  github.createError = new GitHubApiError("rate limited", 429, true, 0);
  const { kv, app, store, telegram, ai, advanceTime } = await fixture(
    { github: githubConfig() },
    github,
  );
  try {
    ai.response = { text: issueDraft("Deferred submission") };
    const update = makeUpdate(45, { text: "/issue sigmabot defer this" });

    const deferred = await app.fetch(webhookRequest(update));
    assert.equal(deferred.status, 503);
    assert.equal(deferred.headers.get("retry-after"), "1");
    const checkpoint = await store.getJob(45);
    assert.equal(checkpoint?.state, "pending");
    assert.equal(checkpoint?.attempts, 0);
    assert.ok((checkpoint?.retryNotBefore ?? 0) > 1_000_000);
    assert.equal(ai.calls.length, 1);
    assert.equal(github.createCalls.length, 1);

    assert.equal((await app.fetch(webhookRequest(update))).status, 503);
    assert.equal(github.findCalls.length, 1);
    assert.equal(github.createCalls.length, 1);

    github.createError = undefined;
    github.foundIssue = {
      number: 89,
      url: "https://github.com/smolcars/SigmaBot/issues/89",
    };
    advanceTime(1_001);
    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal(ai.calls.length, 1);
    assert.equal(github.findCalls.length, 2);
    assert.equal(github.createCalls.length, 1);
    assert.equal(telegram.messages.length, 1);
  } finally {
    kv.close();
  }
});

Deno.test("an existing marker avoids issue creation", async () => {
  const github = new FakeGitHub();
  github.foundIssue = {
    number: 90,
    url: "https://github.com/smolcars/SigmaBot/issues/90",
  };
  const { kv, app, telegram, ai } = await fixture(
    { github: githubConfig() },
    github,
  );
  try {
    ai.response = { text: issueDraft("Already submitted") };
    assert.equal(
      (await app.fetch(webhookRequest(makeUpdate(46, {
        text: "/issue sigmabot reconcile this",
      })))).status,
      200,
    );
    assert.equal(ai.calls.length, 1);
    assert.equal(github.findCalls.length, 1);
    assert.equal(github.createCalls.length, 0);
    assert.match(telegram.messages[0]?.plainText ?? "", /issue #90/);
  } finally {
    kv.close();
  }
});

Deno.test("Telegram retry after publication does not repeat GitHub", async () => {
  const github = new FakeGitHub();
  const { kv, app, store, telegram, ai } = await fixture(
    { github: githubConfig() },
    github,
  );
  try {
    ai.response = { text: issueDraft("Delivery retry") };
    telegram.failMessages = 1;
    const update = makeUpdate(47, { text: "/issue sigmabot retry delivery" });

    assert.equal((await app.fetch(webhookRequest(update))).status, 500);
    const ready = await store.getJob(47);
    assert.equal(ready?.state, "response_ready");
    assert.equal(
      ready?.state === "response_ready" ? ready.issueSubmission : "present",
      undefined,
    );
    assert.equal(ai.calls.length, 1);
    assert.equal(github.findCalls.length, 1);
    assert.equal(github.createCalls.length, 1);

    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal(ai.calls.length, 1);
    assert.equal(github.findCalls.length, 1);
    assert.equal(github.createCalls.length, 1);
    assert.equal(telegram.messageAttempts, 2);
    assert.equal(telegram.messages.length, 1);
  } finally {
    kv.close();
  }
});

Deno.test("permanent GitHub errors produce only a generic failed response", async () => {
  const github = new FakeGitHub();
  github.createError = new GitHubApiError(
    "rejected body ghp_abcdefghijklmnopqrstuvwxyz123456",
    422,
    false,
  );
  const { kv, app, store, telegram, ai } = await fixture(
    { github: githubConfig() },
    github,
  );
  try {
    ai.response = {
      text: issueDraft("Permanent failure"),
      inputTokens: 31,
      outputTokens: 7,
    };
    telegram.failMessages = 1;
    const update = makeUpdate(48, { text: "/issue sigmabot submit this" });
    assert.equal((await app.fetch(webhookRequest(update))).status, 500);
    assert.equal(ai.calls.length, 1);
    assert.equal(github.createCalls.length, 1);
    const ready = await store.getJob(48);
    assert.equal(ready?.state, "response_ready");
    assert.equal(
      ready?.state === "response_ready" ? ready.response?.inputTokens : undefined,
      31,
    );
    assert.equal(
      ready?.state === "response_ready" ? ready.response?.outputTokens : undefined,
      7,
    );
    assert.equal(
      ready?.state === "response_ready" ? ready.response?.text : undefined,
      "I couldn't create the GitHub issue. Please try again later.",
    );
    assert.doesNotMatch(
      ready?.state === "response_ready" ? ready.response?.text ?? "" : "",
      /ghp_|body|422/,
    );

    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal((await store.getJob(48))?.state, "failed");
    assert.equal(github.createCalls.length, 1);
  } finally {
    kv.close();
  }
});

Deno.test("checkpoint resume revalidates the issue allowlist", async () => {
  const issueUsers = new Set(["1"]);
  const github = new FakeGitHub();
  github.createError = new GitHubApiError("temporary", 503, true);
  const { kv, app, store, telegram, ai } = await fixture(
    { github: githubConfig({ allowedUserIds: issueUsers }) },
    github,
  );
  try {
    ai.response = {
      text: issueDraft("Permission changed"),
      inputTokens: 29,
      outputTokens: 6,
    };
    const update = makeUpdate(49, { text: "/issue sigmabot permission test" });
    assert.equal((await app.fetch(webhookRequest(update))).status, 500);
    assert.equal(github.findCalls.length, 1);
    assert.equal(github.createCalls.length, 1);

    issueUsers.clear();
    github.createError = undefined;
    telegram.failMessages = 1;
    assert.equal((await app.fetch(webhookRequest(update))).status, 500);
    assert.equal(ai.calls.length, 1);
    assert.equal(github.findCalls.length, 1);
    assert.equal(github.createCalls.length, 1);
    const ready = await store.getJob(49);
    assert.equal(ready?.state, "response_ready");
    assert.equal(
      ready?.state === "response_ready" ? ready.response?.inputTokens : undefined,
      29,
    );
    assert.equal(
      ready?.state === "response_ready" ? ready.response?.outputTokens : undefined,
      6,
    );
    assert.match(
      ready?.state === "response_ready" ? ready.response?.text ?? "" : "",
      /couldn't create/,
    );

    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal((await store.getJob(49))?.state, "failed");
    assert.equal(github.findCalls.length, 1);
    assert.equal(github.createCalls.length, 1);
  } finally {
    kv.close();
  }
});

Deno.test("checkpoint resume rejects an alias remapped to another repository", async () => {
  const repositories = new Map([
    ["sigmabot", "smolcars/SigmaBot"],
    ["blixt", "smolcars/blixt-wallet"],
  ]);
  const github = new FakeGitHub();
  github.createError = new GitHubApiError("temporary", 503, true);
  const { kv, app, store, telegram, ai } = await fixture(
    { github: githubConfig({ repositories }) },
    github,
  );
  try {
    ai.response = { text: issueDraft("Repository changed") };
    const update = makeUpdate(491, { text: "/issue sigmabot repository test" });
    assert.equal((await app.fetch(webhookRequest(update))).status, 500);
    assert.equal(github.findCalls.length, 1);
    assert.equal(github.createCalls.length, 1);

    repositories.set("sigmabot", "smolcars/blixt-wallet");
    github.createError = undefined;
    assert.equal((await app.fetch(webhookRequest(update))).status, 200);
    assert.equal(ai.calls.length, 1);
    assert.equal(github.findCalls.length, 1);
    assert.equal(github.createCalls.length, 1);
    assert.equal((await store.getJob(491))?.state, "failed");
    assert.match(telegram.messages[0]?.plainText ?? "", /couldn't create/);
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
