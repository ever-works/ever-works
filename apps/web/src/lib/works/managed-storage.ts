import 'server-only';

import { onboardingAPI } from '@/lib/api/onboarding';
import type {
    OnboardingCatalogResponse,
    OnboardingStorageChoice,
    OnboardingWizardStateV2,
} from '@ever-works/contracts/api';

/**
 * The wizard storage choice that means "the platform owns the repo".
 *
 * Mirrors `CreateWorkDto.storageProvider` on the API and the
 * `storageProvider === 'ever-works-git'` branch in
 * `WorkLifecycleService.createWork`, which provisions the repository in the
 * managed `ever-works-cloud` GitHub org BEFORE the Work row is written.
 */
export const EVER_WORKS_GIT_STORAGE: OnboardingStorageChoice = 'ever-works-git';

/**
 * The fallback the API applies when neither the DTO nor the user's persisted
 * onboarding state names a storage provider. Kept in lockstep with
 * `WorkLifecycleService.resolveProviderDefaults` so the web's view of "which
 * storage will actually be used" cannot drift from the server's.
 */
const DEFAULT_STORAGE_CHOICE: OnboardingStorageChoice = 'user-github';

export interface ManagedStorageStatus {
    /**
     * The storage provider the API will resolve for this user's next Work,
     * computed with the same precedence `resolveProviderDefaults` uses.
     */
    readonly storageChoice: OnboardingStorageChoice;
    /**
     * Whether the platform currently offers the managed Ever Works Git org.
     * Read from the server-authoritative onboarding catalog — never from an
     * env var, which is not readable in the browser and would go stale the
     * moment ops flipped the flag without a web release.
     */
    readonly everWorksGitAvailable: boolean;
    /**
     * True when this user's Works go to the managed Ever Works GitHub org.
     * When true there is nothing for the user to connect: the platform's own
     * PAT creates the repo, so requiring a personal git-provider OAuth
     * connection blocks a flow that the API would have accepted.
     */
    readonly managedGitActive: boolean;
}

/**
 * Normalize a caller-supplied storage provider the way the API's
 * `@Transform(trim().toLowerCase())` on `CreateWorkDto.storageProvider` does,
 * so `'Ever-Works-Git'` is recognised here exactly as it will be there.
 */
function normalizeStorageOverride(value: string | undefined): string | undefined {
    const normalized = value?.trim().toLowerCase();
    return normalized ? normalized : undefined;
}

/**
 * Pure resolver — exported so the precedence rules are unit-testable without
 * standing up the onboarding endpoints.
 *
 * `state` is the user's persisted wizard state (`null` when they never
 * reached the wizard, in which case the API's `user-github` fallback applies).
 * `catalog` is the platform capability document; `null` means "we could not
 * ask", which deliberately resolves to NOT managed so the caller keeps the
 * personal-provider gate rather than waving an unverified user through.
 * `override` is an explicit `CreateWorkDto.storageProvider` from the caller;
 * it wins, mirroring `resolveProviderDefaults`' DTO-first precedence, so the
 * gate is always decided from the SAME value the request will carry.
 */
export function resolveManagedStorage(
    state: OnboardingWizardStateV2 | null | undefined,
    catalog: OnboardingCatalogResponse | null | undefined,
    override?: string,
): ManagedStorageStatus {
    const storageChoice = (normalizeStorageOverride(override) ??
        state?.storage?.choice ??
        DEFAULT_STORAGE_CHOICE) as OnboardingStorageChoice;

    const everWorksGitAvailable =
        catalog?.storage?.find((card) => card.choice === EVER_WORKS_GIT_STORAGE)?.available ===
        true;

    return {
        storageChoice,
        everWorksGitAvailable,
        managedGitActive: storageChoice === EVER_WORKS_GIT_STORAGE && everWorksGitAvailable,
    };
}

/**
 * Resolve, for the CURRENT request's user, whether a new Work's repository
 * will be created in the managed Ever Works GitHub org.
 *
 * Two server-side reads, in parallel:
 *
 *   - `GET /onboarding/state`   → what this user picked in the wizard.
 *   - `GET /onboarding/catalog` → whether the platform offers it at all
 *     (`available` is driven by `STORAGE_EVER_WORKS_GIT_ENABLED` on the API,
 *     which is exactly the flag `WorkLifecycleService` gates the managed
 *     branch on).
 *
 * Fails CLOSED: any error on either call degrades to "not managed", which
 * restores the pre-existing personal-provider gate. A transient blip must
 * never let an unconnected `user-github` user through — the whole point of
 * the gate is that their create would fail server-side.
 */
export async function resolveManagedStorageStatus(
    override?: string,
): Promise<ManagedStorageStatus> {
    const [stateResult, catalogResult] = await Promise.allSettled([
        onboardingAPI.getState(),
        onboardingAPI.getCatalog(),
    ]);

    if (stateResult.status === 'rejected') {
        console.warn(
            'Failed to read onboarding state while resolving storage provider; falling back to the personal git-provider gate:',
            stateResult.reason,
        );
    }
    if (catalogResult.status === 'rejected') {
        console.warn(
            'Failed to read the onboarding catalog while resolving storage provider; falling back to the personal git-provider gate:',
            catalogResult.reason,
        );
    }

    return resolveManagedStorage(
        stateResult.status === 'fulfilled' ? stateResult.value?.state : null,
        catalogResult.status === 'fulfilled' ? catalogResult.value : null,
        override,
    );
}
