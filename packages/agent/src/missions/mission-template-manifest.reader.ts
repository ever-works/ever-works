import { Injectable, Logger, Optional } from '@nestjs/common';
import { GitFacadeService } from '../facades/git.facade';
import {
    MISSION_TEMPLATE_DEFAULT_GIT_PROVIDER,
    MISSION_TEMPLATE_MANIFEST_PATH,
    type MissionTemplateConfig,
} from './mission-template.config';
import {
    MissionTemplateManifestService,
    type MissionTemplateManifest,
} from './mission-template-manifest.service';

/**
 * APW-08 T38 (APW08-G13) — the FETCH half of a Mission Template's manifest.
 *
 * `MissionTemplateManifestService` is a pure parser; this is its one reader. The manifest is a file
 * read of `.works/mission.yml` through the **git facade** at the template repository's recorded
 * `branch` — the same `getFileContent` read the App spec and `.works/works.yml` readers use — with
 * the template's `owner` / `repo` / `branch` from `findMissionTemplateConfig`, and the acting
 * person's own git credentials (no platform token is minted for it).
 *
 * It never throws. A repository that cannot be read (no credentials, no such repository or file,
 * a provider error) answers `unreadable`; a file that is not a valid manifest answers `invalid`.
 * Either way the caller keeps the Mission on its explicit values and records ONE warning.
 */

/** A manifest larger than this is refused unread (a manifest is a few hundred bytes). */
export const MISSION_TEMPLATE_MANIFEST_MAX_BYTES = 64 * 1024;

/** The warning a Mission write answers when the template's manifest could not be used. */
export const MISSION_TEMPLATE_MANIFEST_UNREADABLE = 'templateManifestUnreadable';

/**
 * How long a create or a form render waits for the provider (review of #3077): past it the
 * manifest counts as unreadable, so a slow provider never holds a Mission create.
 */
export const MISSION_TEMPLATE_MANIFEST_READ_TIMEOUT_MS = 5_000;

export type MissionTemplateManifestReadResult =
    | { ok: true; manifest: MissionTemplateManifest }
    | { ok: false; reason: 'unreadable' | 'invalid'; message: string };

@Injectable()
export class MissionTemplateManifestReader {
    private readonly logger = new Logger(MissionTemplateManifestReader.name);

    constructor(
        private readonly parser: MissionTemplateManifestService,
        // `@Optional()` so a graph without the facades (a hand-rolled test, a trimmed worker)
        // reads nothing and answers `unreadable` instead of failing to construct.
        @Optional() private readonly gitFacade?: GitFacadeService,
    ) {}

    /** Overridable by a test; production reads with {@link MISSION_TEMPLATE_MANIFEST_READ_TIMEOUT_MS}. */
    timeoutMs = MISSION_TEMPLATE_MANIFEST_READ_TIMEOUT_MS;

    async read(
        template: MissionTemplateConfig,
        userId: string,
    ): Promise<MissionTemplateManifestReadResult> {
        if (!this.gitFacade) {
            return { ok: false, reason: 'unreadable', message: 'No git facade in this context.' };
        }
        let file: { content: string; encoding: string } | null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const read = this.gitFacade.getFileContent(
                template.owner,
                template.repo,
                MISSION_TEMPLATE_MANIFEST_PATH,
                {
                    userId,
                    providerId: template.gitProvider ?? MISSION_TEMPLATE_DEFAULT_GIT_PROVIDER,
                },
                template.branch,
            );
            const deadline = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`No answer within ${this.timeoutMs} ms.`)),
                    this.timeoutMs,
                );
            });
            // A late answer after the deadline is dropped; its rejection must not go unhandled.
            read.catch(() => undefined);
            file = await Promise.race([read, deadline]);
        } catch (error) {
            return {
                ok: false,
                reason: 'unreadable',
                message: error instanceof Error ? error.message : String(error),
            };
        } finally {
            if (timer) clearTimeout(timer);
        }
        if (!file || typeof file.content !== 'string') {
            return {
                ok: false,
                reason: 'unreadable',
                message: `${MISSION_TEMPLATE_MANIFEST_PATH} not found in ${template.owner}/${template.repo}@${template.branch}.`,
            };
        }
        const text = decode(file);
        if (text === null) {
            return {
                ok: false,
                reason: 'invalid',
                message: `${MISSION_TEMPLATE_MANIFEST_PATH} is not readable text or exceeds ${MISSION_TEMPLATE_MANIFEST_MAX_BYTES} bytes.`,
            };
        }
        const parsed = this.parser.parse(text);
        // `in` narrows the union without relying on `strictNullChecks` (off in this package).
        if ('errorKind' in parsed) {
            this.logger.debug(
                `Mission template ${template.id}: manifest rejected (${parsed.errorKind}): ${parsed.message}`,
            );
            return { ok: false, reason: 'invalid', message: parsed.message };
        }
        return { ok: true, manifest: parsed.manifest };
    }
}

function decode(file: { content: string; encoding: string }): string | null {
    const raw = file.content;
    if (file.encoding === 'base64') {
        // The decoded size is at most 3/4 of the encoded length; refuse before allocating.
        if ((raw.length * 3) / 4 > MISSION_TEMPLATE_MANIFEST_MAX_BYTES + 4) return null;
        const buffer = Buffer.from(raw.replace(/\s+/g, ''), 'base64');
        if (buffer.length > MISSION_TEMPLATE_MANIFEST_MAX_BYTES) return null;
        return buffer.toString('utf8');
    }
    if (Buffer.byteLength(raw, 'utf8') > MISSION_TEMPLATE_MANIFEST_MAX_BYTES) return null;
    return raw;
}
