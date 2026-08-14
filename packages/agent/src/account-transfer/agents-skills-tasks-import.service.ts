import { Injectable, Logger, Optional } from '@nestjs/common';
import { AgentExportService } from '../agents/agent-export.service';
import { SkillsService } from '../skills/skills.service';
import { SkillFilesService } from '../skills/skill-files.service';
import { TasksService } from '../tasks-domain/tasks.service';
import { UserUploadRepository } from '../database/repositories/user-upload.repository';
import type { TaskAcceptanceCheck } from '@ever-works/contracts';
import {
    type AccountExportV2Tail,
    type AgentsSkillsTasksImportOptions,
    type ExportedSkillFile,
} from './agents-skills-tasks-types';

/** Per-Task isolation override values (drop-if-unrecognized on import). */
const TASK_ISOLATION_MODES: readonly string[] = ['on', 'off'];

/**
 * Task isolation override from an untrusted payload. `null` is MEANINGFUL
 * (= inherit the Work's setting) and is preserved; an unrecognized string
 * is dropped (treated as absent) rather than defaulted.
 */
function normalizeImportedIsolationMode(value: unknown): 'on' | 'off' | null | undefined {
    if (value === null) return null;
    return typeof value === 'string' && TASK_ISOLATION_MODES.includes(value)
        ? (value as 'on' | 'off')
        : undefined;
}

/** Task acceptance checks: arrays only ever import as arrays; `null` = inherit. */
function normalizeImportedAcceptanceChecks(
    value: unknown,
): TaskAcceptanceCheck[] | null | undefined {
    if (value === null) return null;
    return Array.isArray(value) ? (value as TaskAcceptanceCheck[]) : undefined;
}

/**
 * Task gate-attempt budget: integers inside the resolve-time clamp range
 * only. `null` = inherit the Work's value and is preserved; out-of-range
 * values are dropped, never clamped.
 */
function normalizeImportedMaxGateAttempts(value: unknown): number | null | undefined {
    if (value === null) return null;
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5
        ? value
        : undefined;
}

export interface AgentsSkillsTasksImportSummary {
    agents: { imported: number; skipped: number; errors: string[] };
    skills: { imported: number; skipped: number; errors: string[] };
    tasks: { imported: number; skipped: number; errors: string[] };
}

/**
 * Tasks/Agents/Skills feature — Phase 19 (ADR-008 v1) import side.
 *
 * Replays the v2 payload tail against the user's account. Reuses
 * the single-Agent / single-Skill / single-Task service surfaces
 * so the secret-scan + slug-uniqueness + recurrence validation
 * paths are honored.
 *
 * Conflict resolution is plumbed through the per-feature options.
 * Cross-tenant id resolution (mission/idea/work slugs from a
 * different tenant pointing at this tenant's targets) is
 * intentionally NOT v1: the importer drops scope references that
 * can't be resolved to a local entity and reports them as
 * warnings — staying inside the v1 ADR scope.
 */
@Injectable()
export class AgentsSkillsTasksImportService {
    private readonly logger = new Logger(AgentsSkillsTasksImportService.name);

    constructor(
        private readonly agentExport: AgentExportService,
        private readonly skillsService: SkillsService,
        private readonly tasksService: TasksService,
        // Skill files feature — companion-file metadata restore. Trailing
        // + @Optional() so existing positional constructor calls keep
        // working; unbound → skills import exactly as before (files
        // reported as skipped). The upload-ownership repo gates restore:
        // a row is recreated ONLY when the importing account owns the
        // referenced bytes (same sha256 in user_uploads) — anything else
        // would create a dangling reference into someone else's storage.
        @Optional() private readonly skillFilesService?: SkillFilesService,
        @Optional() private readonly userUploads?: UserUploadRepository,
    ) {}

    async importTail(
        userId: string,
        tail: AccountExportV2Tail,
        options: AgentsSkillsTasksImportOptions = {},
    ): Promise<AgentsSkillsTasksImportSummary> {
        const summary: AgentsSkillsTasksImportSummary = {
            agents: { imported: 0, skipped: 0, errors: [] },
            skills: { imported: 0, skipped: 0, errors: [] },
            tasks: { imported: 0, skipped: 0, errors: [] },
        };

        if (options.importAgents && tail.agents?.length) {
            for (const envelope of tail.agents) {
                try {
                    await this.agentExport.importOne(userId, envelope as any, {
                        onConflict: options.onConflictAgent ?? 'rename',
                    });
                    summary.agents.imported += 1;
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (msg.toLowerCase().includes('skip')) {
                        summary.agents.skipped += 1;
                    } else {
                        summary.agents.errors.push(`${envelope.identity?.slug ?? '?'}: ${msg}`);
                    }
                }
            }
        }

        if (options.importSkills && tail.skills?.length) {
            for (const skill of tail.skills) {
                try {
                    // v1 imports Skills at tenant scope — cross-tenant ownerId
                    // resolution isn't reliable, so we drop the scope hint
                    // rather than guess. Bindings drop for the same reason
                    // (re-attach lives behind the per-target Skills tab).
                    if (skill.ownerType !== 'tenant') {
                        summary.skills.skipped += 1;
                        continue;
                    }
                    const created = await this.skillsService.create(userId, {
                        ownerType: 'tenant',
                        ownerId: userId,
                        title: skill.title,
                        description: skill.description,
                        instructionsMd: skill.instructionsMd,
                        frontmatter: skill.frontmatter as any,
                        slug: skill.slug,
                        version: skill.version,
                    });
                    summary.skills.imported += 1;

                    // Skill files feature — the second/third whitelist places
                    // (see the export service note): invocationSlug is
                    // re-applied AFTER create so a per-user slug conflict
                    // degrades to a warning instead of skipping the whole
                    // skill; file rows restore only for uploads the
                    // importing account already owns (sha256 match).
                    if (skill.invocationSlug) {
                        try {
                            await this.skillsService.update(userId, created.id, {
                                invocationSlug: skill.invocationSlug,
                            });
                        } catch (err) {
                            summary.skills.errors.push(
                                `${skill.slug}: invocationSlug "/${skill.invocationSlug}" not restored — ${
                                    err instanceof Error ? err.message : String(err)
                                }`,
                            );
                        }
                    }
                    if (skill.files?.length) {
                        await this.restoreSkillFiles(userId, created.id, skill.slug, skill.files, summary);
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (msg.toLowerCase().includes('already exists')) {
                        summary.skills.skipped += 1;
                    } else {
                        summary.skills.errors.push(`${skill.slug}: ${msg}`);
                    }
                }
            }
        }

        if (options.importTasks && tail.tasks?.length) {
            // v1: ignore scope cross-refs; ignore parent-task pointers
            // (resolved post-import once the rest of the payload exists).
            // The importer creates each Task at tenant scope (no
            // missionId/ideaId/workId).
            for (const task of tail.tasks) {
                try {
                    // User-authored Task settings round-trip with the same
                    // posture as every other imported field: `null` means
                    // "inherit" and is preserved, arrays only apply when
                    // they really are arrays, and unrecognized enum / out
                    // of range values are DROPPED (never defaulted, never
                    // clamped) so a hand-edited payload cannot reset an
                    // isolation or gate setting into something plausible.
                    const isolationMode = normalizeImportedIsolationMode(task.isolationMode);
                    const acceptanceChecks = normalizeImportedAcceptanceChecks(
                        task.acceptanceChecks,
                    );
                    const maxGateAttempts = normalizeImportedMaxGateAttempts(task.maxGateAttempts);
                    await this.tasksService.create(userId, {
                        title: task.title,
                        description: task.description ?? null,
                        priority: task.priority as any,
                        labels: task.labels ?? null,
                        missionId: null,
                        ideaId: null,
                        workId: null,
                        parentTaskId: null,
                        createdByType: 'user',
                        createdById: userId,
                        requireAllApprovers: task.requireAllApprovers,
                        ...(isolationMode !== undefined ? { isolationMode } : {}),
                        ...(acceptanceChecks !== undefined ? { acceptanceChecks } : {}),
                        ...(maxGateAttempts !== undefined ? { maxGateAttempts } : {}),
                    });
                    summary.tasks.imported += 1;
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    summary.tasks.errors.push(`${task.slug}: ${msg}`);
                }
            }
        }

        return summary;
    }

    /**
     * Restore companion-file rows for an imported skill. Ownership-gated:
     * a row is recreated only when the importing account owns the bytes
     * (`user_uploads` has the same sha256 for this user) — otherwise the
     * entry is reported, not silently dropped and not danglingly linked.
     */
    private async restoreSkillFiles(
        userId: string,
        skillId: string,
        skillSlug: string,
        files: ExportedSkillFile[],
        summary: AgentsSkillsTasksImportSummary,
    ): Promise<void> {
        if (!this.skillFilesService || !this.userUploads) {
            summary.skills.errors.push(
                `${skillSlug}: ${files.length} file(s) not restored — file import is unavailable in this runtime.`,
            );
            return;
        }
        for (const file of files) {
            try {
                const owned = await this.userUploads.findOwnedByUser(file.uploadId, userId);
                if (!owned) {
                    summary.skills.errors.push(
                        `${skillSlug}: file "${file.filename}" not restored — upload ${file.uploadId.slice(0, 12)}… is not present in this account.`,
                    );
                    continue;
                }
                await this.skillFilesService.add(userId, {
                    skillId,
                    uploadId: file.uploadId,
                    filename: file.filename,
                    kind: file.kind,
                    sizeBytes: file.sizeBytes,
                    mime: file.mime,
                });
            } catch (err) {
                summary.skills.errors.push(
                    `${skillSlug}: file "${file.filename}" not restored — ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }
    }
}
