import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkMemberRepository } from '../database/repositories/work-member.repository';
import { WorkCustomDomainRepository } from '../database/repositories/work-custom-domain.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { PluginRepository } from '../plugins/repositories/plugin.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { WorkAdvancedPromptsRepository } from '../database/repositories/work-advanced-prompts.repository';
import { WorkScheduleRepository } from '../database/repositories/work-schedule.repository';
import { GitFacadeService } from '../facades/git.facade';
import { DataRepository } from '../generators/data-generator/data-repository';
import { UserPluginEntity } from '../plugins/entities/user-plugin.entity';
import type {
    AccountExportPayload,
    ImportPreview,
    ImportConflict,
    ConflictResolution,
    ImportResult,
    ExportedWork,
} from './types';
import { containsMaskedSecrets, MASKED_SECRET_PREFIX } from './types';
import { sanitizePrompt } from '../utils/sanitize.util';
import { normalizeCreateWorkKind, type Work, type WorkKind } from '../entities/work.entity';
import {
    WORK_CHECKS_POLICIES,
    WORK_EXTERNAL_REF_KINDS,
    WORK_EXTERNAL_REFS_MAX_PER_KIND,
    WORK_KINDS,
    type WorkChecksPolicy,
    type WorkExternalRefs,
} from '@ever-works/contracts';
import type { User } from '../entities/user.entity';
import {
    ONBOARDING_DEFAULT_STATE,
    ROLE_OPTIONS,
    TEAM_SIZE_OPTIONS,
    type OnboardingWizardStateV2,
} from '@ever-works/contracts/api';

/**
 * Canonical slug shape (matches the work/item DTO `@Matches` rule and
 * `ItemImportService.SLUG_PATTERN`). Item/comparison slugs from an
 * imported payload are written to disk as directory/file names by
 * `DataRepository.writeItem`/`writeComparison*` (which `path.join` the
 * raw slug onto the clone dir with no confinement), so a slug containing
 * `..`/`/` segments would let an attacker-supplied export escape the
 * cloned data repo and write attacker-controlled content elsewhere on
 * the host (zip-slip / path traversal → arbitrary file write). Enforcing
 * this whitelist before any write keeps malicious slugs out of the
 * filesystem while leaving every legitimate export unchanged.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Import-specific kind normalization. `normalizeCreateWorkKind` maps
 * UNKNOWN strings to `'default'` (right for the create endpoint), but on an
 * import-overwrite that would let a tampered payload RESET an existing
 * work's kind. Here an unrecognized value is treated as absent instead —
 * only strings that name a real kind (or the `landing` alias) are applied.
 */
function normalizeImportedWorkKind(value: unknown): WorkKind | undefined {
    if (typeof value !== 'string' || !value.trim()) {
        return undefined;
    }
    const raw = value.trim().toLowerCase();
    const recognized = raw === 'landing' || (WORK_KINDS as readonly string[]).includes(raw);
    return recognized ? normalizeCreateWorkKind(value) : undefined;
}

/**
 * Quality-gate fields arrive from user-supplied JSON, so they follow the
 * same posture as `normalizeImportedWorkKind`: drop-if-unrecognized, never
 * default-if-unrecognized. A tampered `checksPolicy` must not be able to
 * reset an existing Work's enforcement, and an out-of-range attempts
 * budget is treated as absent rather than clamped — clamping would launder
 * a bogus payload value into a legitimate-looking setting.
 */
function normalizeImportedChecksPolicy(value: unknown): WorkChecksPolicy | undefined {
    return typeof value === 'string' && (WORK_CHECKS_POLICIES as readonly string[]).includes(value)
        ? (value as WorkChecksPolicy)
        : undefined;
}

/** Gate-attempt budget: integers within the resolve-time clamp range only. */
function normalizeImportedMaxGateAttempts(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5
        ? value
        : undefined;
}

/** Cadences accepted for `users.digestFrequency` (drop-if-unrecognized). */
const DIGEST_FREQUENCIES: readonly string[] = ['off', 'daily', 'weekly'];

const ROLE_IDS: readonly string[] = ROLE_OPTIONS.map((option) => option.id);
const TEAM_SIZE_IDS: readonly string[] = TEAM_SIZE_OPTIONS.map((option) => option.id);

/**
 * Onboarding roles from an untrusted payload. Arrays only ever import as
 * arrays; entries outside `ROLE_OPTIONS` are DROPPED (never defaulted, never
 * stored verbatim) so a hand-edited export can't plant unknown ids into the
 * suggestion surfaces that read this list. An array that survives filtering
 * with zero entries is still meaningful — it means "the user cleared their
 * answers" — so it is kept; a non-array is treated as absent.
 */
function normalizeImportedRoles(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<string>();
    for (const entry of value) {
        if (typeof entry === 'string' && ROLE_IDS.includes(entry)) seen.add(entry);
    }
    return [...seen];
}

/** Team size: a single known id, or absent. Drop-if-unrecognized. */
function normalizeImportedTeamSize(value: unknown): string | undefined {
    return typeof value === 'string' && TEAM_SIZE_IDS.includes(value) ? value : undefined;
}

/** Digest cadence: a single known value, or absent. Drop-if-unrecognized. */
function normalizeImportedDigestFrequency(value: unknown): 'off' | 'daily' | 'weekly' | undefined {
    return typeof value === 'string' && DIGEST_FREQUENCIES.includes(value)
        ? (value as 'off' | 'daily' | 'weekly')
        : undefined;
}

/**
 * Ingest routing claims: keep only the KNOWN hint kinds, and under each
 * only non-empty strings, deduped and capped. Same drop-if-unrecognized
 * posture as the rest — an unknown key in a hand-edited payload must not
 * survive into a column the resolver iterates. Returns undefined when
 * nothing survives, so the caller leaves the existing value untouched.
 */
function normalizeImportedExternalRefs(value: unknown): WorkExternalRefs | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const out: WorkExternalRefs = {};
    let kept = 0;
    for (const kind of WORK_EXTERNAL_REF_KINDS) {
        const raw = source[kind];
        if (!Array.isArray(raw)) continue;
        const ids = Array.from(
            new Set(
                raw
                    .filter((entry): entry is string => typeof entry === 'string')
                    .map((entry) => entry.trim())
                    .filter((entry) => entry.length > 0 && entry.length <= 200),
            ),
        ).slice(0, WORK_EXTERNAL_REFS_MAX_PER_KIND);
        if (ids.length > 0) {
            out[kind] = ids;
            kept += ids.length;
        }
    }
    return kept > 0 ? out : undefined;
}

/**
 * Max length applied to imported advanced-prompt fields. Mirrors
 * `UpdateWorkAdvancedPromptsDto`'s `MAX_PROMPT_LENGTH` (2000) so an
 * imported payload can't carry a longer/un-sanitized prompt than the
 * canonical write path allows.
 */
const MAX_IMPORTED_PROMPT_LENGTH = 2000;

/**
 * Sanitize an advanced-prompt string coming from an untrusted import
 * payload, exactly as the canonical DTO write path does
 * (`UpdateWorkAdvancedPromptsDto.sanitizeAndNormalize`): trim, treat
 * empty/whitespace-only as `null`, otherwise `sanitizePrompt` (strips
 * control characters, caps length, preserves intentional newlines).
 *
 * These fields are later injected verbatim into LLM system prompts by
 * `PromptAssemblerService`. The account-import flow previously wrote
 * them straight to the DB with no sanitization, so a hostile export
 * could plant control characters / oversized content that the normal
 * API path would never accept (prompt-injection hardening). Applying
 * the same transform here keeps legitimate prompts unchanged while
 * stripping the abusive bits. (Stronger isolation — delimiting
 * user-supplied prompt segments as untrusted in the assembler — is a
 * separate, cross-file change.)
 */
function sanitizeImportedPrompt(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return sanitizePrompt(trimmed, MAX_IMPORTED_PROMPT_LENGTH);
}

@Injectable()
export class AccountImportService {
    private readonly logger = new Logger(AccountImportService.name);

    constructor(
        private readonly dataSource: DataSource,
        private readonly workRepository: WorkRepository,
        private readonly workMemberRepository: WorkMemberRepository,
        private readonly workCustomDomainRepository: WorkCustomDomainRepository,
        private readonly userPluginRepository: UserPluginRepository,
        private readonly workPluginRepository: WorkPluginRepository,
        private readonly pluginRepository: PluginRepository,
        private readonly userRepository: UserRepository,
        private readonly advancedPromptsRepository: WorkAdvancedPromptsRepository,
        private readonly scheduleRepository: WorkScheduleRepository,
        private readonly gitFacade: GitFacadeService,
    ) {}

    async previewImport(userId: string, payload: AccountExportPayload): Promise<ImportPreview> {
        const errors: string[] = [];

        if (!payload || typeof payload !== 'object') {
            return {
                valid: false,
                errors: ['Invalid payload: expected a JSON object'],
                version: 0,
                includesSecrets: false,
                hasMaskedSecrets: false,
                profile: { username: '', email: '' },
                workCount: 0,
                totalItemCount: 0,
                userPluginCount: 0,
                conflicts: [],
                missingPlugins: [],
            };
        }

        if (payload.version !== 1) {
            return {
                valid: false,
                errors: [
                    `Unsupported export version: ${payload.version}. Only version 1 is supported.`,
                ],
                version: payload.version || 0,
                includesSecrets: false,
                hasMaskedSecrets: false,
                profile: { username: '', email: '' },
                workCount: 0,
                totalItemCount: 0,
                userPluginCount: 0,
                conflicts: [],
                missingPlugins: [],
            };
        }

        if (!payload.data) {
            errors.push('Missing data field in payload');
        }

        if (!payload.data?.profile) {
            errors.push('Missing profile data');
        }

        if (!Array.isArray(payload.data?.works)) {
            errors.push('Missing or invalid works array');
        }

        if (!Array.isArray(payload.data?.userPlugins)) {
            errors.push('Missing or invalid userPlugins array');
        }

        // Element-shape validation. The `Array.isArray` guards above only check
        // the CONTAINERS — a null/non-object element (or a missing load-bearing
        // field) then either crashed the slug/pluginId loops below with an
        // unmapped 500 (e.g. `dir.slug` / `up.pluginId` on null), or passed
        // preview as `valid:true` and failed mid-apply. Validate each element
        // up-front so a malformed payload is a clean `valid:false` instead.
        if (
            payload.data?.profile !== undefined &&
            payload.data?.profile !== null &&
            (typeof payload.data.profile !== 'object' || Array.isArray(payload.data.profile))
        ) {
            errors.push('Invalid profile: expected an object');
        }
        if (Array.isArray(payload.data?.works)) {
            (payload.data.works as unknown[]).forEach((dir, i) => {
                if (!dir || typeof dir !== 'object') {
                    errors.push(`Invalid work at index ${i}: expected an object`);
                    return;
                }
                const w = dir as { slug?: unknown; name?: unknown; workPlugins?: unknown };
                if (typeof w.slug !== 'string' || w.slug.length === 0) {
                    errors.push(`Invalid work at index ${i}: missing or invalid slug`);
                }
                if (typeof w.name !== 'string' || w.name.length === 0) {
                    errors.push(`Invalid work at index ${i}: missing or invalid name`);
                }
                if (w.workPlugins !== undefined && w.workPlugins !== null) {
                    if (!Array.isArray(w.workPlugins)) {
                        errors.push(`Invalid work at index ${i}: workPlugins must be an array`);
                    } else {
                        (w.workPlugins as unknown[]).forEach((dp, j) => {
                            if (
                                !dp ||
                                typeof dp !== 'object' ||
                                typeof (dp as { pluginId?: unknown }).pluginId !== 'string'
                            ) {
                                errors.push(
                                    `Invalid workPlugin at work ${i}, index ${j}: missing or invalid pluginId`,
                                );
                            }
                        });
                    }
                }
            });
        }
        if (Array.isArray(payload.data?.userPlugins)) {
            (payload.data.userPlugins as unknown[]).forEach((up, i) => {
                if (
                    !up ||
                    typeof up !== 'object' ||
                    typeof (up as { pluginId?: unknown }).pluginId !== 'string'
                ) {
                    errors.push(`Invalid userPlugin at index ${i}: missing or invalid pluginId`);
                }
            });
        }

        if (errors.length > 0) {
            return {
                valid: false,
                errors,
                version: payload.version,
                includesSecrets: payload.includesSecrets || false,
                hasMaskedSecrets: false,
                profile: payload.data?.profile || { username: '', email: '' },
                workCount: 0,
                totalItemCount: 0,
                userPluginCount: 0,
                conflicts: [],
                missingPlugins: [],
            };
        }

        // Detect slug conflicts
        const conflicts: ImportConflict[] = [];
        const existingWorks = await this.workRepository.findByUser(userId);
        const existingSlugs = new Map(existingWorks.map((d) => [d.slug, d.name]));

        for (const dir of payload.data.works) {
            if (existingSlugs.has(dir.slug)) {
                conflicts.push({
                    slug: dir.slug,
                    existingName: existingSlugs.get(dir.slug)!,
                    incomingName: dir.name,
                });
            }
        }

        // Check for missing plugins
        const missingPlugins: string[] = [];
        const allPluginIds = new Set<string>();

        for (const up of payload.data.userPlugins) {
            allPluginIds.add(up.pluginId);
        }
        for (const dir of payload.data.works) {
            for (const dp of dir.workPlugins || []) {
                allPluginIds.add(dp.pluginId);
            }
        }

        for (const pluginId of allPluginIds) {
            const exists = await this.pluginRepository.findByPluginId(pluginId);
            if (!exists) {
                missingPlugins.push(pluginId);
            }
        }

        const totalItemCount = payload.data.works.reduce(
            (sum, d) => sum + (d.items?.length || 0),
            0,
        );

        // Detect masked secret values in the payload
        let hasMaskedSecrets = false;
        for (const up of payload.data.userPlugins) {
            if (containsMaskedSecrets(up.secretSettings)) {
                hasMaskedSecrets = true;
                break;
            }
        }
        if (!hasMaskedSecrets) {
            for (const dir of payload.data.works) {
                for (const dp of dir.workPlugins || []) {
                    if (containsMaskedSecrets(dp.secretSettings)) {
                        hasMaskedSecrets = true;
                        break;
                    }
                }
                if (hasMaskedSecrets) break;
            }
        }

        return {
            valid: true,
            errors: [],
            version: payload.version,
            includesSecrets: payload.includesSecrets || false,
            hasMaskedSecrets,
            profile: payload.data.profile,
            workCount: payload.data.works.length,
            totalItemCount,
            userPluginCount: payload.data.userPlugins.length,
            conflicts,
            missingPlugins,
        };
    }

    async applyImport(
        userId: string,
        payload: AccountExportPayload,
        resolutions: ConflictResolution[],
    ): Promise<ImportResult> {
        const result: ImportResult = {
            success: true,
            worksCreated: 0,
            worksUpdated: 0,
            worksSkipped: 0,
            userPluginsImported: 0,
            errors: [],
            warnings: [],
        };

        // Security: previewImport gates the payload version + shape, but
        // applyImport could be called directly (skipping preview) and then
        // dereferenced payload.data.works/.userPlugins unguarded — a malformed
        // or unsupported-version body crashed with an unhandled 500. Mirror the
        // preview guard here so only well-formed v1/v2 envelopes proceed; reject
        // everything else with a clean failed result. v2 is accepted (its tail
        // arrays are ignored, matching existing behavior); only unknown versions
        // and missing works/userPlugins arrays are rejected.
        if (!payload || typeof payload !== 'object') {
            result.success = false;
            result.errors.push('Invalid payload: expected a JSON object');
            return result;
        }
        if (payload.version !== 1 && payload.version !== 2) {
            result.success = false;
            result.errors.push(
                `Unsupported export version: ${payload.version}. Only versions 1 and 2 are supported.`,
            );
            return result;
        }
        if (!Array.isArray(payload.data?.works) || !Array.isArray(payload.data?.userPlugins)) {
            result.success = false;
            result.errors.push('Invalid payload: missing works or userPlugins array');
            return result;
        }

        const user = await this.userRepository.findById(userId);
        if (!user) {
            result.success = false;
            result.errors.push('User not found');
            return result;
        }

        // Guard `resolutions` BEFORE the `.map` below — it runs outside the
        // transaction try/catch, so the controller's `body.resolutions || []`
        // passing a truthy NON-array (string/number/object) or a null element
        // used to throw a TypeError → unmapped 500. Reject a non-array cleanly
        // and skip malformed elements rather than crash.
        if (!Array.isArray(resolutions)) {
            result.success = false;
            result.errors.push('Invalid payload: resolutions must be an array');
            return result;
        }
        const resolutionMap = new Map(
            (resolutions as unknown[])
                .filter(
                    (r): r is ConflictResolution =>
                        !!r &&
                        typeof r === 'object' &&
                        typeof (r as { slug?: unknown }).slug === 'string',
                )
                .map((r) => [r.slug, r]),
        );

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // Import the account-level profile (onboarding answers +
            // preferences) BEFORE the works, so a failure there still
            // rolls back with everything else in the same transaction.
            try {
                result.profileImported = await this.importProfile(
                    userId,
                    user,
                    payload.data?.profile,
                );
            } catch (error) {
                result.warnings.push(
                    `Failed to import profile settings: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }

            // Import works
            for (const dir of payload.data.works) {
                try {
                    await this.importWork(
                        userId,
                        user,
                        dir,
                        resolutionMap,
                        payload.includesSecrets,
                        result,
                    );
                } catch (error) {
                    result.errors.push(
                        `Failed to import work "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }

            // Import user plugins
            for (const up of payload.data.userPlugins) {
                try {
                    const pluginEntity = await this.pluginRepository.findByPluginId(up.pluginId);
                    if (!pluginEntity) {
                        result.warnings.push(
                            `Plugin "${up.pluginId}" is not installed on this instance, skipping`,
                        );
                        continue;
                    }

                    const data: Partial<UserPluginEntity> & { userId: string; pluginId: string } = {
                        userId,
                        pluginId: up.pluginId,
                        pluginEntityId: pluginEntity.id,
                        enabled: up.enabled,
                        autoEnableForWorks: up.autoEnableForWorks,
                        settings: up.settings || {},
                    };
                    if (payload.includesSecrets && up.secretSettings) {
                        // Skip masked secret values — they are placeholders, not real credentials
                        if (containsMaskedSecrets(up.secretSettings)) {
                            result.warnings.push(
                                `Plugin "${up.pluginId}" has masked secret values. Replace "${MASKED_SECRET_PREFIX}..." values with real credentials in the JSON file and re-import.`,
                            );
                        } else {
                            data.secretSettings = up.secretSettings;
                        }
                    }

                    await this.userPluginRepository.upsert(data);
                    result.userPluginsImported++;
                } catch (error) {
                    result.errors.push(
                        `Failed to import user plugin "${up.pluginId}": ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }

            await queryRunner.commitTransaction();
        } catch (error) {
            await queryRunner.rollbackTransaction();
            result.success = false;
            result.errors.push(
                `Transaction failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            await queryRunner.release();
        }

        return result;
    }

    /**
     * Apply the account-level profile from an imported payload: the
     * onboarding "What do you do" answers and the account preferences.
     *
     * Posture (identical to every other imported field): the payload is
     * attacker-editable JSON, so enum values are DROP-if-unrecognized
     * rather than default-if-unrecognized, arrays only apply when they
     * really are arrays, and an absent field leaves the importing
     * account's own value untouched. Identity columns (`username`,
     * `email`, `avatar`) are deliberately NOT applied — they identify the
     * importing account, not the exporting one.
     *
     * The onboarding answers are deep-merged into the existing wizard
     * state so importing a profile never wipes the importer's own AI /
     * storage / deploy choices or step progress.
     *
     * Returns true when at least one column was written.
     */
    private async importProfile(userId: string, user: any, profile: unknown): Promise<boolean> {
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
            return false;
        }
        const source = profile as {
            onboarding?: unknown;
            preferences?: unknown;
        };
        const update: Partial<User> = {};

        const onboarding =
            source.onboarding && typeof source.onboarding === 'object'
                ? (source.onboarding as { roles?: unknown; teamSize?: unknown })
                : null;
        if (onboarding) {
            const roles = normalizeImportedRoles(onboarding.roles);
            const teamSize = normalizeImportedTeamSize(onboarding.teamSize);
            if (roles !== undefined || teamSize !== undefined) {
                const current: OnboardingWizardStateV2 =
                    user.onboardingState && typeof user.onboardingState === 'object'
                        ? (user.onboardingState as OnboardingWizardStateV2)
                        : ONBOARDING_DEFAULT_STATE;
                update.onboardingState = {
                    ...current,
                    profile: {
                        ...(current.profile ?? {}),
                        ...(roles !== undefined ? { roles } : {}),
                        ...(teamSize !== undefined ? { teamSize } : {}),
                    },
                };
            }
        }

        const preferences =
            source.preferences && typeof source.preferences === 'object'
                ? (source.preferences as Record<string, unknown>)
                : null;
        if (preferences) {
            const digestFrequency = normalizeImportedDigestFrequency(preferences.digestFrequency);
            if (digestFrequency !== undefined) {
                update.digestFrequency = digestFrequency;
            }
            // Explicit booleans only — a deliberate `false` (an opt-out) is
            // exactly the value that has to survive the round-trip, so these
            // can never be written through a truthiness check.
            if (typeof preferences.emailAgentAlerts === 'boolean') {
                update.emailAgentAlerts = preferences.emailAgentAlerts;
            }
            if (typeof preferences.emailTaskNotifications === 'boolean') {
                update.emailTaskNotifications = preferences.emailTaskNotifications;
            }
            if (typeof preferences.emailBudgetAlerts === 'boolean') {
                update.emailBudgetAlerts = preferences.emailBudgetAlerts;
            }
            if (typeof preferences.userResearchOptOut === 'boolean') {
                update.userResearchOptOut = preferences.userResearchOptOut;
            }
        }

        if (Object.keys(update).length === 0) {
            return false;
        }
        await this.userRepository.update(userId, update);
        return true;
    }

    private async importWork(
        userId: string,
        user: any,
        dir: ExportedWork,
        resolutionMap: Map<string, ConflictResolution>,
        includesSecrets: boolean,
        result: ImportResult,
    ): Promise<void> {
        let slug = dir.slug;
        const existing = await this.workRepository.findByOwnerAndSlug({
            userId,
            owner: dir.owner || user.username,
            slug,
        });

        if (existing) {
            const resolution = resolutionMap.get(dir.slug);
            if (!resolution || resolution.strategy === 'skip') {
                result.worksSkipped++;
                return;
            }

            if (resolution.strategy === 'rename') {
                slug = resolution.newSlug || `${dir.slug}-imported`;
                // Security: `newSlug` comes straight from the request body and
                // flows into the created work's `slug`, which is later used to
                // build the `${slug}-data` git clone directory name in
                // importWorkRepoData. Reject anything outside the canonical slug
                // charset so a value like `../../../injected` can't escape the
                // repo namespace (path traversal). Legitimate renames always use
                // a canonical slug, so this is a no-op for valid input.
                if (!SLUG_PATTERN.test(slug)) {
                    result.errors.push(`Cannot rename "${dir.slug}" to "${slug}" - invalid slug`);
                    result.worksSkipped++;
                    return;
                }
                // Check the new slug doesn't conflict either
                const newExisting = await this.workRepository.existsByUserAndSlug(userId, slug);
                if (newExisting) {
                    result.errors.push(
                        `Cannot rename "${dir.slug}" to "${slug}" - slug already exists`,
                    );
                    result.worksSkipped++;
                    return;
                }
            }

            if (resolution.strategy === 'overwrite') {
                // Update existing work
                const updateData: Partial<Work> = {
                    name: dir.name,
                    description: dir.description,
                    gitProvider: dir.gitProvider,
                    deployProvider: dir.deployProvider,
                    readmeConfig: dir.readmeConfig,
                    domainType: dir.domainType,
                    repoVisibility: dir.repoVisibility,
                    scheduledUpdatesEnabled: dir.scheduledUpdatesEnabled,
                    scheduledCadence: dir.scheduledCadence as any,
                    communityPrEnabled: dir.communityPrEnabled,
                    communityPrAutoClose: dir.communityPrAutoClose,
                    comparisonsEnabled: dir.comparisonsEnabled,
                };
                // `kind` is user-supplied JSON — only apply a value that
                // normalizes to a known kind; never let a bogus payload
                // corrupt the column. Absent (pre-kind export) → keep as-is.
                const importedKind = normalizeImportedWorkKind(dir.kind);
                if (importedKind) {
                    updateData.kind = importedKind;
                }
                // Preserve an explicit toggle (notably `false`); absent in
                // old payloads → leave the existing work's setting alone.
                if (typeof dir.providerRepositoryEnabled === 'boolean') {
                    updateData.providerRepositoryEnabled = dir.providerRepositoryEnabled;
                }
                if (
                    typeof dir.taskIsolation === 'string' &&
                    ['off', 'worktree'].includes(dir.taskIsolation)
                ) {
                    updateData.taskIsolation = dir.taskIsolation;
                }
                if (
                    typeof dir.taskIsolationTargetRepo === 'string' &&
                    ['work-output', 'data', 'provider'].includes(dir.taskIsolationTargetRepo)
                ) {
                    updateData.taskIsolationTargetRepo = dir.taskIsolationTargetRepo;
                }
                if (
                    typeof dir.taskBranchCleanup === 'string' &&
                    ['on-merge', 'manual'].includes(dir.taskBranchCleanup)
                ) {
                    updateData.taskBranchCleanup = dir.taskBranchCleanup;
                }
                if (
                    dir.taskIsolationBaseBranch === null ||
                    (typeof dir.taskIsolationBaseBranch === 'string' &&
                        dir.taskIsolationBaseBranch.length <= 128)
                ) {
                    // null = 'use repo default' and must overwrite a custom base.
                    updateData.taskIsolationBaseBranch = dir.taskIsolationBaseBranch;
                }
                // Memory recall toggle — preserve an explicit boolean
                // (notably `false`); absent in old payloads → keep the
                // existing work's setting.
                if (typeof dir.memoryRecallEnabled === 'boolean') {
                    updateData.memoryRecallEnabled = dir.memoryRecallEnabled;
                }
                // Ingest routing claims — sanitized to known kinds only;
                // absent/empty leaves the existing Work's claims alone.
                const importedExternalRefs = normalizeImportedExternalRefs(dir.externalRefs);
                if (importedExternalRefs) {
                    updateData.externalRefs = importedExternalRefs;
                }
                // Quality-gate fields: arrays only ever import as arrays;
                // enum/int values are drop-if-unrecognized (see the
                // normalizeImported* helpers above). Absent → existing
                // Work's settings untouched.
                if (Array.isArray(dir.checkDefaults)) {
                    updateData.checkDefaults = dir.checkDefaults;
                }
                const importedChecksPolicy = normalizeImportedChecksPolicy(dir.checksPolicy);
                if (importedChecksPolicy) {
                    updateData.checksPolicy = importedChecksPolicy;
                }
                const importedMaxGateAttempts = normalizeImportedMaxGateAttempts(
                    dir.maxGateAttempts,
                );
                if (importedMaxGateAttempts !== undefined) {
                    updateData.maxGateAttempts = importedMaxGateAttempts;
                }
                await this.workRepository.update(existing.id, updateData);

                await this.importWorkRelations(existing.id, userId, dir, includesSecrets, result);
                await this.importWorkRepoData(existing, dir, user, result);
                result.worksUpdated++;
                return;
            }
        }

        // Create new work
        const createData: Partial<Work> = {
            name: dir.name,
            slug,
            description: dir.description,
            owner: dir.owner || user.username,
            userId,
            gitProvider: dir.gitProvider,
            deployProvider: dir.deployProvider,
            readmeConfig: dir.readmeConfig,
            domainType: dir.domainType,
            repoVisibility: dir.repoVisibility,
            scheduledUpdatesEnabled: dir.scheduledUpdatesEnabled,
            scheduledCadence: dir.scheduledCadence as any,
            communityPrEnabled: dir.communityPrEnabled,
            communityPrAutoClose: dir.communityPrAutoClose,
            comparisonsEnabled: dir.comparisonsEnabled,
        };
        // Same normalization rules as the overwrite path above.
        const importedKind = normalizeImportedWorkKind(dir.kind);
        if (importedKind) {
            createData.kind = importedKind;
        }
        if (typeof dir.providerRepositoryEnabled === 'boolean') {
            createData.providerRepositoryEnabled = dir.providerRepositoryEnabled;
        }
        if (
            typeof dir.taskIsolation === 'string' &&
            ['off', 'worktree'].includes(dir.taskIsolation)
        ) {
            createData.taskIsolation = dir.taskIsolation;
        }
        if (
            typeof dir.taskIsolationTargetRepo === 'string' &&
            ['work-output', 'data', 'provider'].includes(dir.taskIsolationTargetRepo)
        ) {
            createData.taskIsolationTargetRepo = dir.taskIsolationTargetRepo;
        }
        if (
            typeof dir.taskBranchCleanup === 'string' &&
            ['on-merge', 'manual'].includes(dir.taskBranchCleanup)
        ) {
            createData.taskBranchCleanup = dir.taskBranchCleanup;
        }
        if (typeof dir.memoryRecallEnabled === 'boolean') {
            createData.memoryRecallEnabled = dir.memoryRecallEnabled;
        }
        const importedExternalRefs = normalizeImportedExternalRefs(dir.externalRefs);
        if (importedExternalRefs) {
            createData.externalRefs = importedExternalRefs;
        }
        if (
            typeof dir.taskIsolationBaseBranch === 'string' &&
            dir.taskIsolationBaseBranch.length <= 128
        ) {
            createData.taskIsolationBaseBranch = dir.taskIsolationBaseBranch;
        }
        if (Array.isArray(dir.checkDefaults)) {
            createData.checkDefaults = dir.checkDefaults;
        }
        const importedChecksPolicy = normalizeImportedChecksPolicy(dir.checksPolicy);
        if (importedChecksPolicy) {
            createData.checksPolicy = importedChecksPolicy;
        }
        const importedMaxGateAttempts = normalizeImportedMaxGateAttempts(dir.maxGateAttempts);
        if (importedMaxGateAttempts !== undefined) {
            createData.maxGateAttempts = importedMaxGateAttempts;
        }
        const newDir = await this.workRepository.create(createData, user);

        await this.importWorkRelations(newDir.id, userId, dir, includesSecrets, result);
        await this.importWorkRepoData(newDir, dir, user, result);
        result.worksCreated++;
    }

    private async importWorkRelations(
        workId: string,
        userId: string,
        dir: ExportedWork,
        includesSecrets: boolean,
        result: ImportResult,
    ): Promise<void> {
        // Import members
        for (const member of dir.members || []) {
            try {
                const memberUser = await this.userRepository.findById(member.userId);
                if (!memberUser) {
                    result.warnings.push(
                        `Member user "${member.userId}" not found on this instance, skipping`,
                    );
                    continue;
                }
                const exists = await this.workMemberRepository.isMember(workId, member.userId);
                if (!exists) {
                    await this.workMemberRepository.addMember(
                        workId,
                        member.userId,
                        member.role as any,
                    );
                }
            } catch (error) {
                result.warnings.push(
                    `Failed to import member for work: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        // Import custom domains
        for (const cd of dir.customDomains || []) {
            try {
                const existingDomain = await this.workCustomDomainRepository.findOne(
                    workId,
                    cd.domain,
                );
                if (!existingDomain) {
                    await this.workCustomDomainRepository.addDomain(workId, cd.domain, cd.provider);
                }
            } catch (error) {
                result.warnings.push(
                    `Failed to import custom domain "${cd.domain}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        // Import advanced prompts
        if (dir.advancedPrompts && Object.keys(dir.advancedPrompts).length > 0) {
            try {
                // Security: sanitize each imported prompt the same way the
                // canonical DTO write path does (strip control chars, cap at
                // 2000, empty→null) before it is stored and later injected
                // verbatim into LLM system prompts. Prevents an untrusted
                // export from smuggling oversized/control-char prompt-injection
                // payloads past the validation the normal API enforces.
                await this.advancedPromptsRepository.createOrUpdate(workId, {
                    relevanceAssessment: sanitizeImportedPrompt(
                        dir.advancedPrompts.relevanceAssessment,
                    ),
                    itemGeneration: sanitizeImportedPrompt(dir.advancedPrompts.itemGeneration),
                    itemExtraction: sanitizeImportedPrompt(dir.advancedPrompts.itemExtraction),
                    searchQuery: sanitizeImportedPrompt(dir.advancedPrompts.searchQuery),
                    categorization: sanitizeImportedPrompt(dir.advancedPrompts.categorization),
                    deduplication: sanitizeImportedPrompt(dir.advancedPrompts.deduplication),
                    sourceValidation: sanitizeImportedPrompt(dir.advancedPrompts.sourceValidation),
                });
            } catch (error) {
                result.warnings.push(
                    `Failed to import advanced prompts for work "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        // Import schedule
        if (dir.schedule) {
            try {
                await this.scheduleRepository.upsert(workId, {
                    userId,
                    cadence: dir.schedule.cadence as any,
                    status: dir.schedule.status as any,
                    billingMode: dir.schedule.billingMode as any,
                    alwaysCreatePullRequest: dir.schedule.alwaysCreatePullRequest,
                    maxFailureBeforePause: dir.schedule.maxFailureBeforePause,
                    providerOverrides: dir.schedule.providerOverrides || null,
                });
            } catch (error) {
                result.warnings.push(
                    `Failed to import schedule for work "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        // Import work plugins
        for (const dp of dir.workPlugins || []) {
            try {
                const pluginEntity = await this.pluginRepository.findByPluginId(dp.pluginId);
                if (!pluginEntity) {
                    result.warnings.push(
                        `Plugin "${dp.pluginId}" is not installed on this instance, skipping`,
                    );
                    continue;
                }

                // Determine secret settings: skip masked values, use real values only
                let secretSettings: Record<string, unknown> = {};
                if (includesSecrets && dp.secretSettings) {
                    if (containsMaskedSecrets(dp.secretSettings)) {
                        result.warnings.push(
                            `Work plugin "${dp.pluginId}" has masked secret values. Replace "${MASKED_SECRET_PREFIX}..." values with real credentials in the JSON file and re-import.`,
                        );
                    } else {
                        secretSettings = dp.secretSettings;
                    }
                }

                await this.workPluginRepository.upsert({
                    workId,
                    pluginId: dp.pluginId,
                    pluginEntityId: pluginEntity.id,
                    enabled: dp.enabled,
                    activeCapabilities:
                        dp.activeCapabilities ?? (dp.activeCapability ? [dp.activeCapability] : []),
                    settings: dp.settings || {},
                    secretSettings,
                    priority: dp.priority,
                });
            } catch (error) {
                result.warnings.push(
                    `Failed to import work plugin "${dp.pluginId}": ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    private async importWorkRepoData(
        work: any,
        dir: ExportedWork,
        user: any,
        result: ImportResult,
    ): Promise<void> {
        const hasItems = dir.items && dir.items.length > 0;
        const hasComparisons = dir.comparisons && dir.comparisons.length > 0;
        const hasSiteConfig = dir.siteConfig && Object.keys(dir.siteConfig).length > 0;
        const hasMarkdownTemplate =
            dir.markdownTemplate && (dir.markdownTemplate.header || dir.markdownTemplate.footer);

        if (!hasItems && !hasComparisons && !hasSiteConfig && !hasMarkdownTemplate) {
            return;
        }

        try {
            const repoOwner = work.getRepoOwner?.() || dir.owner || user.username;
            const dataRepo = `${work.slug || dir.slug}-data`;
            const committer = user.asCommitter?.() || { name: user.username, email: user.email };

            const dest = await this.gitFacade.cloneOrPull(
                { owner: repoOwner, repo: dataRepo, committer },
                { userId: user.id || work.userId, providerId: dir.gitProvider },
            );

            const data = await DataRepository.create(dest);
            await data.ensureWorksExist();

            // Write site config
            if (hasSiteConfig) {
                await data.writeConfig(dir.siteConfig as any);
            }

            // Write markdown template
            if (hasMarkdownTemplate) {
                await data.writeMarkdownTemplate(
                    dir.markdownTemplate!.header || '',
                    dir.markdownTemplate!.footer || '',
                );
            }

            // Write categories, tags, collections
            if (dir.categories && dir.categories.length > 0) {
                await data.writeCategories(dir.categories as any);
            }
            if (dir.tags && dir.tags.length > 0) {
                await data.writeTags(dir.tags as any);
            }
            if (dir.collections && dir.collections.length > 0) {
                await data.writeCollections(dir.collections as any);
            }

            // Write items
            if (hasItems) {
                for (const item of dir.items!) {
                    // Security: the item slug becomes a directory/file name on
                    // disk via path.join with no confinement, so reject any
                    // slug with traversal/illegal chars to prevent writing
                    // outside the cloned data repo (path traversal). Legitimate
                    // exports always carry a canonical slug, so this is a no-op
                    // for valid input.
                    if (item.slug && !SLUG_PATTERN.test(item.slug)) {
                        result.warnings.push(
                            `Skipped item with invalid slug "${item.slug}" in work "${dir.slug}"`,
                        );
                        continue;
                    }
                    const { markdown, ...itemData } = item;
                    await data.writeItem(itemData as any);
                    if (markdown) {
                        await data.writeItemMarkdown(item as any, markdown);
                    }
                }
            }

            // Write comparisons
            if (hasComparisons) {
                for (const comp of dir.comparisons!) {
                    // Security: the comparison slug becomes a directory/file
                    // name on disk via path.join with no confinement, so reject
                    // any slug with traversal/illegal chars to prevent writing
                    // outside the cloned data repo (path traversal). Legitimate
                    // exports always carry a canonical slug, so this is a no-op
                    // for valid input.
                    if (!SLUG_PATTERN.test(comp.slug)) {
                        result.warnings.push(
                            `Skipped comparison with invalid slug "${comp.slug}" in work "${dir.slug}"`,
                        );
                        continue;
                    }
                    const { markdown, ...compData } = comp;
                    await data.writeComparison(compData as any);
                    if (markdown) {
                        await data.writeComparisonMarkdown(comp.slug, markdown);
                    }
                }
            }

            // Stage, commit, push
            await this.gitFacade.addAll(dir.gitProvider, dest);
            const status = await this.gitFacade.getStatus(dir.gitProvider, dest);
            if (status.length > 0) {
                const parts: string[] = [];
                if (hasItems) parts.push(`${dir.items!.length} items`);
                if (hasComparisons) parts.push(`${dir.comparisons!.length} comparisons`);
                if (hasSiteConfig) parts.push('site config');
                if (hasMarkdownTemplate) parts.push('markdown template');

                await this.gitFacade.commit(
                    dir.gitProvider,
                    dest,
                    `import: restore ${parts.join(', ')} from account export`,
                    committer,
                );
                await this.gitFacade.push(
                    { dir: dest },
                    { userId: user.id || work.userId, providerId: dir.gitProvider },
                );
            }
        } catch (error) {
            this.logger.warn(
                `Failed to import repo data for work "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
            );
            result.warnings.push(
                `Repo data for work "${dir.slug}" could not be imported: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
