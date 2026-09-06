'use server';

import { z } from 'zod';
import {
    workAPI,
    CreateWorkDto,
    itemsGeneratorAPI,
    UpdateWorkDto,
    DeleteWorkDto,
    SyncWorkResponse,
    AnalyzeRepositoryResponseDto,
    ImportWorkDto,
    GetUserRepositoriesResponseDto,
    UpdateWorkSchedulePayload,
    UpdateWorkAdvancedPromptsDto,
    GitProviderConnectionInfo,
} from '@/lib/api';
import type { Work } from '@/lib/api/types-only';
import type {
    MergePolicyOverride,
    TaskAcceptanceCheck,
    WorkChecksPolicy,
    WorkExternalRefs,
} from '@ever-works/contracts';
import {
    INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS,
    WORK_EXTERNAL_REFS_MAX_PER_KIND,
    WORK_EXTERNAL_REF_KINDS,
} from '@ever-works/contracts';
// Security: server actions are reachable as POST endpoints via the
// `Next-Action` header, so every exported action must independently verify
// authentication at the Next.js layer before proxying to backend
// mutation/read endpoints — UI gating alone is not a security boundary.
// Mirrors work-proposals.ts / work-schedule.ts.
import { getAuthFromCookie } from '@/lib/auth';
import { checkGitProviderConnection } from './oauth';
import {
    EVER_WORKS_GIT_STORAGE,
    resolveManagedStorageStatus,
    type ManagedStorageStatus,
} from '@/lib/works/managed-storage';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { ROUTES } from '@/lib/constants';
import { redirect } from 'next/navigation';
import { sanitizeName, sanitizeDescription, sanitizePrompt } from '@/lib/utils/sanitize';
import { slugify } from '@ever-works/plugin';
import { ApiResponseError, serverMutation } from '@/lib/api/server-api';
import { workProposalsAPI } from '@/lib/api/work-proposals';

const readmeConfigSchema = z.object({
    header: z.string().optional(),
    overwriteDefaultHeader: z.boolean().optional(),
    footer: z.string().optional(),
    overwriteDefaultFooter: z.boolean().optional(),
});

// Work-kind chip vocabulary (see `InitialWorkKind` in
// works/new/new-work-client.tsx). Persisted on `work.kind` by the API so
// the kind-aware default website template applies (general-purpose kinds
// → the `web` template). The API whitelists again server-side.
const workKindSchema = z.enum([
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
    'repo',
]);

// `repo` is manual-only: registering one means naming an existing repository,
// and the AI creation path neither collects nor constructs `repositoryUrl`, so
// a Work created there with `kind: 'repo'` could never satisfy the API's
// registration contract. Excluded at the schema so it cannot arrive at all.
const aiWorkKindSchema = workKindSchema.exclude(['repo']);
type AIWorkKind = z.infer<typeof aiWorkKindSchema>;

const getCreateWorkSchema = async () => {
    const t = await getTranslations('actions.works');

    const createWorkSchema = z.object({
        slug: z
            .string()
            .min(1, t('slug.required'))
            .transform((val) => val.trim().toLowerCase())
            .pipe(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, t('slug.format'))),
        name: z
            .string()
            .min(1, t('name.required'))
            .transform((val) => sanitizeName(val, 100))
            .pipe(z.string().max(100, t('name.maxLength'))),
        description: z
            .string()
            .min(1, t('description.required'))
            .transform((val) => sanitizeDescription(val, 500))
            .pipe(z.string().max(500, t('description.maxLength'))),
        owner: z
            .string()
            .optional()
            .transform((val) => val?.trim()),
        organization: z.boolean(),
        gitProvider: z.string().optional(),
        deployProvider: z.string().optional(),
        // Storage provider (`ever-works-git` | `user-github` | …). zod strips
        // unknown keys, so this MUST be declared or the field is silently
        // dropped on its way to `CreateWorkDto` and the API is left to
        // re-infer the choice from onboarding state.
        storageProvider: z.string().optional(),
        websiteTemplateId: z.string().optional(),
        // Optional work-kind chip value — kept in the parsed output so it
        // reaches the API's CreateWorkDto (zod strips unknown keys). This is
        // the MANUAL create path, which does collect `repositoryUrl`, so the
        // full vocabulary applies here.
        kind: workKindSchema.optional(),
        // Repository Work (`kind: 'repo'`) — the existing repository the
        // Work wraps. Declared so zod keeps it; the API parses + validates.
        repositoryUrl: z
            .string()
            .optional()
            .transform((val) => val?.trim() || undefined)
            .pipe(z.string().max(400).optional()),
        readmeConfig: readmeConfigSchema.optional(),
    });

    return createWorkSchema;
};

async function markProposalAcceptedWithRetry(proposalId: string, workId: string): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            await workProposalsAPI.accept(proposalId, workId);
            revalidatePath('/[locale]/(dashboard)/(home)', 'page');
            return;
        } catch (error) {
            if (attempt === 2) {
                console.warn('Failed to mark Work proposal as accepted after AI Work creation:', {
                    proposalId,
                    workId,
                    error,
                });
            }
        }
    }
}

const checkOrganization = (
    connectionInfo: GitProviderConnectionInfo | null,
    data: { owner?: string; organization?: boolean },
) => {
    if (!connectionInfo?.connected) {
        return {
            organization: data.organization || false,
            owner: data.owner || undefined,
        };
    }

    const username = connectionInfo.username;

    if (!data.organization) {
        return {
            organization: false,
            owner: username || undefined,
        };
    }

    const owner = data.owner?.trim();

    if (owner && username && owner !== username) {
        return {
            organization: true,
            owner: owner || undefined,
        };
    }

    return {
        organization: false,
        owner: username || undefined,
    };
};

/**
 * Outcome of the create-time git-provider gate. `ok: true` carries the
 * connection info the owner/organization resolution needs (or `null` when no
 * personal provider was involved at all).
 *
 * The reason codes exist so callers can keep their exact user-facing copy —
 * "connect a git provider" vs "connect <provider>" — while the decision
 * itself lives in one place.
 */
type CreateWorkGitGate =
    | { readonly ok: true; readonly connectionInfo: GitProviderConnectionInfo | null }
    | { readonly ok: false; readonly reason: 'missing-provider' }
    | { readonly ok: false; readonly reason: 'not-connected'; readonly providerId: string };

/**
 * Decide whether creating a Work requires a *personal* connected git
 * provider.
 *
 * It does NOT when the user's effective storage choice is the managed
 * `ever-works-git` and the platform has that feature enabled: the API creates
 * the repository in the `ever-works-cloud` org with the platform's own PAT
 * (`WorkLifecycleService.createWork`'s `storageProvider === 'ever-works-git'`
 * branch), so there is nothing for the user to connect. Blocking here made
 * the single core action of the product impossible for every user who took
 * the wizard's DEFAULT storage option — `POST /works` would have accepted the
 * request.
 *
 * It DOES for every personal choice (`user-github`, …): those repositories
 * are created with the user's own OAuth token, so an unconnected provider is
 * a genuine, pre-flight-detectable failure. That path is unchanged.
 */
async function resolveCreateWorkGitGate(
    providerId: string | undefined,
    managedStorage: ManagedStorageStatus,
): Promise<CreateWorkGitGate> {
    if (managedStorage.managedGitActive) {
        return { ok: true, connectionInfo: null };
    }

    if (!providerId) {
        return { ok: false, reason: 'missing-provider' };
    }

    const connectionCheck = await checkGitProviderConnection(providerId);
    if (!connectionCheck.connected) {
        return { ok: false, reason: 'not-connected', providerId };
    }

    return { ok: true, connectionInfo: connectionCheck as GitProviderConnectionInfo };
}

/**
 * The `storageProvider` value to send with `CreateWorkDto`. Sending it
 * explicitly (rather than letting the API infer it from onboarding state)
 * keeps the web's gate decision and the server's provisioning decision keyed
 * off the SAME value — they can no longer disagree about which storage a
 * given create used.
 */
function storageProviderForCreate(managedStorage: ManagedStorageStatus): string | undefined {
    return managedStorage.managedGitActive ? EVER_WORKS_GIT_STORAGE : undefined;
}

export async function createWork(data: CreateWorkDto) {
    // Security: verify authentication at the server-action boundary.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.works');

    const createWorkSchema = await getCreateWorkSchema();

    try {
        // Validate input data
        const validation = createWorkSchema.safeParse(data);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const providerId = validation.data.gitProvider;
        // An explicit `storageProvider` on the DTO wins, exactly as it does in
        // `resolveProviderDefaults` — so the gate below is decided from the
        // same value this request will carry to the API. Resolving the gate
        // from onboarding state while sending a different provider is how the
        // two tiers would silently disagree again.
        const managedStorage = await resolveManagedStorageStatus(validation.data.storageProvider);

        // Repository Work (self-build slice D, EW-766): the API verifies that
        // the caller can read the repository with THEIR OWN connected
        // account before it registers anything, so managed storage — which
        // needs no personal connection — is no shortcut for the kind. Gate
        // on a personal connection so the form says "connect GitHub" up
        // front instead of relaying the API's 400 after the round-trip.
        const gate = await resolveCreateWorkGitGate(
            providerId,
            validation.data.kind === 'repo'
                ? { ...managedStorage, managedGitActive: false }
                : managedStorage,
        );
        if (!gate.ok) {
            return {
                success: false,
                error: t('oauthRequired', {
                    provider: gate.reason === 'not-connected' ? gate.providerId : 'git provider',
                }),
                requiresGitProvider: true,
            };
        }

        const { organization, owner } = checkOrganization(gate.connectionInfo, validation.data);

        // Under managed storage the API replaces owner / organization with the
        // platform org once it has provisioned the repo, so these two only
        // matter on the personal path.
        validation.data.organization = organization;
        validation.data.owner = owner;
        validation.data.gitProvider = providerId;
        validation.data.deployProvider = data.deployProvider || undefined;
        validation.data.storageProvider =
            validation.data.storageProvider ?? storageProviderForCreate(managedStorage);

        // Security: do not log validated work-creation payload (contains git
        // provider id, owner/org, slug, name, description) to server stdout.

        // Create the work with validated data
        const { work } = await workAPI.create(validation.data);

        return {
            success: true,
            work,
            message: t('createSuccess'),
        };
    } catch (error) {
        console.error('Failed to create Work:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('createFailed'),
        };
    }
}

const AI_WORK_KIND_PROMPT_LABELS: Record<AIWorkKind, string> = {
    website: 'website',
    'landing-page': 'landing page',
    blog: 'blog',
    directory: 'directory',
    'awesome-repo': 'awesome repository list',
};

interface AIWorkOptions {
    name: string;
    /**
     * Optional user-provided slug. When present we honor it (after
     * sanitisation by the schema) instead of falling back to
     * `slugify(name)`. The combined Create form lets users override
     * the auto-generated slug, so we need a way to plumb it through.
     */
    slug?: string;
    prompt: string;
    organization?: boolean;
    owner?: string;
    gitProvider?: string;
    deployProvider?: string;
    websiteTemplateId?: string;
    providers?: {
        search?: string;
        screenshot?: string;
        ai?: string;
        contentExtractor?: string;
        pipeline?: string;
    };
    pluginConfig?: Record<string, unknown>;
    proposalId?: string;
    workKind?: AIWorkKind;
}

export async function createWorkWithAI(request: AIWorkOptions) {
    // Security: verify authentication at the server-action boundary before
    // triggering AI work generation.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.works');

    // AI prompt validation schema. `slug` is optional — when the
    // user typed an override in the form we run it through the same
    // shape check `getCreateWorkSchema()` uses (lowercase letters,
    // digits, hyphens); when missing we fall back to slugify(name)
    // below.
    const aiPromptSchema = z.object({
        prompt: z
            .string()
            .min(10, t('prompt.minLength'))
            .transform((val) => sanitizePrompt(val, 1000))
            .pipe(z.string().max(1000, t('prompt.maxLength'))),
        name: z
            .string()
            .min(1, t('name.required'))
            .transform((val) => sanitizeName(val, 100))
            .pipe(z.string().max(100, t('name.maxLength'))),
        slug: z
            .string()
            .optional()
            .transform((val) => val?.trim().toLowerCase())
            .pipe(
                z
                    .string()
                    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, t('slug.format'))
                    .optional(),
            ),
        gitProvider: z.string().optional(),
        proposalId: z.string().uuid().optional(),
        workKind: aiWorkKindSchema.optional(),
    });

    const createWorkSchema = await getCreateWorkSchema();

    try {
        // Validate input
        const validation = aiPromptSchema.safeParse({
            prompt: request.prompt,
            name: request.name,
            slug: request.slug,
            gitProvider: request.gitProvider,
            proposalId: request.proposalId,
            workKind: request.workKind,
        });
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const providerId = validation.data.gitProvider;
        const managedStorage = await resolveManagedStorageStatus();

        const gate = await resolveCreateWorkGitGate(providerId, managedStorage);
        if (!gate.ok) {
            return {
                success: false,
                error: t('oauthRequired', {
                    provider: gate.reason === 'not-connected' ? gate.providerId : 'git provider',
                }),
                requiresGitProvider: true,
            };
        }

        const aiProvider = request.providers?.ai;
        const generationPrompt = validation.data.workKind
            ? `Create a ${AI_WORK_KIND_PROMPT_LABELS[validation.data.workKind]}.\n\n${validation.data.prompt}`
            : validation.data.prompt;
        const defaultDetails = {
            name: validation.data.name,
            slug: slugify(validation.data.name),
            description: validation.data.prompt,
            keywords: [] as string[],
            categories: [] as string[],
        };
        let workDetails = defaultDetails;

        if (aiProvider) {
            workDetails = await workAPI
                .generateDetails({
                    work_name: validation.data.name,
                    prompt: generationPrompt,
                    ai_provider: aiProvider,
                })
                .catch(() => defaultDetails);
        }

        // User-provided slug overrides whatever the AI generator
        // returned (or the slugify fallback). Lets the user keep a
        // specific repo name even when the AI proposes something
        // different.
        if (validation.data.slug) {
            workDetails = { ...workDetails, slug: validation.data.slug };
        }

        // Determine organization settings
        const { organization, owner } = checkOrganization(gate.connectionInfo, request);

        const workData: CreateWorkDto = {
            name: validation.data.name,
            slug: workDetails.slug,
            description: workDetails.description,
            organization,
            owner,
            gitProvider: providerId,
            deployProvider: request.deployProvider || undefined,
            // Explicit storage choice — see `storageProviderForCreate`. Under
            // managed storage the API resolves `gitProvider` from this value
            // (`gitProviderFromStorageChoice('ever-works-git')` → `github`),
            // so an absent `providerId` above is fine.
            storageProvider: storageProviderForCreate(managedStorage),
            websiteTemplateId: request.websiteTemplateId || undefined,
            // Persist the work-kind chip on the Work itself (not just the
            // generation prompt) so the kind-aware default website
            // template applies when no explicit template was chosen.
            kind: validation.data.workKind,
        };

        // Validate the generated work data
        const workValidation = createWorkSchema.safeParse(workData);
        if (!workValidation.success) {
            return {
                success: false,
                error: t('invalidGeneratedData'),
            };
        }

        const { work } = await workAPI.create(workValidation.data);

        await itemsGeneratorAPI.generate(work.id, {
            name: validation.data.name,
            prompt: generationPrompt,
            providers: request.providers || undefined,
            pluginConfig: {
                ...(request.pluginConfig || {}),
                // Security: server-authoritative key listed AFTER the
                // user-supplied spread so a malicious caller cannot override
                // the generation target keywords via pluginConfig.
                target_keywords: workDetails.keywords,
            },
        });

        if (request.proposalId) {
            await markProposalAcceptedWithRetry(request.proposalId, work.id);
        }

        return {
            success: true,
            work,
            message: t('aiGenerationStarted'),
            isGenerating: true,
        };
    } catch (error) {
        console.error('Failed to create Work with AI:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('createFailed'),
        };
    }
}

export type CheckWorkSlugResult =
    | { available: boolean; slug: string; suggestion?: string }
    | { error: string };

/**
 * Live slug-availability check for the create-Work form (GitHub-style
 * "repository name" check). Returns `{ available, slug, suggestion? }` on
 * success or `{ error }` so the client can render a neutral hint instead of
 * blocking. Work slugs are unique per user, so this proxies the
 * authenticated `GET /works/check-slug` endpoint.
 */
export async function checkWorkSlug(slug: string): Promise<CheckWorkSlugResult> {
    // Security: verify authentication at the server-action boundary.
    const user = await getAuthFromCookie();
    if (!user) {
        return { error: 'unauthorized' };
    }

    const trimmed = (slug ?? '').trim();
    if (!trimmed) {
        return { available: false, slug: '' };
    }

    try {
        return await workAPI.checkSlug(trimmed);
    } catch (error) {
        console.error('Failed to check Work slug availability:', error);
        return { error: error instanceof Error ? error.message : 'check failed' };
    }
}

export async function fetchWorkGenerationHistory(
    workId: string,
    options: { limit?: number; offset?: number; activityType?: string } = {},
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.getHistory(workId, options);
        return {
            success: true,
            data: response,
        };
    } catch (error) {
        console.error('Failed to fetch Work generation history:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

export async function updateWork(workId: string, data: UpdateWorkDto) {
    // Security: verify authentication at the server-action boundary.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.works');

    const updateWorkSchema = z.object({
        name: z
            .string()
            .min(1, t('name.required'))
            .transform((val) => sanitizeName(val, 100))
            .pipe(z.string().max(100, t('name.maxLength'))),
        description: z
            .string()
            .min(1, t('description.required'))
            .transform((val) => sanitizeDescription(val, 500))
            .pipe(z.string().max(500, t('description.maxLength'))),
        owner: z
            .string()
            .optional()
            .transform((val) => val?.trim()),
        organization: z.boolean().optional(),
        websiteTemplateId: z.string().optional(),
        readmeConfig: readmeConfigSchema.optional(),
    });

    try {
        // Validate input data
        const validation = updateWorkSchema.safeParse(data);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const { work } = await workAPI.get(workId);
        const providerId = work.gitProvider;

        const connectionCheck = providerId ? await checkGitProviderConnection(providerId) : null;

        const { organization, owner } = checkOrganization(
            connectionCheck as GitProviderConnectionInfo | null,
            validation.data,
        );

        validation.data.organization = organization;
        validation.data.owner = owner;

        await workAPI.update(workId, validation.data);

        const readmeUpdate = await workAPI.updateReadme(workId);

        revalidatePath(ROUTES.DASHBOARD_WORK_SETTINGS(workId));

        return {
            success: true,
            message: readmeUpdate?.message || t('updateSuccess'),
        };
    } catch (error) {
        console.error('Failed to update Work:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('updateFailed'),
        };
    }
}

export async function updateWorkTemplate(workId: string, websiteTemplateId: string | null) {
    // Security: verify authentication at the server-action boundary.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.works');

    const schema = z.object({
        workId: z.string().uuid(t('invalidId')),
        websiteTemplateId: z.string().nullable(),
    });

    try {
        const validation = schema.safeParse({ workId, websiteTemplateId });
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const normalizedTemplateId = validation.data.websiteTemplateId?.trim() || null;

        await workAPI.update(validation.data.workId, {
            websiteTemplateId: normalizedTemplateId,
        });

        revalidatePath(ROUTES.DASHBOARD_WORK_GENERATOR(validation.data.workId));
        revalidatePath(ROUTES.DASHBOARD_WORK_SETTINGS(validation.data.workId));

        return {
            success: true,
            message: t('updateSuccess'),
        };
    } catch (error) {
        console.error('Failed to update Work template:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('updateFailed'),
        };
    }
}

export async function deleteWork(workId: string, options?: DeleteWorkDto) {
    // Security: verify authentication at the server-action boundary.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.works');

    // Delete work validation schema
    const deleteWorkSchema = z.object({
        id: z.string().uuid(t('invalidId')),
    });

    try {
        // Validate the work ID
        const validation = deleteWorkSchema.safeParse({ id: workId });
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        await workAPI.delete(validation.data.id, options || {});

        return {
            success: true,
            message: t('deleteSuccess'),
        };
    } catch (error) {
        console.error('Failed to delete Work:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('deleteFailed'),
        };
    }
}

export async function syncWorkData(workId: string): Promise<SyncWorkResponse | null> {
    const user = await getAuthFromCookie();
    if (!user) {
        return null;
    }

    try {
        const res = await workAPI.syncData(workId);
        if (res.status === 'success') {
            revalidatePath(`/works/${workId}`);
            revalidatePath(`/works`);
        }
        return res;
    } catch (error) {
        console.error('Failed to sync Work data:', error);
        return null;
    }
}

export async function getWorkForStatusRefresh(workId: string): Promise<Work | null> {
    const user = await getAuthFromCookie();
    if (!user) {
        return null;
    }

    try {
        const { work } = await workAPI.get(workId);
        return work;
    } catch (error) {
        console.error('Failed to refresh Work status:', error);
        return null;
    }
}

interface GetWorksParams {
    search?: string;
    limit?: number;
    offset?: number;
}

export async function getWorks(params: GetWorksParams = {}) {
    // Security: verify authentication at the server-action boundary before
    // enumerating works.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.works');

    try {
        const { works, total } = await workAPI.getAll({
            search: params.search,
            limit: params.limit || 20,
            offset: params.offset || 0,
        });

        return {
            success: true,
            works,
            total,
        };
    } catch (error) {
        console.error('Failed to fetch works:', error);
        return {
            success: false,
            works: [],
            total: 0,
            error: error instanceof Error ? error.message : t('fetchFailed'),
        };
    }
}

export async function getWorkStats() {
    // Security: verify authentication at the server-action boundary before
    // returning aggregate stats.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const stats = await workAPI.getStats();
        return {
            success: true,
            ...stats,
        };
    } catch (error) {
        console.error('Failed to fetch Work stats:', error);
        // Phase 2 PR F — error fallback includes the new tile values
        // so the Dashboard render path never sees undefined.
        return {
            success: false,
            totalWorks: 0,
            totalItems: 0,
            activeWebsites: 0,
            generatingCount: 0,
            totalMissions: 0,
            totalIdeas: 0,
        };
    }
}

// Import actions

export async function analyzeRepository(sourceUrl: string, providerId?: string) {
    // Security: verify authentication at the server-action boundary.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.works');

    const urlSchema = z.string().url(t('import.invalidUrl'));

    try {
        const validation = urlSchema.safeParse(sourceUrl);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        if (!providerId) {
            return {
                success: false,
                error: t('oauthRequired', { provider: 'git provider' }),
                requiresGitProvider: true,
            };
        }

        const connectionCheck = await checkGitProviderConnection(providerId);
        if (!connectionCheck.connected) {
            return {
                success: false,
                error: t('oauthRequired', { provider: providerId }),
                requiresGitProvider: true,
            };
        }

        const result = await workAPI.analyzeRepository({
            sourceUrl: validation.data,
            gitProvider: providerId,
        });

        return {
            success: true,
            data: result as AnalyzeRepositoryResponseDto,
        };
    } catch (error) {
        console.error('Failed to analyze repository:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('import.analyzeFailed'),
        };
    }
}

type ImportWorkRequest = ImportWorkDto;

interface ImportWorkProviderErrors {
    ai?: string;
    search?: string;
    contentExtractor?: string;
    screenshot?: string;
    pipeline?: string;
}

function isImportWorkProviderErrors(value: unknown): value is ImportWorkProviderErrors {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    return Object.values(value).every((entry) => typeof entry === 'string');
}

export async function importWork(data: ImportWorkRequest) {
    // Security: verify authentication at the server-action boundary before
    // importing from an external source URL.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.works');

    const importSchema = z.object({
        sourceUrl: z.string().url(t('import.invalidUrl')),
        sourceType: z.enum(['data_repo', 'awesome_readme', 'link_existing', 'works_config']),
        awesomeReadmeImportMode: z.enum(['clone', 'reuse_source']).optional(),
        name: z
            .string()
            .min(1, t('name.required'))
            .transform((val) => sanitizeName(val, 100))
            .pipe(z.string().max(100, t('name.maxLength'))),
        organization: z.boolean().optional(),
        owner: z.string().optional(),
        createMissingRepos: z.boolean().optional(),
        sync: z.boolean().optional(),
        restoreWorksConfig: z.boolean().optional(),
        gitProvider: z.string().optional(),
        deployProvider: z.string().optional(),
        providers: z.record(z.string()).optional(),
        enrichmentConfig: z
            .object({
                expansionFactor: z.number().min(1.5).max(5).optional(),
            })
            .optional(),
    });

    try {
        const validation = importSchema.safeParse(data);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const providerId = validation.data.gitProvider;
        if (!providerId) {
            return {
                success: false,
                error: t('oauthRequired', { provider: 'git provider' }),
                requiresGitProvider: true,
            };
        }

        // Check git provider connection
        const connectionCheck = await checkGitProviderConnection(providerId);
        if (!connectionCheck.connected) {
            return {
                success: false,
                error: t('oauthRequired', { provider: providerId }),
                requiresGitProvider: true,
            };
        }

        const { organization, owner } = checkOrganization(
            connectionCheck as GitProviderConnectionInfo,
            validation.data,
        );

        const result = await workAPI.importWork({
            sourceUrl: validation.data.sourceUrl,
            sourceType: validation.data.sourceType,
            awesomeReadmeImportMode: validation.data.awesomeReadmeImportMode,
            name: validation.data.name,
            organization,
            owner: owner || undefined,
            createMissingRepos: validation.data.createMissingRepos,
            sync: validation.data.sync,
            restoreWorksConfig: validation.data.restoreWorksConfig,
            gitProvider: providerId,
            deployProvider: validation.data.deployProvider,
            providers: validation.data.providers,
            enrichmentConfig: validation.data.enrichmentConfig,
        });

        return {
            success: result.status !== 'error',
            workId: result.workId,
            historyId: result.historyId,
            message: result.message || t('import.started'),
            error: result.status === 'error' ? result.message : undefined,
        };
    } catch (error) {
        console.error('Failed to import Work:', error);

        if (error instanceof ApiResponseError) {
            const providerErrors = error.details?.providerErrors;
            const resolvedPipelineId = error.details?.resolvedPipelineId;

            return {
                success: false,
                error: error.message,
                providerErrors: isImportWorkProviderErrors(providerErrors)
                    ? providerErrors
                    : undefined,
                resolvedPipelineId:
                    typeof resolvedPipelineId === 'string' ? resolvedPipelineId : undefined,
            };
        }

        return {
            success: false,
            error: error instanceof Error ? error.message : t('import.failed'),
        };
    }
}

interface GetUserRepositoriesParams {
    page?: number;
    perPage?: number;
    search?: string;
    gitProvider: string;
    owner?: string;
    type?: 'user' | 'org';
}

export async function analyzeForLinking(sourceUrl: string, providerId: string) {
    // Security: verify authentication at the server-action boundary.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.works');

    const urlSchema = z.string().url(t('import.invalidUrl'));

    try {
        const validation = urlSchema.safeParse(sourceUrl);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const connectionCheck = await checkGitProviderConnection(providerId);
        if (!connectionCheck.connected) {
            return {
                success: false,
                error: t('oauthRequired', { provider: providerId }),
                requiresGitProvider: true,
            };
        }

        const result = await workAPI.analyzeForLinking({
            sourceUrl: validation.data,
            gitProvider: providerId,
        });

        return {
            success: true,
            data: result,
        };
    } catch (error) {
        console.error('Failed to analyze for linking:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('import.analyzeFailed'),
        };
    }
}

export async function getUserRepositories(params: GetUserRepositoriesParams) {
    // Security: verify authentication at the server-action boundary.
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.works');

    try {
        const { gitProvider } = params;

        const connectionCheck = await checkGitProviderConnection(gitProvider);
        if (!connectionCheck.connected) {
            return {
                success: false,
                error: t('oauthRequired', { provider: gitProvider }),
                requiresGitProvider: true,
            };
        }

        const result = await workAPI.getUserRepositories({
            gitProvider,
            page: params.page,
            perPage: params.perPage,
            search: params.search,
            owner: params.owner,
            type: params.type,
        });

        return {
            success: true,
            data: result as GetUserRepositoriesResponseDto,
        };
    } catch (error) {
        console.error('Failed to fetch user repositories:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : t('import.fetchReposFailed'),
        };
    }
}

export async function updateWorkSchedule(workId: string, data: UpdateWorkSchedulePayload) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await workAPI.updateSchedule(workId, data);
        revalidatePath(`/works/${workId}/settings`);
        return {
            success: true,
            data: result,
        };
    } catch (error) {
        console.error('Failed to update Work schedule:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update schedule',
        };
    }
}

export async function getRepositoryVisibility(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const result = await workAPI.getRepositoryVisibility(workId);
        return {
            success: true,
            data: result,
        };
    } catch (error) {
        console.error('Failed to get repository visibility:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get repository visibility',
        };
    }
}

export async function toggleRepositoryVisibility(
    workId: string,
    repoType: 'data' | 'work' | 'website',
    isPrivate: boolean,
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        await workAPI.updateRepositoryVisibility(workId, {
            repoType,
            isPrivate,
        });
        revalidatePath(`/works/${workId}/settings`);
        return {
            success: true,
        };
    } catch (error) {
        console.error('Failed to update repository visibility:', error);
        return {
            success: false,
            error:
                error instanceof Error ? error.message : 'Failed to update repository visibility',
        };
    }
}

// Advanced Prompts Actions

export async function getAdvancedPrompts(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.getAdvancedPrompts(workId);
        return {
            success: true,
            data: response.advancedPrompts,
        };
    } catch (error) {
        console.error('Failed to fetch advanced prompts:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to fetch advanced prompts',
        };
    }
}

export async function updateAdvancedPrompts(workId: string, data: UpdateWorkAdvancedPromptsDto) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    // Validation schema for advanced prompts (max 2000 chars per prompt)
    const advancedPromptsSchema = z.object({
        relevanceAssessment: z.string().max(2000).nullable().optional(),
        itemGeneration: z.string().max(2000).nullable().optional(),
        itemExtraction: z.string().max(2000).nullable().optional(),
        searchQuery: z.string().max(2000).nullable().optional(),
        categorization: z.string().max(2000).nullable().optional(),
        deduplication: z.string().max(2000).nullable().optional(),
        sourceValidation: z.string().max(2000).nullable().optional(),
    });

    try {
        const validation = advancedPromptsSchema.safeParse(data);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const response = await workAPI.updateAdvancedPrompts(workId, validation.data);
        revalidatePath(`/works/${workId}/settings`);

        return {
            success: true,
            data: response.advancedPrompts,
        };
    } catch (error) {
        console.error('Failed to update advanced prompts:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update advanced prompts',
        };
    }
}

export async function getWebsiteSettings(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.getWebsiteSettings(workId);
        return {
            success: true,
            data: response,
        };
    } catch (error) {
        console.error('Failed to fetch website settings:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to fetch website settings',
        };
    }
}

export async function updateWebsiteSettings(
    workId: string,
    data: {
        company_name?: string;
        company_website?: string;
        categories_enabled?: boolean;
        companies_enabled?: boolean;
        tags_enabled?: boolean;
        surveys_enabled?: boolean;
        export_enabled?: boolean;
        import_enabled?: boolean;
        import_max_rows?: number;
        header?: {
            submit_enabled?: boolean;
            pricing_enabled?: boolean;
            layout_enabled?: boolean;
            language_enabled?: boolean;
            theme_enabled?: boolean;
            layout_default?: string;
            pagination_default?: string;
            theme_default?: string;
        };
        homepage?: {
            hero_enabled?: boolean;
            search_enabled?: boolean;
            default_view?: string;
            default_sort?: string;
        };
        footer?: {
            subscribe_enabled?: boolean;
            version_enabled?: boolean;
            theme_selector_enabled?: boolean;
        };
        custom_menu?: {
            header?: Array<{
                label: string;
                path: string;
                target?: '_self' | '_blank';
                icon?: string;
            }>;
            footer?: Array<{
                label: string;
                path: string;
                target?: '_self' | '_blank';
                icon?: string;
            }>;
        };
    },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    // Validate the scalar fields that have well-defined safe bounds.
    // Nested objects (header/homepage/footer/custom_menu) are passed through
    // to the backend which applies its own class-validator checks.
    const websiteSettingsScalarSchema = z.object({
        company_name: z.string().max(200).optional(),
        company_website: z.string().max(2000).optional(),
        import_max_rows: z.number().int().min(1).max(2000).optional(),
        categories_enabled: z.boolean().optional(),
        companies_enabled: z.boolean().optional(),
        tags_enabled: z.boolean().optional(),
        surveys_enabled: z.boolean().optional(),
        export_enabled: z.boolean().optional(),
        import_enabled: z.boolean().optional(),
    });
    const scalarValidation = websiteSettingsScalarSchema.safeParse(data);
    if (!scalarValidation.success) {
        return {
            success: false,
            error: scalarValidation.error.errors[0].message,
        };
    }

    try {
        await workAPI.updateWebsiteSettings(workId, data);
        revalidatePath(`/works/${workId}/settings`);

        return {
            success: true,
        };
    } catch (error) {
        console.error('Failed to update website settings:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update website settings',
        };
    }
}

/**
 * Toggle generation of the "{provider} Repository" — the browsable,
 * AI-generated repo published to the git provider but never deployed.
 */
export async function updateProviderRepositorySettings(
    workId: string,
    settings: {
        providerRepositoryEnabled?: boolean;
    },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.update(workId, settings);
        revalidatePath(`/works/${workId}/settings`);

        return {
            success: response.status === 'success',
        };
    } catch (error) {
        console.error('Failed to update provider repository settings:', error);
        return {
            success: false,
            error: 'Failed to update settings',
        };
    }
}

export async function updateCommunityPrSettings(
    workId: string,
    settings: {
        communityPrEnabled?: boolean;
        communityPrAutoClose?: boolean;
    },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.update(workId, settings);
        revalidatePath(`/works/${workId}/settings`);

        return {
            success: response.status === 'success',
        };
    } catch (error) {
        console.error('Failed to update community PR settings:', error);
        return {
            success: false,
            error:
                error instanceof Error ? error.message : 'Failed to update community PR settings',
        };
    }
}

export async function updateActivitySyncMode(workId: string, mode: 'pull' | 'push' | 'disabled') {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.update(workId, { activitySyncMode: mode });
        revalidatePath(`/works/${workId}/settings`);

        return {
            success: response.status === 'success',
        };
    } catch (error) {
        console.error('Failed to update activity sync mode:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update activity sync mode',
        };
    }
}

export async function rotateActivitySyncSecret(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await serverMutation<{ status: string; redeployRequired: boolean }>({
            endpoint: `/works/${workId}/activity-sync/rotate-secret`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
        revalidatePath(`/works/${workId}/settings`);
        return {
            success: response.status === 'success',
            redeployRequired: response.redeployRequired ?? false,
        };
    } catch (error) {
        console.error('Failed to rotate activity sync secret:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to rotate activity sync secret',
        };
    }
}

/**
 * Wave 2 M7 — Work-level worktree-per-Task isolation settings. All four
 * fields flow through the same `PATCH /works/:id` UpdateWorkDto path the
 * sibling settings cards use.
 */
export async function updateTaskIsolationSettings(
    workId: string,
    settings: {
        taskIsolation?: 'off' | 'worktree';
        taskIsolationBaseBranch?: string | null;
        taskIsolationTargetRepo?: 'work-output' | 'linked';
        taskBranchCleanup?: 'on-merge' | 'manual';
    },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const taskIsolationSchema = z.object({
        taskIsolation: z.enum(['off', 'worktree']).optional(),
        taskIsolationBaseBranch: z.string().max(255).nullable().optional(),
        taskIsolationTargetRepo: z.enum(['work-output', 'linked']).optional(),
        taskBranchCleanup: z.enum(['on-merge', 'manual']).optional(),
    });

    try {
        const validation = taskIsolationSchema.safeParse(settings);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const response = await workAPI.update(workId, validation.data);
        revalidatePath(`/works/${workId}/settings`);

        return {
            success: response.status === 'success',
        };
    } catch (error) {
        console.error('Failed to update task isolation settings:', error);
        return {
            success: false,
            error:
                error instanceof Error ? error.message : 'Failed to update task isolation settings',
        };
    }
}

/**
 * Quality gates (Wave 3 M6) — Work-level default acceptance checks +
 * enforcement policy + gate-attempt budget. Saves flow through the same
 * `PATCH /works/:id` UpdateWorkDto path as the sibling settings cards
 * (TaskIsolationSettings / CommitterSettings).
 */
export async function updateQualityGatesSettings(
    workId: string,
    settings: {
        checkDefaults?: TaskAcceptanceCheck[] | null;
        checksPolicy?: WorkChecksPolicy;
        maxGateAttempts?: number;
    },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const checkSchema = z.object({
        id: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z0-9][a-z0-9-]*$/),
        name: z.string().min(1).max(120),
        kind: z.enum(['build', 'test', 'lint', 'typecheck', 'custom']),
        command: z.string().min(1).max(500),
        cwd: z.string().max(200).optional(),
        timeoutSec: z.number().int().min(1).max(1800).optional(),
        required: z.boolean(),
        disabled: z.boolean().optional(),
    });
    const qualityGatesSchema = z.object({
        checkDefaults: z.array(checkSchema).max(20).nullable().optional(),
        checksPolicy: z.enum(['off', 'warn', 'required']).optional(),
        maxGateAttempts: z.number().int().min(1).max(5).optional(),
    });

    try {
        const validation = qualityGatesSchema.safeParse(settings);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const response = await workAPI.update(workId, validation.data);
        revalidatePath(`/works/${workId}/settings`);

        return {
            success: response.status === 'success',
        };
    } catch (error) {
        console.error('Failed to update quality gates settings:', error);
        return {
            success: false,
            error:
                error instanceof Error ? error.message : 'Failed to update quality gates settings',
        };
    }
}

/**
 * Merge-policy matrix (Wave 3, founder decision D4) — the Work-scoped
 * slice. Saves flow through the same `PATCH /works/:id` UpdateWorkDto
 * path as the sibling settings cards; this feature adds a field to an
 * existing write path rather than a parallel one.
 *
 * The payload is a PARTIAL by contract: every field OMITTED inside the
 * object inherits from the organization, then the tenant, then the
 * platform default. `null` clears the Work override entirely. The zod
 * schema below mirrors the API's `MergePolicyDto` constraints so an
 * obviously-invalid payload never leaves the browser — the API still
 * validates and sanitizes independently.
 */
export async function updateWorkMergePolicy(
    workId: string,
    mergePolicy: MergePolicyOverride | null,
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const mergePolicySchema = z
        .object({
            allowAgentMerge: z.boolean().optional(),
            requireGreenGate: z.boolean().optional(),
            requireHumanApproval: z.boolean().optional(),
            allowedMergeMethods: z
                .array(z.enum(['merge', 'squash', 'rebase']))
                .max(3)
                .optional(),
            protectedBranches: z.array(z.string().min(1).max(255)).max(50).optional(),
        })
        .strict()
        .nullable();

    try {
        const validation = mergePolicySchema.safeParse(mergePolicy);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const response = await workAPI.update(workId, { mergePolicy: validation.data });
        revalidatePath(`/works/${workId}/settings`);

        return {
            success: response.status === 'success',
        };
    } catch (error) {
        console.error('Failed to update merge policy:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update merge policy',
        };
    }
}

export async function updateCommitterSettings(
    workId: string,
    settings: {
        committerName?: string | null;
        committerEmail?: string | null;
    },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await workAPI.update(workId, settings);
        revalidatePath(`/works/${workId}/settings`);

        return {
            success: response.status === 'success',
        };
    } catch (error) {
        console.error('Failed to update committer settings:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update committer settings',
        };
    }
}

/**
 * Save the Work's ingest routing claims (`works.externalRefs`).
 *
 * Mirrors the server-side rules so a bad map never leaves the browser:
 * only the known kinds, non-empty ids capped at
 * `INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS`, at most
 * `WORK_EXTERNAL_REFS_MAX_PER_KIND` per kind. The API re-validates and
 * additionally rejects a claim another Work of the same owner already
 * holds (409) — that error message is surfaced verbatim.
 */
export async function updateWorkExternalRefs(
    workId: string,
    externalRefs: WorkExternalRefs | null,
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const refsSchema = z
        .object(
            Object.fromEntries(
                WORK_EXTERNAL_REF_KINDS.map((kind) => [
                    kind,
                    z
                        .array(z.string().trim().min(1).max(INGEST_WORK_HINT_EXTERNAL_ID_MAX_CHARS))
                        .max(WORK_EXTERNAL_REFS_MAX_PER_KIND)
                        .optional(),
                ]),
            ) as Record<string, z.ZodTypeAny>,
        )
        .strict()
        .nullable();

    try {
        const validation = refsSchema.safeParse(externalRefs);
        if (!validation.success) {
            return {
                success: false,
                error: validation.error.errors[0].message,
            };
        }

        const response = await workAPI.update(workId, {
            externalRefs: validation.data as WorkExternalRefs | null,
        });
        revalidatePath(`/works/${workId}/settings`);

        return {
            success: response.status === 'success',
        };
    } catch (error) {
        console.error('Failed to update external references:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update external references',
        };
    }
}

/** One artifact set provisioned by `POST /api/works/from-campaign-template`. */
export interface CampaignActivationSummary {
    work: { id: string; slug: string; name: string; kind: string };
    goal: { id: string; title: string; metricId: string; targetValue: number };
    agents: Array<{ id: string; name: string; templateSlug: string }>;
    tasks: Array<{ id: string; slug: string; title: string; stageId: string }>;
    pipeline: { id: string; applied: boolean; reason?: string };
}

const campaignBriefSchema = z.object({
    name: z.string().trim().min(1).max(100),
    objective: z.string().trim().min(1).max(500),
    target: z
        .object({
            metricId: z.string().trim().max(64).optional(),
            value: z.number().positive().optional(),
            unit: z.string().trim().max(32).optional(),
            window: z.enum(['day', 'week', 'month', 'total', 'point']).optional(),
        })
        .optional(),
    channels: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
});

/**
 * Start a campaign — the ONLY path that mints a `campaign` Work.
 *
 * One call provisions the Work, a Goal capturing the objective, the
 * prebuilt go-to-market Agents, Tasks for the first pipeline stages and
 * the `gtm-pipeline` preference. The API runs it as a compensating
 * transaction, so a failure here means nothing was left behind.
 */
export async function createCampaignWork(input: {
    name: string;
    objective: string;
    target?: { metricId?: string; value?: number; unit?: string; window?: string };
    channels?: string[];
}) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const validation = campaignBriefSchema.safeParse(input);
    if (!validation.success) {
        return { success: false as const, error: validation.error.errors[0].message };
    }

    try {
        const response = await serverMutation<CampaignActivationSummary>({
            endpoint: '/works/from-campaign-template',
            data: {
                name: sanitizeName(validation.data.name, 100),
                objective: sanitizeDescription(validation.data.objective, 500),
                target: validation.data.target,
                channels: validation.data.channels,
            },
            method: 'POST',
            wrapInData: false,
        });

        revalidatePath('/works');
        return { success: true as const, campaign: response };
    } catch (error) {
        console.error('Failed to start campaign:', error);
        return {
            success: false as const,
            error: error instanceof Error ? error.message : 'Failed to start campaign',
        };
    }
}
