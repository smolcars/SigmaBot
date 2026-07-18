import type { AIGateway } from "../src/ai.ts";
import type { AppConfig } from "../src/config.ts";
import type { TelegramGateway } from "../src/telegram.ts";
import type {
  AIResponse,
  ConversationMessage,
  ImageReference,
  TelegramFormattedMessage,
  TelegramMessage,
  TelegramSentMessage,
  TelegramUpdate,
} from "../src/types.ts";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    botName: "SigmaBot",
    botUsername: "sigmabot",
    telegramToken: "telegram-test-token",
    telegramWebhookSecret: "test_secret",
    publicUrl: "https://sigmabot.example",
    allowedUserIds: new Set(["1"]),
    allowedGroupIds: new Set(["-100"]),
    requireAllowedGroupUser: false,
    aiProvider: "openai",
    aiApiKey: "ai-test-key",
    aiModel: "test-model",
    aiSupportsImages: "auto",
    openAIBaseUrl: "https://api.openai.com/v1",
    webSearch: false,
    maxOutputTokens: 1024,
    aiTimeoutMs: 5_000,
    rateLimitPerMinute: 10,
    maxContextMessages: 20,
    maxContextChars: 30_000,
    maxRetainedMessages: 100,
    maxMessageChars: 12_000,
    maxWebhookBytes: 1_000_000,
    maxImageBytes: 5 * 1024 * 1024,
    systemPrompt: "You are SigmaBot.",
    port: 8000,
    ...overrides,
  };
}

export function makeUpdate(
  updateId: number,
  overrides: Partial<TelegramMessage> = {},
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 1, type: "private" },
      from: { id: 1, first_name: "Alice" },
      text: "hello",
      ...overrides,
    },
  };
}

export class FakeAI implements AIGateway {
  calls: { systemPrompt: string; messages: ConversationMessage[] }[] = [];
  response: AIResponse = { text: "AI response", inputTokens: 10, outputTokens: 2 };
  error?: Error;
  imageSupport = true;
  imageSupportCalls = 0;

  supportsImages(): Promise<boolean> {
    this.imageSupportCalls++;
    return Promise.resolve(this.imageSupport);
  }

  generate(
    systemPrompt: string,
    messages: ConversationMessage[],
  ): Promise<AIResponse> {
    this.calls.push({ systemPrompt, messages: structuredClone(messages) });
    if (this.error) return Promise.reject(this.error);
    return Promise.resolve(this.response);
  }
}

export class FakeTelegram implements TelegramGateway {
  messages: {
    chatId: number;
    formatted: TelegramFormattedMessage;
    plainText: string;
    options?: Record<string, unknown>;
  }[] = [];
  actions: { chatId: number; threadId?: number }[] = [];
  failMessages = 0;
  messageError?: Error;
  messageAttempts = 0;
  image = { mediaType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) };
  fetchedImages: ImageReference[] = [];

  sendMessage(): Promise<TelegramSentMessage> {
    return Promise.resolve({ message_id: this.messages.length + 1 });
  }

  sendFormattedMessage(
    chatId: number,
    formatted: TelegramFormattedMessage,
    plainText: string,
    options?: Record<string, unknown>,
  ): Promise<TelegramSentMessage> {
    this.messageAttempts++;
    if (this.messageError) return Promise.reject(this.messageError);
    if (this.failMessages > 0) {
      this.failMessages--;
      return Promise.reject(new Error("Telegram unavailable"));
    }
    this.messages.push({ chatId, formatted, plainText, options });
    return Promise.resolve({ message_id: this.messages.length });
  }

  sendChatAction(chatId: number, messageThreadId?: number): Promise<void> {
    this.actions.push({ chatId, threadId: messageThreadId });
    return Promise.resolve();
  }

  fetchImage(
    image: ImageReference,
    _maxBytes: number,
  ): Promise<{ mediaType: string; bytes: Uint8Array }> {
    this.fetchedImages.push(structuredClone(image));
    return Promise.resolve(this.image);
  }
}

export function webhookRequest(
  update: unknown,
  secret = "test_secret",
): Request {
  return new Request("http://localhost/api/telegram-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(update),
  });
}
