import { z } from 'zod';
import { tool } from 'ai';
import { APP_REPOSITORY_MODES, type AppSourceInspectResponse } from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import { workAPI, type Work } from '@/lib/api/work';
import {
    createWork,
    createWorkWithAI,
    deleteWork,
    getWorkStats,
    updateWork,
    syncWorkData,
    fetchWorkGenerationHistory,
    analyzeRepository,
    importWork,
    inspectAppSourceAction,
} from '@/app/actions/dashboard/works';
import { resolveGenerationConfig } from './utils';
import type { UserConfirmationCheck } from './generated/confirmation';
import { CONFIRMED_FIELD_DESCRIPTION, requireUserConfirmation } from './confirm-gate';

// Work-kind chip vocabulary (mirrors `InitialWorkKind` in
// works/new/new-work-client.tsx and the server action's aiWorkKindSchema).
// When the user's message says what they're building ("I want to create a
// landing page…"), passing the matching kind persists it on the Work so
// the kind-aware default website template applies.
const workKindEnum = z.enum([
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
    'repo',
    // APW-01 T25 — an App Work: a running open-source app built from an existing
    // GitHub repository (linked, forked or copied). Created behind confirmation.
    'app',
]);

const workKindSchema = workKindEnum.describe(
    'Kind of Work the user asked for (from their message, e.g. "I want to create a landing page" → landing-page). ' +
        '"repo" registers an EXISTING code repository as a Work (needs repositoryUrl; use createWorkManual, never the AI creator). ' +
        '"app" creates an App Work — a running app — from an existing GitHub repository: call inspectAppSource first, ' +
        'then createWorkManual with repositoryUrl, repositoryMode and (for fork / private-copy) targetOwner. Omit if unclear.',
);

// The AI creator cannot collect a repositoryUrl, so a `repo` Work is not
// something it can validly ask for — the description used to say so and hope.
// Excluding it from the schema means a model that tries anyway gets a
// validation error instead of a Work that fails registration. The same goes
// for `app` (APW-01 T25): it needs a repository, a mode and the user's
// confirmation, none of which the AI creator collects.
const aiWorkKindSchema = workKindEnum
    .exclude(['repo', 'app'])
    .describe(
        'Kind of Work the user asked for (from their message, e.g. "I want to create a landing page" → landing-page). ' +
            'To register an EXISTING code repository, use createWorkManual with kind "repo" and a repositoryUrl; ' +
            'to run an existing open-source app, use createWorkManual with kind "app". Omit if unclear.',
    );

const repositoryModeSchema = z
    .enum(APP_REPOSITORY_MODES)
    .describe(
        'App Work only (kind "app"): how the repository becomes the App Work’s repository — "link" (use it as is; ' +
            'needs push access), "fork" (fork it into targetOwner) or "private-copy" (a private copy in targetOwner). ' +
            'Use a mode inspectAppSource reports as available; its defaultMode when the user did not choose.',
    );

/**
 * APW-01 T32 — what the model sees of an inspection: the repository's facts, the modes with their
 * reasons, the default mode, the owners a fork or copy can go to, the Blueprint and the licence.
 * No URL is echoed beyond `fullName` (the user pasted it; the provider's other URLs add nothing), and
 * the Blueprint's prompts are counted, not listed — their answers are set in the Deploy tab.
 */
export function summarizeAppSourceInspection(preview: AppSourceInspectResponse) {
    const { repository, blueprint } = preview;
    return {
        repository: {
            fullName: repository.fullName,
            description: repository.description,
            defaultBranch: repository.defaultBranch,
            stars: repository.stars,
            visibility: repository.visibility,
            archived: repository.archived,
            isFork: repository.isFork,
            ...(repository.parent ? { parent: repository.parent } : {}),
        },
        access: preview.access,
        modes: preview.modes,
        defaultMode: preview.defaultMode,
        targetOwners: preview.targetOwners.map((owner) => ({
            login: owner.login,
            type: owner.type,
            available: owner.available,
            ...(owner.reason ? { reason: owner.reason } : {}),
            ...(owner.existingFork ? { existingFork: owner.existingFork.fullName } : {}),
        })),
        blueprint: {
            status: blueprint.status,
            ...(blueprint.id ? { id: blueprint.id } : {}),
            ...(blueprint.name ? { name: blueprint.name } : {}),
            ...(blueprint.version ? { version: blueprint.version } : {}),
            ...(blueprint.verified !== undefined ? { verified: blueprint.verified } : {}),
            promptCount: blueprint.prompts?.length ?? 0,
        },
        license: preview.license,
        deployTargets: Object.fromEntries(
            Object.entries(preview.deployTargets).map(([target, availability]) => [
                target,
                {
                    available: availability.available,
                    ...(availability.reason ? { reason: availability.reason } : {}),
                },
            ]),
        ),
        ...(preview.existingAppWork ? { existingAppWork: preview.existingAppWork } : {}),
        scanIncomplete: preview.scanIncomplete,
        ...(preview.retryAfter ? { retryAfter: preview.retryAfter } : {}),
    };
}

/**
 * APW-01 T25/T42 — the confirmation card's sentence for an App Work create: which repository is
 * created (a fork or a private copy, and where) or which one a setup pull request is opened on (a
 * link), and the Blueprint the server will apply when one matched — so a Blueprint is never applied
 * unseen.
 */
export function describeAppWorkCreate(
    preview: AppSourceInspectResponse,
    mode: (typeof APP_REPOSITORY_MODES)[number],
    targetOwner: string | undefined,
): string {
    const source = preview.repository.fullName;
    const repo = preview.repository.repo;
    let sentence: string;
    if (mode === 'link') {
        sentence = `Create an App Work from ${source} (linked as is; a setup pull request is opened on ${source})`;
    } else if (mode === 'fork') {
        sentence = `Create an App Work by forking ${source} into ${targetOwner}/${repo}`;
    } else {
        sentence = `Create an App Work as a private copy of ${source} in ${targetOwner}`;
    }
    if (preview.blueprint.status === 'matched') {
        sentence += ` with the ${preview.blueprint.name ?? preview.blueprint.id ?? 'matched'} App Blueprint`;
    }
    return `${sentence}.`;
}

// ────────────────────────────────────────────────────────────────
// Read
// ────────────────────────────────────────────────────────────────

export const listWorks = tool({
    description:
        'List Works the user has access to. Use to find Works by name before other operations.',
    inputSchema: z.object({
        search: z.string().optional().describe('Search query to filter by name'),
        limit: z.number().optional().describe('Max results (default 20)'),
        offset: z.number().optional().describe('Pagination offset (default 0)'),
    }),
    execute: async ({ search, limit, offset }) => {
        const result = await workAPI.getAll({
            search,
            limit: limit ?? 20,
            offset: offset ?? 0,
        });
        return {
            works: result.works.map((d: Work) => ({
                id: d.id,
                name: d.name,
                slug: d.slug,
                itemsCount: d.itemsCount ?? 0,
                generateStatus: d.generateStatus?.status ?? 'idle',
                generateWarnings: d.generateStatus?.warnings ?? [],
                gitProvider: d.gitProvider,
                deployProvider: d.deployProvider,
                url: ROUTES.DASHBOARD_WORK(d.id),
            })),
            total: result.total,
            hasMore: (offset ?? 0) + (limit ?? 20) < result.total,
        };
    },
});

export const getWorkDetails = tool({
    description: 'Get detailed info about a specific Work.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
    }),
    execute: async ({ workId }) => {
        const { work } = await workAPI.get(workId);
        return {
            id: work.id,
            name: work.name,
            slug: work.slug,
            description: work.description,
            itemsCount: work.itemsCount ?? 0,
            generateStatus: work.generateStatus?.status ?? 'idle',
            generateWarnings: work.generateStatus?.warnings ?? [],
            gitProvider: work.gitProvider,
            deployProvider: work.deployProvider,
            url: ROUTES.DASHBOARD_WORK(work.id),
        };
    },
});

export const getStats = tool({
    description: 'Get aggregated stats — total Works, items, active websites.',
    inputSchema: z.object({}),
    execute: async () => getWorkStats(),
});

export const getWorkItemsSummary = tool({
    description:
        'Get item counts and categories for a Work. For browsing items, navigate to items tab instead.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
    }),
    execute: async ({ workId }) => {
        try {
            const counts = await workAPI.getCount(workId);
            const catTags = await workAPI.getCategoriesTags(workId);
            return {
                ...counts,
                categories: catTags.categories?.slice(0, 20) ?? [],
                tags: catTags.tags?.slice(0, 20) ?? [],
            };
        } catch {
            return { error: 'Failed to fetch items summary' };
        }
    },
});

export const getGenerationHistory = tool({
    description: 'Get generation history — past runs, status, and metrics.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
        limit: z.number().optional().describe('Max results (default 10)'),
    }),
    execute: async ({ workId, limit }) => {
        const result = await fetchWorkGenerationHistory(workId, { limit: limit ?? 10 });
        return { success: result.success, data: result.data, error: result.error };
    },
});

export const getScheduleStatus = tool({
    description: 'Get current schedule configuration and status for a Work.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
    }),
    execute: async ({ workId }) => {
        try {
            return await workAPI.getSchedule(workId);
        } catch {
            return { enabled: false, error: 'Failed to fetch schedule' };
        }
    },
});

export const getWorkConfig = tool({
    description:
        'Get Work configuration — metadata, generation settings, website config. (The raw stored generation prompt is omitted.)',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
    }),
    execute: async ({ workId }) => {
        try {
            const result = await workAPI.getConfig(workId);
            // Security: the raw stored generation prompt is user-authored free
            // text and is fed straight back into the model context as tool
            // output — a stored-prompt-injection vector (a Work created with a
            // payload like "ignore previous instructions …" could hijack a later
            // chat that calls getWorkConfig for it). Strip the free-text prompt
            // blobs (initial_prompt + the raw last_request_data request dump,
            // which also carries .prompt) while keeping the structured website /
            // generation config the tool exists to surface.
            const { config } = result;
            if (config?.metadata) {
                const safeMetadata = { ...config.metadata };
                delete safeMetadata.initial_prompt;
                delete safeMetadata.last_request_data;
                return { success: true, config: { ...config, metadata: safeMetadata } };
            }
            return { success: true, config };
        } catch {
            return { success: false, error: 'Failed to fetch config' };
        }
    },
});

// ────────────────────────────────────────────────────────────────
// Create
// ────────────────────────────────────────────────────────────────

/**
 * APW-01 T32 — `inspectAppSource`: the create form's "Check repository", read-only. It writes
 * nothing (no repository, no row, no Activity — FR-5), so it needs no confirmation.
 */
export const inspectAppSource = tool({
    description: [
        'Check a GitHub repository before creating an App Work (a running open-source app) from it.',
        'Read-only — writes nothing.',
        'Answers which modes are available (link / fork / private-copy) and why not, the default mode,',
        'the accounts a fork or copy can go to, the matched App Blueprint and the licence.',
        'Use it for "can I run / self-host / fork github.com/…?" and always before createWorkManual with kind "app".',
    ].join(' '),
    inputSchema: z.object({
        repositoryUrl: z
            .string()
            .describe('The https://github.com/<owner>/<repo> URL the user gave'),
        gitProvider: z
            .string()
            .optional()
            .describe('Git provider ID from checkGitConnection (optional)'),
    }),
    execute: async ({ repositoryUrl, gitProvider }) => {
        const result = await inspectAppSourceAction({
            repositoryUrl,
            ...(gitProvider ? { gitProvider } : {}),
        });
        if (!result.success) {
            return {
                success: false,
                error: result.error,
                ...(result.code ? { code: result.code } : {}),
                ...(result.details ? { details: result.details } : {}),
            };
        }
        return { success: true, ...summarizeAppSourceInspection(result.data) };
    },
});

/**
 * Build `createWorkManual`.
 *
 * Every kind but `app` is created at once, as before. An App Work (APW-01 T25/T42) forks or
 * copies a repository into the user's account, or opens a setup pull request on theirs, so it is
 * behind the same confirmation handshake as the generated tools: the tool inspects the repository
 * first (read-only), refuses a mode the inspection says is unavailable, and returns a card that
 * names the repository to be created — or the one a setup pull request is opened on — and the App
 * Blueprint the server will apply. Only a `confirmed: true` call backed by the user's own latest
 * message (`userConfirmed`) creates it. No `blueprintId` is ever sent: the server picks the
 * Blueprint from its resolution order, the same one the card named.
 */
export function createCreateWorkManualTool(userConfirmed?: UserConfirmationCheck) {
    return tool({
        description: [
            'Create a Work manually WITHOUT generating content.',
            'Just creates the repository structure. User can add items later.',
            'REQUIRES git provider — call checkGitConnection first.',
            'For an App Work (kind "app"): call inspectAppSource first; the call returns a confirmation card —',
            'call once without `confirmed`, then again with `confirmed: true` only after the user agrees.',
        ].join(' '),
        inputSchema: z.object({
            name: z.string().describe('Work name'),
            slug: z.string().describe('URL-friendly slug (lowercase, hyphens only)'),
            description: z.string().optional().describe('Work description'),
            gitProvider: z.string().describe('Git provider ID from checkGitConnection'),
            kind: workKindSchema.optional(),
            repositoryUrl: z
                .string()
                .optional()
                .describe(
                    'Repository Work (kind "repo"): the existing https://github.com/<owner>/<repo> to register as the Work\'s data repository. ' +
                        'App Work (kind "app"): the repository the app is built from.',
                ),
            repositoryMode: repositoryModeSchema.optional(),
            targetOwner: z
                .string()
                .optional()
                .describe(
                    'App Work only, for "fork" / "private-copy": the account (a login from inspectAppSource targetOwners) the repository is created in.',
                ),
            confirmed: z.boolean().optional().describe(CONFIRMED_FIELD_DESCRIPTION),
        }),
        execute: async ({
            name,
            slug,
            description,
            gitProvider,
            kind,
            repositoryUrl,
            repositoryMode,
            targetOwner,
            confirmed,
        }) => {
            if (kind === 'app') {
                return createAppWork(
                    {
                        name,
                        slug,
                        description,
                        gitProvider,
                        repositoryUrl,
                        repositoryMode,
                        targetOwner,
                    },
                    confirmed,
                    userConfirmed,
                );
            }
            const result = await createWork({
                name,
                slug,
                description: description ?? '',
                gitProvider,
                organization: false,
                kind,
                repositoryUrl,
            });
            return {
                success: result.success,
                workId: result.work?.id,
                message: result.message,
                error: result.error,
                url: result.work ? ROUTES.DASHBOARD_WORK(result.work.id) : undefined,
            };
        },
    });
}

interface AppWorkCreateInput {
    name: string;
    slug: string;
    description?: string;
    gitProvider: string;
    repositoryUrl?: string;
    repositoryMode?: (typeof APP_REPOSITORY_MODES)[number];
    targetOwner?: string;
}

/** The App Work branch of `createWorkManual`: inspect → refuse or card → create once confirmed. */
async function createAppWork(
    input: AppWorkCreateInput,
    confirmed: boolean | undefined,
    userConfirmed: UserConfirmationCheck | undefined,
) {
    const repositoryUrl = input.repositoryUrl?.trim();
    if (!repositoryUrl || !input.repositoryMode) {
        return {
            success: false,
            error:
                'An App Work needs repositoryUrl and repositoryMode. Call inspectAppSource with the repository first ' +
                'and use one of the modes it reports as available.',
        };
    }
    const mode = input.repositoryMode;
    const targetOwner = mode === 'link' ? undefined : input.targetOwner?.trim() || undefined;

    const inspection = await inspectAppSourceAction({
        repositoryUrl,
        gitProvider: input.gitProvider,
    });
    if (!inspection.success) {
        return {
            success: false,
            error: inspection.error,
            ...(inspection.code ? { code: inspection.code } : {}),
            ...(inspection.details ? { details: inspection.details } : {}),
        };
    }
    const preview = inspection.data;
    const availability = preview.modes[mode];
    if (!availability?.available) {
        return {
            success: false,
            error: `The "${mode}" mode is not available for ${preview.repository.fullName}.`,
            ...(availability?.reason ? { code: availability.reason } : {}),
            modes: preview.modes,
            defaultMode: preview.defaultMode,
        };
    }
    if (mode !== 'link') {
        const owner = targetOwner
            ? preview.targetOwners.find((candidate) => candidate.login === targetOwner)
            : undefined;
        if (!owner?.available) {
            return {
                success: false,
                error: targetOwner
                    ? `${targetOwner} cannot receive the ${mode} of ${preview.repository.fullName}.`
                    : `A ${mode} needs targetOwner: one of the available accounts inspectAppSource lists.`,
                ...(owner?.reason ? { code: owner.reason } : {}),
                targetOwners: preview.targetOwners
                    .filter((candidate) => candidate.available)
                    .map((candidate) => candidate.login),
            };
        }
    }

    // The card binds to exactly these arguments (everything the model passed but `confirmed`).
    const cardArgs: Record<string, unknown> = {
        name: input.name,
        slug: input.slug,
        gitProvider: input.gitProvider,
        kind: 'app',
        repositoryUrl,
        repositoryMode: mode,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(targetOwner ? { targetOwner } : {}),
    };
    const card = requireUserConfirmation({
        toolName: 'createWorkManual',
        action: describeAppWorkCreate(preview, mode, targetOwner),
        target: preview.repository.fullName,
        args: cardArgs,
        confirmed,
        userConfirmed,
    });
    if (card) return card;

    const description =
        input.description?.trim() ||
        preview.repository.description?.trim() ||
        preview.repository.fullName;
    const result = await createWork({
        name: input.name,
        slug: input.slug,
        description,
        gitProvider: input.gitProvider,
        organization: false,
        kind: 'app',
        repositoryUrl: preview.repository.url,
        repositoryMode: mode,
        ...(targetOwner ? { targetOwner } : {}),
    });
    return {
        success: result.success,
        workId: result.work?.id,
        message: result.message,
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
        ...(result.alreadyExisted ? { alreadyExisted: true } : {}),
        ...(result.appSource ? { appSource: result.appSource } : {}),
        url: result.work ? ROUTES.DASHBOARD_WORK(result.work.id) : undefined,
    };
}

/** Legacy flag-only instance (no user-turn check) — kept for existing imports. */
export const createWorkManual = createCreateWorkManualTool();

export const createWorkWithAITool = tool({
    description: [
        'Create a Work AND generate content using AI.',
        'BEFORE calling: call checkGitConnection, then listAvailablePipelines to let user choose pipeline/providers.',
        'Pass user provider choices. If not provided, uses defaults.',
    ].join(' '),
    inputSchema: z.object({
        name: z.string().describe('Work name'),
        prompt: z.string().describe('What the Work should contain'),
        gitProvider: z.string().describe('Git provider ID from checkGitConnection'),
        deployProvider: z
            .string()
            .optional()
            .describe('Deploy provider ID from checkDeployConnection'),
        providers: z
            .record(z.string(), z.string())
            .optional()
            .describe(
                'User-chosen providers from listAvailablePipelines (e.g., { pipeline: "sim-ai", ai: "openrouter" })',
            ),
        workKind: aiWorkKindSchema.optional(),
    }),
    execute: async ({
        name,
        prompt,
        gitProvider,
        deployProvider,
        providers: userProviders,
        workKind,
    }) => {
        // Resolve defaults, then override with user choices
        const config = await resolveGenerationConfig();
        const mergedProviders = userProviders ?? config.providers;

        const result = await createWorkWithAI({
            name,
            prompt,
            gitProvider,
            deployProvider,
            providers: mergedProviders,
            pluginConfig: config.pluginConfig,
            workKind,
        });
        return {
            success: result.success,
            workId: result.work?.id,
            message: result.message,
            isGenerating: result.isGenerating,
            error: result.error,
            url: result.work ? ROUTES.DASHBOARD_WORK(result.work.id) : undefined,
        };
    },
});

export const importWorkTool = tool({
    description: [
        'Import a Work from an existing GitHub repository or awesome list URL.',
        'First call analyzeImportSource to check the URL, then import.',
        'REQUIRES git provider — call checkGitConnection first.',
    ].join(' '),
    inputSchema: z.object({
        sourceUrl: z.string().describe('GitHub repository URL or awesome list URL to import'),
        sourceType: z
            .enum(['data_repo', 'awesome_readme', 'link_existing', 'works_config'])
            .describe('Type of import source'),
        name: z.string().describe('Work name'),
        gitProvider: z.string().describe('Git provider ID from checkGitConnection'),
    }),
    execute: async ({ sourceUrl, sourceType, name, gitProvider }) => {
        const result = await importWork({ sourceUrl, sourceType, name, gitProvider });
        return {
            success: result.success,
            workId: result.workId,
            message: result.message,
            error: result.error,
            url: result.workId ? ROUTES.DASHBOARD_WORK(result.workId) : undefined,
        };
    },
});

export const analyzeImportSource = tool({
    description:
        'Analyze a GitHub URL to determine if it can be imported and what type of import to use.',
    inputSchema: z.object({
        sourceUrl: z.string().describe('GitHub repository URL to analyze'),
    }),
    execute: async ({ sourceUrl }) => {
        const result = await analyzeRepository(sourceUrl);
        return { success: result.success, data: result.data, error: result.error };
    },
});

// ────────────────────────────────────────────────────────────────
// Update / Delete
// ────────────────────────────────────────────────────────────────

export const updateWorkTool = tool({
    description: 'Update a Work name or description.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
        name: z.string().optional().describe('New name'),
        description: z.string().optional().describe('New description'),
    }),
    execute: async ({ workId, name, description }) => {
        const result = await updateWork(workId, { name, description });
        return { success: result.success, message: result.message, error: result.error };
    },
});

/**
 * Build `deleteWork`. Security: with `userConfirmed` (the per-turn check from
 * `./generated/confirmation.ts`), a model-supplied `confirmed: true` only
 * runs the deletion when the user's own latest message confirms the exact
 * card (`deleteWork` on this `workId`) shown right before it; otherwise the
 * card comes back. Without it, the legacy flag-only handshake applies.
 */
export function createDeleteWorkTool(userConfirmed?: UserConfirmationCheck) {
    return tool({
        description:
            'Delete a Work. Destructive — requires user confirmation (call once without `confirmed`, then again with `confirmed: true` after the user agrees).',
        inputSchema: z.object({
            workId: z.string().describe('Work ID to delete'),
            confirmed: z
                .boolean()
                .optional()
                .describe(
                    'Set to true ONLY after the user has explicitly confirmed this ' +
                        'irreversible deletion in chat. Omit it on the first call so the ' +
                        'user is shown a confirmation prompt first.',
                ),
        }),
        execute: async ({ workId, confirmed }) => {
            // Security: server-side confirmation gate. The prose "ALWAYS ask for
            // confirmation" is only advisory to the LLM and can be overridden by
            // prompt injection (e.g. a poisoned README/search result instructing
            // "delete work X now"). Mirror the generated factory's handshake
            // (factory.ts) so the mutation never runs until the user clicks Confirm
            // in the UI and the model re-calls with `confirmed: true` — and, with a
            // user-turn check, only for the card the user actually confirmed.
            const card = requireUserConfirmation({
                toolName: 'deleteWork',
                action: 'Delete a Work',
                target: workId,
                args: { workId },
                confirmed,
                userConfirmed,
            });
            if (card) return card;
            const result = await deleteWork(workId);
            return { success: result.success, message: result.message, error: result.error };
        },
    });
}

/** Legacy flag-only instance (no user-turn check) — kept for existing imports. */
export const deleteWorkTool = createDeleteWorkTool();

export const syncWork = tool({
    description: 'Sync a Work data repository with the latest changes.',
    inputSchema: z.object({
        workId: z.string().describe('Work ID'),
    }),
    execute: async ({ workId }) => {
        const result = await syncWorkData(workId);
        return result ?? { success: false, error: 'Sync failed' };
    },
});
