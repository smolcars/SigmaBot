import assert from "node:assert/strict";
import { AIProviderError, ProviderAIClient } from "../src/ai.ts";
import { testConfig } from "./test_utils.ts";

Deno.test("OpenAI chat completions request and usage are mapped", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      Response.json({
        choices: [{ message: { content: "  hello  " }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
    );
  }) as typeof fetch;
  const client = new ProviderAIClient(testConfig(), fetcher);
  const result = await client.generate("system", [{ role: "user", content: "hi" }]);
  assert.equal(result.text, "  hello  ");
  assert.equal(result.inputTokens, 12);
  assert.equal(result.outputTokens, 3);
  assert.equal(requestBody?.model, "test-model");
  assert.equal(requestBody?.max_completion_tokens, 1024);
  assert.equal(requestBody?.max_tokens, undefined);
  assert.equal((requestBody?.messages as unknown[]).length, 2);
});

Deno.test("per-call options can disable configured web search", async () => {
  let requestedUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      Response.json({
        choices: [{ message: { content: "draft" }, finish_reason: "stop" }],
      }),
    );
  }) as typeof fetch;
  const client = new ProviderAIClient(testConfig({ webSearch: true }), fetcher);

  const result = await client.generate(
    "system",
    [{ role: "user", content: "write an issue" }],
    { webSearch: false },
  );

  assert.equal(result.text, "draft");
  assert.equal(requestedUrl, "https://api.openai.com/v1/chat/completions");
  assert.equal(requestBody?.tools, undefined);
  assert.equal(requestBody?.store, undefined);
});

Deno.test("OpenAI does not double-count reasoning token details", async () => {
  const fetcher = (() =>
    Promise.resolve(Response.json({
      choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 32,
        completion_tokens: 119,
        completion_tokens_details: { reasoning_tokens: 110 },
      },
    }))) as typeof fetch;
  const client = new ProviderAIClient(testConfig(), fetcher);

  const result = await client.generate("system", [{ role: "user", content: "hi" }]);

  assert.equal(result.outputTokens, 119);
});

Deno.test("Grok adds separately reported reasoning tokens to usage", async () => {
  const fetcher = (() =>
    Promise.resolve(Response.json({
      choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 32,
        completion_tokens: 9,
        completion_tokens_details: { reasoning_tokens: 110 },
      },
    }))) as typeof fetch;
  const client = new ProviderAIClient(
    testConfig({ aiProvider: "grok", aiModel: "grok-4" }),
    fetcher,
  );

  const result = await client.generate("system", [{ role: "user", content: "hi" }]);

  assert.equal(result.inputTokens, 32);
  assert.equal(result.outputTokens, 119);
});

Deno.test("custom OpenAI-compatible chat uses max_tokens", async () => {
  let requestedUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      Response.json({ choices: [{ message: { content: "compatible" } }] }),
    );
  }) as typeof fetch;
  const client = new ProviderAIClient(
    testConfig({ openAIBaseUrl: "https://compatible.example/v1" }),
    fetcher,
  );

  const result = await client.generate("system", [{ role: "user", content: "hi" }]);

  assert.equal(result.text, "compatible");
  assert.equal(requestedUrl, "https://compatible.example/v1/chat/completions");
  assert.equal(requestBody?.max_tokens, 1024);
  assert.equal(requestBody?.max_completion_tokens, undefined);
});

Deno.test("Chat Completions returns provider refusal text", async () => {
  const fetcher = (() =>
    Promise.resolve(
      Response.json({
        choices: [{ message: { content: null, refusal: "Request refused" } }],
      }),
    )) as typeof fetch;
  const client = new ProviderAIClient(testConfig(), fetcher);

  const result = await client.generate("system", [{ role: "user", content: "hi" }]);

  assert.equal(result.text, "Request refused");
});

Deno.test("Chat Completions rejects non-answer finish reasons", async () => {
  for (const finishReason of ["content_filter", "tool_calls", "function_call", null]) {
    const fetcher = (() =>
      Promise.resolve(Response.json({
        choices: [{
          message: { content: "partial answer" },
          finish_reason: finishReason,
        }],
      }))) as typeof fetch;
    const client = new ProviderAIClient(testConfig(), fetcher);

    await assert.rejects(
      () => client.generate("system", [{ role: "user", content: "hi" }]),
      /final answer/,
      String(finishReason),
    );
  }
});

Deno.test("Kimi K3 uses max reasoning and preserves reasoning history", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      Response.json({
        choices: [{
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "  answer \n",
            reasoning_content: "  final reasoning \n",
          },
        }],
      }),
    );
  }) as typeof fetch;
  const client = new ProviderAIClient(
    testConfig({ aiProvider: "moonshot", aiModel: "kimi-k3" }),
    fetcher,
  );

  const result = await client.generate("system", [
    { role: "assistant", content: "earlier", reasoningContent: "earlier reasoning" },
    { role: "user", content: "continue" },
  ]);

  assert.equal(requestBody?.max_tokens, undefined);
  assert.equal(requestBody?.max_completion_tokens, 1024);
  assert.equal(requestBody?.reasoning_effort, "max");
  assert.equal(requestBody?.thinking, undefined);
  const sentMessages = requestBody?.messages as Record<string, unknown>[];
  assert.equal(sentMessages[1]?.reasoning_content, "earlier reasoning");
  assert.equal(result.text, "  answer \n");
  assert.equal(result.reasoningContent, "  final reasoning \n");
});

Deno.test("Kimi K3 web search replays reasoning and maps tool usage", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  const toolCalls = [
    {
      id: "web_search:0",
      type: "function",
      function: {
        name: "$web_search",
        arguments:
          '{ "query": "England World Cup tomorrow", "usage": { "total_tokens": 13046 } }',
      },
    },
    {
      id: "web_search:1",
      type: "function",
      function: {
        name: "$web_search",
        arguments: '{"query":"Argentina team news"}',
      },
    },
  ];
  const intermediateMessage = {
    role: "assistant",
    content: null,
    reasoning_content: "  search plan \n",
    tool_calls: toolCalls,
    provider_extension: { opaque: true },
  };
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://api.moonshot.ai/v1/chat/completions");
    requestBodies.push(JSON.parse(String(init?.body)));
    return Promise.resolve(
      requestBodies.length === 1
        ? Response.json({
          choices: [{
            finish_reason: "tool_calls",
            message: intermediateMessage,
          }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        })
        : Response.json({
          choices: [{
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "England play Argentina.",
              reasoning_content: "  final reasoning \n",
            },
          }],
          usage: { prompt_tokens: 13_212, completion_tokens: 295 },
        }),
    );
  }) as typeof fetch;
  const client = new ProviderAIClient(
    testConfig({ aiProvider: "moonshot", aiModel: "kimi-k3", webSearch: true }),
    fetcher,
  );

  const result = await client.generate(
    "system",
    [{ role: "user", content: "Who does England play tomorrow?" }],
  );

  assert.equal(requestBodies.length, 2);
  for (const body of requestBodies) {
    assert.equal(body.reasoning_effort, "max");
    assert.equal(body.max_completion_tokens, 1024);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.thinking, undefined);
    assert.deepEqual(body.tools, [{
      type: "builtin_function",
      function: { name: "$web_search" },
    }]);
  }
  const continuedMessages = requestBodies[1]?.messages as Record<string, unknown>[];
  assert.deepEqual(continuedMessages[2], intermediateMessage);
  assert.deepEqual(continuedMessages.slice(3), [
    {
      role: "tool",
      tool_call_id: "web_search:0",
      name: "$web_search",
      content: '{"query":"England World Cup tomorrow","usage":{"total_tokens":13046}}',
    },
    {
      role: "tool",
      tool_call_id: "web_search:1",
      name: "$web_search",
      content: '{"query":"Argentina team news"}',
    },
  ]);
  assert.equal(result.text, "England play Argentina.");
  assert.equal(result.reasoningContent, "  final reasoning \n");
  assert.equal(result.inputTokens, 13_222);
  assert.equal(result.outputTokens, 299);
  assert.deepEqual(result.webSearchQueries, [
    "England World Cup tomorrow",
    "Argentina team news",
  ]);
  assert.equal(result.webSearchCount, 2);
});

Deno.test("Kimi K3 rejects invalid web search tool calls", async () => {
  const cases = [
    {
      name: "unknown tool",
      toolCalls: [{
        id: "call-1",
        function: { name: "other_tool", arguments: "{}" },
      }],
    },
    {
      name: "duplicate IDs",
      toolCalls: [
        {
          id: "call-1",
          function: { name: "$web_search", arguments: "{}" },
        },
        {
          id: "call-1",
          function: { name: "$web_search", arguments: "{}" },
        },
      ],
    },
    {
      name: "non-object arguments",
      toolCalls: [{
        id: "call-1",
        function: { name: "$web_search", arguments: "[]" },
      }],
    },
  ];

  for (const testCase of cases) {
    const fetcher = (() =>
      Promise.resolve(Response.json({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "searching",
            tool_calls: testCase.toolCalls,
          },
        }],
      }))) as typeof fetch;
    const client = new ProviderAIClient(
      testConfig({ aiProvider: "moonshot", aiModel: "kimi-k3", webSearch: true }),
      fetcher,
    );

    await assert.rejects(
      () => client.generate("system", [{ role: "user", content: "latest" }]),
      (error: unknown) => {
        assert.ok(error instanceof AIProviderError, testCase.name);
        assert.equal(error.retryable, false, testCase.name);
        assert.match(error.message, /invalid web search/, testCase.name);
        return true;
      },
    );
  }
});

Deno.test("Kimi K3 caps searches and forces a final answer", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(body);
    if (body.tool_choice === "none") {
      return Promise.resolve(Response.json({
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: "bounded answer" },
        }],
      }));
    }

    return Promise.resolve(Response.json({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          reasoning_content: `round-${requestBodies.length}`,
          tool_calls: [{
            id: "web_search:0",
            function: {
              name: "$web_search",
              arguments: `{"query":"query-${requestBodies.length}"}`,
            },
          }],
        },
      }],
    }));
  }) as typeof fetch;
  const client = new ProviderAIClient(
    testConfig({ aiProvider: "moonshot", aiModel: "kimi-k3", webSearch: true }),
    fetcher,
  );

  const result = await client.generate(
    "system",
    [{ role: "user", content: "latest" }],
  );

  assert.equal(result.text, "bounded answer");
  assert.equal(result.webSearchCount, 8);
  assert.equal(requestBodies.length, 9);
  assert.equal(requestBodies[7]?.tool_choice, undefined);
  assert.equal(requestBodies[8]?.tool_choice, "none");
});

Deno.test("Kimi K3 rejects token-exhausted web search responses", async () => {
  const fetcher = (() =>
    Promise.resolve(Response.json({
      choices: [{
        finish_reason: "length",
        message: {
          role: "assistant",
          content: "partial answer",
          reasoning_content: "unfinished reasoning",
        },
      }],
    }))) as typeof fetch;
  const client = new ProviderAIClient(
    testConfig({ aiProvider: "moonshot", aiModel: "kimi-k3", webSearch: true }),
    fetcher,
  );

  await assert.rejects(
    () => client.generate("system", [{ role: "user", content: "latest" }]),
    /completion token limit/,
  );
});

Deno.test("Kimi K3 image requests skip web search", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Promise.resolve(Response.json({
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "image answer" },
      }],
    }));
  }) as typeof fetch;
  const client = new ProviderAIClient(
    testConfig({ aiProvider: "moonshot", aiModel: "kimi-k3", webSearch: true }),
    fetcher,
  );

  const result = await client.generate("system", [{
    role: "user",
    content: [
      { type: "text", text: "describe" },
      { type: "image", mediaType: "image/jpeg", data: "AA==" },
    ],
  }]);

  assert.equal(result.text, "image answer");
  assert.equal(requestBody?.tools, undefined);
  assert.equal(requestBody?.reasoning_effort, "max");
});

Deno.test("Claude accepts only completed textual stop reasons", async () => {
  for (const stopReason of ["end_turn", "stop_sequence", "refusal"]) {
    const fetcher = (() =>
      Promise.resolve(Response.json({
        content: [{ type: "text", text: `answer from ${stopReason}` }],
        stop_reason: stopReason,
        usage: { input_tokens: 12, output_tokens: 3 },
      }))) as typeof fetch;
    const client = new ProviderAIClient(
      testConfig({ aiProvider: "claude", aiModel: "claude-opus-4-6" }),
      fetcher,
    );

    const result = await client.generate("system", [{ role: "user", content: "hi" }]);

    assert.equal(result.text, `answer from ${stopReason}`);
    assert.equal(result.inputTokens, 12);
    assert.equal(result.outputTokens, 3);
  }
});

Deno.test("Claude rejects partial and non-terminal responses", async () => {
  const cases = [
    {
      stopReason: "max_tokens",
      expected: /completion token limit/,
    },
    {
      stopReason: "model_context_window_exceeded",
      expected: /model context window/,
    },
    {
      stopReason: "tool_use",
      expected: /invalid stop reason/,
    },
    {
      stopReason: undefined,
      expected: /invalid stop reason/,
    },
  ];

  for (const testCase of cases) {
    const fetcher = (() =>
      Promise.resolve(Response.json({
        content: [{ type: "text", text: "partial answer" }],
        ...(testCase.stopReason && { stop_reason: testCase.stopReason }),
      }))) as typeof fetch;
    const client = new ProviderAIClient(
      testConfig({ aiProvider: "claude", aiModel: "claude-opus-4-6" }),
      fetcher,
    );

    await assert.rejects(
      () => client.generate("system", [{ role: "user", content: "hi" }]),
      testCase.expected,
    );
  }
});

Deno.test("Responses returns provider refusal text", async () => {
  const fetcher = (() =>
    Promise.resolve(Response.json({
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "refusal", refusal: "Response refused" }],
      }],
    }))) as typeof fetch;
  const client = new ProviderAIClient(testConfig({ webSearch: true }), fetcher);

  const result = await client.generate("system", [{ role: "user", content: "latest" }]);

  assert.equal(result.text, "Response refused");
});

Deno.test("Responses web search uses current token fields", async () => {
  let requestedUrl = "";
  const marker = "\uE200cite\uE202turn0search0\uE201";
  const outputText = `result${marker}`;
  const markerStart = outputText.indexOf(marker);
  const fetcher = ((input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return Promise.resolve(
      Response.json({
        status: "completed",
        output: [
          {
            type: "web_search_call",
            action: { type: "search", queries: ["first query", "second query"] },
          },
          { type: "web_search_call", action: { type: "open_page" } },
          { type: "web_search_call", action: { type: "find_in_page" } },
          {
            type: "web_search_call",
            action: { type: "search", query: "third query" },
          },
          {
            type: "message",
            content: [{
              type: "output_text",
              text: outputText,
              annotations: [
                {
                  type: "url_citation",
                  start_index: markerStart,
                  end_index: markerStart + marker.length,
                  url: "https://example.com/source?a=1&b=2",
                  title: "  Primary   source  ",
                },
                {
                  type: "url_citation",
                  start_index: markerStart,
                  end_index: markerStart + marker.length,
                  url: "https://second.example/report",
                  title: "Second source",
                },
                {
                  type: "url_citation",
                  start_index: markerStart,
                  end_index: markerStart + marker.length,
                  url: "javascript:alert(1)",
                  title: "Unsafe source",
                },
              ],
            }],
          },
        ],
        usage: { input_tokens: 20, output_tokens: 4 },
      }),
    );
  }) as typeof fetch;
  const client = new ProviderAIClient(testConfig({ webSearch: true }), fetcher);
  const result = await client.generate("system", [{ role: "user", content: "latest" }]);
  assert.match(requestedUrl, /\/responses$/);
  assert.equal(result.text, "result[1][2]");
  assert.equal(result.inputTokens, 20);
  assert.equal(result.outputTokens, 4);
  assert.deepEqual(result.webSearchQueries, [
    "first query",
    "second query",
    "third query",
  ]);
  assert.equal(result.webSearchCount, 3);
  assert.deepEqual(result.webCitations, [
    { url: "https://example.com/source?a=1&b=2", title: "Primary source" },
    { url: "https://second.example/report", title: "Second source" },
  ]);
});

Deno.test("Grok Responses maps current and legacy usage without double-counting", async () => {
  const cases = [
    {
      usage: {
        input_tokens: 32,
        output_tokens: 119,
        completion_tokens_details: { reasoning_tokens: 110 },
      },
      expected: 119,
    },
    {
      usage: {
        prompt_tokens: 32,
        completion_tokens: 9,
        completion_tokens_details: { reasoning_tokens: 110 },
      },
      expected: 119,
    },
  ];

  for (const testCase of cases) {
    const fetcher = (() =>
      Promise.resolve(Response.json({
        status: "completed",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "answer" }],
        }],
        usage: testCase.usage,
      }))) as typeof fetch;
    const client = new ProviderAIClient(
      testConfig({ aiProvider: "grok", aiModel: "grok-4", webSearch: true }),
      fetcher,
    );

    const result = await client.generate("system", [{ role: "user", content: "hi" }]);

    assert.equal(result.inputTokens, 32);
    assert.equal(result.outputTokens, testCase.expected);
  }
});

Deno.test("Responses rejects partial and non-terminal responses", async () => {
  const cases: {
    status?: string;
    incompleteReason?: string;
    expected: RegExp;
  }[] = [
    {
      status: "incomplete",
      incompleteReason: "max_output_tokens",
      expected: /completion token limit/,
    },
    {
      status: "incomplete",
      incompleteReason: "content_filter",
      expected: /incomplete response/,
    },
    { status: "failed", expected: /did not complete/ },
    { status: "in_progress", expected: /did not complete/ },
    { expected: /did not complete/ },
  ];

  for (const testCase of cases) {
    const fetcher = (() =>
      Promise.resolve(Response.json({
        ...(testCase.status && { status: testCase.status }),
        ...(testCase.incompleteReason && {
          incomplete_details: { reason: testCase.incompleteReason },
        }),
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "partial answer" }],
        }],
      }))) as typeof fetch;
    const client = new ProviderAIClient(testConfig({ webSearch: true }), fetcher);

    await assert.rejects(
      () => client.generate("system", [{ role: "user", content: "latest" }]),
      testCase.expected,
    );
  }
});

Deno.test("provider errors do not expose response bodies or credentials", async () => {
  const fetcher = (() =>
    Promise.resolve(
      new Response("secret diagnostic ai-test-key", { status: 401 }),
    )) as typeof fetch;
  const client = new ProviderAIClient(testConfig(), fetcher);
  await assert.rejects(
    () => client.generate("system", [{ role: "user", content: "hi" }]),
    (error: unknown) => {
      assert.ok(error instanceof AIProviderError);
      assert.equal(error.status, 401);
      assert.doesNotMatch(error.message, /secret|ai-test-key/);
      return true;
    },
  );
});

Deno.test("empty provider output is rejected", async () => {
  const fetcher = (() =>
    Promise.resolve(
      Response.json({ choices: [{ message: { content: "   " } }] }),
    )) as typeof fetch;
  const client = new ProviderAIClient(testConfig(), fetcher);
  await assert.rejects(
    () => client.generate("system", [{ role: "user", content: "hi" }]),
    /empty response/,
  );
});

Deno.test("provider retries after Retry-After delta-seconds", async () => {
  let now = Date.UTC(2026, 0, 1);
  const waits: number[] = [];
  let attempts = 0;
  const fetcher = (() => {
    attempts++;
    if (attempts === 1) {
      return Promise.resolve(
        new Response(null, { status: 429, headers: { "retry-after": "2" } }),
      );
    }
    return Promise.resolve(
      Response.json({ choices: [{ message: { content: "ready" } }] }),
    );
  }) as typeof fetch;
  const client = new ProviderAIClient(testConfig(), fetcher, {
    now: () => now,
    sleep: (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
      return Promise.resolve();
    },
  });

  const result = await client.generate("system", [{ role: "user", content: "hi" }]);

  assert.equal(result.text, "ready");
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2_000]);
});

Deno.test("provider retries after Retry-After HTTP-date", async () => {
  let now = Date.UTC(2026, 0, 1);
  const waits: number[] = [];
  let attempts = 0;
  const retryAt = new Date(now + 3_000).toUTCString();
  const fetcher = (() => {
    attempts++;
    if (attempts === 1) {
      return Promise.resolve(
        new Response(null, { status: 503, headers: { "retry-after": retryAt } }),
      );
    }
    return Promise.resolve(
      Response.json({ choices: [{ message: { content: "ready" } }] }),
    );
  }) as typeof fetch;
  const client = new ProviderAIClient(testConfig(), fetcher, {
    now: () => now,
    sleep: (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
      return Promise.resolve();
    },
  });

  const result = await client.generate("system", [{ role: "user", content: "hi" }]);

  assert.equal(result.text, "ready");
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [3_000]);
});

Deno.test("provider bounds Retry-After by the request deadline", async () => {
  let now = Date.UTC(2026, 0, 1);
  const waits: number[] = [];
  let attempts = 0;
  const fetcher = (() => {
    attempts++;
    return Promise.resolve(
      new Response(null, { status: 429, headers: { "retry-after": "60" } }),
    );
  }) as typeof fetch;
  const client = new ProviderAIClient(testConfig({ aiTimeoutMs: 5_000 }), fetcher, {
    now: () => now,
    sleep: (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
      return Promise.resolve();
    },
  });

  await assert.rejects(
    () => client.generate("system", [{ role: "user", content: "hi" }]),
    /timed out/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(waits, [5_000]);
});

Deno.test("provider uses exponential backoff for invalid Retry-After", async () => {
  let now = Date.UTC(2026, 0, 1);
  const waits: number[] = [];
  let attempts = 0;
  const fetcher = (() => {
    attempts++;
    if (attempts === 1) {
      return Promise.resolve(
        new Response(null, { status: 503, headers: { "retry-after": "later" } }),
      );
    }
    return Promise.resolve(
      Response.json({ choices: [{ message: { content: "ready" } }] }),
    );
  }) as typeof fetch;
  const client = new ProviderAIClient(testConfig(), fetcher, {
    now: () => now,
    sleep: (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
      return Promise.resolve();
    },
  });

  const result = await client.generate("system", [{ role: "user", content: "hi" }]);

  assert.equal(result.text, "ready");
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [250]);
});

Deno.test("provider retries HTTP 408 and 409 responses", async () => {
  for (const status of [408, 409]) {
    let now = Date.UTC(2026, 0, 1);
    let attempts = 0;
    const waits: number[] = [];
    const fetcher = (() => {
      attempts++;
      return Promise.resolve(
        attempts === 1
          ? new Response(null, { status })
          : Response.json({ choices: [{ message: { content: "ready" } }] }),
      );
    }) as typeof fetch;
    const client = new ProviderAIClient(testConfig(), fetcher, {
      now: () => now,
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
    });

    const result = await client.generate("system", [{ role: "user", content: "hi" }]);

    assert.equal(result.text, "ready", String(status));
    assert.equal(attempts, 2, String(status));
    assert.deepEqual(waits, [250], String(status));
  }
});

Deno.test("Moonshot image support uses exact model metadata and is cached", async () => {
  let requests = 0;
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    assert.equal(String(input), "https://api.moonshot.ai/v1/models");
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer ai-test-key");
    return Promise.resolve(Response.json({
      data: [
        { id: "text-model", supports_image_in: false },
        { id: "kimi-k3", supports_image_in: true },
      ],
    }));
  }) as typeof fetch;
  const client = new ProviderAIClient(
    testConfig({ aiProvider: "moonshot", aiModel: "kimi-k3" }),
    fetcher,
  );

  assert.deepEqual(await Promise.all([client.supportsImages(), client.supportsImages()]), [
    true,
    true,
  ]);
  assert.equal(await client.supportsImages(), true);
  assert.equal(requests, 1);

  const textClient = new ProviderAIClient(
    testConfig({ aiProvider: "moonshot", aiModel: "text-model" }),
    fetcher,
  );
  assert.equal(await textClient.supportsImages(), false);
  assert.equal(requests, 2);
});

Deno.test("Claude image support uses the model capability response", async () => {
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(
      String(input),
      "https://api.anthropic.com/v1/models/claude-opus-4-6",
    );
    assert.equal(init?.method, "GET");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-api-key"), "ai-test-key");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    return Promise.resolve(Response.json({
      capabilities: { image_input: { supported: false } },
    }));
  }) as typeof fetch;
  const client = new ProviderAIClient(
    testConfig({ aiProvider: "claude", aiModel: "claude-opus-4-6" }),
    fetcher,
  );

  assert.equal(await client.supportsImages(), false);
});

Deno.test("Grok image support resolves model aliases and input modalities", async () => {
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://api.x.ai/v1/language-models");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer ai-test-key");
    return Promise.resolve(Response.json({
      models: [
        {
          id: "grok-current",
          aliases: ["grok-latest"],
          input_modalities: ["text", "image"],
        },
        {
          id: "grok-text",
          aliases: ["grok-text-latest"],
          input_modalities: ["text"],
        },
      ],
    }));
  }) as typeof fetch;

  const imageClient = new ProviderAIClient(
    testConfig({ aiProvider: "grok", aiModel: "grok-latest" }),
    fetcher,
  );
  assert.equal(await imageClient.supportsImages(), true);

  const textClient = new ProviderAIClient(
    testConfig({ aiProvider: "grok", aiModel: "grok-text-latest" }),
    fetcher,
  );
  assert.equal(await textClient.supportsImages(), false);
});

Deno.test("official global and regional OpenAI assume image support", async () => {
  let requests = 0;
  const fetcher = (() => {
    requests++;
    return Promise.reject(new Error("unexpected metadata request"));
  }) as typeof fetch;

  for (
    const openAIBaseUrl of [
      "https://api.openai.com/v1",
      "https://eu.api.openai.com/v1",
    ]
  ) {
    assert.equal(
      await new ProviderAIClient(
        testConfig({ openAIBaseUrl }),
        fetcher,
      ).supportsImages(),
      true,
    );
  }
  assert.equal(requests, 0);
});

Deno.test("OpenAI-compatible model metadata extensions detect image support", async () => {
  const cases: {
    name: string;
    capability: Record<string, unknown>;
    expected: boolean;
  }[] = [
    {
      name: "top-level image modalities",
      capability: { input_modalities: ["text", "image"] },
      expected: true,
    },
    {
      name: "top-level text modalities",
      capability: { input_modalities: ["text"] },
      expected: false,
    },
    {
      name: "architecture image modalities",
      capability: { architecture: { input_modalities: ["text", "image"] } },
      expected: true,
    },
    {
      name: "architecture text modalities",
      capability: { architecture: { input_modalities: ["text"] } },
      expected: false,
    },
    {
      name: "vision capability",
      capability: { capabilities: { vision: true } },
      expected: true,
    },
    {
      name: "no vision capability",
      capability: { capabilities: { vision: false } },
      expected: false,
    },
    {
      name: "supports vision",
      capability: { supports_vision: true },
      expected: true,
    },
    {
      name: "does not support vision",
      capability: { supports_vision: false },
      expected: false,
    },
  ];

  for (const testCase of cases) {
    let requests = 0;
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      assert.equal(
        String(input),
        "https://compatible.example/v1/models",
        testCase.name,
      );
      assert.equal(init?.method, "GET", testCase.name);
      assert.equal(init?.body, undefined, testCase.name);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer ai-test-key",
        testCase.name,
      );
      return Promise.resolve(Response.json({
        data: [
          { id: "other-model", input_modalities: ["text", "image"] },
          { id: "target-model", ...testCase.capability },
        ],
      }));
    }) as typeof fetch;
    const client = new ProviderAIClient(
      testConfig({
        aiModel: "target-model",
        openAIBaseUrl: "https://compatible.example/v1",
      }),
      fetcher,
    );

    assert.equal(await client.supportsImages(), testCase.expected, testCase.name);
    assert.equal(requests, 1, testCase.name);
  }
});

Deno.test("OpenAI-compatible model aliases resolve after exact IDs", async () => {
  let requests = 0;
  const fetcher = (() => {
    requests++;
    return Promise.resolve(Response.json({
      data: [
        {
          id: "canonical-text",
          aliases: ["text-latest", "target-model"],
          capabilities: { vision: false },
        },
        {
          id: "target-model",
          capabilities: { vision: true },
        },
        {
          id: "duplicate-text",
          aliases: ["ambiguous-model"],
          capabilities: { vision: false },
        },
        {
          id: "duplicate-image",
          aliases: ["ambiguous-model"],
          capabilities: { vision: true },
        },
      ],
    }));
  }) as typeof fetch;

  const aliasClient = new ProviderAIClient(
    testConfig({
      aiModel: "text-latest",
      openAIBaseUrl: "https://compatible.example/v1",
    }),
    fetcher,
  );
  assert.equal(await aliasClient.supportsImages(), false);

  const exactClient = new ProviderAIClient(
    testConfig({
      aiModel: "target-model",
      openAIBaseUrl: "https://compatible.example/v1",
    }),
    fetcher,
  );
  assert.equal(await exactClient.supportsImages(), true);

  const ambiguousClient = new ProviderAIClient(
    testConfig({
      aiModel: "ambiguous-model",
      openAIBaseUrl: "https://compatible.example/v1",
    }),
    fetcher,
  );
  assert.equal(await ambiguousClient.supportsImages(), true);
  assert.equal(requests, 3);
});

Deno.test("OpenAI-compatible missing or ambiguous metadata fails open", async () => {
  const responses: unknown[] = [
    {
      data: [{
        id: "target-model",
        object: "model",
        created: 1,
        owned_by: "vendor",
      }],
    },
    { data: [{ id: "different-model", capabilities: { vision: false } }] },
    {
      data: [{
        id: "target-model",
        input_modalities: "image",
        architecture: { input_modalities: ["text", 1] },
        capabilities: { vision: "false" },
        supports_vision: "false",
      }],
    },
    { data: [{ id: "target-model", input_modalities: [] }] },
    {
      data: [{
        id: "target-model",
        input_modalities: ["text"],
        capabilities: { vision: true },
      }],
    },
    { data: { id: "target-model", capabilities: { vision: false } } },
  ];

  for (const response of responses) {
    let requests = 0;
    const fetcher = (() => {
      requests++;
      return Promise.resolve(Response.json(response));
    }) as typeof fetch;
    const client = new ProviderAIClient(
      testConfig({
        aiModel: "target-model",
        openAIBaseUrl: "https://api.openai.com.proxy.example/v1",
      }),
      fetcher,
    );
    assert.equal(await client.supportsImages(), true);
    assert.equal(requests, 1);
  }
});

Deno.test("successful sparse image metadata uses the normal cache lifetime", async () => {
  let now = 0;
  let requests = 0;
  const fetcher = (() => {
    requests++;
    return Promise.resolve(Response.json({
      data: [{ id: "target-model", object: "model" }],
    }));
  }) as typeof fetch;
  const client = new ProviderAIClient(
    testConfig({
      aiModel: "target-model",
      openAIBaseUrl: "https://compatible.example/v1",
    }),
    fetcher,
    { now: () => now, sleep: () => Promise.resolve() },
  );

  assert.equal(await client.supportsImages(), true);
  now = 60_001;
  assert.equal(await client.supportsImages(), true);
  assert.equal(requests, 1);

  now = 3_600_001;
  assert.equal(await client.supportsImages(), true);
  assert.equal(requests, 2);
});

Deno.test("non-retryable image metadata errors use the normal cache lifetime", async () => {
  let now = 0;
  let requests = 0;
  const fetcher = (() => {
    requests++;
    return Promise.resolve(
      requests === 1 ? new Response(null, { status: 404 }) : Response.json({
        data: [{ id: "target-model", capabilities: { vision: false } }],
      }),
    );
  }) as typeof fetch;
  const client = new ProviderAIClient(
    testConfig({
      aiModel: "target-model",
      openAIBaseUrl: "https://compatible.example/v1",
    }),
    fetcher,
    { now: () => now, sleep: () => Promise.resolve() },
  );

  assert.equal(await client.supportsImages(), true);
  now = 60_001;
  assert.equal(await client.supportsImages(), true);
  assert.equal(requests, 1);

  now = 3_600_001;
  assert.equal(await client.supportsImages(), false);
  assert.equal(requests, 2);
});
Deno.test("explicit image overrides skip discovery", async () => {
  let requests = 0;
  const fetcher = (() => {
    requests++;
    return Promise.reject(new Error("unexpected metadata request"));
  }) as typeof fetch;

  assert.equal(
    await new ProviderAIClient(
      testConfig({
        aiProvider: "moonshot",
        aiSupportsImages: true,
      }),
      fetcher,
    ).supportsImages(),
    true,
  );
  assert.equal(
    await new ProviderAIClient(
      testConfig({
        aiProvider: "openai",
        aiSupportsImages: false,
      }),
      fetcher,
    ).supportsImages(),
    false,
  );
  assert.equal(requests, 0);
});

Deno.test("unexpected image capability discovery errors fail open", async () => {
  let requests = 0;
  const fetcher = (() => {
    requests++;
    return Promise.reject(new Error("unexpected metadata request"));
  }) as typeof fetch;
  const client = new ProviderAIClient(
    testConfig({ aiProvider: "claude", aiModel: "\uD800" }),
    fetcher,
  );

  assert.equal(await client.supportsImages(), true);
  assert.equal(requests, 0);
});

Deno.test("transient image metadata failure fails open briefly and is retried", async () => {
  let now = 0;
  let requests = 0;
  const fetcher = (() => {
    requests++;
    return Promise.resolve(
      requests === 1 ? new Response(null, { status: 503 }) : Response.json({
        data: [{ id: "text-model", supports_image_in: false }],
      }),
    );
  }) as typeof fetch;
  const client = new ProviderAIClient(
    testConfig({ aiProvider: "moonshot", aiModel: "text-model" }),
    fetcher,
    { now: () => now, sleep: () => Promise.resolve() },
  );

  assert.equal(await client.supportsImages(), true);
  assert.equal(await client.supportsImages(), true);
  assert.equal(requests, 1);

  now = 60_001;
  assert.equal(await client.supportsImages(), false);
  assert.equal(requests, 2);
});

Deno.test("invalid image metadata JSON fails open briefly and is retried", async () => {
  let now = 0;
  let requests = 0;
  const fetcher = (() => {
    requests++;
    return Promise.resolve(
      requests === 1 ? new Response("not JSON") : Response.json({
        data: [{ id: "text-model", supports_image_in: false }],
      }),
    );
  }) as typeof fetch;
  const client = new ProviderAIClient(
    testConfig({ aiProvider: "moonshot", aiModel: "text-model" }),
    fetcher,
    { now: () => now, sleep: () => Promise.resolve() },
  );

  assert.equal(await client.supportsImages(), true);
  assert.equal(requests, 1);

  now = 60_001;
  assert.equal(await client.supportsImages(), false);
  assert.equal(requests, 2);
});
