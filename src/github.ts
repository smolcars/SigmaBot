import { createAppAuth } from "npm:@octokit/auth-app@8.2.0";
import { request as octokitRequest } from "npm:@octokit/request@10.0.11";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const TOKEN_FALLBACK_TTL_MS = 5 * 60_000;

export interface GitHubIssue {
  number: number;
  url: string;
}

export interface GitHubCreateIssueInput {
  repository: string;
  title: string;
  body: string;
  marker: string;
}

export interface GitHubGateway {
  findIssueByMarker(
    repository: string,
    marker: string,
  ): Promise<GitHubIssue | undefined>;
  createIssue(input: GitHubCreateIssueInput): Promise<GitHubIssue>;
}

export interface GitHubClientConfig {
  appId: string;
  installationId: string;
  privateKey: string;
}

export interface GitHubInstallationAuthentication {
  token: string;
  expiresAt?: string;
}

export type GitHubInstallationAuth = (
  forceRefresh: boolean,
) => Promise<GitHubInstallationAuthentication>;

export type GitHubAuthFactory = (options: {
  appId: string;
  installationId: string;
  privateKey: string;
  fetcher: typeof fetch;
}) => GitHubInstallationAuth;

export interface GitHubClientDependencies {
  fetcher?: typeof fetch;
  now?: () => number;
  authFactory?: GitHubAuthFactory;
  apiBase?: string;
  requestTimeoutMs?: number;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export class GitHubClient implements GitHubGateway {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly auth: GitHubInstallationAuth;
  private readonly apiBase: string;
  private cachedToken?: { value: string; expiresAt: number };
  private forceTokenRefresh = false;

  constructor(
    config: GitHubClientConfig,
    dependencies: GitHubClientDependencies = {},
  ) {
    const requestTimeoutMs = dependencies.requestTimeoutMs ??
      DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new TypeError("GitHub request timeout must be positive");
    }
    this.fetcher = withRequestTimeout(
      dependencies.fetcher ?? fetch,
      requestTimeoutMs,
    );
    this.now = dependencies.now ?? Date.now;
    this.apiBase = (dependencies.apiBase ?? GITHUB_API_BASE).replace(/\/+$/, "");
    this.auth = (dependencies.authFactory ?? octokitAuthFactory)({
      appId: config.appId,
      installationId: config.installationId,
      privateKey: config.privateKey,
      fetcher: this.fetcher,
    });
  }

  async findIssueByMarker(
    repository: string,
    marker: string,
  ): Promise<GitHubIssue | undefined> {
    const { owner, name } = parseRepository(repository);
    const response = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues` +
        "?state=all&sort=created&direction=desc&per_page=100",
      { method: "GET" },
    );
    const data = await readJson(response);
    if (!Array.isArray(data)) {
      throw invalidResponseError(response.status);
    }

    const expectedMarker = formatIssueMarker(marker);
    for (const candidate of data) {
      if (!isRecord(candidate) || typeof candidate.body !== "string") continue;
      if (!candidate.body.includes(expectedMarker)) continue;
      return readIssue(candidate, response.status);
    }
    return undefined;
  }

  async createIssue(input: GitHubCreateIssueInput): Promise<GitHubIssue> {
    const { owner, name } = parseRepository(input.repository);
    const marker = formatIssueMarker(input.marker);
    const body = input.body.includes(marker)
      ? input.body
      : `${input.body.trimEnd()}\n\n${marker}`;
    const response = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ title: input.title, body }),
      },
    );
    const data = await readJson(response);
    if (!isRecord(data)) throw invalidResponseError(response.status);
    return readIssue(data, response.status);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let token = await this.getInstallationToken();
    let response = await this.fetchOnce(path, init, token);

    if (response.status === 401) {
      this.cachedToken = undefined;
      this.forceTokenRefresh = true;
      if ((init.method ?? "GET").toUpperCase() !== "GET") {
        throw new GitHubApiError(
          "GitHub API request failed with status 401",
          401,
          true,
        );
      }
      token = await this.getInstallationToken(true);
      response = await this.fetchOnce(path, init, token);
    }

    if (!response.ok) throw await responseError(response, this.now());
    return response;
  }

  private async fetchOnce(
    path: string,
    init: RequestInit,
    token: string,
  ): Promise<Response> {
    try {
      return await this.fetcher(`${this.apiBase}${path}`, {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "sigmabot",
          "x-github-api-version": GITHUB_API_VERSION,
          ...init.headers,
        },
      });
    } catch {
      throw new GitHubApiError("GitHub API request failed", undefined, true);
    }
  }

  private async getInstallationToken(forceRefresh = false): Promise<string> {
    const now = this.now();
    const mustForceRefresh = forceRefresh || this.forceTokenRefresh;
    if (
      !mustForceRefresh &&
      this.cachedToken &&
      now < this.cachedToken.expiresAt - TOKEN_REFRESH_SKEW_MS
    ) {
      return this.cachedToken.value;
    }

    let authentication: GitHubInstallationAuthentication;
    try {
      authentication = await this.auth(mustForceRefresh);
    } catch (error) {
      throw authenticationError(error, now);
    }
    if (
      typeof authentication.token !== "string" ||
      authentication.token.length === 0
    ) {
      throw new GitHubApiError(
        "GitHub App authentication returned an invalid token",
        undefined,
        false,
      );
    }

    this.forceTokenRefresh = false;
    const parsedExpiry = authentication.expiresAt
      ? Date.parse(authentication.expiresAt)
      : NaN;
    this.cachedToken = {
      value: authentication.token,
      expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : now + TOKEN_FALLBACK_TTL_MS,
    };
    return authentication.token;
  }
}

export function formatIssueMarker(marker: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(marker)) {
    throw new TypeError("Invalid GitHub issue marker");
  }
  return `<!-- sigmabot-issue:${marker} -->`;
}

function parseRepository(repository: string): { owner: string; name: string } {
  const parts = repository.split("/");
  if (
    parts.length !== 2 ||
    !isRepositoryPart(parts[0]) ||
    !isRepositoryPart(parts[1])
  ) {
    throw new TypeError("Invalid GitHub repository");
  }
  return { owner: parts[0], name: parts[1] };
}

function isRepositoryPart(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value !== "." &&
    value !== ".." &&
    /^[A-Za-z0-9_.-]{1,100}$/.test(value)
  );
}

function readIssue(
  data: Record<string, unknown>,
  responseStatus: number,
): GitHubIssue {
  if (
    !Number.isSafeInteger(data.number) ||
    (data.number as number) <= 0 ||
    typeof data.html_url !== "string" ||
    !isHttpUrl(data.html_url)
  ) {
    throw invalidResponseError(responseStatus);
  }
  return { number: data.number as number, url: data.html_url };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw invalidResponseError(response.status);
  }
}

function invalidResponseError(status: number): GitHubApiError {
  return new GitHubApiError("GitHub API returned an invalid response", status, true);
}

async function responseError(
  response: Response,
  now: number,
): Promise<GitHubApiError> {
  let secondaryRateLimited = false;
  if (response.status === 403) {
    try {
      secondaryRateLimited = hasStandardSecondaryRateLimitMessage(
        await response.json(),
      );
    } catch {
      // A response body is optional and is never surfaced.
    }
  }
  const classification = classifyHttpFailure(
    response.status,
    response.headers,
    secondaryRateLimited,
    now,
  );
  return new GitHubApiError(
    `GitHub API request failed with status ${response.status}`,
    response.status,
    classification.retryable,
    classification.retryAfterMs,
  );
}

interface FailureClassification {
  retryable: boolean;
  retryAfterMs?: number;
}

function classifyHttpFailure(
  status: number,
  headers: Headers,
  secondaryRateLimited: boolean,
  now: number,
): FailureClassification {
  let retryAfterMs = readRetryAfter(headers, now);
  const rateLimited403 = status === 403 &&
    (headers.get("x-ratelimit-remaining") === "0" ||
      headers.has("retry-after") ||
      secondaryRateLimited);
  const retryable = status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500 ||
    rateLimited403;
  if (
    retryAfterMs === undefined &&
    (status === 429 || rateLimited403)
  ) {
    retryAfterMs = DEFAULT_RETRY_AFTER_MS;
  }
  return { retryable, retryAfterMs };
}

function readRetryAfter(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }

  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = headers.get("x-ratelimit-reset");
    if (reset !== null && reset.trim() !== "") {
      const resetSeconds = Number(reset);
      if (Number.isFinite(resetSeconds) && resetSeconds >= 0) {
        return Math.max(0, Math.ceil(resetSeconds * 1000 - now));
      }
    }
  }
  return undefined;
}

function isTransientAuthenticationError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!isRecord(error)) return false;
  return error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error.name === "NetworkError";
}

function headersFromUnknown(value: unknown): Headers {
  if (value instanceof Headers) return value;
  const headers = new Headers();
  if (!isRecord(value)) return headers;
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string" || typeof headerValue === "number") {
      headers.set(name, String(headerValue));
    }
  }
  return headers;
}

function readErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const candidate = typeof error.status === "number"
    ? error.status
    : isRecord(error.response) && typeof error.response.status === "number"
    ? error.response.status
    : undefined;
  return candidate !== undefined &&
      Number.isSafeInteger(candidate) &&
      candidate >= 100 &&
      candidate <= 599
    ? candidate
    : undefined;
}

function authenticationError(error: unknown, now: number): GitHubApiError {
  const status = readErrorStatus(error);
  if (status === undefined) {
    return new GitHubApiError(
      "GitHub App authentication failed",
      undefined,
      isTransientAuthenticationError(error),
    );
  }

  const response = isRecord(error) && isRecord(error.response) ? error.response : undefined;
  const headers = headersFromUnknown(response?.headers);
  const classification = classifyHttpFailure(
    status,
    headers,
    hasStandardSecondaryRateLimitMessage(response?.data),
    now,
  );
  return new GitHubApiError(
    "GitHub App authentication failed",
    status,
    classification.retryable,
    classification.retryAfterMs,
  );
}

function hasStandardSecondaryRateLimitMessage(data: unknown): boolean {
  if (!isRecord(data) || typeof data.message !== "string") return false;
  const message = data.message.toLowerCase();
  return message.includes("secondary rate limit") ||
    message.includes("abuse detection mechanism") ||
    message.includes("abuse rate limit");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function withRequestTimeout(
  fetcher: typeof fetch,
  requestTimeoutMs: number,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const upstreamSignal = init?.signal ??
      (input instanceof Request ? input.signal : undefined);
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const signal = upstreamSignal
      ? AbortSignal.any([upstreamSignal, timeoutSignal])
      : timeoutSignal;
    return fetcher(input, { ...init, signal });
  }) as typeof fetch;
}

const octokitAuthFactory: GitHubAuthFactory = ({ fetcher, ...options }) => {
  const request = octokitRequest.defaults({ request: { fetch: fetcher } });
  const auth = createAppAuth({ ...options, request });
  return async (forceRefresh) => {
    const authentication = await auth({
      type: "installation",
      refresh: forceRefresh,
    });
    return {
      token: authentication.token,
      expiresAt: authentication.expiresAt,
    };
  };
};
