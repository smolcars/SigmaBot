import type {
  AIProvider,
  ConversationMessage,
  StoredMessage,
  TelegramFormattedMessage,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
  WebCitation,
} from "./types.ts";

const CODE_FENCE_PATTERN = /```([^`\r\n]*)[ \t]*\r?\n([\s\S]*?)```/g;
const INLINE_CODE_PATTERN = /(?<!`)`([^`\r\n]+?)`(?!`)/g;

export function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < maxLength; index++) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  if (!value || typeof value !== "object") return false;
  const update = value as Record<string, unknown>;
  return Number.isSafeInteger(update.update_id) && (update.update_id as number) >= 0;
}

export function getUsableMessage(update: TelegramUpdate): TelegramMessage | undefined {
  const message = update.message as unknown;
  if (!isMessageShape(message, true, 1)) return undefined;
  return message.from?.is_bot ? undefined : message;
}

function isMessageShape(
  value: unknown,
  requireFrom: boolean,
  replyDepth: number,
): value is TelegramMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (!Number.isSafeInteger(message.message_id)) return false;
  if (
    message.message_thread_id !== undefined &&
    !Number.isSafeInteger(message.message_thread_id)
  ) return false;
  if (
    message.direct_messages_topic !== undefined &&
    !isDirectMessagesTopicShape(message.direct_messages_topic)
  ) return false;
  if (message.text !== undefined && typeof message.text !== "string") return false;
  if (message.caption !== undefined && typeof message.caption !== "string") return false;

  if (!message.chat || typeof message.chat !== "object") return false;
  const chat = message.chat as Record<string, unknown>;
  if (!Number.isSafeInteger(chat.id) || typeof chat.type !== "string") return false;
  if (chat.title !== undefined && typeof chat.title !== "string") return false;
  if (
    chat.is_direct_messages !== undefined &&
    typeof chat.is_direct_messages !== "boolean"
  ) return false;

  if (message.from === undefined) {
    if (requireFrom) return false;
  } else if (!isUserShape(message.from)) return false;

  if (message.photo !== undefined) {
    if (!Array.isArray(message.photo)) return false;
    const photo = message.photo.at(-1);
    if (photo !== undefined && !isPhotoShape(photo)) return false;
  }
  if (message.document !== undefined && !isDocumentShape(message.document)) return false;
  if (
    message.reply_to_message !== undefined &&
    (replyDepth <= 0 || !isMessageShape(message.reply_to_message, false, replyDepth - 1))
  ) return false;
  return true;
}

function isUserShape(value: unknown): value is TelegramUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Record<string, unknown>;
  return Number.isSafeInteger(user.id) && typeof user.first_name === "string" &&
    (user.last_name === undefined || typeof user.last_name === "string") &&
    (user.username === undefined || typeof user.username === "string") &&
    (user.is_bot === undefined || typeof user.is_bot === "boolean");
}

function isDirectMessagesTopicShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const topic = value as Record<string, unknown>;
  return isNonNegativeSafeInteger(topic.topic_id);
}

function isPhotoShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const photo = value as Record<string, unknown>;
  return typeof photo.file_id === "string" &&
    (photo.file_unique_id === undefined || typeof photo.file_unique_id === "string") &&
    (photo.width === undefined || isNonNegativeSafeInteger(photo.width)) &&
    (photo.height === undefined || isNonNegativeSafeInteger(photo.height)) &&
    (photo.file_size === undefined || isNonNegativeSafeInteger(photo.file_size));
}

function isDocumentShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const document = value as Record<string, unknown>;
  return typeof document.file_id === "string" &&
    (document.file_unique_id === undefined ||
      typeof document.file_unique_id === "string") &&
    (document.file_name === undefined || typeof document.file_name === "string") &&
    (document.mime_type === undefined || typeof document.mime_type === "string") &&
    (document.file_size === undefined || isNonNegativeSafeInteger(document.file_size));
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function normalizeUpdate(
  update: TelegramUpdate,
  maxTextLength = 50_000,
): TelegramUpdate {
  const normalizeMessage = (
    message: TelegramMessage,
    includeReply: boolean,
  ): TelegramMessage => ({
    message_id: message.message_id,
    ...(message.message_thread_id !== undefined && {
      message_thread_id: message.message_thread_id,
    }),
    ...(message.direct_messages_topic && {
      direct_messages_topic: {
        topic_id: message.direct_messages_topic.topic_id,
      },
    }),
    ...(message.from && { from: normalizeUser(message.from) }),
    chat: {
      id: message.chat.id,
      type: message.chat.type,
      ...(message.chat.title && { title: message.chat.title.slice(0, 256) }),
      ...(message.chat.is_direct_messages !== undefined && {
        is_direct_messages: message.chat.is_direct_messages,
      }),
    },
    ...(message.text !== undefined && {
      text: message.text.slice(0, includeReply ? maxTextLength : 1000),
    }),
    ...(message.caption !== undefined && {
      caption: message.caption.slice(0, includeReply ? maxTextLength : 1000),
    }),
    ...(message.photo?.length && {
      photo: [{
        file_id: message.photo.at(-1)!.file_id,
        ...(message.photo.at(-1)!.file_unique_id && {
          file_unique_id: message.photo.at(-1)!.file_unique_id,
        }),
        ...(message.photo.at(-1)!.width !== undefined && {
          width: message.photo.at(-1)!.width,
        }),
        ...(message.photo.at(-1)!.height !== undefined && {
          height: message.photo.at(-1)!.height,
        }),
        ...(message.photo.at(-1)!.file_size !== undefined && {
          file_size: message.photo.at(-1)!.file_size,
        }),
      }],
    }),
    ...(message.document && {
      document: {
        file_id: message.document.file_id,
        ...(message.document.file_unique_id && {
          file_unique_id: message.document.file_unique_id,
        }),
        ...(message.document.file_name && {
          file_name: message.document.file_name.slice(0, 256),
        }),
        ...(message.document.mime_type && { mime_type: message.document.mime_type }),
        ...(message.document.file_size !== undefined && {
          file_size: message.document.file_size,
        }),
      },
    }),
    ...(includeReply && message.reply_to_message && {
      reply_to_message: normalizeMessage(message.reply_to_message, false),
    }),
  });

  return {
    update_id: update.update_id,
    ...(update.message && { message: normalizeMessage(update.message, true) }),
  };
}

function normalizeUser(user: TelegramUser): TelegramUser {
  return {
    id: user.id,
    first_name: user.first_name.slice(0, 256),
    ...(user.last_name && { last_name: user.last_name.slice(0, 256) }),
    ...(user.username && { username: user.username.slice(0, 64) }),
    ...(user.is_bot !== undefined && { is_bot: user.is_bot }),
  };
}

export function buildUserName(user: TelegramUser): string {
  return user.first_name + (user.last_name ? ` ${user.last_name}` : "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isCommandForBot(text: string, botUsername: string): boolean {
  const token = text.trimStart().split(/\s+/, 1)[0] ?? "";
  const match = token.match(/^\/[a-zA-Z0-9_]+(?:@([A-Za-z0-9_]+))?$/);
  if (!match) return false;
  return !match[1] || match[1].toLowerCase() === botUsername.toLowerCase();
}

export function parseCommand(text: string): string | undefined {
  const token = text.trimStart().split(/\s+/, 1)[0] ?? "";
  const match = token.match(/^(\/[a-zA-Z0-9_]+)(?:@[A-Za-z0-9_]+)?$/);
  return match?.[1]?.toLowerCase();
}

export function shouldRespond(
  chatType: string,
  text: string,
  botUsername: string,
  isReplyToBot: boolean,
): boolean {
  if (chatType === "private") return true;
  const mention = new RegExp(`@${escapeRegExp(botUsername)}\\b`, "i");
  return mention.test(text) || isCommandForBot(text, botUsername) || isReplyToBot;
}

export function stripMention(text: string, botUsername: string): string {
  return text.replace(
    new RegExp(`@${escapeRegExp(botUsername)}\\b`, "gi"),
    "",
  ).trim();
}

export function formatReplyContext(
  replyUserName: string,
  replyText: string,
  maxQuoteLength = 200,
): string {
  const normalized = replyText.replace(/\s+/g, " ").trim();
  const truncated = normalized.length > maxQuoteLength
    ? `${normalized.slice(0, maxQuoteLength)}...`
    : normalized;
  return `[Replying to ${replyUserName}: "${truncated}"]\n`;
}

export function extractImage(message: TelegramMessage | undefined):
  | { fileId: string; mimeType?: string; fileSize?: number }
  | undefined {
  const photo = message?.photo?.at(-1);
  if (photo?.file_id) {
    return { fileId: photo.file_id, mimeType: "image/jpeg", fileSize: photo.file_size };
  }
  const document = message?.document;
  if (document?.file_id && document.mime_type?.startsWith("image/")) {
    return {
      fileId: document.file_id,
      mimeType: document.mime_type,
      fileSize: document.file_size,
    };
  }
  return undefined;
}

export function normalizeSupportedImageMediaType(
  mediaType: string | undefined,
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | undefined {
  if (!mediaType) return undefined;
  const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  if (
    normalized === "image/jpeg" ||
    normalized === "image/png" ||
    normalized === "image/gif" ||
    normalized === "image/webp"
  ) {
    return normalized;
  }
  return undefined;
}

export function isSupportedImageMediaType(
  mediaType: string | undefined,
  provider?: AIProvider,
): boolean {
  const normalized = normalizeSupportedImageMediaType(mediaType);
  if (provider === "grok") {
    return normalized === "image/jpeg" || normalized === "image/png";
  }
  return normalized !== undefined;
}

export function isAllowed(
  chatType: string,
  chatId: number,
  userId: number,
  allowedUsers: ReadonlySet<string>,
  allowedGroups: ReadonlySet<string>,
  requireAllowedGroupUser: boolean,
): boolean {
  if (chatType === "private") return allowedUsers.has(String(userId));
  return allowedGroups.has(String(chatId)) &&
    (!requireAllowedGroupUser || allowedUsers.has(String(userId)));
}

export function conversationKey(
  chatId: number,
  messageThreadId?: number,
  directMessagesTopicId?: number,
): string {
  if (directMessagesTopicId !== undefined) {
    return `${chatId}:direct:${directMessagesTopicId}`;
  }
  return `${chatId}:${messageThreadId ?? "main"}`;
}

export function formatConversation(
  messages: StoredMessage[],
  maxMessages: number,
  maxChars: number,
): ConversationMessage[] {
  const selected: StoredMessage[] = [];
  let chars = 0;
  for (const message of messages.toReversed()) {
    const formatted = message.role === "user"
      ? `[${message.userName ?? "Unknown"}]: ${message.text}`
      : message.text;
    const messageChars = formatted.length + (message.reasoningContent?.length ?? 0);
    if (selected.length > 0 && chars + messageChars > maxChars) break;
    selected.push(message);
    chars += messageChars;
    if (selected.length >= maxMessages) break;
  }
  while (selected.at(-1)?.role === "assistant") selected.pop();
  return selected.toReversed().map((message) => ({
    role: message.role,
    content: message.role === "user"
      ? `[${message.userName ?? "Unknown"}]: ${message.text}`
      : message.text,
    ...(message.role === "assistant" && message.reasoningContent && {
      reasoningContent: message.reasoningContent,
    }),
  }));
}

function safeSliceUtf16(text: string, maxLength: number): string {
  let sliced = text.slice(0, maxLength);
  const final = sliced.charCodeAt(sliced.length - 1);
  if (final >= 0xd800 && final <= 0xdbff) sliced = sliced.slice(0, -1);
  return sliced;
}

export function truncateResponse(text: string, maxLength = 3900): string {
  if (text.length <= maxLength) return text;
  const suffix = "\n\n[truncated]";
  if (maxLength <= suffix.length) return safeSliceUtf16(text, maxLength);
  return safeSliceUtf16(text, maxLength - suffix.length) + suffix;
}

function escapeTelegramHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function sanitizeLanguageToken(rawLanguage: string | undefined): string | null {
  const token = rawLanguage?.trim().split(/\s+/)[0] ?? "";
  const sanitized = token.replace(/[^a-zA-Z0-9_+.#-]/g, "").toLowerCase();
  return sanitized || null;
}

interface MarkdownLink {
  end: number;
  label: string;
  url: string;
}

function parseMarkdownLink(text: string, start: number): MarkdownLink | undefined {
  if (text[start] !== "[" || isEscaped(text, start)) return undefined;

  let labelDepth = 1;
  let labelEnd = -1;
  for (let index = start + 1; index < text.length; index++) {
    const character = text[index];
    if (character === "\n" || character === "\r") return undefined;
    if (character === "\\" && index + 1 < text.length) {
      index++;
      continue;
    }
    if (character === "[") labelDepth++;
    if (character === "]" && --labelDepth === 0) {
      labelEnd = index;
      break;
    }
  }
  if (labelEnd < 0 || text[labelEnd + 1] !== "(") return undefined;

  const destinationStart = labelEnd + 2;
  let destinationEnd = -1;
  let linkEnd = -1;
  if (text[destinationStart] === "<") {
    for (let index = destinationStart + 1; index < text.length; index++) {
      const character = text[index];
      if (character === "\n" || character === "\r") return undefined;
      if (character === "\\" && index + 1 < text.length) {
        index++;
        continue;
      }
      if (character === ">" && text[index + 1] === ")") {
        destinationEnd = index;
        linkEnd = index + 2;
        break;
      }
    }
  } else {
    let parenthesisDepth = 0;
    for (let index = destinationStart; index < text.length; index++) {
      const character = text[index];
      if (character === "\n" || character === "\r") return undefined;
      if (character === "\\" && index + 1 < text.length) {
        index++;
        continue;
      }
      if (character === "(") {
        parenthesisDepth++;
        continue;
      }
      if (character !== ")") continue;
      if (parenthesisDepth > 0) {
        parenthesisDepth--;
        continue;
      }
      destinationEnd = index;
      linkEnd = index + 1;
      break;
    }
  }
  if (destinationEnd < 0) return undefined;

  const label = unescapeMarkdown(text.slice(start + 1, labelEnd));
  const rawUrl = text[destinationStart] === "<"
    ? text.slice(destinationStart + 1, destinationEnd)
    : text.slice(destinationStart, destinationEnd);
  const url = normalizeCitationUrl(unescapeMarkdown(rawUrl).trim());
  if (!label.trim() || !url) return undefined;
  return { end: linkEnd, label, url };
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  while (index - backslashes - 1 >= 0 && text[index - backslashes - 1] === "\\") {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function unescapeMarkdown(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "\\" && index + 1 < value.length) index++;
    result += value[index];
  }
  return result;
}

function renderMarkdownLinks(
  text: string,
  target: "html" | "plain",
): { text: string; formatted: boolean } {
  let result = "";
  let cursor = 0;
  let searchFrom = 0;
  let formatted = false;
  while (searchFrom < text.length) {
    const start = text.indexOf("[", searchFrom);
    if (start < 0) break;
    const link = parseMarkdownLink(text, start);
    if (!link) {
      searchFrom = start + 1;
      continue;
    }
    const prefix = text.slice(cursor, start);
    result += target === "html" ? escapeTelegramHtml(prefix) : prefix;
    result += target === "html"
      ? `<a href="${escapeTelegramHtmlAttribute(link.url)}">${
        escapeTelegramHtml(link.label)
      }</a>`
      : `${link.label} (${link.url})`;
    cursor = link.end;
    searchFrom = link.end;
    formatted = true;
  }
  if (!formatted) {
    return {
      text: target === "html" ? escapeTelegramHtml(text) : text,
      formatted: false,
    };
  }
  const suffix = text.slice(cursor);
  result += target === "html" ? escapeTelegramHtml(suffix) : suffix;
  return { text: result, formatted: true };
}

function formatInlineCode(text: string): { text: string; formatted: boolean } {
  let lastIndex = 0;
  let result = "";
  let formatted = false;
  for (const match of text.matchAll(INLINE_CODE_PATTERN)) {
    if (match.index === undefined) continue;
    formatted = true;
    result += renderMarkdownLinks(text.slice(lastIndex, match.index), "html").text;
    result += `<code>${escapeTelegramHtml(match[1] ?? "")}</code>`;
    lastIndex = match.index + match[0].length;
  }
  if (!formatted) return renderMarkdownLinks(text, "html");
  return {
    text: result + renderMarkdownLinks(text.slice(lastIndex), "html").text,
    formatted: true,
  };
}

function plainTextMarkdownLinksOutsideCode(text: string): string {
  const outsideInlineCode = (value: string): string => {
    let lastIndex = 0;
    let result = "";
    for (const match of value.matchAll(INLINE_CODE_PATTERN)) {
      if (match.index === undefined) continue;
      result += renderMarkdownLinks(value.slice(lastIndex, match.index), "plain").text;
      result += match[0];
      lastIndex = match.index + match[0].length;
    }
    return result + renderMarkdownLinks(value.slice(lastIndex), "plain").text;
  };

  let lastIndex = 0;
  let result = "";
  for (const match of text.matchAll(CODE_FENCE_PATTERN)) {
    if (match.index === undefined) continue;
    result += outsideInlineCode(text.slice(lastIndex, match.index));
    result += match[0];
    lastIndex = match.index + match[0].length;
  }
  return result + outsideInlineCode(text.slice(lastIndex));
}

export function formatTelegramResponse(text: string): TelegramFormattedMessage {
  let lastIndex = 0;
  let result = "";
  let formatted = false;
  for (const match of text.matchAll(CODE_FENCE_PATTERN)) {
    if (match.index === undefined) continue;
    formatted = true;
    result += formatInlineCode(text.slice(lastIndex, match.index)).text;
    const language = sanitizeLanguageToken(match[1]);
    const code = escapeTelegramHtml(match[2] ?? "");
    result += language
      ? `<pre><code class="language-${language}">${code}</code></pre>`
      : `<pre><code>${code}</code></pre>`;
    lastIndex = match.index + match[0].length;
  }
  if (!formatted) {
    const inline = formatInlineCode(text);
    return inline.formatted ? { text: inline.text, parseMode: "HTML" } : { text };
  }
  result += formatInlineCode(text.slice(lastIndex)).text;
  return { text: result, parseMode: "HTML" };
}

export function prepareTelegramResponse(
  text: string,
  citations: WebCitation[] = [],
  maxLength = 3_900,
): { formatted: TelegramFormattedMessage; plainText: string } {
  const normalized = citations.flatMap((citation, index) => {
    const url = normalizeCitationUrl(citation.url);
    if (!url) return [];
    return [{
      number: index + 1,
      url,
      title: citation.title?.replace(/\s+/g, " ").trim().slice(0, 256) || undefined,
    }];
  });
  if (!normalized.length) {
    const body = truncateResponse(text, maxLength);
    const plainText = truncateResponse(plainTextMarkdownLinksOutsideCode(body), maxLength);
    return { formatted: formatTelegramResponse(body), plainText };
  }

  const heading = "\n\nSources:\n";
  const minimumBodyLength = Math.min(256, maxLength);
  const maximumAppendixLength = Math.max(0, maxLength - minimumBodyLength);
  const selected: typeof normalized = [];
  let appendixLength = heading.length;
  for (const citation of normalized) {
    const line = plainCitationLine(citation);
    const addedLength = line.length + (selected.length ? 1 : 0);
    if (appendixLength + addedLength > maximumAppendixLength) continue;
    selected.push(citation);
    appendixLength += addedLength;
  }

  const bodyText = text;
  if (!selected.length) {
    const body = truncateResponse(bodyText, maxLength);
    const plainText = truncateResponse(plainTextMarkdownLinksOutsideCode(body), maxLength);
    return { formatted: formatTelegramResponse(body), plainText };
  }

  const plainAppendix = heading + selected.map(plainCitationLine).join("\n");
  const body = truncateResponse(bodyText, maxLength - plainAppendix.length);
  const plainBody = truncateResponse(
    plainTextMarkdownLinksOutsideCode(body),
    maxLength - plainAppendix.length,
  );
  const plainText = plainBody + plainAppendix;
  const formattedBody = formatTelegramResponse(body);
  const bodyHtml = formattedBody.parseMode
    ? formattedBody.text
    : escapeTelegramHtml(formattedBody.text);
  const formattedAppendix = "\n\n<b>Sources:</b>\n" + selected.map((citation) => {
    const title = citation.title ?? new URL(citation.url).hostname;
    const label = `[${citation.number}] ${title}`;
    return `<a href="${escapeTelegramHtmlAttribute(citation.url)}">${
      escapeTelegramHtml(label)
    }</a>`;
  }).join("\n");
  return {
    formatted: { text: bodyHtml + formattedAppendix, parseMode: "HTML" },
    plainText,
  };
}

function normalizeCitationUrl(value: string): string | undefined {
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

function plainCitationLine(citation: {
  number: number;
  url: string;
  title?: string;
}): string {
  return `[${citation.number}] ${
    citation.title ? `${citation.title} - ` : ""
  }${citation.url}`;
}

function escapeTelegramHtmlAttribute(text: string): string {
  return escapeTelegramHtml(text).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
