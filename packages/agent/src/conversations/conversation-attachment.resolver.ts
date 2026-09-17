import { Injectable, Logger } from '@nestjs/common';
import type { OwnershipScope } from '../database/ownership-scope';
import {
    UserUploadRepository,
    uploadServeUrl,
} from '../database/repositories/user-upload.repository';
import type { UserUpload } from '../entities/user-upload.entity';
import type { ConversationAttachmentRef, ConversationAttachmentView } from './conversation.types';

/** The fields of a message this resolver reads and fills in. */
export interface MessageWithAttachments {
    authorType?: string | null;
    authorId?: string | null;
    attachments?: ConversationAttachmentRef[] | null;
}

/**
 * Turns the upload references a person's message stores into attachments a
 * Conversation can show and reopen: the file's name, its type and the
 * owner-gated URL that opens it.
 *
 * A message stores only `{ uploadId }` — names and URLs are resolved from the
 * upload each time the message is read, never copied onto the message, so a
 * file that is no longer readable in the workspace reads back with `null`
 * details instead of a stale link. Uploads are looked up for the person who
 * attached them (the message's author) inside the request's scope, one query
 * per author.
 */
@Injectable()
export class ConversationAttachmentResolver {
    private readonly logger = new Logger(ConversationAttachmentResolver.name);

    constructor(private readonly uploads: UserUploadRepository) {}

    /**
     * `messages`, with the attachments of every person-authored message
     * described. Messages without attachments come back as the same objects;
     * the rest as copies. Reading a Conversation never fails because upload
     * details could not be read — those messages keep their bare references.
     */
    async describe<T extends MessageWithAttachments>(
        messages: readonly T[],
        scope?: OwnershipScope,
    ): Promise<T[]> {
        const byAuthor = new Map<string, Set<string>>();
        for (const message of messages) {
            const author = attachingAuthor(message);
            if (!author) continue;
            const ids = byAuthor.get(author) ?? new Set<string>();
            for (const ref of message.attachments ?? []) ids.add(ref.uploadId.toLowerCase());
            byAuthor.set(author, ids);
        }
        if (byAuthor.size === 0) return [...messages];

        const found = new Map<string, Map<string, UserUpload>>();
        try {
            await Promise.all(
                [...byAuthor.entries()].map(async ([author, ids]) => {
                    const rows = await this.uploads.findOwnedBySha256s([...ids], author, scope);
                    const bySha = new Map<string, UserUpload>();
                    for (const row of rows) {
                        if (!bySha.has(row.sha256)) bySha.set(row.sha256, row);
                    }
                    found.set(author, bySha);
                }),
            );
        } catch (err) {
            this.logger.warn(
                `Attachment details could not be read: ${err instanceof Error ? err.message : String(err)}`,
            );
            return [...messages];
        }

        return messages.map((message) => {
            const author = attachingAuthor(message);
            if (!author) return message;
            const uploads = found.get(author) ?? new Map<string, UserUpload>();
            const attachments = (message.attachments ?? []).map(
                (ref): ConversationAttachmentView =>
                    describeAttachment(author, ref, uploads.get(ref.uploadId.toLowerCase())),
            );
            return { ...message, attachments };
        });
    }
}

/** The person whose uploads a message's attachments are, when it has any. */
function attachingAuthor(message: MessageWithAttachments): string | null {
    if (message.authorType !== 'user' || !message.authorId) return null;
    return message.attachments && message.attachments.length > 0 ? message.authorId : null;
}

function describeAttachment(
    author: string,
    ref: ConversationAttachmentRef,
    upload: UserUpload | undefined,
): ConversationAttachmentView {
    if (!upload) return { uploadId: ref.uploadId, filename: null, mimeType: null, url: null };
    return {
        uploadId: ref.uploadId,
        filename: upload.originalFilename ?? null,
        mimeType: upload.mimeType ?? null,
        url: uploadServeUrl(author, upload),
    };
}
