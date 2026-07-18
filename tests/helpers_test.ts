import assert from "node:assert/strict";
import {
  constantTimeEqual,
  conversationKey,
  formatConversation,
  formatTelegramResponse,
  getUsableMessage,
  isAllowed,
  normalizeUpdate,
  parseCommand,
  prepareTelegramResponse,
  shouldRespond,
  stripMention,
  truncateResponse,
} from "../src/helpers.ts";
import type { StoredMessage, TelegramUpdate } from "../src/types.ts";

Deno.test("mention and command matching is case-insensitive and bot-specific", () => {
  assert.equal(shouldRespond("private", "hello", "sigmabot", false), true);
  assert.equal(shouldRespond("group", "hi @SigmaBot", "sigmabot", false), true);
  assert.equal(shouldRespond("group", "/help@otherbot", "sigmabot", false), false);
  assert.equal(parseCommand(" /RESET@sigmabot now"), "/reset");
  assert.equal(stripMention("@SIGMABOT hello", "sigmabot"), "hello");
});

Deno.test("allowlists fail closed and optionally restrict group users", () => {
  const users = new Set(["1"]);
  const groups = new Set(["-100"]);
  assert.equal(isAllowed("private", 1, 1, users, groups, false), true);
  assert.equal(isAllowed("private", 2, 2, users, groups, false), false);
  assert.equal(isAllowed("group", -100, 2, users, groups, false), true);
  assert.equal(isAllowed("group", -100, 2, users, groups, true), false);
});

Deno.test("channel direct-message topic identity survives validation and normalization", () => {
  const update: TelegramUpdate = {
    update_id: 9,
    message: {
      message_id: 12,
      direct_messages_topic: { topic_id: 34 },
      from: { id: 56, first_name: "Alice" },
      chat: {
        id: -100,
        type: "supergroup",
        title: "Channel messages",
        is_direct_messages: true,
      },
      text: "hello",
    },
  };

  assert.ok(getUsableMessage(update));
  const normalized = normalizeUpdate(update);
  assert.equal(normalized.message?.chat.is_direct_messages, true);
  assert.deepEqual(normalized.message?.direct_messages_topic, { topic_id: 34 });
});

Deno.test("malformed channel direct-message metadata is rejected", () => {
  const update = {
    update_id: 9,
    message: {
      message_id: 12,
      direct_messages_topic: { topic_id: "34" },
      from: { id: 56, first_name: "Alice" },
      chat: { id: -100, type: "supergroup", is_direct_messages: "yes" },
      text: "hello",
    },
  } as unknown as TelegramUpdate;

  assert.equal(getUsableMessage(update), undefined);
});

Deno.test("channel direct-message topics have independent conversation identities", () => {
  assert.equal(conversationKey(-100, undefined, 34), "-100:direct:34");
  assert.notEqual(conversationKey(-100, undefined, 34), conversationKey(-100, 34));
  assert.notEqual(
    conversationKey(-100, undefined, 34),
    conversationKey(-100, undefined, 35),
  );
});

Deno.test("Telegram formatting escapes HTML around code", () => {
  const formatted = formatTelegramResponse(
    "A < B and `<tag>&value`.\n```ts\nconst x = 1;\n```",
  );
  assert.equal(formatted.parseMode, "HTML");
  assert.match(formatted.text, /A &lt; B/);
  assert.match(formatted.text, /<code>&lt;tag&gt;&amp;value<\/code>/);
  assert.match(formatted.text, /language-ts/);
});

Deno.test("Telegram formatting renders safe balanced Markdown links", () => {
  const formatted = formatTelegramResponse(
    "See [FIFA <news> & fixtures](https://example.com/report_(final)?a=1&b=2) and <raw>.",
  );

  assert.deepEqual(formatted, {
    parseMode: "HTML",
    text:
      'See <a href="https://example.com/report_(final)?a=1&amp;b=2">FIFA &lt;news&gt; &amp; fixtures</a> and &lt;raw&gt;.',
  });
});

Deno.test("Telegram formatting leaves unsafe Markdown links inert", () => {
  const formatted = formatTelegramResponse(
    "Go [safe](https://safe.example/doc) and [bad <tag>](javascript:alert(1)).",
  );

  assert.equal(formatted.parseMode, "HTML");
  assert.equal(
    formatted.text,
    'Go <a href="https://safe.example/doc">safe</a> and [bad &lt;tag&gt;](javascript:alert(1)).',
  );
  assert.doesNotMatch(formatted.text, /href="javascript:/);
});

Deno.test("Telegram formatting ignores Markdown links inside code", () => {
  const formatted = formatTelegramResponse([
    "[outside](https://outside.example/a)",
    "`[inline](https://inside.example/b)`",
    "```md",
    "[fenced](https://inside.example/c?a=1&b=2)",
    "```",
  ].join("\n"));

  assert.equal(formatted.parseMode, "HTML");
  assert.equal(formatted.text.match(/<a /g)?.length, 1);
  assert.match(
    formatted.text,
    /<code>\[inline\]\(https:\/\/inside\.example\/b\)<\/code>/,
  );
  assert.match(
    formatted.text,
    /<pre><code class="language-md">\[fenced\]\(https:\/\/inside\.example\/c\?a=1&amp;b=2\)\n<\/code><\/pre>/,
  );
});

Deno.test("citation responses render inline Markdown links and a readable fallback", () => {
  const url = "https://www.fifa.com/report_(final)?a=1&b=2";
  const delivery = prepareTelegramResponse(
    `England play Argentina tomorrow ([fifa.com](${url}))[1]`,
    [{ url, title: "England < Argentina & preview" }],
  );

  assert.equal(delivery.formatted.parseMode, "HTML");
  assert.match(
    delivery.formatted.text,
    /\(<a href="https:\/\/www\.fifa\.com\/report_\(final\)\?a=1&amp;b=2">fifa\.com<\/a>\)\[1\]/,
  );
  assert.doesNotMatch(delivery.formatted.text, /\[fifa\.com\]\(/);
  assert.match(delivery.formatted.text, /<b>Sources:<\/b>/);
  assert.match(
    delivery.plainText,
    /\(fifa\.com \(https:\/\/www\.fifa\.com\/report_\(final\)\?a=1&b=2\)\)\[1\]/,
  );
  assert.doesNotMatch(delivery.plainText, /\[fifa\.com\]\(/);
});

Deno.test("web citations are visible and safely linked in Telegram", () => {
  const delivery = prepareTelegramResponse("The result is current.[1]", [
    {
      url: "https://example.com/report?a=1&b=2",
      title: '<Research> & "news"',
    },
    { url: "javascript:alert(1)", title: "Unsafe" },
  ]);

  assert.equal(delivery.formatted.parseMode, "HTML");
  assert.match(
    delivery.formatted.text,
    /href="https:\/\/example\.com\/report\?a=1&amp;b=2"/,
  );
  assert.match(delivery.formatted.text, /\[1\] &lt;Research&gt; &amp; "news"/);
  assert.doesNotMatch(delivery.formatted.text, /javascript:/);
  assert.match(delivery.plainText, /Sources:/);
  assert.match(delivery.plainText, /https:\/\/example\.com\/report\?a=1&b=2/);
  assert.ok(delivery.plainText.length <= 3_900);
});

Deno.test("omitted citations do not remove legitimate numeric markers", () => {
  const omittedUrl = `https://example.com/omitted-${"x".repeat(180)}`;
  const delivery = prepareTelegramResponse(
    "Use `items[2]` here; the literal [2] is data, not a citation. Verified.[1]",
    [
      { url: "https://example.com/kept", title: "Kept source" },
      { url: omittedUrl, title: "Omitted source" },
    ],
    400,
  );

  assert.match(delivery.formatted.text, /<code>items\[2\]<\/code>/);
  assert.match(delivery.formatted.text, /literal \[2\] is data/);
  assert.match(delivery.plainText, /literal \[2\] is data/);
  assert.match(delivery.plainText, /Sources:\n\[1\]/);
  assert.doesNotMatch(delivery.plainText, /omitted-/);
});
Deno.test("response truncation does not leave a dangling surrogate", () => {
  const suffix = "\n\n[truncated]";
  const result = truncateResponse("a".repeat(5) + "😀" + "tail".repeat(10), 19);
  const content = result.slice(0, -suffix.length);
  const finalCodeUnit = content.charCodeAt(content.length - 1);
  assert.equal(finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff, false);
  assert.match(result, /\[truncated\]$/);
});

Deno.test("context selection keeps the newest messages within both budgets", () => {
  const messages = [
    stored(1, "one"),
    stored(2, "two"),
    stored(3, "three"),
  ];
  const result = formatConversation(messages, 2, 100);
  assert.deepEqual(result.map((message) => message.content), [
    "[Alice]: two",
    "[Alice]: three",
  ]);
});

Deno.test("context preserves assistant reasoning for provider continuation", () => {
  const messages = [
    stored(1, "question"),
    {
      ...stored(2, "answer", "assistant"),
      reasoningContent: "provider reasoning state",
    },
    stored(3, "follow-up"),
  ];

  const result = formatConversation(messages, 10, 1_000);

  assert.equal(result[1]?.role, "assistant");
  assert.equal(result[1]?.reasoningContent, "provider reasoning state");
  assert.equal(result[0]?.reasoningContent, undefined);
});

Deno.test("context character budget includes assistant reasoning", () => {
  const messages = [
    stored(1, "question"),
    {
      ...stored(2, "answer", "assistant"),
      reasoningContent: "x".repeat(100),
    },
    stored(3, "follow-up"),
  ];

  const result = formatConversation(messages, 10, 50);

  assert.deepEqual(result.map((message) => message.content), [
    "[Alice]: follow-up",
  ]);
});

Deno.test("context selection drops an assistant orphaned by the message limit", () => {
  const messages = [
    stored(1, "u1"),
    stored(2, "a1", "assistant"),
    stored(3, "u2"),
    stored(4, "a2", "assistant"),
    stored(5, "u3"),
  ];
  const result = formatConversation(messages, 4, 100);

  assert.deepEqual(result.map((message) => message.role), ["user", "assistant", "user"]);
  assert.deepEqual(result.map((message) => message.content), [
    "[Alice]: u2",
    "a2",
    "[Alice]: u3",
  ]);
});

Deno.test("context selection drops an assistant orphaned by the character limit", () => {
  const messages = [
    stored(1, "old"),
    stored(2, "old reply", "assistant"),
    stored(3, "newest"),
  ];
  const result = formatConversation(messages, 10, 24);

  assert.deepEqual(result.map((message) => message.role), ["user"]);
  assert.deepEqual(result.map((message) => message.content), ["[Alice]: newest"]);
});

Deno.test("constantTimeEqual handles equal, unequal, and different-length values", () => {
  assert.equal(constantTimeEqual("secret", "secret"), true);
  assert.equal(constantTimeEqual("secret", "secRet"), false);
  assert.equal(constantTimeEqual("secret", "secret-long"), false);
});

function stored(
  updateId: number,
  text: string,
  role: StoredMessage["role"] = "user",
): StoredMessage {
  return {
    updateId,
    order: role === "assistant" ? 1 : 0,
    chatId: 1,
    epoch: 0,
    role,
    text,
    userName: "Alice",
    createdAt: updateId,
  };
}
