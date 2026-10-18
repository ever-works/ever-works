import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    TenantEmailAddressRepository,
    AgentEmailAssignmentRepository,
    EmailMessageRepository,
    EmailConversationRepository,
} from '@src/database';
import type {
    EmailMessage,
    EmailMessageAttachmentRecord,
} from '@src/entities/email-message.entity';
import type { EmailConversation } from '@src/entities/email-conversation.entity';
import type { TenantEmailAddress } from '@src/entities/tenant-email-address.entity';
import {
    AGENT_INBOUND_EMAIL_DISPATCHER,
    INBOUND_EMAIL_ATTACHMENT_STORE,
    INBOUND_EMAIL_TASK_SPAWNER,
    deriveThreadKey,
    type AgentInboundEmailDispatcher,
    type AgentInboundEmailDispatchPayload,
    type AgentInboundEmailDispatchResult,
    type InboundEmailAttachmentStore,
    type InboundEmailTaskSpawner,
    type InboundEmailTaskSpawnerInput,
} from './agent-inbound-email-dispatcher';

/** Address directions that receive inbound mail. */
const INBOUND_DIRECTIONS: readonly string[] = ['inbound', 'both'];

/** Most thread ids looked up per inbound message (newest first). */
const MAX_THREAD_LOOKUP_IDS = 20;

/** EW-P4-3 — most attachments stored per inbound message; the rest are listed only. */
export const MAX_INBOUND_ATTACHMENTS = 20;

/** EW-P4-3 — most decoded attachment bytes stored per inbound message. */
export const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * EW-P4-3 — most UTF-8 bytes of provider metadata kept on an inbound row.
 * Bytes, not characters: `simple-json` is a MySQL `TEXT` (65,535 bytes).
 */
export const MAX_INBOUND_METADATA_BYTES = 32_000;

/**
 * EW-P4-3 — most UTF-8 bytes of the serialized attachment list on a row. The
 * list is sender-driven (one record per attachment, refused ones included),
 * and `simple-json` is a MySQL `TEXT` (65,535 bytes).
 */
export const MAX_INBOUND_ATTACHMENT_LIST_BYTES = 48_000;

/** EW-P4-3 — most attachments listed one by one; the rest are summed in one record. */
export const MAX_LISTED_INBOUND_ATTACHMENTS = 50;

/** EW-P4-3 — most `Cc` recipients kept on an inbound row. */
export const MAX_INBOUND_CC = 100;

/** UTF-8 size of `value` serialized as JSON; `Infinity` when it cannot be. */
function jsonBytes(value: unknown): number {
    try {
        return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

/**
 * EW-P4-3 — the attachment list as stored: at most
 * {@link MAX_LISTED_INBOUND_ATTACHMENTS} records and
 * {@link MAX_INBOUND_ATTACHMENT_LIST_BYTES} serialized bytes; whatever does
 * not fit is summed in one trailing record, so the count is never lost.
 */
export function boundAttachmentRecords(
    records: EmailMessageAttachmentRecord[],
): EmailMessageAttachmentRecord[] {
    const summary = (rest: EmailMessageAttachmentRecord[]): EmailMessageAttachmentRecord => ({
        filename: `${rest.length} more attachment${rest.length === 1 ? '' : 's'}`,
        mimeType: 'application/octet-stream',
        size: rest.reduce((total, record) => total + (record.size || 0), 0),
        cid: null,
        stored: false,
        uploadId: null,
        reason: `not listed: ${rest.filter((r) => r.stored).length} of them stored`,
    });
    let kept = records.slice(0, MAX_LISTED_INBOUND_ATTACHMENTS);
    const fits = (list: EmailMessageAttachmentRecord[]): boolean =>
        jsonBytes(list) <= MAX_INBOUND_ATTACHMENT_LIST_BYTES;
    const withSummary = (list: EmailMessageAttachmentRecord[]): EmailMessageAttachmentRecord[] =>
        list.length < records.length ? [...list, summary(records.slice(list.length))] : list;
    while (kept.length > 0 && !fits(withSummary(kept))) {
        kept = kept.slice(0, kept.length - 1);
    }
    return withSummary(kept);
}

/**
 * EW-P4-3 — the provider metadata kept on an inbound row: as given when it
 * serializes small enough; else without its bulkiest part (the raw header
 * list) and marked; else only its keys. Never throws (a value that cannot be
 * serialized is dropped).
 */
export function boundInboundMetadata(
    metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const fits = (value: unknown): boolean => jsonBytes(value) <= MAX_INBOUND_METADATA_BYTES;
    if (fits(metadata)) return { ...metadata };
    const { headers: _headers, ...rest } = metadata as Record<string, unknown>;
    if (fits(rest)) return { ...rest, headersOmitted: true };
    return { truncated: true, keys: Object.keys(metadata).slice(0, 50) };
}

/** A sender-written filename made safe to list: no control characters, bounded. */
function safeFilename(name: unknown): string {
    const text = typeof name === 'string' ? name : '';
    // eslint-disable-next-line no-control-regex
    const cleaned = text
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 255);
    return cleaned || 'attachment';
}

/** A provider-given URL, bounded (it is listed, never fetched). */
function boundedUrl(url: unknown): string | null {
    return typeof url === 'string' && url ? url.slice(0, 1024) : null;
}

/** A sender-written MIME type, lower-cased and bounded (the store validates it). */
function safeMimeType(type: unknown): string {
    const text = typeof type === 'string' ? type.trim().toLowerCase().slice(0, 127) : '';
    return text || 'application/octet-stream';
}

/**
 * EW-P4-3 — the ids an inbound message threads on, most specific first:
 * `In-Reply-To`, then `References` from newest to oldest. Its own
 * `Message-ID` is never one of them (a message is not its own parent).
 */
function threadLookupIds(payload: AgentInboundEmailDispatchPayload): string[] {
    const ids: string[] = [];
    if (payload.inReplyTo) ids.push(payload.inReplyTo);
    const references = payload.references ?? [];
    for (let i = references.length - 1; i >= 0; i -= 1) ids.push(references[i]);
    const own = payload.messageIdHeader;
    return [...new Set(ids.filter((id) => typeof id === 'string' && id && id !== own))].slice(
        0,
        MAX_THREAD_LOOKUP_IDS,
    );
}

/**
 * Why `address` may not receive a webhook verified as `userId` on `pluginId`,
 * or `null` when it may.
 */
function whyNotDeliverable(
    address: TenantEmailAddress,
    userId: string,
    pluginId: string,
): string | null {
    if (address.userId !== userId) return 'owned by another user';
    if (address.pluginId !== pluginId) return `registered with ${address.pluginId}`;
    if (address.disabledAt) return 'disabled';
    if (!INBOUND_DIRECTIONS.includes(address.direction)) return `${address.direction}-only`;
    return null;
}

/**
 * Default binding for {@link AGENT_INBOUND_EMAIL_DISPATCHER} (EW-670 / T25).
 *
 * Loads the tenant address the webhook was AUTHENTICATED for
 * (`payload.recipient`) → its inbound agent assignment, persists the
 * inbound `email_messages` row, and branches on the assignment's
 * `dispatchMode`:
 *  - `task-spawn` (default): delegate Task creation + agent-task-execute
 *    enqueue to the optional {@link INBOUND_EMAIL_TASK_SPAWNER} adapter.
 *  - `conversation`: find/create the per-agent `email_conversations`
 *    thread, link the message, and bump `lastMessageAt` (the agent's
 *    chat-reply path consumes the thread).
 *
 * RFC threading (EW-P4-3): before either, the message's `In-Reply-To` /
 * `References` are matched against the SAME owner's and Agent's messages. A
 * match joins that thread: its conversation, or its Task (through the
 * spawner's optional `appendInboundEmailToTask`, falling back to a new Task
 * when that is absent or fails). The subject is only the fallback. After a
 * Task is spawned or joined, the message is linked to it (`taskId`).
 *
 * Mirrors `task-dispatcher.ts` — heavy downstream side-effects live
 * behind optional injected adapters so this stays free of the
 * tasks-domain + Trigger.dev cycle.
 */
@Injectable()
export class DefaultInboundEmailDispatcher implements AgentInboundEmailDispatcher {
    private readonly logger = new Logger(DefaultInboundEmailDispatcher.name);

    constructor(
        private readonly addresses: TenantEmailAddressRepository,
        private readonly assignments: AgentEmailAssignmentRepository,
        private readonly messages: EmailMessageRepository,
        private readonly conversations: EmailConversationRepository,
        @Optional()
        @Inject(INBOUND_EMAIL_TASK_SPAWNER)
        private readonly taskSpawner?: InboundEmailTaskSpawner,
        // EW-P4-3 — stores inbound attachments; @Optional() and appended LAST
        // so existing constructions keep working (attachments are then listed
        // on the row but not stored).
        @Optional()
        @Inject(INBOUND_EMAIL_ATTACHMENT_STORE)
        private readonly attachmentStore?: InboundEmailAttachmentStore,
    ) {}

    async dispatch(
        payload: AgentInboundEmailDispatchPayload,
    ): Promise<AgentInboundEmailDispatchResult> {
        // 1. The address the webhook was authenticated for — and no other.
        const address = await this.resolveAuthenticatedAddress(payload);
        if (!address) {
            return { handled: false, reason: 'no matching inbound address' };
        }

        // 2. Resolve the inbound assignment (lowest priority first), or the one of the
        // agent the caller authorized (review 2026-10-17 F15).
        const assignments = await this.assignments.findByEmailAddress(address.id, 'inbound');
        const assignment = payload.agentId
            ? assignments.find((candidate) => candidate.agentId === payload.agentId)
            : assignments[0];
        if (!assignment) {
            return {
                handled: false,
                reason: payload.agentId
                    ? 'the agent has no inbound assignment on this address'
                    : 'address has no inbound agent assignment',
            };
        }
        const agentId = assignment.agentId;
        const mode = assignment.dispatchMode === 'conversation' ? 'conversation' : 'task-spawn';

        // Review 2026-10-17 U2 (F113): a provider retries a webhook with the same message
        // id when its first try timed out or failed after the row was written. That
        // message is handled already: answer so (the route acknowledges, the provider
        // stops) before storing its attachments again, instead of uploading them once more
        // and failing on the unique `(pluginId, providerMessageId)` row with a 500.
        if (payload.providerMessageId) {
            const delivered = await this.messages.findByProviderMessageId(
                payload.pluginId,
                payload.providerMessageId,
            );
            if (delivered) {
                return {
                    handled: true,
                    agentId: delivered.agentId ?? agentId,
                    mode,
                    emailMessageId: delivered.id,
                    taskId: delivered.taskId ?? undefined,
                    conversationId: delivered.conversationId ?? undefined,
                    reason: 'duplicate',
                };
            }
        }

        // EW-P4-3 — attachments are stored (for the address owner, in the
        // address's scope) before the row is written, so the row lists them.
        const attachments = await this.storeAttachments(payload, address);

        if (mode === 'conversation') {
            return this.dispatchConversation(payload, address, agentId, attachments);
        }
        return this.dispatchTaskSpawn(payload, address, agentId, attachments);
    }

    /**
     * The address `payload.recipient` names, when it is still an active
     * inbound (or `both`) address of the webhook's plugin owned by the user
     * the signature was verified as. Anything else is refused (`null`).
     *
     * Security: the destination is NEVER re-derived from `payload.to`. The
     * facade verifies the webhook with the secret of ONE recipient's owner (a
     * per-user key replaces the admin one at that owner's scope), while `to`
     * is the sender's to write. Routing on `to` let a tenant sign with their
     * own key, name their own address where verification looks and a
     * victim's where routing looked, and spawn a Task for the victim's Agent.
     */
    private async resolveAuthenticatedAddress(
        payload: AgentInboundEmailDispatchPayload,
    ): Promise<TenantEmailAddress | null> {
        const recipient = payload.recipient;
        if (!recipient?.emailAddressId || !recipient.userId) return null;
        const address = await this.addresses.findById(recipient.emailAddressId);
        if (!address) return null;
        const mismatch = whyNotDeliverable(address, recipient.userId, payload.pluginId);
        if (mismatch) {
            this.logger.warn(
                `Refusing inbound ${payload.pluginId} dispatch: authenticated address ${address.id} is ${mismatch}`,
            );
            return null;
        }
        return address;
    }

    private async dispatchTaskSpawn(
        payload: AgentInboundEmailDispatchPayload,
        address: TenantEmailAddress,
        agentId: string,
        attachments: EmailMessageAttachmentRecord[] | null,
    ): Promise<AgentInboundEmailDispatchResult> {
        const userId = address.userId;
        const message = await this.persistMessage(payload, address, agentId, null, attachments);

        let taskId: string | undefined;
        if (this.taskSpawner) {
            const input: InboundEmailTaskSpawnerInput = {
                agentId,
                userId,
                emailMessageId: message.id,
                subject: payload.subject,
                bodyText: payload.bodyText,
                from: payload.from,
                // EW-P4-3 — the Task lives where the receiving address does.
                tenantId: address.tenantId ?? null,
                organizationId: address.organizationId ?? null,
                ...(attachments?.length
                    ? {
                          attachments: attachments.map((a) => ({
                              filename: a.filename,
                              mimeType: a.mimeType,
                              size: a.size,
                              stored: a.stored,
                              uploadId: a.uploadId ?? null,
                          })),
                      }
                    : {}),
            };

            // EW-P4-3 — a reply to a message already linked to a Task joins
            // that Task instead of spawning another one.
            const joined = await this.joinThreadTask(payload, userId, agentId, input);
            if (joined) {
                await this.linkTask(message.id, joined);
                return {
                    handled: true,
                    agentId,
                    mode: 'task-spawn',
                    emailMessageId: message.id,
                    taskId: joined,
                    threaded: true,
                };
            }

            const spawned = await this.taskSpawner.spawnTaskForInboundEmail(input);
            taskId = spawned?.taskId;
            if (taskId) {
                // EW-P4-3 — the message and the Task it created are linked, so
                // a later reply can thread onto the Task.
                await this.linkTask(message.id, taskId);
                await this.messages.updateDeliveryStatus(message.id, 'delivered').catch(() => {});
            }
        } else {
            this.logger.debug(
                `INBOUND_EMAIL_TASK_SPAWNER unbound; persisted inbound message ${message.id} for agent ${agentId} without spawning a task`,
            );
        }

        return { handled: true, agentId, mode: 'task-spawn', emailMessageId: message.id, taskId };
    }

    private async dispatchConversation(
        payload: AgentInboundEmailDispatchPayload,
        address: TenantEmailAddress,
        agentId: string,
        attachments: EmailMessageAttachmentRecord[] | null,
    ): Promise<AgentInboundEmailDispatchResult> {
        const userId = address.userId;
        // EW-P4-3 — the conversation of the message this one replies to, when
        // its headers name one of this Agent's messages; else the subject.
        const parent = await this.findThreadParent(
            payload,
            userId,
            agentId,
            (candidate) => !!candidate.conversationId,
        );
        let conversation: EmailConversation | null = null;
        if (parent?.conversationId) {
            const parentConversation = await this.conversations.findById(parent.conversationId);
            if (parentConversation && parentConversation.agentId === agentId) {
                conversation = parentConversation;
            }
        }
        const threaded = !!conversation;
        const threadKey = deriveThreadKey(payload.subject);
        if (!conversation) {
            conversation = await this.conversations.findByThreadKey(agentId, threadKey);
        }
        if (!conversation) {
            conversation = await this.conversations.save({
                agentId,
                threadKey,
                participants: [{ address: payload.from }],
                lastMessageAt: payload.receivedAt,
                // EW-P4-3 — a public webhook has no request scope: stamp the
                // receiving address's tenant / organization explicitly.
                tenantId: address.tenantId ?? null,
                organizationId: address.organizationId ?? null,
            } as EmailConversation);
        }

        const message = await this.persistMessage(
            payload,
            address,
            agentId,
            conversation.id,
            attachments,
        );
        await this.conversations
            .touchLastMessageAt(conversation.id, payload.receivedAt)
            .catch(() => {});

        return {
            handled: true,
            agentId,
            mode: 'conversation',
            emailMessageId: message.id,
            conversationId: conversation.id,
            ...(threaded ? { threaded: true } : {}),
        };
    }

    /**
     * EW-P4-3 — the earliest-named message of this owner AND Agent that the
     * inbound message's `In-Reply-To` / `References` point at and that
     * `accept` takes, or `null`. Owner- and Agent-scoped: the headers are the
     * sender's to write, so they can only ever pick among this Agent's own
     * mail. Never throws — threading is best-effort, the subject fallback and
     * a new Task still deliver the message.
     */
    private async findThreadParent(
        payload: AgentInboundEmailDispatchPayload,
        userId: string,
        agentId: string,
        accept: (candidate: EmailMessage) => boolean,
    ): Promise<EmailMessage | null> {
        const ids = threadLookupIds(payload);
        if (ids.length === 0) return null;
        try {
            const candidates = (await this.messages.findByMessageIdHeaders(userId, ids)).filter(
                (candidate) => candidate.agentId === agentId && accept(candidate),
            );
            for (const id of ids) {
                const match = candidates.find((candidate) => candidate.messageIdHeader === id);
                if (match) return match;
            }
        } catch (error) {
            this.logger.warn(
                `Thread lookup failed for inbound ${payload.pluginId} message; falling back to the subject — ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        return null;
    }

    /**
     * EW-P4-3 — deliver a threaded reply to its Task: the Task id when the
     * spawner took it, `null` when there is no Task to join, the adapter cannot
     * append, or appending failed (the caller then spawns a new Task, so the
     * reply is never lost).
     */
    private async joinThreadTask(
        payload: AgentInboundEmailDispatchPayload,
        userId: string,
        agentId: string,
        input: InboundEmailTaskSpawnerInput,
    ): Promise<string | null> {
        const append = this.taskSpawner?.appendInboundEmailToTask;
        if (typeof append !== 'function') return null;
        const parent = await this.findThreadParent(
            payload,
            userId,
            agentId,
            (candidate) => !!candidate.taskId,
        );
        if (!parent?.taskId) return null;
        try {
            const joined = await append.call(this.taskSpawner, { ...input, taskId: parent.taskId });
            return joined?.taskId ?? null;
        } catch (error) {
            this.logger.warn(
                `Could not append inbound message ${input.emailMessageId} to task ${parent.taskId}; spawning a new task — ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /** EW-P4-3 — best-effort `email_messages.taskId` back-link. */
    private async linkTask(messageId: string, taskId: string): Promise<void> {
        try {
            await this.messages.linkTask(messageId, taskId);
        } catch (error) {
            this.logger.warn(
                `Could not link inbound message ${messageId} to task ${taskId} — ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * EW-P4-3 — store the message's attachments through the optional store,
     * for the address owner and in the address's scope, within the
     * per-message limits. Every attachment is listed; one that was refused
     * (the store's validation, a limit, an unbound store, bad base64) says
     * why. `null` when the message has none. Never throws.
     */
    private async storeAttachments(
        payload: AgentInboundEmailDispatchPayload,
        address: TenantEmailAddress,
    ): Promise<EmailMessageAttachmentRecord[] | null> {
        const incoming = Array.isArray(payload.attachments) ? payload.attachments : [];
        if (incoming.length === 0) return null;
        const records: EmailMessageAttachmentRecord[] = [];
        let storedBytes = 0;
        for (const [index, attachment] of incoming.entries()) {
            const filename = safeFilename(attachment?.filename);
            const mimeType = safeMimeType(attachment?.mimeType);
            const cid = typeof attachment?.cid === 'string' ? attachment.cid.slice(0, 255) : null;
            let content: Buffer;
            try {
                content = Buffer.from(
                    typeof attachment?.content === 'string' ? attachment.content : '',
                    'base64',
                );
            } catch {
                content = Buffer.alloc(0);
            }
            const base = { filename, mimeType, size: content.length, cid };
            const refuse = (reason: string): void => {
                records.push({ ...base, stored: false, uploadId: null, reason });
            };
            if (content.length === 0) {
                refuse('empty');
                continue;
            }
            if (!this.attachmentStore) {
                refuse('no attachment store bound');
                continue;
            }
            if (index >= MAX_INBOUND_ATTACHMENTS) {
                refuse(`over the ${MAX_INBOUND_ATTACHMENTS}-attachment limit`);
                continue;
            }
            if (storedBytes + content.length > MAX_INBOUND_ATTACHMENT_BYTES) {
                refuse('over the per-message size limit');
                continue;
            }
            try {
                const stored = await this.attachmentStore.store({
                    userId: address.userId,
                    tenantId: address.tenantId ?? null,
                    organizationId: address.organizationId ?? null,
                    filename,
                    mimeType,
                    content,
                });
                storedBytes += content.length;
                records.push({
                    ...base,
                    stored: true,
                    uploadId: stored.uploadId,
                    url: boundedUrl(stored.url),
                });
            } catch (error) {
                refuse(describeRefusal(error));
            }
        }
        // Bounded for the column (a sender can attach hundreds of tiny files).
        return boundAttachmentRecords(records);
    }

    private async persistMessage(
        payload: AgentInboundEmailDispatchPayload,
        address: TenantEmailAddress,
        agentId: string,
        conversationId: string | null,
        attachments: EmailMessageAttachmentRecord[] | null = null,
    ): Promise<EmailMessage> {
        return this.messages.save({
            userId: address.userId,
            agentId,
            taskId: null,
            conversationId,
            emailAddressId: address.id,
            direction: 'inbound',
            pluginId: payload.pluginId,
            providerMessageId: payload.providerMessageId,
            from: payload.from,
            toAddresses: payload.to,
            // EW-P4-3 — Cc, provider metadata and attachments are kept, and the
            // row is stamped with the receiving address's tenant / organization
            // (a public webhook has no request scope to stamp it from).
            ccAddresses: payload.cc?.length ? payload.cc.slice(0, MAX_INBOUND_CC) : null,
            metadata: boundInboundMetadata(payload.metadata),
            attachments,
            tenantId: address.tenantId ?? null,
            organizationId: address.organizationId ?? null,
            subject: payload.subject,
            bodyText: payload.bodyText,
            bodyHtml: payload.bodyHtml ?? null,
            // EW-P4-3 — RFC threading ids, so a later reply can find this one.
            messageIdHeader: payload.messageIdHeader ?? null,
            inReplyTo: payload.inReplyTo ?? null,
            references: payload.references?.length ? [...payload.references] : null,
            receivedAt: payload.receivedAt,
            deliveryStatus: 'delivered',
            // AW-05 — lifecycle status; inbound mail is always `received`.
            status: 'received',
        } as Parameters<EmailMessageRepository['save']>[0]);
    }
}

/** A short, caller-safe reason an attachment store refused an attachment. */
function describeRefusal(error: unknown): string {
    const response = (error as { response?: { code?: unknown; message?: unknown } })?.response;
    const code = typeof response?.code === 'string' ? response.code : undefined;
    const message =
        typeof response?.message === 'string'
            ? response.message
            : error instanceof Error
              ? error.message
              : String(error);
    return (code ? `${code}: ${message}` : message).slice(0, 200);
}

export const DEFAULT_INBOUND_EMAIL_DISPATCHER_PROVIDER = {
    provide: AGENT_INBOUND_EMAIL_DISPATCHER,
    useClass: DefaultInboundEmailDispatcher,
};
