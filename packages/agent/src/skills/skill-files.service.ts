import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { SkillRepository } from '../database/repositories/skill.repository';
import { SkillFileRepository } from '../database/repositories/skill-file.repository';
import { SkillFile, SKILL_FILE_KINDS, type SkillFileKind } from '../entities/skill-file.entity';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { assertNoSecrets } from '../utils/secret-scan';
import { assertNoInjectionTokens } from '../utils/content-policy';

/** 2 MiB per companion file — well under the uploads spine's 25 MiB cap. */
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILES_PER_SKILL = 20;

export interface AddSkillFileInput {
    skillId: string;
    /** sha256 upload id returned by the uploads spine. */
    uploadId: string;
    /** Display filename inside the skill (`analyze.py`). */
    filename: string;
    kind?: SkillFileKind;
    sizeBytes: number;
    mime: string;
    /**
     * UTF-8 decoded content for text-like uploads — secret-scanned with
     * the same scanner skill bodies use. Callers pass it only when the
     * mime is text-like; binary uploads skip the scan.
     */
    textContent?: string;
}

/**
 * Default kind by extension: code files are scripts (US-6: CODE,
 * execution-gated — data-only in v1), docs are references, structured
 * config formats are configs, everything else is an asset.
 */
const SCRIPT_EXTS = new Set(['py', 'sh', 'js', 'ts', 'mjs', 'cjs', 'rb', 'ps1', 'bash']);
const REFERENCE_EXTS = new Set(['md', 'markdown', 'txt', 'pdf', 'rst']);
const CONFIG_EXTS = new Set(['json', 'yml', 'yaml', 'toml', 'ini', 'env', 'xml']);

export function defaultKindForFilename(filename: string): SkillFileKind {
    const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
    if (SCRIPT_EXTS.has(ext)) return 'script';
    if (REFERENCE_EXTS.has(ext)) return 'reference';
    if (CONFIG_EXTS.has(ext)) return 'config';
    return 'asset';
}

/**
 * Skills feature — companion files (uploads-spine sidecars).
 *
 * Owns the `skill_files` row lifecycle. The BYTES live in the uploads
 * spine (`UploadsService` stores + `user_uploads` indexes them); this
 * service validates and records the skill-facing metadata. Mirrors the
 * SkillsService posture: cross-user reads → 404, caps enforced here so
 * they hold for every caller.
 *
 * Note: `docs/specs/features/skills/tasks.md` T14 sketched a
 * git-backed `SkillFileService` writing skill BODIES to a repo; this
 * service instead implements companion files over the uploads spine —
 * see `docs/internal/feat-skill-files-notes.md` for the divergence.
 */
@Injectable()
export class SkillFilesService {
    private readonly logger = new Logger(SkillFilesService.name);

    constructor(
        private readonly skills: SkillRepository,
        private readonly files: SkillFileRepository,
        // Trailing + @Optional() so existing positional constructor calls
        // keep working; unbound → no activity rows, never a failed write.
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    async list(userId: string, skillId: string): Promise<SkillFile[]> {
        await this.assertOwnedSkill(userId, skillId);
        return this.files.findBySkillId(skillId, userId);
    }

    async getOne(userId: string, skillId: string, fileId: string): Promise<SkillFile> {
        await this.assertOwnedSkill(userId, skillId);
        const file = await this.files.findByIdAndUser(fileId, userId);
        if (!file || file.skillId !== skillId) {
            throw new NotFoundException(`Skill file ${fileId} not found.`);
        }
        return file;
    }

    async add(userId: string, input: AddSkillFileInput): Promise<SkillFile> {
        await this.assertOwnedSkill(userId, input.skillId);

        const filename = input.filename?.trim();
        if (!filename || filename.length > 255 || /[/\\]|\.\.|[\0-\x1f]/.test(filename)) {
            throw new BadRequestException('filename must be a plain name without path segments.');
        }
        if (input.kind !== undefined && !SKILL_FILE_KINDS.includes(input.kind)) {
            throw new BadRequestException(`kind must be one of: ${SKILL_FILE_KINDS.join(', ')}.`);
        }
        if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
            throw new BadRequestException('sizeBytes must be a positive integer.');
        }
        if (input.sizeBytes > MAX_SKILL_FILE_BYTES) {
            throw new BadRequestException(
                `Skill files are capped at ${MAX_SKILL_FILE_BYTES / (1024 * 1024)} MB.`,
            );
        }

        const count = await this.files.countBySkillId(input.skillId, userId);
        if (count >= MAX_FILES_PER_SKILL) {
            throw new BadRequestException(
                `A skill can carry at most ${MAX_FILES_PER_SKILL} files.`,
            );
        }

        const duplicate = await this.files.findBySkillAndFilename(input.skillId, filename, userId);
        if (duplicate) {
            throw new ConflictException(`A file named "${filename}" already exists on this skill.`);
        }

        // Same scanner the skill BODY writes run — a companion file is
        // injected into model context via getSkillFile, so it must obey
        // the same no-secrets / no-control-token policy.
        if (input.textContent !== undefined) {
            assertNoSecrets(input.textContent, `skill file ${filename}`);
            assertNoInjectionTokens(input.textContent, `skill file ${filename}`);
        }

        const created = await this.files.create({
            skillId: input.skillId,
            userId,
            uploadId: input.uploadId,
            filename,
            kind: input.kind ?? defaultKindForFilename(filename),
            sizeBytes: Math.floor(input.sizeBytes),
            mime: input.mime,
        });
        await this.logActivity(userId, input.skillId, filename, 'added');
        return created;
    }

    async remove(userId: string, skillId: string, fileId: string): Promise<{ deleted: true }> {
        const file = await this.getOne(userId, skillId, fileId);
        // Row only — the bytes stay in the uploads spine (they are
        // content-addressed and possibly shared with other references).
        await this.files.deleteByIdAndUser(fileId, userId);
        await this.logActivity(userId, skillId, file.filename, 'removed');
        return { deleted: true };
    }

    /**
     * A companion file changes what the model can read for a skill, so
     * add/remove are user-visible state changes. `SKILL_FILE_EDITED` is
     * the existing enum entry for exactly this; it had no producer until
     * now. Never throws — activity is telemetry, not the write path.
     */
    private async logActivity(
        userId: string,
        skillId: string,
        filename: string,
        verb: 'added' | 'removed',
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId,
                action: ActivityActionType.SKILL_FILE_EDITED,
                actionType: ActivityActionType.SKILL_FILE_EDITED,
                status: ActivityStatus.COMPLETED,
                summary: `Skill ${skillId} — file "${filename}" ${verb}`,
                details: { resourceType: 'skill', resourceId: skillId, filename, change: verb },
            });
        } catch (err) {
            this.logger.warn(`Failed to log skill-file activity (${verb} ${filename}): ${err}`);
        }
    }

    private async assertOwnedSkill(userId: string, skillId: string): Promise<void> {
        const skill = await this.skills.findByIdAndUser(skillId, userId);
        if (!skill) throw new NotFoundException(`Skill ${skillId} not found.`);
    }
}
