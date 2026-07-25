export type AIProvider = "claude" | "openai" | "moonshot" | "grok";

export type ImageSupportMode = boolean | "auto";

export interface ImageReference {
  fileId: string;
  mimeType?: string;
  fileSize?: number;
}

export interface ImagePromptReference {
  image: ImageReference;
  userId: number;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string };

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string | ContentPart[];
  reasoningContent?: string;
}

export interface AIResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningContent?: string;
  webSearchQueries?: string[];
  webSearchCount?: number;
  webCitations?: WebCitation[];
}

export interface WebCitation {
  url: string;
  title?: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel" | string;
  title?: string;
  is_direct_messages?: boolean;
}

export interface TelegramDirectMessagesTopic {
  topic_id: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  direct_messages_topic?: TelegramDirectMessagesTopic;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  reply_to_message?: TelegramMessage;
}

export interface TelegramSentMessage {
  message_id: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface StoredMessage {
  updateId: number;
  order: 0 | 1;
  chatId: number;
  messageThreadId?: number;
  directMessagesTopicId?: number;
  epoch: number;
  role: "user" | "assistant";
  text: string;
  userId?: number;
  userName?: string;
  telegramMessageId?: number;
  image?: ImageReference;
  assistantContentChunkCount?: number;
  reasoningChunkCount?: number;
  reasoningContent?: string;
  createdAt: number;
}

export interface JobResponse {
  chatId: number;
  messageId: number;
  messageThreadId?: number;
  directMessagesTopicId?: number;
  epoch: number;
  text: string;
  storeAssistant: boolean;
  finishState?: "done" | "failed";
  inputTokens?: number;
  outputTokens?: number;
  formatted?: TelegramFormattedMessage;
  webSearchCount?: number;
  assistantContentChunkCount?: number;
  reasoningChunkCount?: number;
  omitHistoryTurn?: boolean;
  resetHistoryBeforeEpoch?: number;
  imagePrompt?: ImagePromptReference;
}

export interface IssueSubmissionCheckpoint {
  alias: string;
  repository: string;
  title: string;
  body: string;
  marker: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type ActiveJobState = "pending" | "response_ready";
export type TerminalJobState = "done" | "ignored" | "failed";
export type JobState = ActiveJobState | TerminalJobState;

interface UpdateJobMetadata {
  updateId: number;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  errorCode?: string;
}

export interface UpdateJob extends UpdateJobMetadata {
  update: TelegramUpdate;
  state: ActiveJobState;
  leaseOwner?: string;
  leaseUntil?: number;
  retryNotBefore?: number;
  issueSubmission?: IssueSubmissionCheckpoint;
  response?: JobResponse;
}

export interface TerminalUpdateJob extends UpdateJobMetadata {
  state: TerminalJobState;
  update?: never;
  leaseOwner?: never;
  leaseUntil?: never;
  retryNotBefore?: never;
  issueSubmission?: never;
  response?: never;
}

export type StoredUpdateJob = UpdateJob | TerminalUpdateJob;

export interface TelegramFormattedMessage {
  text: string;
  parseMode?: "HTML";
}
