import { Injectable, Logger } from '@nestjs/common';
import { UserUploadRepository } from '@ever-works/agent/database';
import type { SkillFileContentReadInput, SkillFileContentReader } from '@ever-works/agent/agents';
import { MAX_SKILL_FILE_BYTES } from '@ever-works/agent/skills';
import { UploadsService } from '../uploads/uploads.service';

/**
 * Skill files feature — API-side implementation of the agent package's
 * `SKILL_FILE_CONTENT_READER` port. The agent package owns the
 * `getSkillFile` tool but cannot reach the storage backend (it lives
 * behind `UploadsService` here); this adapter resolves the upload row
 * the user OWNS (`user_uploads` by sha256), fetches the bytes through
 * the active storage plugin, and returns UTF-8 text.
 *
 * Errors are returned as `{ error }` values, not thrown — the tool
 * loop feeds them back to the model as structured refusals.
 */
@Injectable()
export class SkillFileContentReaderService implements SkillFileContentReader {
    private readonly logger = new Logger(SkillFileContentReaderService.name);

    constructor(
        private readonly uploads: UploadsService,
        private readonly userUploads: UserUploadRepository,
    ) {}

    async readTextContent(
        input: SkillFileContentReadInput,
    ): Promise<{ content: string } | { error: string }> {
        const owned = await this.userUploads.findOwnedByUser(input.uploadId, input.userId);
        if (!owned) {
            return { error: `File "${input.filename}" is not available.` };
        }
        let buffer: Buffer;
        try {
            const backend = await this.uploads.getBackend();
            const result = await backend.getObject(owned.storagePath);
            buffer = result.buffer;
        } catch (err) {
            this.logger.warn(
                `Skill-file read failed (upload ${input.uploadId.slice(0, 12)}…): ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return { error: `File "${input.filename}" could not be read from storage.` };
        }
        if (buffer.length > MAX_SKILL_FILE_BYTES) {
            return { error: `File "${input.filename}" exceeds the skill-file size cap.` };
        }
        try {
            // Strict decode — a binary payload mislabeled with a text mime
            // is refused instead of returning mojibake into the prompt.
            const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
            return { content };
        } catch {
            return { error: `File "${input.filename}" is not valid UTF-8 text.` };
        }
    }
}
