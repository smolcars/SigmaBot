import assert from "node:assert/strict";
import {
  formatIssueMarker,
  GitHubApiError,
  type GitHubAuthFactory,
  GitHubClient,
  type GitHubClientDependencies,
} from "../src/github.ts";

const CONFIG = {
  appId: "123",
  installationId: "456",
  privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
};

Deno.test("createIssue authenticates as the app installation and appends a marker", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  let authOptions: Parameters<GitHubAuthFactory>[0] | undefined;
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedInit = init;
    return Promise.resolve(Response.json({
      number: 17,
      html_url: "https://github.com/smolcars/blixt-wallet/issues/17",
    }));
  }) as typeof fetch;
  const authFactory: GitHubAuthFactory = (options) => {
    authOptions = options;
    return () =>
      Promise.resolve({
        token: "installation-token",
        expiresAt: "2026-07-23T02:00:00.000Z",
      });
  };
  const client = new GitHubClient(CONFIG, {
    fetcher,
    authFactory,
    now: () => Date.parse("2026-07-23T01:00:00.000Z"),
    apiBase: "https://github.test/",
  });

  const issue = await client.createIssue({
    repository: "smolcars/blixt-wallet",
    title: "Payment fails",
    body: "Steps to reproduce.",
    marker: "18d0998d-07c3-4db4-a3db-cc44995ca39d",
  });

  assert.deepEqual(issue, {
    number: 17,
    url: "https://github.com/smolcars/blixt-wallet/issues/17",
  });
  assert.equal(authOptions?.appId, CONFIG.appId);
  assert.equal(authOptions?.installationId, CONFIG.installationId);
  assert.equal(authOptions?.privateKey, CONFIG.privateKey);
  assert.equal(typeof authOptions?.fetcher, "function");
  assert.equal(
    requestedUrl,
    "https://github.test/repos/smolcars/blixt-wallet/issues",
  );
  assert.equal(requestedInit?.method, "POST");
  const headers = new Headers(requestedInit?.headers);
  assert.equal(headers.get("authorization"), "Bearer installation-token");
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.equal(headers.get("x-github-api-version"), "2026-03-10");
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    title: "Payment fails",
    body:
      "Steps to reproduce.\n\n<!-- sigmabot-issue:18d0998d-07c3-4db4-a3db-cc44995ca39d -->",
  });
});

Deno.test("findIssueByMarker searches the newest 100 issues", async () => {
  let requestedUrl = "";
  const fetcher = ((input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return Promise.resolve(Response.json([
      {
        number: 12,
        html_url: "https://github.com/smolcars/SigmaBot/issues/12",
        body: "unrelated",
      },
      {
        number: 11,
        html_url: "https://github.com/smolcars/SigmaBot/issues/11",
        body: `Report\n\n${formatIssueMarker("submission_1")}`,
      },
    ]));
  }) as typeof fetch;
  const client = testClient(fetcher);

  assert.deepEqual(
    await client.findIssueByMarker("smolcars/SigmaBot", "submission_1"),
    {
      number: 11,
      url: "https://github.com/smolcars/SigmaBot/issues/11",
    },
  );
  assert.equal(
    requestedUrl,
    "https://github.test/repos/smolcars/SigmaBot/issues" +
      "?state=all&sort=created&direction=desc&per_page=100",
  );
});

Deno.test("findIssueByMarker returns undefined when no issue contains the marker", async () => {
  const fetcher = (() =>
    Promise.resolve(Response.json([
      {
        number: 12,
        html_url: "https://github.test/issues/12",
        body: null,
      },
    ]))) as typeof fetch;

  assert.equal(
    await testClient(fetcher).findIssueByMarker("smolcars/SigmaBot", "missing"),
    undefined,
  );
});

Deno.test("installation tokens are cached until their refresh window", async () => {
  let now = Date.parse("2026-07-23T01:00:00.000Z");
  let authCalls = 0;
  const authorizations: string[] = [];
  const authFactory: GitHubAuthFactory = () => () => {
    authCalls++;
    return Promise.resolve({
      token: `token-${authCalls}`,
      expiresAt: new Date(now + 3_600_000).toISOString(),
    });
  };
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  const client = new GitHubClient(CONFIG, {
    fetcher,
    authFactory,
    now: () => now,
    apiBase: "https://github.test",
  });

  await client.findIssueByMarker("smolcars/SigmaBot", "one");
  now += 1_000;
  await client.findIssueByMarker("smolcars/SigmaBot", "two");

  assert.equal(authCalls, 1);
  assert.deepEqual(authorizations, [
    "Bearer token-1",
    "Bearer token-1",
  ]);
});

Deno.test("installation tokens refresh near expiry", async () => {
  let now = Date.parse("2026-07-23T01:00:00.000Z");
  let authCalls = 0;
  const authFactory: GitHubAuthFactory = () => () => {
    authCalls++;
    return Promise.resolve({
      token: `token-${authCalls}`,
      expiresAt: new Date(
        Date.parse("2026-07-23T02:00:00.000Z"),
      ).toISOString(),
    });
  };
  const fetcher = (() => Promise.resolve(Response.json([]))) as typeof fetch;
  const client = new GitHubClient(CONFIG, {
    fetcher,
    authFactory,
    now: () => now,
    apiBase: "https://github.test",
  });

  await client.findIssueByMarker("smolcars/SigmaBot", "one");
  now = Date.parse("2026-07-23T01:59:01.000Z");
  await client.findIssueByMarker("smolcars/SigmaBot", "two");

  assert.equal(authCalls, 2);
});

Deno.test("a GET 401 forces authentication refresh and replays once", async () => {
  let authCalls = 0;
  let fetchCalls = 0;
  const authorizations: string[] = [];
  const refreshFlags: boolean[] = [];
  const authFactory: GitHubAuthFactory = () => (forceRefresh) => {
    refreshFlags.push(forceRefresh);
    authCalls++;
    return Promise.resolve({
      token: `token-${authCalls}`,
      expiresAt: "2026-07-23T02:00:00.000Z",
    });
  };
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls++;
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    if (fetchCalls === 1) return Promise.resolve(new Response(null, { status: 401 }));
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  const client = new GitHubClient(CONFIG, {
    fetcher,
    authFactory,
    now: () => Date.parse("2026-07-23T01:00:00.000Z"),
    apiBase: "https://github.test",
  });

  await client.findIssueByMarker(
    "smolcars/blixt-wallet",
    "submission",
  );

  assert.equal(authCalls, 2);
  assert.equal(fetchCalls, 2);
  assert.deepEqual(authorizations, ["Bearer token-1", "Bearer token-2"]);
  assert.deepEqual(refreshFlags, [false, true]);
});

Deno.test("createIssue does not replay a 401 and reconciliation refreshes auth", async () => {
  let authCalls = 0;
  const refreshFlags: boolean[] = [];
  const methods: string[] = [];
  const authorizations: string[] = [];
  const marker = "submission";
  const authFactory: GitHubAuthFactory = () => (forceRefresh) => {
    refreshFlags.push(forceRefresh);
    authCalls++;
    return Promise.resolve({
      token: `token-${authCalls}`,
      expiresAt: "2026-07-23T02:00:00.000Z",
    });
  };
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    methods.push(method);
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    if (method === "POST") {
      return Promise.resolve(new Response(null, { status: 401 }));
    }
    return Promise.resolve(Response.json([{
      number: 9,
      html_url: "https://github.test/issues/9",
      body: formatIssueMarker(marker),
    }]));
  }) as typeof fetch;
  const client = new GitHubClient(CONFIG, {
    fetcher,
    authFactory,
    now: () => Date.parse("2026-07-23T01:00:00.000Z"),
    apiBase: "https://github.test",
  });

  await assertGitHubError(
    () =>
      client.createIssue({
        repository: "smolcars/blixt-wallet",
        title: "Title",
        body: "Body",
        marker,
      }),
    { status: 401, retryable: true },
  );
  const issue = await client.findIssueByMarker(
    "smolcars/blixt-wallet",
    marker,
  );

  assert.deepEqual(issue, { number: 9, url: "https://github.test/issues/9" });
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.deepEqual(authorizations, ["Bearer token-1", "Bearer token-2"]);
  assert.deepEqual(refreshFlags, [false, true]);
});
Deno.test("createIssue never retries an ambiguous network failure", async () => {
  let calls = 0;
  const fetcher = (() => {
    calls++;
    return Promise.reject(new TypeError("connection reset after upload"));
  }) as typeof fetch;

  await assert.rejects(
    () =>
      testClient(fetcher).createIssue({
        repository: "smolcars/blixt-wallet",
        title: "Title",
        body: "Body",
        marker: "submission",
      }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, undefined);
      assert.equal(error.retryable, true);
      assert.equal(error.message, "GitHub API request failed");
      assert.ok(!error.message.includes("connection reset"));
      return true;
    },
  );
  assert.equal(calls, 1);
});

Deno.test("createIssue does not retry server failures", async () => {
  let calls = 0;
  const fetcher = (() => {
    calls++;
    return Promise.resolve(new Response("upstream internal details", { status: 503 }));
  }) as typeof fetch;

  await assert.rejects(
    () =>
      testClient(fetcher).createIssue({
        repository: "smolcars/blixt-wallet",
        title: "Title",
        body: "Body",
        marker: "submission",
      }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      assert.ok(!error.message.includes("upstream internal details"));
      return true;
    },
  );
  assert.equal(calls, 1);
});

Deno.test("direct GitHub requests abort a hung fetch", async () => {
  let observedAbort = false;
  const fetcher =
    ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(signal.reason);
        }, { once: true });
      })) as typeof fetch;
  const client = new GitHubClient(CONFIG, {
    ...testDependencies(fetcher),
    requestTimeoutMs: 5,
  });

  await assertGitHubError(
    () => client.findIssueByMarker("smolcars/SigmaBot", "marker"),
    { status: undefined, retryable: true },
  );
  assert.equal(observedAbort, true);
});

Deno.test("direct GitHub requests abort a stalled response body", async () => {
  let observedAbort = false;
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          controller.error(signal.reason);
        }, { once: true });
      },
    });
    return Promise.resolve(
      new Response(body, {
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  const client = new GitHubClient(CONFIG, {
    ...testDependencies(fetcher),
    requestTimeoutMs: 5,
  });

  await assertGitHubError(
    () => client.findIssueByMarker("smolcars/SigmaBot", "marker"),
    { status: 200, retryable: true },
  );
  assert.equal(observedAbort, true);
});

Deno.test("installation-token exchange uses the request timeout", async () => {
  let observedAbort = false;
  const fetcher =
    ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(signal.reason);
        }, { once: true });
      })) as typeof fetch;
  const authFactory: GitHubAuthFactory = ({ fetcher: authFetcher }) => async () => {
    await authFetcher("https://github.test/app/installations/456/access_tokens", {
      method: "POST",
    });
    return { token: "unreachable" };
  };
  const client = new GitHubClient(CONFIG, {
    fetcher,
    authFactory,
    apiBase: "https://github.test",
    requestTimeoutMs: 5,
  });

  await assertGitHubError(
    () => client.findIssueByMarker("smolcars/SigmaBot", "marker"),
    { status: undefined, retryable: true },
  );
  assert.equal(observedAbort, true);
});

Deno.test("request timeouts must be positive", () => {
  const fetcher = (() => Promise.resolve(Response.json([]))) as typeof fetch;
  assert.throws(
    () =>
      new GitHubClient(CONFIG, {
        ...testDependencies(fetcher),
        requestTimeoutMs: 0,
      }),
    /timeout must be positive/i,
  );
  assert.throws(
    () =>
      new GitHubClient(CONFIG, {
        ...testDependencies(fetcher),
        requestTimeoutMs: Number.POSITIVE_INFINITY,
      }),
    /timeout must be positive/i,
  );
});

Deno.test("statusless GitHub App signing failures are permanent and sanitized", async () => {
  const authFactory: GitHubAuthFactory = () => () =>
    Promise.reject(new Error("private key secret"));
  const client = new GitHubClient(CONFIG, {
    fetcher: (() => Promise.resolve(Response.json([]))) as typeof fetch,
    authFactory,
    apiBase: "https://github.test",
  });

  await assert.rejects(
    () => client.findIssueByMarker("smolcars/SigmaBot", "marker"),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, undefined);
      assert.equal(error.retryable, false);
      assert.equal(error.message, "GitHub App authentication failed");
      assert.ok(!error.message.includes("private key secret"));
      return true;
    },
  );
});

for (const status of [401, 404]) {
  Deno.test(`GitHub App HTTP ${status} authentication failures are permanent`, async () => {
    const authFactory: GitHubAuthFactory = () => () =>
      Promise.reject({
        status,
        response: {
          status,
          headers: {},
          data: { message: "credential and repository secret" },
        },
      });
    const client = new GitHubClient(CONFIG, {
      fetcher: (() => Promise.resolve(Response.json([]))) as typeof fetch,
      authFactory,
      apiBase: "https://github.test",
    });

    await assertGitHubError(
      () => client.findIssueByMarker("smolcars/SigmaBot", "marker"),
      { status, retryable: false },
    );
  });
}

Deno.test("GitHub App transport TypeErrors are retryable", async () => {
  const authFactory: GitHubAuthFactory = () => () =>
    Promise.reject(new TypeError("socket secret"));
  const client = new GitHubClient(CONFIG, {
    fetcher: (() => Promise.resolve(Response.json([]))) as typeof fetch,
    authFactory,
    apiBase: "https://github.test",
  });

  await assertGitHubError(
    () => client.findIssueByMarker("smolcars/SigmaBot", "marker"),
    { status: undefined, retryable: true },
  );
});

Deno.test("GitHub App HTTP 5xx authentication failures are retryable", async () => {
  const authFactory: GitHubAuthFactory = () => () =>
    Promise.reject({ status: 503, response: { status: 503, headers: {} } });
  const client = new GitHubClient(CONFIG, {
    fetcher: (() => Promise.resolve(Response.json([]))) as typeof fetch,
    authFactory,
    apiBase: "https://github.test",
  });

  await assertGitHubError(
    () => client.findIssueByMarker("smolcars/SigmaBot", "marker"),
    { status: 503, retryable: true },
  );
});
for (const status of [408, 409, 500, 502]) {
  Deno.test(`HTTP ${status} is classified as retryable`, async () => {
    const fetcher = (() => Promise.resolve(new Response(null, { status }))) as typeof fetch;
    await assertGitHubError(
      () => testClient(fetcher).findIssueByMarker("smolcars/SigmaBot", "marker"),
      { status, retryable: true },
    );
  });
}

Deno.test("headerless 429 uses the fallback retry delay", async () => {
  const fetcher =
    (() => Promise.resolve(new Response(null, { status: 429 }))) as typeof fetch;

  await assertGitHubError(
    () => testClient(fetcher).findIssueByMarker("smolcars/SigmaBot", "marker"),
    { status: 429, retryable: true, retryAfterMs: 60_000 },
  );
});

Deno.test("primary rate-limited 403 without reset uses the fallback delay", async () => {
  const fetcher = (() =>
    Promise.resolve(
      new Response(null, {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    )) as typeof fetch;

  await assertGitHubError(
    () => testClient(fetcher).findIssueByMarker("smolcars/SigmaBot", "marker"),
    { status: 403, retryable: true, retryAfterMs: 60_000 },
  );
});

for (
  const message of [
    "You have exceeded a secondary rate limit. Please wait before trying again.",
    "You have triggered an abuse detection mechanism. Please wait before trying again.",
  ]
) {
  Deno.test("standard secondary or abuse 403 uses the fallback delay", async () => {
    const fetcher = (() =>
      Promise.resolve(Response.json({ message }, { status: 403 }))) as typeof fetch;

    await assertGitHubError(
      () => testClient(fetcher).findIssueByMarker("smolcars/SigmaBot", "marker"),
      { status: 403, retryable: true, retryAfterMs: 60_000 },
    );
  });
}
Deno.test("rate-limited 403 uses the rate-limit reset time", async () => {
  const now = Date.parse("2026-07-23T01:00:00.000Z");
  const reset = Math.floor((now + 45_000) / 1000);
  const fetcher = (() =>
    Promise.resolve(
      new Response(null, {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset),
        },
      }),
    )) as typeof fetch;
  const client = new GitHubClient(CONFIG, testDependencies(fetcher, () => now));

  await assertGitHubError(
    () => client.findIssueByMarker("smolcars/SigmaBot", "marker"),
    { status: 403, retryable: true, retryAfterMs: 45_000 },
  );
});

Deno.test("secondary rate limits use Retry-After", async () => {
  const fetcher = (() =>
    Promise.resolve(
      new Response(null, {
        status: 403,
        headers: { "retry-after": "12" },
      }),
    )) as typeof fetch;

  await assertGitHubError(
    () => testClient(fetcher).findIssueByMarker("smolcars/SigmaBot", "marker"),
    { status: 403, retryable: true, retryAfterMs: 12_000 },
  );
});

Deno.test("ordinary authorization failures are permanent and sanitized", async () => {
  const fetcher = (() =>
    Promise.resolve(
      new Response(
        '{"message":"repository secret and permissions"}',
        { status: 403 },
      ),
    )) as typeof fetch;

  await assert.rejects(
    () => testClient(fetcher).findIssueByMarker("smolcars/SigmaBot", "marker"),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, 403);
      assert.equal(error.retryable, false);
      assert.ok(!error.message.includes("repository secret"));
      return true;
    },
  );
});

Deno.test("successful malformed responses are retryable provider failures", async () => {
  const fetcher =
    (() =>
      Promise.resolve(Response.json({ number: "wrong", html_url: null }))) as typeof fetch;

  await assertGitHubError(
    () =>
      testClient(fetcher).createIssue({
        repository: "smolcars/SigmaBot",
        title: "Title",
        body: "Body",
        marker: "marker",
      }),
    { status: 200, retryable: true },
  );
});

Deno.test("repository and marker inputs are constrained", async () => {
  const fetcher = (() => Promise.resolve(Response.json([]))) as typeof fetch;
  const client = testClient(fetcher);

  await assert.rejects(
    () => client.findIssueByMarker("smolcars/SigmaBot/extra", "marker"),
    /Invalid GitHub repository/,
  );
  await assert.rejects(
    () => client.findIssueByMarker("smolcars/SigmaBot", "<!--bad-->"),
    /Invalid GitHub issue marker/,
  );
});

function testClient(fetcher: typeof fetch): GitHubClient {
  return new GitHubClient(CONFIG, testDependencies(fetcher));
}

function testDependencies(
  fetcher: typeof fetch,
  now: () => number = () => Date.parse("2026-07-23T01:00:00.000Z"),
): GitHubClientDependencies {
  return {
    fetcher,
    now,
    apiBase: "https://github.test",
    authFactory: () => () =>
      Promise.resolve({
        token: "token",
        expiresAt: "2026-07-23T02:00:00.000Z",
      }),
  };
}

async function assertGitHubError(
  operation: () => Promise<unknown>,
  expected: {
    status: number | undefined;
    retryable: boolean;
    retryAfterMs?: number;
  },
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.status, expected.status);
      assert.equal(error.retryable, expected.retryable);
      assert.equal(error.retryAfterMs, expected.retryAfterMs);
      return true;
    },
  );
}
