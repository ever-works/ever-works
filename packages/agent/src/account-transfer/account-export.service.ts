import { Injectable, Logger, Optional } from '@nestjs/common';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkMemberRepository } from '../database/repositories/work-member.repository';
import { WorkCustomDomainRepository } from '../database/repositories/work-custom-domain.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { WorkAdvancedPromptsRepository } from '../database/repositories/work-advanced-prompts.repository';
import { WorkScheduleRepository } from '../database/repositories/work-schedule.repository';
import { GitFacadeService } from '../facades/git.facade';
import { DataRepository } from '../generators/data-generator/data-repository';
import type {
    AccountExportPayload,
    ExportedProfile,
    ExportedOnboardingProfile,
    ExportedUserPreferences,
    ExportedWork,
    ExportedAdvancedPrompts,
    ExportedSchedule,
    ExportedComparison,
    ExportedMarkdownTemplate,
    ExportedWorkItem,
    ExportedWorkCategory,
    ExportedWorkTag,
    ExportedWorkCollection,
    ExportedUserPlugin,
    ExportOptions,
} from './types';
import { maskSecretSettings } from './types';
import { getActiveCapabilities } from '../plugins/utils/active-capabilities.util';
import { AgentsSkillsTasksExportService } from './agents-skills-tasks-export.service';

/**
 * What one Work's data repo holds, as {@link AccountExportService.readWorkRepoContent}
 * returns it. Named so the AW-22 workspace backup can depend on the shape
 * without restating it.
 */
export interface WorkRepoContent {
    items: ExportedWorkItem[];
    categories: ExportedWorkCategory[];
    tags: ExportedWorkTag[];
    collections: ExportedWorkCollection[];
    siteConfig?: Record<string, any>;
    comparisons: ExportedComparison[];
    markdownTemplate?: ExportedMarkdownTemplate;
}

/**
 * How many Works' data repos one account export reads at once. See
 * {@link AccountExportService.exportWorksInOrder}.
 */
const ACCOUNT_EXPORT_WORK_CONCURRENCY = 2;

@Injectable()
export class AccountExportService {
    private readonly logger = new Logger(AccountExportService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly workMemberRepository: WorkMemberRepository,
        private readonly workCustomDomainRepository: WorkCustomDomainRepository,
        private readonly userPluginRepository: UserPluginRepository,
        private readonly workPluginRepository: WorkPluginRepository,
        private readonly userRepository: UserRepository,
        private readonly advancedPromptsRepository: WorkAdvancedPromptsRepository,
        private readonly scheduleRepository: WorkScheduleRepository,
        private readonly gitFacade: GitFacadeService,
        // Phase 19.6 — v2 payload tail. Optional() so the existing
        // single-arg constructors in tests + the AccountTransferModule's
        // current wiring don't break; when bound, the per-feature
        // toggles flip the tail on.
        @Optional() private readonly agentsSkillsTasksExport?: AgentsSkillsTasksExportService,
    ) {}

    async exportAccountData(
        userId: string,
        options: ExportOptions = {},
    ): Promise<AccountExportPayload> {
        const { includeSecrets = false } = options;

        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new Error('User not found');
        }

        const works = await this.workRepository.findByUser(userId);

        // In order, a couple at a time — see `exportWorksInOrder`. This used
        // to be one `Promise.all` over every Work, i.e. a clone-or-pull of
        // every data repo at once on the API's single event loop.
        const exportedWorks: ExportedWork[] = [];
        for await (const exported of this.exportWorksInOrder(works, includeSecrets)) {
            exportedWorks.push(exported);
        }

        const exportedUserPlugins = await this.exportUserPlugins(userId, includeSecrets);
        const { tailAgents, tailSkills, tailTasks } = await this.exportTailSections(
            userId,
            options,
        );
        const hasTailRows = !!(tailAgents || tailSkills || tailTasks);

        return {
            version: hasTailRows ? 2 : 1,
            exportedAt: new Date().toISOString(),
            includesSecrets: includeSecrets,
            data: {
                profile: this.exportProfile(user),
                works: exportedWorks,
                userPlugins: exportedUserPlugins,
                ...(tailAgents ? { agents: tailAgents } : {}),
                ...(tailSkills ? { skills: tailSkills } : {}),
                ...(tailTasks ? { tasks: tailTasks } : {}),
            },
        };
    }

    /**
     * The same payload as {@link exportAccountData}, as the fragments of its
     * JSON text — so `GET /api/account/export` can start answering at once
     * and keep bytes flowing while each Work's data repo is read.
     *
     * The export used to be built whole and then sent: every Work's repo
     * read, every item held in memory, one `JSON.stringify` of the lot, and
     * only then a first byte. On a large account that took longer than the
     * 100 s an edge proxy waits for a response, so the owner got a 524 and
     * nothing at all. Here the account, its plugins and the v2 tail — all
     * database reads — come first, so every failure the endpoint has always
     * answered with an error status still happens before the first fragment;
     * then each Work is serialised and released as it is read, a couple at a
     * time and in order.
     *
     * Joined, the fragments are exactly `JSON.stringify` of the payload
     * `exportAccountData` returns for the same data (same keys, same order),
     * so every consumer that parses the body sees the same document. Fragment
     * boundaries always fall between JSON tokens, so a caller may write
     * insignificant whitespace between two of them to keep a connection busy.
     */
    async *exportAccountDataChunks(
        userId: string,
        options: ExportOptions = {},
    ): AsyncGenerator<string, void, undefined> {
        const { includeSecrets = false } = options;

        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new Error('User not found');
        }
        const works = await this.workRepository.findByUser(userId);
        const exportedUserPlugins = await this.exportUserPlugins(userId, includeSecrets);
        const { tailAgents, tailSkills, tailTasks } = await this.exportTailSections(
            userId,
            options,
        );
        const hasTailRows = !!(tailAgents || tailSkills || tailTasks);

        yield `{"version":${hasTailRows ? 2 : 1},"exportedAt":${JSON.stringify(
            new Date().toISOString(),
        )},"includesSecrets":${JSON.stringify(includeSecrets)},"data":{"profile":${JSON.stringify(
            this.exportProfile(user),
        )},"works":[`;

        let index = 0;
        for await (const exported of this.exportWorksInOrder(works, includeSecrets)) {
            yield `${index > 0 ? ',' : ''}${JSON.stringify(exported)}`;
            index += 1;
        }

        let tail = `],"userPlugins":${JSON.stringify(exportedUserPlugins)}`;
        if (tailAgents) tail += `,"agents":${JSON.stringify(tailAgents)}`;
        if (tailSkills) tail += `,"skills":${JSON.stringify(tailSkills)}`;
        if (tailTasks) tail += `,"tasks":${JSON.stringify(tailTasks)}`;
        yield `${tail}}}`;
    }

    /**
     * Every Work's export, in the order given, with at most
     * {@link ACCOUNT_EXPORT_WORK_CONCURRENCY} being read at once.
     *
     * Each one costs a clone or pull of the Work's data repo — pure-JS git on
     * the API's only event loop — and holds that Work's whole content in
     * memory until it is serialised. All of them at once froze the process
     * and held the whole account in memory; one at a time would leave the
     * network idle while a repo is indexed. A small window keeps the order,
     * bounds both, and lets a consumer that stops reading stop the walk.
     *
     * A Work whose export rejects rejects this walk where it stands, exactly
     * as the `Promise.all` it replaces did; the others still in flight are
     * claimed so none of them surfaces as an unhandled rejection.
     */
    private async *exportWorksInOrder(
        works: readonly any[],
        includeSecrets: boolean,
    ): AsyncGenerator<ExportedWork, void, undefined> {
        const inFlight: Promise<ExportedWork>[] = [];
        let next = 0;
        const startNext = () => {
            if (next >= works.length) return;
            const dir = works[next++];
            const pending = this.exportWork(dir.id, dir, includeSecrets);
            pending.catch(() => undefined);
            inFlight.push(pending);
        };

        for (let i = 0; i < ACCOUNT_EXPORT_WORK_CONCURRENCY; i += 1) startNext();
        while (inFlight.length > 0) {
            const exported = await inFlight.shift()!;
            startNext();
            yield exported;
        }
    }

    private async exportUserPlugins(
        userId: string,
        includeSecrets: boolean,
    ): Promise<ExportedUserPlugin[]> {
        const userPlugins = await this.userPluginRepository.findByUser(userId);
        return userPlugins.map((up) => {
            const exported: ExportedUserPlugin = {
                pluginId: up.pluginId,
                enabled: up.enabled,
                autoEnableForWorks: up.autoEnableForWorks,
                settings: up.settings || {},
            };
            if (includeSecrets && up.secretSettings) {
                // Never export real secrets — only masked representations
                exported.secretSettings = maskSecretSettings(up.secretSettings);
            }
            return exported;
        });
    }

    /**
     * Phase 19.6 — collect the v2 tail when toggles are set + the tail
     * service is bound. Each section is opt-in; the tail is populated only
     * when the corresponding flag is true AND the resulting array has rows,
     * so the payload stays v1-shaped for legacy users.
     */
    private async exportTailSections(
        userId: string,
        options: ExportOptions,
    ): Promise<{
        tailAgents: AccountExportPayload['data']['agents'];
        tailSkills: AccountExportPayload['data']['skills'];
        tailTasks: AccountExportPayload['data']['tasks'];
    }> {
        const wantsTail =
            (options.includeAgents || options.includeSkills || options.includeTasks) === true;
        let tailAgents: AccountExportPayload['data']['agents'];
        let tailSkills: AccountExportPayload['data']['skills'];
        let tailTasks: AccountExportPayload['data']['tasks'];
        if (wantsTail && this.agentsSkillsTasksExport) {
            try {
                const tail = await this.agentsSkillsTasksExport.exportTail(userId, {
                    includeAgents: options.includeAgents,
                    includeSkills: options.includeSkills,
                    includeTasks: options.includeTasks,
                    includeTaskChat: options.includeTaskChat,
                });
                if (tail.agents && tail.agents.length > 0) tailAgents = tail.agents;
                if (tail.skills && tail.skills.length > 0) tailSkills = tail.skills;
                if (tail.tasks && tail.tasks.length > 0) tailTasks = tail.tasks;
            } catch (err) {
                // Best-effort — a tail failure should not break the v1
                // export. Log and continue with the v1 payload.
                this.logger.warn(
                    `v2 tail export failed for user ${userId}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }
        return { tailAgents, tailSkills, tailTasks };
    }

    /**
     * Serialize the account-level profile. Onboarding answers and account
     * preferences are user-authored settings, so they must round-trip —
     * without them an export/import silently resets the "What do you do"
     * answers (and every suggestion surface built on them) plus the digest
     * cadence and the notification/privacy opt-outs.
     *
     * Explicit `false` booleans are serialized (an opt-OUT is exactly the
     * value that must survive); only genuinely absent values are omitted so
     * the importing account keeps its own.
     */
    private exportProfile(user: any): ExportedProfile {
        const profile: ExportedProfile = {
            username: user.username,
            email: user.email,
            avatar: user.avatar || undefined,
        };

        const answers = user.onboardingState?.profile;
        if (answers && typeof answers === 'object') {
            const onboarding: ExportedOnboardingProfile = {};
            if (Array.isArray(answers.roles)) {
                onboarding.roles = answers.roles.filter(
                    (role: unknown): role is string => typeof role === 'string',
                );
            }
            if (typeof answers.teamSize === 'string' && answers.teamSize.length > 0) {
                onboarding.teamSize = answers.teamSize;
            }
            if (Object.keys(onboarding).length > 0) {
                profile.onboarding = onboarding;
            }
        }

        const preferences: ExportedUserPreferences = {};
        if (typeof user.digestFrequency === 'string' && user.digestFrequency.length > 0) {
            preferences.digestFrequency = user.digestFrequency;
        }
        if (typeof user.emailAgentAlerts === 'boolean') {
            preferences.emailAgentAlerts = user.emailAgentAlerts;
        }
        if (typeof user.emailTaskNotifications === 'boolean') {
            preferences.emailTaskNotifications = user.emailTaskNotifications;
        }
        if (typeof user.emailBudgetAlerts === 'boolean') {
            preferences.emailBudgetAlerts = user.emailBudgetAlerts;
        }
        if (typeof user.userResearchOptOut === 'boolean') {
            preferences.userResearchOptOut = user.userResearchOptOut;
        }
        if (Object.keys(preferences).length > 0) {
            profile.preferences = preferences;
        }

        return profile;
    }

    private async exportWork(
        workId: string,
        dir: any,
        includeSecrets: boolean,
    ): Promise<ExportedWork> {
        const [members, customDomains, workPlugins, prompts, scheduleEntity] = await Promise.all([
            this.workMemberRepository.findByWork(workId),
            this.workCustomDomainRepository.findByWork(workId),
            this.workPluginRepository.findByWork(workId),
            this.advancedPromptsRepository.findByWorkId(workId),
            this.scheduleRepository.findByWorkId(workId),
        ]);

        // Fetch items, config, comparisons, and markdown template from the data repo
        const repoData = await this.fetchWorkRepoData(dir);

        // Build schedule if configured
        let schedule: ExportedSchedule | undefined;
        if (scheduleEntity) {
            schedule = {
                cadence: scheduleEntity.cadence,
                status: scheduleEntity.status,
                billingMode: scheduleEntity.billingMode,
                alwaysCreatePullRequest: scheduleEntity.alwaysCreatePullRequest,
                maxFailureBeforePause: scheduleEntity.maxFailureBeforePause,
                providerOverrides: scheduleEntity.providerOverrides || undefined,
            };
        }

        // Build advanced prompts if any are set
        let advancedPrompts: ExportedAdvancedPrompts | undefined;
        if (prompts) {
            const p: ExportedAdvancedPrompts = {};
            if (prompts.relevanceAssessment) p.relevanceAssessment = prompts.relevanceAssessment;
            if (prompts.itemGeneration) p.itemGeneration = prompts.itemGeneration;
            if (prompts.itemExtraction) p.itemExtraction = prompts.itemExtraction;
            if (prompts.searchQuery) p.searchQuery = prompts.searchQuery;
            if (prompts.categorization) p.categorization = prompts.categorization;
            if (prompts.deduplication) p.deduplication = prompts.deduplication;
            if (prompts.sourceValidation) p.sourceValidation = prompts.sourceValidation;
            if (Object.keys(p).length > 0) advancedPrompts = p;
        }

        return {
            name: dir.name,
            slug: dir.slug,
            description: dir.description,
            owner: dir.owner || undefined,
            kind: dir.kind || undefined,
            providerRepositoryEnabled:
                typeof dir.providerRepositoryEnabled === 'boolean'
                    ? dir.providerRepositoryEnabled
                    : undefined,
            taskIsolation: dir.taskIsolation || undefined,
            // Serialize explicit null (= repo default branch) — omitting it
            // would make an overwrite import silently RETAIN a custom base.
            taskIsolationBaseBranch:
                dir.taskIsolationBaseBranch === undefined ? undefined : dir.taskIsolationBaseBranch,
            taskIsolationTargetRepo: dir.taskIsolationTargetRepo || undefined,
            taskBranchCleanup: dir.taskBranchCleanup || undefined,
            // Memory recall toggle — serialize the explicit boolean (a
            // deliberate `false` must round-trip; see ExportedWork).
            memoryRecallEnabled:
                typeof dir.memoryRecallEnabled === 'boolean' ? dir.memoryRecallEnabled : undefined,
            // Ingest routing claims (chat channels / teams / databases /
            // meetings). Serialize the object as-is when present; an
            // absent column exports as undefined so old importers and
            // old payloads both stay happy.
            externalRefs: dir.externalRefs ?? undefined,
            gitProvider: dir.gitProvider,
            deployProvider: dir.deployProvider || undefined,
            readmeConfig: dir.readmeConfig || undefined,
            domainType: dir.domainType || undefined,
            repoVisibility: dir.repoVisibility || undefined,
            scheduledUpdatesEnabled: dir.scheduledUpdatesEnabled,
            scheduledCadence: dir.scheduledCadence || null,
            communityPrEnabled: dir.communityPrEnabled,
            communityPrAutoClose: dir.communityPrAutoClose,
            comparisonsEnabled: dir.comparisonsEnabled,
            // Quality-gate settings must round-trip: a Work that opted into
            // 'warn'/'required' or curated checkDefaults must not silently
            // fall back to 'off'/none on the imported side.
            checkDefaults: Array.isArray(dir.checkDefaults) ? dir.checkDefaults : undefined,
            checksPolicy: dir.checksPolicy || undefined,
            maxGateAttempts:
                typeof dir.maxGateAttempts === 'number' ? dir.maxGateAttempts : undefined,
            members: members.map((m) => ({
                userId: m.userId,
                role: m.role,
            })),
            customDomains: customDomains.map((cd) => ({
                domain: cd.domain,
                environment: cd.environment,
                verified: cd.verified,
                provider: cd.provider || undefined,
            })),
            workPlugins: workPlugins.map((dp) => {
                const exported: any = {
                    pluginId: dp.pluginId,
                    enabled: dp.enabled,
                    activeCapabilities: getActiveCapabilities(dp),
                    settings: dp.settings || {},
                    priority: dp.priority,
                };
                if (includeSecrets && dp.secretSettings) {
                    // Never export real secrets — only masked representations
                    exported.secretSettings = maskSecretSettings(dp.secretSettings);
                }
                return exported;
            }),
            advancedPrompts,
            schedule,
            siteConfig: repoData.siteConfig,
            markdownTemplate: repoData.markdownTemplate,
            items: repoData.items,
            categories: repoData.categories,
            tags: repoData.tags,
            collections: repoData.collections,
            comparisons: repoData.comparisons,
        };
    }

    /**
     * The per-Work content walk, as a public seam.
     *
     * Added by AW-22 so the workspace backup can write each Work's items,
     * categories, tags, collections and comparisons into its archive without
     * a second implementation of "read a Work's items out of its data repo".
     * This is a one-line delegation to the private walk the account export
     * has always used: there is exactly one clone-or-pull, one
     * `DataRepository` read and one failure policy (a repo that will not
     * clone yields empty content and logs, it does not throw), and both
     * callers get the same answer.
     *
     * Deliberately additive — `exportAccountData` and `exportWork` are
     * untouched, so `GET /api/account/export` returns exactly what it
     * returned before.
     */
    async readWorkRepoContent(work: any): Promise<WorkRepoContent> {
        return this.fetchWorkRepoData(work);
    }

    /**
     * The same walk, given a Work ID rather than a Work.
     *
     * `fetchWorkRepoData` resolves the repository coordinates through
     * `Work.getRepoOwner()` and `Work.getDataRepo()` — instance methods on
     * the entity prototype, which consult `sourceRepository.relatedRepositories`
     * and fall back to `owner` / `user.username` and the slug-derived default.
     * A caller holding only `{ id, slug }` therefore cannot use
     * {@link readWorkRepoContent}: the `TypeError` lands inside that method's
     * own try/catch, which logs a warning and returns EMPTY content, so the
     * caller sees a successful read of nothing. That is how the AW-22
     * archive came to write `data/works/content/<slug>/*.jsonl` as zero-line
     * files for every Work while reporting the domain complete.
     *
     * So the entity is loaded here, where the repository is, and `null`
     * means "no such Work" rather than "this Work has no content" — a
     * distinction the caller needs in order to report a gap.
     */
    async readWorkRepoContentById(workId: string): Promise<WorkRepoContent | null> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            return null;
        }
        return this.fetchWorkRepoData(work);
    }

    private async fetchWorkRepoData(dir: any): Promise<{
        items: ExportedWorkItem[];
        categories: ExportedWorkCategory[];
        tags: ExportedWorkTag[];
        collections: ExportedWorkCollection[];
        siteConfig?: Record<string, any>;
        comparisons: ExportedComparison[];
        markdownTemplate?: ExportedMarkdownTemplate;
    }> {
        const empty = {
            items: [],
            categories: [],
            tags: [],
            collections: [],
            siteConfig: undefined,
            comparisons: [],
            markdownTemplate: undefined,
        };

        try {
            const repoOwner = dir.getRepoOwner();
            const dataRepo = dir.getDataRepo();
            const userId = dir.user?.id || dir.userId;

            const dest = await this.gitFacade.cloneOrPull(
                { owner: repoOwner, repo: dataRepo },
                { userId, providerId: dir.gitProvider },
            );

            const data = await DataRepository.create(dest);

            const [items, categories, tags, collections, siteConfig, comparisons, mdTemplate] =
                await Promise.all([
                    data.getItems().catch(() => []),
                    data.getCategories().catch(() => []),
                    data.getTags().catch(() => []),
                    data.getCollections().catch(() => []),
                    data.getConfig().catch(() => null),
                    data.getComparisons().catch(() => []),
                    data.readMarkdownTemplate().catch(() => null),
                ]);

            // Build comparisons with markdown
            const exportedComparisons: ExportedComparison[] = [];
            for (const comp of comparisons) {
                const md = await data.getComparisonMarkdown(comp.slug).catch(() => undefined);
                exportedComparisons.push({ ...comp, markdown: md } as ExportedComparison);
            }

            return {
                items: items as ExportedWorkItem[],
                categories: categories as ExportedWorkCategory[],
                tags: tags as ExportedWorkTag[],
                collections: collections as ExportedWorkCollection[],
                siteConfig: siteConfig || undefined,
                comparisons: exportedComparisons,
                markdownTemplate:
                    mdTemplate && (mdTemplate.header || mdTemplate.footer) ? mdTemplate : undefined,
            };
        } catch (error) {
            this.logger.warn(
                `Failed to fetch repo data for work "${dir.slug}": ${error instanceof Error ? error.message : String(error)}`,
            );
            return empty;
        }
    }
}
