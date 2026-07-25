import type {
  ImageReference,
  TelegramFormattedMessage,
  TelegramSentMessage,
} from "./types.ts";

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";
const TELEGRAM_FILE_BASE = "https://api.telegram.org/file/bot";

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface SendMessageOptions {
  replyToMessageId?: number;
  messageThreadId?: number;
  directMessagesTopicId?: number;
  parseMode?: "HTML";
}

export interface TelegramGateway {
  sendMessage(
    chatId: number,
    text: string,
    options?: SendMessageOptions,
  ): Promise<TelegramSentMessage>;
  sendFormattedMessage(
    chatId: number,
    formatted: TelegramFormattedMessage,
    plainText: string,
    options?: SendMessageOptions,
  ): Promise<TelegramSentMessage>;
  sendChatAction(chatId: number, messageThreadId?: number): Promise<void>;
  fetchImage(image: ImageReference, maxBytes: number): Promise<{
    mediaType: string;
    bytes: Uint8Array;
  }>;
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export class TelegramClient implements TelegramGateway {
  constructor(
    readonly token: string,
    readonly fetcher: typeof fetch = fetch,
    readonly apiBase = TELEGRAM_API_BASE,
    readonly fileBase = TELEGRAM_FILE_BASE,
    readonly sleeper: (milliseconds: number) => Promise<void> = delay,
  ) {}

  async sendMessage(
    chatId: number,
    text: string,
    options: SendMessageOptions = {},
  ): Promise<TelegramSentMessage> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (options.directMessagesTopicId !== undefined) {
      body.direct_messages_topic_id = options.directMessagesTopicId;
    } else if (options.messageThreadId !== undefined) {
      body.message_thread_id = options.messageThreadId;
    }
    if (options.replyToMessageId !== undefined) {
      body.reply_parameters = {
        message_id: options.replyToMessageId,
        allow_sending_without_reply: true,
      };
    }
    if (options.parseMode) body.parse_mode = options.parseMode;
    const result = await this.call<unknown>("sendMessage", body, {
      attempts: 2,
      timeoutMs: 5_000,
      retryRateLimits: false,
    });
    if (!isSentMessage(result)) {
      throw new TelegramApiError("Telegram sendMessage returned an invalid result", 502);
    }
    return result;
  }

  async sendFormattedMessage(
    chatId: number,
    formatted: TelegramFormattedMessage,
    plainText: string,
    options: SendMessageOptions = {},
  ): Promise<TelegramSentMessage> {
    try {
      return await this.sendMessage(chatId, formatted.text, {
        ...options,
        parseMode: formatted.parseMode,
      });
    } catch (error) {
      if (
        formatted.parseMode && error instanceof TelegramApiError && error.status === 400
      ) {
        return await this.sendMessage(chatId, plainText, options);
      }
      throw error;
    }
  }

  async sendChatAction(chatId: number, messageThreadId?: number): Promise<void> {
    const body: Record<string, unknown> = { chat_id: chatId, action: "typing" };
    if (messageThreadId !== undefined) body.message_thread_id = messageThreadId;
    await this.call("sendChatAction", body, { attempts: 1, timeoutMs: 2_000 });
  }

  async getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }> {
    return await this.call("getFile", { file_id: fileId }, {
      attempts: 2,
      timeoutMs: 5_000,
      retryRateLimits: false,
    });
  }

  async fetchImage(
    image: ImageReference,
    maxBytes: number,
  ): Promise<{ mediaType: string; bytes: Uint8Array }> {
    if (image.fileSize !== undefined && image.fileSize > maxBytes) {
      throw new Error("IMAGE_TOO_LARGE");
    }
    const file = await this.getFile(image.fileId);
    if (!file.file_path) throw new Error("IMAGE_FILE_PATH_MISSING");
    if (file.file_size !== undefined && file.file_size > maxBytes) {
      throw new Error("IMAGE_TOO_LARGE");
    }

    const response = await this.fetcher(`${this.fileBase}${this.token}/${file.file_path}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw await telegramFileError(response);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error("IMAGE_TOO_LARGE");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("IMAGE_TOO_LARGE");
    return {
      mediaType: image.mimeType ?? response.headers.get("content-type") ?? "image/jpeg",
      bytes,
    };
  }

  async setWebhook(
    url: string,
    secret: string,
    dropPendingUpdates = false,
  ): Promise<boolean> {
    return await this.call("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message"],
      max_connections: 1,
      drop_pending_updates: dropPendingUpdates,
    });
  }

  async deleteWebhook(dropPendingUpdates = false): Promise<boolean> {
    return await this.call("deleteWebhook", {
      drop_pending_updates: dropPendingUpdates,
    });
  }

  async getWebhookInfo(): Promise<Record<string, unknown>> {
    return await this.call("getWebhookInfo", {});
  }

  async setMyCommands(includeIssue = false): Promise<boolean> {
    const commands = [
      { command: "help", description: "Show help" },
      { command: "reset", description: "Clear this conversation" },
    ];
    if (includeIssue) {
      commands.push({ command: "issue", description: "Create a GitHub issue" });
    }
    return await this.call("setMyCommands", {
      commands,
    });
  }

  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    options: { attempts?: number; timeoutMs?: number; retryRateLimits?: boolean } = {},
  ): Promise<T> {
    const attempts = options.attempts ?? 3;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const retryRateLimits = options.retryRateLimits ?? true;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await this.fetcher(`${this.apiBase}${this.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        let data: TelegramEnvelope<T>;
        try {
          data = await response.json() as TelegramEnvelope<T>;
        } catch {
          const error = new TelegramApiError(
            "Telegram returned invalid JSON",
            response.status,
          );
          if (response.status >= 500 && attempt < attempts - 1) {
            lastError = error;
            await this.sleeper(250 * (attempt + 1));
            continue;
          }
          throw error;
        }
        if (response.ok && data.ok && data.result !== undefined) return data.result;

        const status = data.error_code ?? (response.ok ? 500 : response.status);
        const retryAfterMs = toRetryAfterMilliseconds(data.parameters?.retry_after);
        const error = new TelegramApiError(
          data.description
            ? `Telegram API rejected ${method}`
            : `Telegram ${method} failed`,
          status,
          data.error_code,
          retryAfterMs,
        );
        const retryableRateLimit = status === 429 && retryRateLimits;
        if ((retryableRateLimit || status >= 500) && attempt < attempts - 1) {
          await this.sleeper(
            retryableRateLimit && retryAfterMs !== undefined
              ? retryAfterMs
              : 250 * (attempt + 1),
          );
          lastError = error;
          continue;
        }
        throw error;
      } catch (error) {
        lastError = error;
        if (error instanceof TelegramApiError || attempt === attempts - 1) throw error;
        await this.sleeper(250 * (attempt + 1));
      }
    }
    throw lastError;
  }
}

function isSentMessage(value: unknown): value is TelegramSentMessage {
  if (!value || typeof value !== "object") return false;
  const messageId = (value as Record<string, unknown>).message_id;
  return Number.isSafeInteger(messageId) && (messageId as number) >= 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toRetryAfterMilliseconds(seconds: number | undefined): number | undefined {
  if (!Number.isSafeInteger(seconds) || seconds === undefined || seconds < 0) {
    return undefined;
  }
  const milliseconds = seconds * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

async function telegramFileError(response: Response): Promise<TelegramApiError> {
  let data: TelegramEnvelope<unknown> | undefined;
  try {
    data = await response.json() as TelegramEnvelope<unknown>;
  } catch {
    // Telegram's file endpoint can return a non-JSON proxy response.
  }
  const status = data?.error_code ?? response.status;
  return new TelegramApiError(
    data?.description
      ? "Telegram API rejected file download"
      : "Telegram file download failed",
    status,
    data?.error_code,
    toRetryAfterMilliseconds(data?.parameters?.retry_after),
  );
}
