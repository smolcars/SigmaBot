import type { AppConfig } from "./config.ts";
import type { AIResponse, ContentPart, ConversationMessage, WebCitation } from "./types.ts";

interface OpenAIMessage {
  role: "user" | "assistant";
  content: string | OpenAIContentPart[];
  reasoning_content?: string | null;
}

interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

interface OpenAIResponse {
  choices?: {
    finish_reason?: string | null;
    message?: {
      role?: "assistant";
      content?: string | null;
      reasoning_content?: string | null;
      refusal?: string | null;
      tool_calls?: unknown;
      [key: string]: unknown;
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

interface MoonshotWebSearchCall {
  id: string;
  parsedArguments: Record<string, unknown>;
}

interface ResponsesAPIResponse {
  status?: string;
  incomplete_details?: { reason?: string | null } | null;
  output?: {
    type?: string;
    action?: {
      type?: string;
      query?: string;
      queries?: string[];
    };
    content?: {
      type?: string;
      text?: string;
      refusal?: string;
      annotations?: ResponsesAnnotation[];
    }[];
  }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

interface ResponsesAnnotation {
  type?: string;
  start_index?: number;
  end_index?: number;
  url?: string;
  title?: string;
}

interface ClaudeResponse {
  content?: { type?: string; text?: string }[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface AIGateway {
  generate(
    systemPrompt: string,
    messages: ConversationMessage[],
    options?: AIGenerationOptions,
  ): Promise<AIResponse>;
  supportsImages(): Promise<boolean>;
}

export interface AIGenerationOptions {
  webSearch?: boolean;
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}

interface RetryTiming {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

interface ImageSupportDiscovery {
  value: boolean | undefined;
  transient: boolean;
}

type ModelMetadataResult =
  | { ok: true; value: unknown }
  | { ok: false; transient: boolean };

const defaultRetryTiming: RetryTiming = {
  now: () => Date.now(),
  sleep: delay,
};

const IMAGE_CAPABILITY_TIMEOUT_MS = 3_000;
const IMAGE_CAPABILITY_CACHE_MS = 60 * 60 * 1_000;
const IMAGE_CAPABILITY_RETRY_MS = 60 * 1_000;
const MAX_MOONSHOT_WEB_SEARCH_ROUNDS = 8;
const MAX_MOONSHOT_WEB_SEARCH_CALLS = 8;
const MAX_TRACKED_SEARCH_QUERY_CHARS = 512;
const MOONSHOT_CHAT_COMPLETIONS_URL = "https://api.moonshot.ai/v1/chat/completions";
const MOONSHOT_WEB_SEARCH_TOOL = {
  type: "builtin_function",
  function: { name: "$web_search" },
} as const;

export class ProviderAIClient implements AIGateway {
  private imageSupportCache?: {
    value: boolean | undefined;
    expiresAt: number;
  };
  private imageSupportLookup?: Promise<ImageSupportDiscovery>;

  constructor(
    readonly config: AppConfig,
    readonly fetcher: typeof fetch = fetch,
    private readonly retryTiming: RetryTiming = defaultRetryTiming,
  ) {}

  async supportsImages(): Promise<boolean> {
    if (this.config.aiSupportsImages !== "auto") {
      return this.config.aiSupportsImages;
    }

    const cached = this.imageSupportCache;
    if (cached && cached.expiresAt > this.retryTiming.now()) {
      return cached.value !== false;
    }

    const lookup = this.imageSupportLookup ??= this.discoverImageSupport().catch(
      () => ({ value: undefined, transient: true }),
    );
    try {
      const result = await lookup;
      this.imageSupportCache = {
        value: result.value,
        expiresAt: this.retryTiming.now() +
          (result.transient ? IMAGE_CAPABILITY_RETRY_MS : IMAGE_CAPABILITY_CACHE_MS),
      };
      return result.value !== false;
    } finally {
      if (this.imageSupportLookup === lookup) this.imageSupportLookup = undefined;
    }
  }

  async generate(
    systemPrompt: string,
    messages: ConversationMessage[],
    options: AIGenerationOptions = {},
  ): Promise<AIResponse> {
    const deadline = this.retryTiming.now() + this.config.aiTimeoutMs;
    const hasImage = messages.some((message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image")
    );
    const search = (options.webSearch ?? this.config.webSearch) && !hasImage;
    switch (this.config.aiProvider) {
      case "claude":
        return await this.callClaude(systemPrompt, messages, deadline);
      case "moonshot":
        return search
          ? await this.callMoonshotWebSearch(systemPrompt, messages, deadline)
          : await this.callChatCompletions(
            MOONSHOT_CHAT_COMPLETIONS_URL,
            systemPrompt,
            messages,
            deadline,
          );
      case "grok":
        return search
          ? await this.callResponses(
            "https://api.x.ai/v1/responses",
            systemPrompt,
            messages,
            deadline,
          )
          : await this.callChatCompletions(
            "https://api.x.ai/v1/chat/completions",
            systemPrompt,
            messages,
            deadline,
          );
      case "openai":
        return search
          ? await this.callResponses(
            `${this.config.openAIBaseUrl}/responses`,
            systemPrompt,
            messages,
            deadline,
          )
          : await this.callChatCompletions(
            `${this.config.openAIBaseUrl}/chat/completions`,
            systemPrompt,
            messages,
            deadline,
          );
    }
  }

  private async callClaude(
    systemPrompt: string,
    messages: ConversationMessage[],
    deadline: number,
  ): Promise<AIResponse> {
    const data = await this.fetchJson<ClaudeResponse>(
      "https://api.anthropic.com/v1/messages",
      {
        headers: {
          "x-api-key": this.config.aiApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: {
          model: this.config.aiModel,
          max_tokens: this.config.maxOutputTokens,
          system: systemPrompt,
          messages: messages.map((message) => ({
            role: message.role,
            content: toClaudeContent(message.content),
          })),
        },
      },
      deadline,
    );
    ensureClaudeCompleted(data.stop_reason);
    const text = data.content?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "").join("\n").trim() ?? "";
    ensureText(text);
    return {
      text,
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
    };
  }

  private async callChatCompletions(
    url: string,
    systemPrompt: string,
    messages: ConversationMessage[],
    deadline: number,
  ): Promise<AIResponse> {
    const body: Record<string, unknown> = {
      model: this.config.aiModel,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((message) =>
          toOpenAIMessage(message, this.config.aiProvider === "moonshot")
        ),
      ],
    };
    if (
      this.config.aiProvider === "moonshot" ||
      (this.config.aiProvider === "openai" &&
        isOfficialOpenAIBaseUrl(this.config.openAIBaseUrl))
    ) {
      body.max_completion_tokens = this.config.maxOutputTokens;
    } else {
      body.max_tokens = this.config.maxOutputTokens;
    }
    if (this.config.aiProvider === "moonshot") {
      body.reasoning_effort = "max";
    }
    const data = await this.fetchJson<OpenAIResponse>(
      url,
      {
        headers: { authorization: `Bearer ${this.config.aiApiKey}` },
        body,
      },
      deadline,
    );
    const choice = data.choices?.[0];
    ensureChatCompletionFinished(choice?.finish_reason);
    const message = choice?.message;
    const text = readChatMessageText(message);
    const reasoningContent = message?.reasoning_content;
    ensureText(text);
    return {
      text,
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: readChatCompletionOutputTokens(
        data.usage,
        this.config.aiProvider === "grok",
      ),
      ...(reasoningContent?.trim() && {
        reasoningContent,
      }),
    };
  }

  private async callMoonshotWebSearch(
    systemPrompt: string,
    messages: ConversationMessage[],
    deadline: number,
  ): Promise<AIResponse> {
    const chatMessages: unknown[] = [
      { role: "system", content: systemPrompt },
      ...messages.map((message) => toOpenAIMessage(message, true)),
    ];
    const searchQueries: string[] = [];
    let webSearchCount = 0;
    let webSearchRounds = 0;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    while (true) {
      const searchBudgetExhausted = webSearchRounds >= MAX_MOONSHOT_WEB_SEARCH_ROUNDS ||
        webSearchCount >= MAX_MOONSHOT_WEB_SEARCH_CALLS;
      const data = await this.fetchJson<OpenAIResponse>(
        MOONSHOT_CHAT_COMPLETIONS_URL,
        {
          headers: { authorization: `Bearer ${this.config.aiApiKey}` },
          body: {
            model: this.config.aiModel,
            max_completion_tokens: this.config.maxOutputTokens,
            reasoning_effort: "max",
            messages: chatMessages,
            tools: [MOONSHOT_WEB_SEARCH_TOOL],
            ...(searchBudgetExhausted && { tool_choice: "none" }),
          },
        },
        deadline,
      );
      inputTokens = addTokenCount(inputTokens, data.usage?.prompt_tokens);
      outputTokens = addTokenCount(outputTokens, data.usage?.completion_tokens);

      const choice = data.choices?.[0];
      const message = choice?.message;
      if (!message || !isRecord(message)) {
        throw new AIProviderError("AI provider returned an invalid response");
      }
      if (choice?.finish_reason === "length") {
        throw new AIProviderError("AI provider exhausted the completion token limit");
      }
      if (searchBudgetExhausted && choice?.finish_reason === "tool_calls") {
        throw new AIProviderError("Moonshot ignored the disabled web search tool");
      }
      if (choice?.finish_reason !== "tool_calls") {
        if (choice?.finish_reason !== "stop") {
          throw new AIProviderError("AI provider returned an invalid finish reason");
        }
        const text = readChatMessageText(message);
        const reasoningContent = typeof message.reasoning_content === "string"
          ? message.reasoning_content
          : undefined;
        ensureText(text);
        return {
          text,
          inputTokens,
          outputTokens,
          ...(reasoningContent?.trim() && { reasoningContent }),
          ...(searchQueries.length && { webSearchQueries: searchQueries }),
          ...(webSearchCount && { webSearchCount }),
        };
      }

      const toolCalls = readMoonshotWebSearchCalls(message.tool_calls);
      if (webSearchCount + toolCalls.length > MAX_MOONSHOT_WEB_SEARCH_CALLS) {
        throw new AIProviderError(
          "Moonshot web search exceeded the tool-call limit",
        );
      }

      webSearchRounds++;
      // K3 requires this provider message to be replayed without reconstruction.
      chatMessages.push(message);
      for (const toolCall of toolCalls) {
        webSearchCount++;
        const query = readMoonshotSearchQuery(toolCall.parsedArguments);
        if (query) searchQueries.push(query);
        chatMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: "$web_search",
          content: JSON.stringify(toolCall.parsedArguments),
        });
      }
    }
  }

  private async callResponses(
    url: string,
    systemPrompt: string,
    messages: ConversationMessage[],
    deadline: number,
  ): Promise<AIResponse> {
    const data = await this.fetchJson<ResponsesAPIResponse>(
      url,
      {
        headers: { authorization: `Bearer ${this.config.aiApiKey}` },
        body: {
          model: this.config.aiModel,
          input: [
            { role: "system", content: systemPrompt },
            ...messages.map((message) => ({
              role: message.role,
              content: toTextContent(message.content),
            })),
          ],
          tools: [{ type: "web_search" }],
          max_output_tokens: this.config.maxOutputTokens,
          store: false,
        },
      },
      deadline,
    );
    ensureResponsesCompleted(data);
    const citations: WebCitation[] = [];
    const citationNumbers = new Map<string, number>();
    const text = data.output?.filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .map((part) => {
        if (part.type === "output_text") {
          return addCitationMarkers(
            part.text ?? "",
            part.annotations ?? [],
            citations,
            citationNumbers,
          );
        }
        return part.type === "refusal" ? part.refusal ?? "" : "";
      }).filter(Boolean).join("\n").trim() ?? "";
    ensureText(text);
    const searchQueries: string[] = [];
    let webSearchCount = 0;
    for (const item of data.output ?? []) {
      if (item.type !== "web_search_call" || item.action?.type !== "search") continue;
      const queries = Array.isArray(item.action.queries)
        ? item.action.queries
        : typeof item.action.query === "string"
        ? [item.action.query]
        : [];
      const normalizedQueries = queries
        .map((query) => query.trim())
        .filter(Boolean);
      searchQueries.push(...normalizedQueries);
      webSearchCount += Math.max(1, normalizedQueries.length);
    }
    return {
      text,
      inputTokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens,
      outputTokens: readResponsesOutputTokens(
        data.usage,
        this.config.aiProvider === "grok",
      ),
      ...(searchQueries.length && { webSearchQueries: searchQueries }),
      ...(webSearchCount && { webSearchCount }),
      ...(citations.length && { webCitations: citations }),
    };
  }

  private async discoverImageSupport(): Promise<ImageSupportDiscovery> {
    switch (this.config.aiProvider) {
      case "moonshot": {
        const result = await this.fetchModelMetadata(
          "https://api.moonshot.ai/v1/models",
          { authorization: `Bearer ${this.config.aiApiKey}` },
        );
        if (!result.ok) return { value: undefined, transient: result.transient };
        const data = result.value;
        const models = isRecord(data) && Array.isArray(data.data) ? data.data : [];
        const model = models.find((entry) =>
          isRecord(entry) && entry.id === this.config.aiModel
        );
        return {
          value: isRecord(model) && typeof model.supports_image_in === "boolean"
            ? model.supports_image_in
            : undefined,
          transient: false,
        };
      }
      case "claude": {
        const result = await this.fetchModelMetadata(
          `https://api.anthropic.com/v1/models/${encodeURIComponent(this.config.aiModel)}`,
          {
            "x-api-key": this.config.aiApiKey,
            "anthropic-version": "2023-06-01",
          },
        );
        if (!result.ok) return { value: undefined, transient: result.transient };
        const model = result.value;
        if (!isRecord(model) || !isRecord(model.capabilities)) {
          return { value: undefined, transient: false };
        }
        const imageInput = model.capabilities.image_input;
        return {
          value: isRecord(imageInput) && typeof imageInput.supported === "boolean"
            ? imageInput.supported
            : undefined,
          transient: false,
        };
      }
      case "grok": {
        const result = await this.fetchModelMetadata(
          "https://api.x.ai/v1/language-models",
          { authorization: `Bearer ${this.config.aiApiKey}` },
        );
        if (!result.ok) return { value: undefined, transient: result.transient };
        const data = result.value;
        const models = isRecord(data) && Array.isArray(data.models) ? data.models : [];
        const model = findModelMetadata(models, this.config.aiModel);
        if (!isRecord(model) || !Array.isArray(model.input_modalities)) {
          return { value: undefined, transient: false };
        }
        if (!model.input_modalities.every((modality) => typeof modality === "string")) {
          return { value: undefined, transient: false };
        }
        return {
          value: model.input_modalities.includes("image"),
          transient: false,
        };
      }
      case "openai": {
        if (isOfficialOpenAIBaseUrl(this.config.openAIBaseUrl)) {
          return { value: true, transient: false };
        }

        const result = await this.fetchModelMetadata(
          `${this.config.openAIBaseUrl}/models`,
          { authorization: `Bearer ${this.config.aiApiKey}` },
        );
        if (!result.ok) return { value: undefined, transient: result.transient };
        const data = result.value;
        const models = isRecord(data) && Array.isArray(data.data) ? data.data : [];
        const model = findModelMetadata(models, this.config.aiModel);
        return {
          value: isRecord(model) ? readOpenAICompatibleImageSupport(model) : undefined,
          transient: false,
        };
      }
    }
  }

  private async fetchModelMetadata(
    url: string,
    headers: Record<string, string>,
  ): Promise<ModelMetadataResult> {
    try {
      const response = await this.fetcher(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(
          Math.min(this.config.aiTimeoutMs, IMAGE_CAPABILITY_TIMEOUT_MS),
        ),
      });
      if (!response.ok) {
        return {
          ok: false,
          transient: isTransientImageMetadataStatus(response.status),
        };
      }
      return { ok: true, value: await response.json() };
    } catch {
      return { ok: false, transient: true };
    }
  }

  private async fetchJson<T>(
    url: string,
    request: { headers: Record<string, string>; body: Record<string, unknown> },
    deadline: number,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - this.retryTiming.now();
      if (remaining <= 0) throw new AIProviderError("AI request timed out", true);
      let retryAfterMs: number | undefined;
      try {
        const response = await this.fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...request.headers },
          body: JSON.stringify(request.body),
          signal: AbortSignal.timeout(remaining),
        });
        if (response.ok) {
          try {
            return await response.json() as T;
          } catch {
            throw new AIProviderError("AI provider returned invalid JSON");
          }
        }
        const retryable = isRetryableProviderStatus(response.status);
        if (retryable) {
          retryAfterMs = parseRetryAfter(
            response.headers.get("retry-after"),
            this.retryTiming.now(),
          );
        }
        const error = new AIProviderError(
          `AI provider request failed with status ${response.status}`,
          retryable,
          response.status,
        );
        if (!retryable || attempt === 2) throw error;
        lastError = error;
      } catch (error) {
        lastError = error;
        if (error instanceof AIProviderError && !error.retryable) throw error;
        if (attempt === 2) {
          if (error instanceof AIProviderError) throw error;
          throw new AIProviderError("AI provider network request failed", true);
        }
      }
      const remainingBeforeRetry = Math.max(0, deadline - this.retryTiming.now());
      const retryDelay = retryAfterMs ?? 250 * 2 ** attempt;
      await this.retryTiming.sleep(Math.min(retryDelay, remainingBeforeRetry));
    }
    throw lastError;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMoonshotWebSearchCalls(value: unknown): MoonshotWebSearchCall[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AIProviderError("AI provider returned invalid web search tool calls");
  }

  const calls: MoonshotWebSearchCall[] = [];
  const currentIds = new Set<string>();
  for (const valueCall of value) {
    if (!isRecord(valueCall) || !isRecord(valueCall.function)) {
      throw new AIProviderError("AI provider returned an invalid web search tool call");
    }
    const id = valueCall.id;
    const name = valueCall.function.name;
    const argumentsJson = valueCall.function.arguments;
    if (
      typeof id !== "string" || !id ||
      currentIds.has(id) ||
      name !== "$web_search" ||
      typeof argumentsJson !== "string"
    ) {
      throw new AIProviderError("AI provider returned an invalid web search tool call");
    }

    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(argumentsJson);
    } catch {
      throw new AIProviderError("AI provider returned invalid web search arguments");
    }
    if (!isRecord(parsedArguments)) {
      throw new AIProviderError("AI provider returned invalid web search arguments");
    }
    currentIds.add(id);
    calls.push({ id, parsedArguments });
  }
  return calls;
}

function readMoonshotSearchQuery(
  argumentsValue: Record<string, unknown>,
): string | undefined {
  if (typeof argumentsValue.query !== "string") return undefined;
  const query = argumentsValue.query.trim().slice(0, MAX_TRACKED_SEARCH_QUERY_CHARS);
  return query || undefined;
}

function addTokenCount(
  current: number | undefined,
  value: number | undefined,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? (current ?? 0) + value
    : current;
}

function readChatCompletionOutputTokens(
  usage: OpenAIResponse["usage"],
  includeSeparateReasoning: boolean,
): number | undefined {
  const completionTokens = addTokenCount(undefined, usage?.completion_tokens);
  return includeSeparateReasoning
    ? addTokenCount(
      completionTokens,
      usage?.completion_tokens_details?.reasoning_tokens,
    )
    : completionTokens;
}

function readResponsesOutputTokens(
  usage: ResponsesAPIResponse["usage"],
  includeSeparateReasoning: boolean,
): number | undefined {
  if (typeof usage?.output_tokens === "number") {
    return addTokenCount(undefined, usage.output_tokens);
  }
  const completionTokens = addTokenCount(undefined, usage?.completion_tokens);
  return includeSeparateReasoning
    ? addTokenCount(
      completionTokens,
      usage?.completion_tokens_details?.reasoning_tokens,
    )
    : completionTokens;
}

function ensureChatCompletionFinished(finishReason: string | null | undefined): void {
  if (finishReason === "length") {
    throw new AIProviderError("AI provider exhausted the completion token limit");
  }
  if (
    finishReason === null || finishReason === "content_filter" ||
    finishReason === "tool_calls" || finishReason === "function_call"
  ) {
    throw new AIProviderError("AI provider did not return a final answer");
  }
}

function ensureClaudeCompleted(stopReason: string | null | undefined): void {
  if (stopReason === "max_tokens") {
    throw new AIProviderError("AI provider exhausted the completion token limit");
  }
  if (stopReason === "model_context_window_exceeded") {
    throw new AIProviderError("AI provider exhausted the model context window");
  }
  if (
    stopReason !== "end_turn" && stopReason !== "stop_sequence" &&
    stopReason !== "refusal"
  ) {
    throw new AIProviderError("AI provider returned an invalid stop reason");
  }
}

function ensureResponsesCompleted(data: ResponsesAPIResponse): void {
  if (data.status === "completed") return;
  if (
    data.status === "incomplete" &&
    (data.incomplete_details?.reason === "max_output_tokens" ||
      data.incomplete_details?.reason === "max_tokens")
  ) {
    throw new AIProviderError("AI provider exhausted the completion token limit");
  }
  if (data.status === "incomplete") {
    throw new AIProviderError("AI provider returned an incomplete response");
  }
  throw new AIProviderError("AI provider did not complete the response");
}

function isTransientImageMetadataStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
function isRetryableProviderStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
function findModelMetadata(
  models: unknown[],
  modelId: string,
): Record<string, unknown> | undefined {
  const exactMatches = models.filter((entry) => isRecord(entry) && entry.id === modelId);
  if (exactMatches.length > 0) {
    return exactMatches.length === 1 && isRecord(exactMatches[0])
      ? exactMatches[0]
      : undefined;
  }

  const aliasMatches = models.filter((entry) =>
    isRecord(entry) &&
    Array.isArray(entry.aliases) &&
    entry.aliases.every((value) => typeof value === "string") &&
    entry.aliases.includes(modelId)
  );
  return aliasMatches.length === 1 && isRecord(aliasMatches[0])
    ? aliasMatches[0]
    : undefined;
}
function isOfficialOpenAIBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const officialHostname = hostname === "api.openai.com" ||
      /^[a-z]{2}\.api\.openai\.com$/.test(hostname);
    return url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname.replace(/\/+$/, "") === "/v1" &&
      url.search === "" &&
      url.hash === "" &&
      officialHostname;
  } catch {
    return false;
  }
}

function readOpenAICompatibleImageSupport(
  model: Record<string, unknown>,
): boolean | undefined {
  const declarations: boolean[] = [];
  const addModalities = (value: unknown) => {
    if (
      Array.isArray(value) && value.length > 0 &&
      value.every((modality) => typeof modality === "string")
    ) {
      declarations.push(
        value.some((modality) => modality.trim().toLowerCase() === "image"),
      );
    }
  };

  addModalities(model.input_modalities);
  if (isRecord(model.architecture)) {
    addModalities(model.architecture.input_modalities);
  }
  if (
    isRecord(model.capabilities) &&
    typeof model.capabilities.vision === "boolean"
  ) {
    declarations.push(model.capabilities.vision);
  }
  if (typeof model.supports_vision === "boolean") {
    declarations.push(model.supports_vision);
  }

  if (declarations.length === 0) return undefined;
  return declarations.every((value) => value === declarations[0])
    ? declarations[0]
    : undefined;
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    if (!Number.isFinite(seconds)) return undefined;
    return Math.min(seconds * 1_000, Number.MAX_SAFE_INTEGER);
  }

  const retryAt = Date.parse(normalized);
  if (Number.isNaN(retryAt)) return undefined;
  return Math.max(0, retryAt - now);
}

function addCitationMarkers(
  text: string,
  annotations: ResponsesAnnotation[],
  citations: WebCitation[],
  citationNumbers: Map<string, number>,
): string {
  const placements = new Map<string, {
    start: number;
    end: number;
    numbers: number[];
  }>();
  const unplaced = new Set<number>();

  for (const annotation of annotations) {
    if (annotation.type !== "url_citation") continue;
    const url = normalizeCitationUrl(annotation.url);
    if (!url) continue;
    let number = citationNumbers.get(url);
    if (!number) {
      number = citations.length + 1;
      citationNumbers.set(url, number);
      const title = normalizeCitationTitle(annotation.title);
      citations.push({
        url,
        ...(title && { title }),
      });
    }

    const range = resolveAnnotationRange(
      text,
      annotation.start_index,
      annotation.end_index,
    );
    if (!range) {
      unplaced.add(number);
      continue;
    }
    const key = `${range.start}:${range.end}`;
    const placement = placements.get(key) ?? { ...range, numbers: [] };
    if (!placement.numbers.includes(number)) placement.numbers.push(number);
    placements.set(key, placement);
  }

  let result = text;
  let rightBoundary = text.length;
  for (
    const placement of [...placements.values()].sort((left, right) =>
      right.start - left.start
    )
  ) {
    const labels = placement.numbers.map((number) => `[${number}]`).join("");
    if (placement.end > rightBoundary) {
      placement.numbers.forEach((number) => unplaced.add(number));
      continue;
    }
    const annotated = text.slice(placement.start, placement.end);
    result = isCitationMarker(annotated)
      ? result.slice(0, placement.start) + labels + result.slice(placement.end)
      : result.slice(0, placement.end) + labels + result.slice(placement.end);
    rightBoundary = placement.start;
  }

  const missing = [...unplaced].sort((left, right) => left - right);
  return missing.length
    ? `${result}${result.endsWith(" ") ? "" : " "}${
      missing.map((number) => `[${number}]`).join("")
    }`
    : result;
}

function resolveAnnotationRange(
  text: string,
  start: number | undefined,
  end: number | undefined,
): { start: number; end: number } | undefined {
  if (
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    start! < 0 || end! < start!
  ) return undefined;

  if (end! <= text.length) {
    const direct = { start: start!, end: end! };
    if (isCitationMarker(text.slice(direct.start, direct.end))) return direct;
  }

  const codePoints = [...text];
  if (end! > codePoints.length) {
    return end! <= text.length ? { start: start!, end: end! } : undefined;
  }
  const codePointRange = {
    start: codePoints.slice(0, start!).join("").length,
    end: codePoints.slice(0, end!).join("").length,
  };
  if (isCitationMarker(text.slice(codePointRange.start, codePointRange.end))) {
    return codePointRange;
  }
  return end! <= text.length ? { start: start!, end: end! } : codePointRange;
}

function isCitationMarker(value: string): boolean {
  return /(?:\uE200cite\uE202|\u3010[^\u3011]*\u2020[^\u3011]*\u3011|^\[\[?\d+\]?\])/.test(
    value,
  );
}

function normalizeCitationUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCitationTitle(value: string | undefined): string | undefined {
  const title = value?.replace(/\s+/g, " ").trim().slice(0, 256);
  return title || undefined;
}

function toOpenAIMessage(
  message: ConversationMessage,
  includeReasoning: boolean,
): OpenAIMessage {
  return {
    role: message.role,
    content: toOpenAIContent(message.content),
    ...(includeReasoning && message.role === "assistant" &&
      message.reasoningContent !== undefined && {
      reasoning_content: message.reasoningContent,
    }),
  };
}

function readChatMessageText(
  message: { content?: string | null; refusal?: string | null } | undefined,
): string {
  return [message?.content, message?.refusal]
    .filter((value): value is string => typeof value === "string" && !!value.trim())
    .join("\n");
}

function toOpenAIContent(content: string | ContentPart[]): string | OpenAIContentPart[] {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "text" ? { type: "text", text: part.text } : {
      type: "image_url",
      image_url: { url: `data:${part.mediaType};base64,${part.data}` },
    }
  );
}

function toClaudeContent(content: string | ContentPart[]): unknown {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "text" ? { type: "text", text: part.text } : {
      type: "image",
      source: {
        type: "base64",
        media_type: part.mediaType,
        data: part.data,
      },
    }
  );
}

function toTextContent(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text" ? part.text : "[image]").join(" ");
}

function ensureText(text: string): void {
  if (!text.trim()) throw new AIProviderError("AI provider returned an empty response");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
