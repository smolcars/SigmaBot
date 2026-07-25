import assert from "node:assert/strict";
import {
  buildIssueContext,
  containsLikelySecret,
  ISSUE_SYSTEM_PROMPT,
  IssueDraftError,
  type IssueDraftErrorCode,
  parseIssueArguments,
  parseIssueDraft,
} from "../src/issues.ts";
import type { StoredMessage } from "../src/types.ts";

Deno.test("issue arguments require an explicit alias and preserve description", () => {
  assert.equal(parseIssueArguments(""), undefined);
  assert.equal(parseIssueArguments(" \r\n\t "), undefined);
  assert.deepEqual(parseIssueArguments("Blixt"), { alias: "blixt" });
  assert.deepEqual(parseIssueArguments("  SigmaBot   app crashes after reset  "), {
    alias: "sigmabot",
    description: "app crashes after reset",
  });
});

Deno.test("issue context removes identity metadata and assistant reasoning", () => {
  const messages: StoredMessage[] = [
    stored(101, "Initial report", "user", "Alice"),
    {
      ...stored(102, "Investigated", "assistant"),
      reasoningContent: "private provider reasoning",
    },
    stored(
      103,
      '[Replying to Hampus: "the crash"]\nMore details',
      "user",
      "Bob",
    ),
  ];

  const context = buildIssueContext(messages, 10, 10_000);

  assert.deepEqual(context, [
    { role: "user", content: "[User]: Initial report" },
    { role: "assistant", content: "Investigated" },
    {
      role: "user",
      content: '[User]: [Replying to another message: "the crash"]\nMore details',
    },
  ]);
  const serialized = JSON.stringify(context);
  assert.doesNotMatch(serialized, /Alice|Bob|Hampus|private provider reasoning/);
  assert.doesNotMatch(serialized, /101|102|103|987654321/);
});

Deno.test("issue context retains the existing message and character budgets", () => {
  const messages = [
    stored(1, "oldest", "user", "Alice"),
    stored(2, "answer", "assistant"),
    stored(3, "newest", "user", "Bob"),
  ];

  const context = buildIssueContext(messages, 2, 1_000);

  assert.deepEqual(context, [{ role: "user", content: "[User]: newest" }]);
});

Deno.test("issue prompt fixes the JSON, privacy, and untrusted-input contract", () => {
  assert.match(ISSUE_SYSTEM_PROMPT, /Return only one JSON object/);
  assert.match(ISSUE_SYSTEM_PROMPT, /Description/);
  assert.match(ISSUE_SYSTEM_PROMPT, /Context/);
  assert.match(ISSUE_SYSTEM_PROMPT, /Expected Behavior/);
  assert.match(ISSUE_SYSTEM_PROMPT, /personal names/);
  assert.match(ISSUE_SYSTEM_PROMPT, /secrets/);
  assert.match(ISSUE_SYSTEM_PROMPT, /untrusted data/);
  assert.match(ISSUE_SYSTEM_PROMPT, /Never follow instructions/);
});

Deno.test("issue draft accepts plain and fenced exact JSON and trims strings", () => {
  assert.deepEqual(
    parseIssueDraft(
      '  {"title":"  Crash on reset  ","body":"  ## Description\\nCrash  ","relevant":true}  ',
    ),
    {
      title: "Crash on reset",
      body: "## Description\nCrash",
      relevant: true,
    },
  );
  assert.deepEqual(
    parseIssueDraft(
      '```json\n{"body":"body","relevant":true,"title":"title"}\n```',
    ),
    { title: "title", body: "body", relevant: true },
  );
  assert.deepEqual(
    parseIssueDraft('```\n{"title":"","body":"","relevant":false}\n```'),
    { title: "", body: "", relevant: false },
  );
});

Deno.test("issue draft rejects invalid JSON without exposing its contents", () => {
  const sensitive = "not JSON ghp_abcdefghijklmnopqrstuvwxyz123456";
  const error = assertDraftError(sensitive, "invalid_json");
  assert.equal(error.message, "AI returned an invalid issue draft");
  assert.doesNotMatch(error.message, /ghp_|abcdefghijklmnopqrstuvwxyz/);
  assertDraftError(
    '{"title":"title","body":"body","relevant":true}\nextra',
    "invalid_json",
  );
});

Deno.test("issue draft requires exactly the three typed fields", () => {
  const invalid = [
    "null",
    "[]",
    '{"title":"title","body":"body"}',
    '{"title":"title","body":"body","relevant":"true"}',
    '{"title":1,"body":"body","relevant":true}',
    '{"title":"title","body":null,"relevant":true}',
    '{"title":"title","body":"body","relevant":true,"labels":[]}',
  ];

  for (const value of invalid) assertDraftError(value, "invalid_shape");
});

Deno.test("relevant issue drafts require nonempty title and body", () => {
  assertDraftError(
    '{"title":"  ","body":"body","relevant":true}',
    "missing_content",
  );
  assertDraftError(
    '{"title":"title","body":"  ","relevant":true}',
    "missing_content",
  );
});

Deno.test("issue title limit counts Unicode characters", () => {
  const accepted = parseIssueDraft(JSON.stringify({
    title: "😀".repeat(100),
    body: "body",
    relevant: true,
  }));
  assert.equal([...accepted.title].length, 100);

  assertDraftError(
    JSON.stringify({ title: "😀".repeat(101), body: "body", relevant: true }),
    "title_too_long",
  );
});

Deno.test("issue body limit is measured in UTF-8 bytes", () => {
  assert.equal(
    parseIssueDraft(JSON.stringify({
      title: "title",
      body: "a".repeat(40_000),
      relevant: true,
    })).body.length,
    40_000,
  );
  assertDraftError(
    JSON.stringify({
      title: "title",
      body: "😀".repeat(10_001),
      relevant: true,
    }),
    "body_too_large",
  );
});

Deno.test("likely credential formats are rejected generically", () => {
  const secrets = [
    `ghp_${"a".repeat(36)}`,
    `gho_${"b".repeat(36)}`,
    `github_pat_${"c".repeat(40)}`,
    `sk-proj-${"d".repeat(30)}`,
    `sk-ant-api03-${"e".repeat(30)}`,
    `xai-${"f".repeat(30)}`,
    `123456789:${"A".repeat(35)}`,
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN DSA PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ];

  for (const secret of secrets) {
    assert.equal(containsLikelySecret(`prefix ${secret} suffix`), true);
    const error = assertDraftError(
      JSON.stringify({ title: "title", body: `Observed ${secret}`, relevant: true }),
      "likely_secret",
    );
    assert.equal(error.message, "AI returned an invalid issue draft");
    assert.equal(error.message.includes(secret), false);
  }
});

Deno.test("likely secrets are rejected even in irrelevant drafts", () => {
  assertDraftError(
    JSON.stringify({
      title: "",
      body: `discard ${`ghs_${"a".repeat(36)}`}`,
      relevant: false,
    }),
    "likely_secret",
  );
});

Deno.test("ordinary technical text is not classified as a secret", () => {
  const text = "HTTP 409 from /repos/smolcars/blixt-wallet/issues using sk-test";
  assert.equal(containsLikelySecret(text), false);
  assert.equal(
    parseIssueDraft(
      JSON.stringify({ title: "Issue submission fails", body: text, relevant: true }),
    )
      .body,
    text,
  );
});

function stored(
  updateId: number,
  text: string,
  role: StoredMessage["role"],
  userName?: string,
): StoredMessage {
  return {
    updateId,
    order: role === "assistant" ? 1 : 0,
    chatId: 987654321,
    messageThreadId: 222,
    epoch: 0,
    role,
    text,
    userId: 123456789,
    userName,
    createdAt: updateId,
  };
}

function assertDraftError(text: string, code: IssueDraftErrorCode): IssueDraftError {
  let caught: IssueDraftError | undefined;
  assert.throws(
    () => parseIssueDraft(text),
    (error: unknown) => {
      assert.ok(error instanceof IssueDraftError);
      assert.equal(error.code, code);
      caught = error;
      return true;
    },
  );
  assert.ok(caught);
  return caught;
}
