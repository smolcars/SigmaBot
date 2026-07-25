import { conversationKey } from "./helpers.ts";
import type {
  ImageReference,
  IssueSubmissionCheckpoint,
  JobResponse,
  StoredMessage,
  StoredUpdateJob,
  TelegramUpdate,
  TerminalJobState,
  TerminalUpdateJob,
  UpdateJob,
} from "./types.ts";

const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_TTL_MS = 2 * 60 * 1000;
const IMAGE_PROMPT_TTL_MS = 10 * 60 * 1000;
const ASSISTANT_PAYLOAD_CHUNK_CHARS = 12_000;
const MAX_ASSISTANT_PAYLOAD_BYTES = 640_000;

interface LeaseValue {
  owner: string;
  leaseUntil: number;
}

interface StoredImagePrompt {
  image: ImageReference;
  userId: number;
  expiresAt: number;
}

export interface AssistantHistoryPayload {
  content: string;
  reasoningContent?: string;
}

interface AssistantPayloadChunks {
  content: string[];
  reasoning: string[];
}

export type JobClaim =
  | { result: "claimed"; job: UpdateJob }
  | { result: "busy" }
  | { result: "deferred"; retryNotBefore: number }
  | { result: "expired" }
  | { result: "terminal"; job: TerminalUpdateJob }
  | { result: "missing" };

export class BotStore {
  constructor(readonly kv: Deno.Kv) {}

  async acceptUpdate(update: TelegramUpdate, now: number): Promise<boolean> {
    const key: Deno.KvKey = ["job", update.update_id];
    const existing = await this.kv.get<StoredUpdateJob>(key);
    if (existing.value) return false;

    const job: UpdateJob = {
      updateId: update.update_id,
      update,
      state: "pending",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    };
    const result = await this.kv.atomic()
      .check(existing)
      .set(key, job, { expireIn: JOB_TTL_MS })
      .set(
        ["conversation_pending", updateConversationKey(update), update.update_id],
        true,
        { expireIn: JOB_TTL_MS },
      )
      .commit();
    return result.ok;
  }

  async getJob(updateId: number): Promise<StoredUpdateJob | null> {
    return (await this.kv.get<StoredUpdateJob>(["job", updateId])).value;
  }

  async claimJob(
    updateId: number,
    owner: string,
    now: number,
    leaseMs: number,
  ): Promise<JobClaim> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await this.kv.get<StoredUpdateJob>(["job", updateId]);
      const job = entry.value;
      if (!job) return { result: "missing" };
      if (isTerminalJob(job)) {
        return { result: "terminal", job };
      }
      if (job.leaseOwner && job.leaseOwner !== owner && (job.leaseUntil ?? 0) > now) {
        return { result: "busy" };
      }
      if (activeJobRemaining(job, now) < leaseMs) {
        const expiredJob = terminalJob(
          job,
          "ignored",
          now,
          job.attempts,
          "expired",
        );
        let operation = this.kv.atomic().check(entry)
          .set(["job", updateId], expiredJob, { expireIn: JOB_TTL_MS })
          .delete(["conversation_pending", jobConversationKey(job), updateId]);
        for (const key of jobPayloadKeys(updateId, job.response)) {
          operation = operation.delete(key);
        }
        const expired = await operation.commit();
        if (expired.ok) return { result: "expired" };
        continue;
      }
      if (job.retryNotBefore !== undefined && job.retryNotBefore > now) {
        return { result: "deferred", retryNotBefore: job.retryNotBefore };
      }

      const claimed: UpdateJob = {
        ...job,
        updatedAt: now,
        leaseOwner: owner,
        leaseUntil: now + leaseMs,
        retryNotBefore: undefined,
      };
      const expireIn = activeJobExpireIn(claimed, now);
      const result = await this.kv.atomic().check(entry)
        .set(["job", updateId], claimed, { expireIn })
        .set(
          ["conversation_pending", jobConversationKey(claimed), updateId],
          true,
          { expireIn },
        )
        .commit();
      if (result.ok) return { result: "claimed", job: claimed };
    }
    return { result: "busy" };
  }

  async saveJobResponse(
    updateId: number,
    owner: string,
    response: NonNullable<UpdateJob["response"]>,
    now: number,
    assistantHistory?: AssistantHistoryPayload,
  ): Promise<JobResponse> {
    const requestedHistory = response.storeAssistant
      ? assistantHistory ?? { content: response.text }
      : undefined;
    const assistantChunks = requestedHistory
      ? splitAssistantPayload(requestedHistory)
      : undefined;
    const omitHistoryTurn = response.storeAssistant && assistantChunks === null;
    const readyResponse: JobResponse = {
      ...response,
      ...(omitHistoryTurn && {
        storeAssistant: false,
        omitHistoryTurn: true,
      }),
      ...(assistantChunks && {
        assistantContentChunkCount: assistantChunks.content.length,
      }),
      ...(assistantChunks && assistantChunks.reasoning.length > 0 && {
        reasoningChunkCount: assistantChunks.reasoning.length,
      }),
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await this.kv.get<StoredUpdateJob>(["job", updateId]);
      const job = entry.value;
      if (!job) throw new Error("Update job no longer exists");
      if (isTerminalJob(job)) throw new Error("Update job is already terminal");
      if (job.leaseOwner !== owner) throw new Error("Update job lease was lost");
      if (job.state !== "pending") {
        throw new Error("Only pending jobs can save a response");
      }
      const readyJob: UpdateJob = {
        ...job,
        update: compactUpdateForDelivery(job.update),
        state: "response_ready",
        issueSubmission: undefined,
        response: readyResponse,
        updatedAt: now,
        leaseUntil: Math.max(job.leaseUntil ?? 0, now + 45_000),
      };
      const expireIn = activeJobExpireIn(readyJob, now);
      let operation = this.kv.atomic().check(entry)
        .set(["job", updateId], readyJob, { expireIn })
        .set(
          ["conversation_pending", jobConversationKey(readyJob), updateId],
          true,
          { expireIn },
        );
      for (let index = 0; index < (assistantChunks?.content.length ?? 0); index++) {
        operation = operation.set(
          assistantPayloadKey(updateId, "content", index),
          assistantChunks!.content[index],
          { expireIn },
        );
      }
      for (let index = 0; index < (assistantChunks?.reasoning.length ?? 0); index++) {
        operation = operation.set(
          assistantPayloadKey(updateId, "reasoning", index),
          assistantChunks!.reasoning[index],
          { expireIn },
        );
      }
      const result = await operation.commit();
      if (result.ok) return readyResponse;
    }
    throw new Error("Could not save job response after concurrent writes");
  }

  async saveIssueSubmission(
    updateId: number,
    owner: string,
    checkpoint: IssueSubmissionCheckpoint,
    now: number,
  ): Promise<UpdateJob> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await this.kv.get<StoredUpdateJob>(["job", updateId]);
      const job = entry.value;
      if (!job) throw new Error("Update job no longer exists");
      if (isTerminalJob(job)) throw new Error("Update job is already terminal");
      if (job.leaseOwner !== owner) throw new Error("Update job lease was lost");
      if (job.state !== "pending") {
        throw new Error("Only pending jobs can save an issue submission");
      }
      if (job.issueSubmission) {
        if (issueSubmissionsEqual(job.issueSubmission, checkpoint)) return job;
        throw new Error("Update job already has an issue submission");
      }

      const updated: UpdateJob = {
        ...job,
        update: compactUpdateForDelivery(job.update),
        issueSubmission: checkpoint,
        updatedAt: now,
      };
      const expireIn = activeJobExpireIn(updated, now);
      const result = await this.kv.atomic().check(entry)
        .set(["job", updateId], updated, { expireIn })
        .set(
          ["conversation_pending", jobConversationKey(updated), updateId],
          true,
          { expireIn },
        )
        .commit();
      if (result.ok) return updated;
    }
    throw new Error("Could not save issue submission after concurrent writes");
  }

  async readJobAssistantHistory(
    updateId: number,
    response: JobResponse,
  ): Promise<AssistantHistoryPayload | undefined> {
    if (!response.storeAssistant) return undefined;
    if (response.assistantContentChunkCount === undefined) {
      const legacyReasoning = await this.readPayloadChunks(
        response.reasoningChunkCount ?? 0,
        (index) => legacyJobReasoningKey(updateId, index),
        "Assistant reasoning",
      );
      return {
        content: response.text,
        ...(legacyReasoning.length > 0 && {
          reasoningContent: legacyReasoning.join(""),
        }),
      };
    }
    const content = await this.readPayloadChunks(
      response.assistantContentChunkCount ?? 0,
      (index) => assistantPayloadKey(updateId, "content", index),
      "Assistant content",
    );
    const reasoning = await this.readPayloadChunks(
      response.reasoningChunkCount ?? 0,
      (index) => assistantPayloadKey(updateId, "reasoning", index),
      "Assistant reasoning",
    );
    return {
      content: content.join(""),
      ...(reasoning.length > 0 && { reasoningContent: reasoning.join("") }),
    };
  }

  async completeDeliveredJob(
    updateId: number,
    owner: string,
    now: number,
    state: "done" | "failed",
    assistantMessage?: StoredMessage,
    maxRetained = 100,
    deliveredMessageId?: number,
    assistantHistory?: AssistantHistoryPayload,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await this.kv.get<StoredUpdateJob>(["job", updateId]);
      const job = entry.value;
      if (!job) return;
      if (job.leaseOwner !== owner || job.state !== "response_ready") {
        throw new Error("Update job lease or state was lost");
      }
      const response = job.response;
      if (!response) throw new Error("Response-ready job is missing response data");
      let assistantChunks: AssistantPayloadChunks | undefined;
      if (response.storeAssistant) {
        const legacyPayload = response.assistantContentChunkCount === undefined;
        const resolvedHistory = assistantHistory ??
          await this.readJobAssistantHistory(updateId, response);
        if (!assistantMessage || !resolvedHistory) {
          throw new Error("Assistant history requires its delivered message and payload");
        }
        assistantChunks = splitAssistantPayload(resolvedHistory) ?? undefined;
        if (
          !assistantChunks ||
          (!legacyPayload &&
            (assistantChunks.content.length !== response.assistantContentChunkCount ||
              assistantChunks.reasoning.length !== (response.reasoningChunkCount ?? 0)))
        ) {
          throw new Error("Assistant history payload does not match its checkpoint");
        }
      }
      const completed = terminalJob(job, state, now);
      let operation = this.kv.atomic().check(entry)
        .set(["job", updateId], completed, { expireIn: JOB_TTL_MS })
        .delete(["conversation_pending", jobConversationKey(job), updateId]);
      if (assistantMessage && assistantChunks) {
        const storedAssistant: StoredMessage = {
          ...assistantMessage,
          assistantContentChunkCount: assistantChunks.content.length,
          ...(assistantChunks.reasoning.length > 0 && {
            reasoningChunkCount: assistantChunks.reasoning.length,
          }),
        };
        operation = operation.set(
          [
            "message",
            conversationKey(
              storedAssistant.chatId,
              storedAssistant.messageThreadId,
              storedAssistant.directMessagesTopicId,
            ),
            storedAssistant.epoch,
            storedAssistant.updateId,
            storedAssistant.order,
          ],
          storedAssistant,
        );
        for (let index = 0; index < assistantChunks.content.length; index++) {
          operation = operation.set(
            assistantPayloadKey(updateId, "content", index),
            assistantChunks.content[index],
          );
        }
        for (let index = 0; index < assistantChunks.reasoning.length; index++) {
          operation = operation.set(
            assistantPayloadKey(updateId, "reasoning", index),
            assistantChunks.reasoning[index],
          );
        }
      }
      if (response.assistantContentChunkCount === undefined) {
        for (let index = 0; index < (response.reasoningChunkCount ?? 0); index++) {
          operation = operation.delete(legacyJobReasoningKey(updateId, index));
        }
      }
      if (response.omitHistoryTurn) {
        operation = operation.delete([
          "message",
          conversationKey(
            response.chatId,
            response.messageThreadId,
            response.directMessagesTopicId,
          ),
          response.epoch,
          updateId,
          0,
        ]);
      }
      if (response.imagePrompt) {
        if (
          typeof deliveredMessageId !== "number" ||
          !Number.isSafeInteger(deliveredMessageId) || deliveredMessageId < 0
        ) {
          throw new Error("Delivered image prompt is missing its Telegram message ID");
        }
        const expiresAt = now + IMAGE_PROMPT_TTL_MS;
        operation = operation.set(
          [
            "image_prompt",
            conversationKey(
              response.chatId,
              response.messageThreadId,
              response.directMessagesTopicId,
            ),
            response.epoch,
            deliveredMessageId,
          ],
          {
            image: response.imagePrompt.image,
            userId: response.imagePrompt.userId,
            expiresAt,
          } satisfies StoredImagePrompt,
          { expireIn: IMAGE_PROMPT_TTL_MS },
        );
      }
      const result = await operation.commit();
      if (result.ok) {
        if (assistantMessage) {
          await this.pruneConversation(
            conversationKey(
              assistantMessage.chatId,
              assistantMessage.messageThreadId,
              assistantMessage.directMessagesTopicId,
            ),
            assistantMessage.epoch,
            maxRetained,
          );
        }
        return;
      }
    }
    throw new Error("Could not record delivered response after concurrent writes");
  }

  async finishJob(
    updateId: number,
    owner: string,
    state: "done" | "ignored" | "failed",
    now: number,
    errorCode?: string,
    incrementAttempts = false,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await this.kv.get<StoredUpdateJob>(["job", updateId]);
      const job = entry.value;
      if (!job) return;
      if (isTerminalJob(job)) {
        throw new Error("Update job is already terminal");
      }
      if (job.leaseOwner !== owner) throw new Error("Update job lease was lost");
      const completed = terminalJob(
        job,
        state,
        now,
        job.attempts + (incrementAttempts ? 1 : 0),
        errorCode ?? job.errorCode,
      );
      let operation = this.kv.atomic().check(entry)
        .set(["job", updateId], completed, { expireIn: JOB_TTL_MS })
        .delete(["conversation_pending", jobConversationKey(job), updateId]);
      for (const key of jobPayloadKeys(updateId, job.response)) {
        operation = operation.delete(key);
      }
      const result = await operation.commit();
      if (result.ok) return;
    }
    throw new Error("Could not finish update job after concurrent writes");
  }

  async releaseJob(
    updateId: number,
    owner: string,
    now: number,
    errorCode?: string,
  ): Promise<void> {
    await this.mutateOwnedJob(updateId, owner, (job) => ({
      ...job,
      updatedAt: now,
      leaseOwner: undefined,
      leaseUntil: undefined,
      ...(errorCode ? { errorCode } : {}),
    }));
  }

  async releaseJobAfterFailure(
    updateId: number,
    owner: string,
    now: number,
    errorCode: string,
  ): Promise<void> {
    await this.mutateOwnedJob(updateId, owner, (job) => ({
      ...job,
      attempts: job.attempts + 1,
      updatedAt: now,
      leaseOwner: undefined,
      leaseUntil: undefined,
      errorCode,
    }));
  }

  async deferJob(
    updateId: number,
    owner: string,
    now: number,
    retryNotBefore: number,
    errorCode: string,
  ): Promise<void> {
    await this.mutateOwnedJob(updateId, owner, (job) => ({
      ...job,
      updatedAt: now,
      leaseOwner: undefined,
      leaseUntil: undefined,
      retryNotBefore,
      errorCode,
    }));
  }

  async renewJobLease(
    updateId: number,
    owner: string,
    now: number,
    leaseMs: number,
  ): Promise<void> {
    await this.mutateOwnedJob(updateId, owner, (job) => ({
      ...job,
      updatedAt: now,
      leaseUntil: Math.max(job.leaseUntil ?? 0, now + leaseMs),
    }));
  }

  async isConversationHead(key: string, updateId: number): Promise<boolean> {
    const headUpdateId = await this.getConversationHeadUpdateId(key);
    return headUpdateId === null || headUpdateId === updateId;
  }

  async getConversationHeadUpdateId(key: string): Promise<number | null> {
    for (let attempt = 0; attempt < 16; attempt++) {
      let head: Deno.KvEntry<boolean> | undefined;
      for await (
        const entry of this.kv.list<boolean>(
          { prefix: ["conversation_pending", key] },
          { limit: 1 },
        )
      ) {
        head = entry;
      }
      if (!head) return null;

      const updateId = head.key[2];
      const job = typeof updateId === "number" && Number.isSafeInteger(updateId)
        ? (await this.kv.get<StoredUpdateJob>(["job", updateId])).value
        : null;
      if (job && !isTerminalJob(job) && jobConversationKey(job) === key) {
        return updateId as number;
      }

      const cleaned = await this.kv.atomic().check(head).delete(head.key).commit();
      if (!cleaned.ok) continue;
    }
    throw new Error("Could not resolve conversation queue head");
  }

  async acquireConversationLease(
    key: string,
    owner: string,
    now: number,
    leaseMs: number,
  ): Promise<boolean> {
    const kvKey: Deno.KvKey = ["conversation_lease", key];
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await this.kv.get<LeaseValue>(kvKey);
      if (entry.value && entry.value.owner !== owner && entry.value.leaseUntil > now) {
        return false;
      }
      const leaseUntil = entry.value?.owner === owner
        ? Math.max(entry.value.leaseUntil, now + leaseMs)
        : now + leaseMs;
      const result = await this.kv.atomic().check(entry).set(
        kvKey,
        { owner, leaseUntil } satisfies LeaseValue,
        { expireIn: Math.max(1, leaseUntil - now) },
      ).commit();
      if (result.ok) return true;
    }
    return false;
  }

  async releaseConversationLease(key: string, owner: string): Promise<void> {
    const kvKey: Deno.KvKey = ["conversation_lease", key];
    const entry = await this.kv.get<LeaseValue>(kvKey);
    if (entry.value?.owner !== owner) return;
    await this.kv.atomic().check(entry).delete(kvKey).commit();
  }

  async getConversationEpoch(
    chatId: number,
    messageThreadId?: number,
    directMessagesTopicId?: number,
  ): Promise<number> {
    const key = conversationKey(chatId, messageThreadId, directMessagesTopicId);
    return (await this.kv.get<number>(["conversation_epoch", key])).value ?? 0;
  }

  async isCurrentEpoch(
    chatId: number,
    messageThreadId: number | undefined,
    epoch: number,
    directMessagesTopicId?: number,
  ): Promise<boolean> {
    return await this.getConversationEpoch(
      chatId,
      messageThreadId,
      directMessagesTopicId,
    ) === epoch;
  }

  async resetConversation(
    chatId: number,
    messageThreadId?: number,
    directMessagesTopicId?: number,
  ): Promise<number> {
    const key = conversationKey(chatId, messageThreadId, directMessagesTopicId);
    const epochKey: Deno.KvKey = ["conversation_epoch", key];
    let nextEpoch = 1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await this.kv.get<number>(epochKey);
      nextEpoch = (entry.value ?? 0) + 1;
      const result = await this.kv.atomic().check(entry).set(epochKey, nextEpoch).commit();
      if (result.ok) break;
      if (attempt === 7) throw new Error("Could not reset conversation");
    }

    await this.deleteConversationHistoryBeforeEpoch(
      chatId,
      messageThreadId,
      nextEpoch,
      directMessagesTopicId,
    );
    return nextEpoch;
  }

  async prepareResetJob(
    updateId: number,
    owner: string,
    chatId: number,
    messageThreadId: number | undefined,
    response: Omit<JobResponse, "epoch">,
    now: number,
    directMessagesTopicId?: number,
  ): Promise<JobResponse> {
    const key = conversationKey(chatId, messageThreadId, directMessagesTopicId);
    const epochKey: Deno.KvKey = ["conversation_epoch", key];
    for (let attempt = 0; attempt < 8; attempt++) {
      const [jobEntry, epochEntry] = await this.kv.getMany<[
        StoredUpdateJob,
        number,
      ]>([["job", updateId], epochKey]);
      const job = jobEntry.value;
      if (!job || job.leaseOwner !== owner || job.state !== "pending") {
        throw new Error("Reset job lease or state was lost");
      }
      const nextEpoch = (epochEntry.value ?? 0) + 1;
      const readyResponse: JobResponse = {
        ...response,
        epoch: nextEpoch,
        resetHistoryBeforeEpoch: nextEpoch,
      };
      const readyJob: UpdateJob = {
        ...job,
        update: compactUpdateForDelivery(job.update),
        state: "response_ready",
        issueSubmission: undefined,
        response: readyResponse,
        updatedAt: now,
        leaseUntil: Math.max(job.leaseUntil ?? 0, now + 45_000),
      };
      const expireIn = activeJobExpireIn(readyJob, now);
      const result = await this.kv.atomic().check(jobEntry).check(epochEntry)
        .set(epochKey, nextEpoch)
        .set(["job", updateId], readyJob, { expireIn })
        .set(
          ["conversation_pending", jobConversationKey(readyJob), updateId],
          true,
          { expireIn },
        )
        .commit();
      if (!result.ok) continue;

      return readyResponse;
    }
    throw new Error("Could not prepare reset after concurrent writes");
  }

  async storeMessage(message: StoredMessage, maxRetained: number): Promise<void> {
    const key = conversationKey(
      message.chatId,
      message.messageThreadId,
      message.directMessagesTopicId,
    );
    const kvKey: Deno.KvKey = [
      "message",
      key,
      message.epoch,
      message.updateId,
      message.order,
    ];
    const existing = await this.kv.get<StoredMessage>(kvKey);
    if (!existing.value) {
      await this.kv.atomic().check(existing).set(kvKey, message).commit();
    }
    await this.pruneConversation(key, message.epoch, maxRetained);
  }

  async deleteConversationHistoryBeforeEpoch(
    chatId: number,
    messageThreadId: number | undefined,
    beforeEpoch: number,
    directMessagesTopicId?: number,
  ): Promise<void> {
    const key = conversationKey(chatId, messageThreadId, directMessagesTopicId);
    const messages: Deno.KvEntry<StoredMessage>[] = [];
    for await (const entry of this.kv.list<StoredMessage>({ prefix: ["message", key] })) {
      const epoch = entry.key[2];
      if (typeof epoch === "number" && epoch < beforeEpoch) {
        messages.push(entry);
      }
    }
    await this.deleteStoredMessages(messages);
  }

  async getRecentMessages(
    chatId: number,
    messageThreadId: number | undefined,
    epoch: number,
    throughUpdateId: number,
    limit: number,
    directMessagesTopicId?: number,
  ): Promise<StoredMessage[]> {
    const key = conversationKey(chatId, messageThreadId, directMessagesTopicId);
    const messages: StoredMessage[] = [];
    for await (
      const entry of this.kv.list<StoredMessage>({ prefix: ["message", key, epoch] })
    ) {
      if (entry.value.updateId <= throughUpdateId) messages.push(entry.value);
    }
    messages.sort((left, right) =>
      left.updateId - right.updateId || left.order - right.order
    );
    const selected = messages.slice(-limit);
    return await Promise.all(selected.map(async (message) => {
      const assistantContentChunkCount = message.assistantContentChunkCount ?? 0;
      const reasoningChunkCount = message.reasoningChunkCount ?? 0;
      if (message.assistantContentChunkCount === undefined) {
        if (reasoningChunkCount === 0) return message;
        const legacyReasoning = await this.readPayloadChunks(
          reasoningChunkCount,
          (index) => legacyMessageReasoningKey(message, index),
          "Assistant reasoning",
        );
        return { ...message, reasoningContent: legacyReasoning.join("") };
      }
      if (assistantContentChunkCount === 0 && reasoningChunkCount === 0) return message;
      const content = await this.readPayloadChunks(
        assistantContentChunkCount,
        (index) => assistantPayloadKey(message.updateId, "content", index),
        "Assistant content",
      );
      const reasoning = await this.readPayloadChunks(
        reasoningChunkCount,
        (index) => assistantPayloadKey(message.updateId, "reasoning", index),
        "Assistant reasoning",
      );
      return {
        ...message,
        ...(assistantContentChunkCount > 0 && { text: content.join("") }),
        ...(reasoningChunkCount > 0 && { reasoningContent: reasoning.join("") }),
      };
    }));
  }

  async getImageForPrompt(
    chatId: number,
    messageThreadId: number | undefined,
    epoch: number,
    promptMessageId: number,
    userId: number,
    now: number,
    directMessagesTopicId?: number,
  ): Promise<ImageReference | null> {
    const entry = await this.kv.get<StoredImagePrompt>([
      "image_prompt",
      conversationKey(chatId, messageThreadId, directMessagesTopicId),
      epoch,
      promptMessageId,
    ]);
    const prompt = entry.value;
    if (!prompt || prompt.userId !== userId || prompt.expiresAt <= now) return null;
    return prompt.image;
  }

  async takeRateLimit(
    updateId: number,
    chatId: number,
    userId: number,
    now: number,
    maxPerMinute: number,
  ): Promise<boolean> {
    const claimKey: Deno.KvKey = ["rate_claim", updateId];
    const priorClaim = await this.kv.get<boolean>(claimKey);
    if (priorClaim.value !== null) return priorClaim.value;

    const window = Math.floor(now / 60_000);
    const key: Deno.KvKey = ["rate", String(chatId), String(userId), window];
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await this.kv.get<number>(key);
      const count = entry.value ?? 0;
      if (count >= maxPerMinute) {
        const denied = await this.kv.atomic().check(priorClaim)
          .set(claimKey, false, { expireIn: JOB_TTL_MS }).commit();
        if (denied.ok) return false;
        const current = await this.kv.get<boolean>(claimKey);
        if (current.value !== null) return current.value;
        continue;
      }
      const result = await this.kv.atomic().check(entry).check(priorClaim)
        .set(key, count + 1, { expireIn: RATE_TTL_MS })
        .set(claimKey, true, { expireIn: JOB_TTL_MS })
        .commit();
      if (result.ok) return true;
      const current = await this.kv.get<boolean>(claimKey);
      if (current.value !== null) return current.value;
    }
    return false;
  }

  private async mutateOwnedJob(
    updateId: number,
    owner: string,
    mutate: (job: UpdateJob) => UpdateJob,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await this.kv.get<StoredUpdateJob>(["job", updateId]);
      const job = entry.value;
      if (!job) throw new Error("Update job no longer exists");
      if (isTerminalJob(job)) {
        throw new Error("Update job is already terminal");
      }
      if (job.leaseOwner !== owner) throw new Error("Update job lease was lost");
      const updated = mutate(job);
      const expireIn = activeJobExpireIn(updated, updated.updatedAt);
      const result = await this.kv.atomic().check(entry)
        .set(["job", updateId], updated, { expireIn })
        .set(
          ["conversation_pending", jobConversationKey(updated), updateId],
          true,
          { expireIn },
        )
        .commit();
      if (result.ok) return;
    }
    throw new Error("Could not update job after concurrent writes");
  }

  private async readPayloadChunks(
    count: number,
    keyForIndex: (index: number) => Deno.KvKey,
    label: string,
  ): Promise<string[]> {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Invalid ${label.toLowerCase()} chunk count`);
    }
    const entries = await Promise.all(
      Array.from({ length: count }, (_, index) => this.kv.get<string>(keyForIndex(index))),
    );
    return entries.map((entry) => {
      if (typeof entry.value !== "string") {
        throw new Error(`${label} is incomplete`);
      }
      return entry.value;
    });
  }

  private async pruneConversation(
    key: string,
    epoch: number,
    maxRetained: number,
  ): Promise<void> {
    const stale: Deno.KvEntry<StoredMessage>[] = [];
    let kept = 0;
    for await (
      const entry of this.kv.list<StoredMessage>(
        { prefix: ["message", key, epoch] },
        { reverse: true },
      )
    ) {
      if (kept++ >= maxRetained) {
        stale.push(entry);
      }
    }
    await this.deleteStoredMessages(stale);
  }

  private async deleteStoredMessages(
    messages: Deno.KvEntry<StoredMessage>[],
  ): Promise<void> {
    for (const message of messages) {
      let operation = this.kv.atomic();
      operation = operation.delete(message.key);
      for (const key of messagePayloadKeys(message.value)) {
        operation = operation.delete(key);
      }
      await operation.commit();
    }
  }
}

function splitAssistantPayload(
  payload: AssistantHistoryPayload,
): AssistantPayloadChunks | null {
  const encoder = new TextEncoder();
  const byteLength = encoder.encode(payload.content).byteLength +
    encoder.encode(payload.reasoningContent ?? "").byteLength;
  if (byteLength > MAX_ASSISTANT_PAYLOAD_BYTES) return null;
  return {
    content: splitPayloadText(payload.content),
    reasoning: splitPayloadText(payload.reasoningContent ?? ""),
  };
}

function splitPayloadText(value: string): string[] {
  if (!value) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + ASSISTANT_PAYLOAD_CHUNK_CHARS);
    const finalCodeUnit = value.charCodeAt(end - 1);
    if (
      end < value.length &&
      finalCodeUnit >= 0xd800 &&
      finalCodeUnit <= 0xdbff
    ) {
      end--;
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

function assistantPayloadKey(
  updateId: number,
  kind: "content" | "reasoning",
  index: number,
): Deno.KvKey {
  return ["assistant_payload", updateId, kind, index];
}

function assistantPayloadKeys(
  updateId: number,
  manifest:
    | Pick<
      JobResponse | StoredMessage,
      "assistantContentChunkCount" | "reasoningChunkCount"
    >
    | undefined,
): Deno.KvKey[] {
  if (!manifest) return [];
  return [
    ...Array.from(
      { length: manifest.assistantContentChunkCount ?? 0 },
      (_, index) => assistantPayloadKey(updateId, "content", index),
    ),
    ...Array.from(
      { length: manifest.reasoningChunkCount ?? 0 },
      (_, index) => assistantPayloadKey(updateId, "reasoning", index),
    ),
  ];
}

function jobPayloadKeys(
  updateId: number,
  response: JobResponse | undefined,
): Deno.KvKey[] {
  if (!response) return [];
  if (response.assistantContentChunkCount === undefined) {
    return Array.from(
      { length: response.reasoningChunkCount ?? 0 },
      (_, index) => legacyJobReasoningKey(updateId, index),
    );
  }
  return assistantPayloadKeys(updateId, response);
}

function messagePayloadKeys(message: StoredMessage): Deno.KvKey[] {
  if (message.assistantContentChunkCount === undefined) {
    return Array.from(
      { length: message.reasoningChunkCount ?? 0 },
      (_, index) => legacyMessageReasoningKey(message, index),
    );
  }
  return assistantPayloadKeys(message.updateId, message);
}

function legacyJobReasoningKey(updateId: number, index: number): Deno.KvKey {
  return ["job_reasoning", updateId, index];
}

function legacyMessageReasoningKey(
  message: StoredMessage,
  index: number,
): Deno.KvKey {
  return [
    "message_reasoning",
    conversationKey(
      message.chatId,
      message.messageThreadId,
      message.directMessagesTopicId,
    ),
    message.epoch,
    message.updateId,
    message.order,
    index,
  ];
}

function activeJobRemaining(job: UpdateJob, now: number): number {
  return job.createdAt + JOB_TTL_MS - now;
}

function activeJobExpireIn(job: UpdateJob, now: number): number {
  return Math.max(1, activeJobRemaining(job, now));
}

function updateConversationKey(update: TelegramUpdate): string {
  const message = update.message;
  return message
    ? conversationKey(
      message.chat.id,
      message.message_thread_id,
      message.direct_messages_topic?.topic_id,
    )
    : `update:${update.update_id}`;
}

function jobConversationKey(job: UpdateJob): string {
  return updateConversationKey(job.update);
}

function isTerminalJob(job: StoredUpdateJob): job is TerminalUpdateJob {
  return job.state === "done" || job.state === "ignored" || job.state === "failed";
}

function compactUpdateForDelivery(update: TelegramUpdate): TelegramUpdate {
  const message = update.message;
  if (!message) return { update_id: update.update_id };
  return {
    update_id: update.update_id,
    message: {
      message_id: message.message_id,
      ...(message.message_thread_id !== undefined && {
        message_thread_id: message.message_thread_id,
      }),
      ...(message.direct_messages_topic && {
        direct_messages_topic: message.direct_messages_topic,
      }),
      ...(message.from && {
        from: { id: message.from.id, first_name: "" },
      }),
      chat: {
        id: message.chat.id,
        type: message.chat.type,
        ...(message.chat.is_direct_messages !== undefined && {
          is_direct_messages: message.chat.is_direct_messages,
        }),
      },
    },
  };
}

function terminalJob(
  job: UpdateJob,
  state: TerminalJobState,
  updatedAt: number,
  attempts = job.attempts,
  errorCode = job.errorCode,
): TerminalUpdateJob {
  return {
    updateId: job.updateId,
    state,
    createdAt: job.createdAt,
    updatedAt,
    attempts,
    ...(errorCode !== undefined && { errorCode }),
  };
}

function issueSubmissionsEqual(
  left: IssueSubmissionCheckpoint,
  right: IssueSubmissionCheckpoint,
): boolean {
  return left.alias === right.alias &&
    left.repository === right.repository &&
    left.title === right.title &&
    left.body === right.body &&
    left.marker === right.marker &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens;
}
