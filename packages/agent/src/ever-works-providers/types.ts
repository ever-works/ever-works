/**
 * Shared types and errors for the Ever Works platform-default providers
 * (Ever Works Git storage, Ever Works Kubernetes deploy).
 *
 * These providers back the default choices in the onboarding wizard so a
 * user can ship without bringing their own GitHub or Kubernetes cluster.
 * Each is feature-flagged at the env layer until the corresponding external
 * resource (GitHub org PAT, tenant cluster) is provisioned.
 */

/** Minimal Work shape needed by the EverWorks providers, decoupled from TypeORM. */
export interface EverWorksProviderWorkRef {
    readonly id: string;
    readonly slug: string;
    readonly userId: string;
    readonly userSlug?: string;
    readonly description?: string;
}

/** Repo coordinates returned after creating a repo in the customers org. */
export interface EverWorksGitRepoRef {
    readonly owner: string;
    readonly repo: string;
    readonly fullName: string;
    readonly htmlUrl: string;
    readonly cloneUrl: string;
    readonly privateRepo: boolean;
}

/**
 * Resolved deploy config the platform passes to the existing k8s plugin
 * primitives. Mirrors the `k8s` plugin's settingsSchema shape so we can
 * reuse its validation and deploy logic without duplicating it.
 */
export interface EverWorksDeployConfig {
    readonly kubeconfig: string;
    readonly namespace: string;
    readonly ingressHost: string;
    readonly ingressClass: string;
    readonly tlsIssuer: string;
    readonly registry?: string;
}

/** Counter interface so the quota service can be tested without TypeORM. */
export interface EverWorksDeployQuotaCounter {
    /**
     * Count Works owned by `userId` that have `deployProvider === 'ever-works'`
     * and are NOT in a deleted/archived state. The actual TypeORM query lives
     * in the consuming module so this package stays repo-agnostic.
     */
    countActiveDeploys(userId: string): Promise<number>;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class EverWorksProviderError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.name = 'EverWorksProviderError';
    }
}

export class EverWorksGitDisabledError extends EverWorksProviderError {
    constructor() {
        super(
            'storage_provider_disabled',
            'Ever Works Git storage is not enabled on this environment. ' +
                'Set STORAGE_EVER_WORKS_GIT_ENABLED=true and provide a PAT to use it.',
        );
        this.name = 'EverWorksGitDisabledError';
    }
}

export class EverWorksGitMisconfiguredError extends EverWorksProviderError {
    constructor(reason: string) {
        super('storage_provider_misconfigured', `Ever Works Git is misconfigured: ${reason}`);
        this.name = 'EverWorksGitMisconfiguredError';
    }
}

export class EverWorksGitRequestError extends EverWorksProviderError {
    readonly status: number;
    readonly responseBody?: string;

    constructor(status: number, message: string, responseBody?: string) {
        super('storage_provider_request_failed', message);
        this.status = status;
        this.responseBody = responseBody;
        this.name = 'EverWorksGitRequestError';
    }
}

export class EverWorksDeployDisabledError extends EverWorksProviderError {
    constructor() {
        super(
            'deploy_provider_disabled',
            'Ever Works Deploy is not enabled on this environment. ' +
                'Set DEPLOY_EVER_WORKS_ENABLED=true and provide a kubeconfig to use it.',
        );
        this.name = 'EverWorksDeployDisabledError';
    }
}

export class EverWorksDeployMisconfiguredError extends EverWorksProviderError {
    constructor(reason: string) {
        super('deploy_provider_misconfigured', `Ever Works Deploy is misconfigured: ${reason}`);
        this.name = 'EverWorksDeployMisconfiguredError';
    }
}

export class EverWorksDeployQuotaExceededError extends EverWorksProviderError {
    readonly currentCount: number;
    readonly limit: number;

    constructor(currentCount: number, limit: number) {
        super(
            'quota_exceeded',
            `Ever Works Deploy is capped at ${limit} active Works per user (current: ${currentCount}). ` +
                'Pick Vercel or your own Kubernetes cluster for additional Works.',
        );
        this.currentCount = currentCount;
        this.limit = limit;
        this.name = 'EverWorksDeployQuotaExceededError';
    }
}
