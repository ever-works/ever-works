/**
 * Standalone barrel for the agent zero-friction onboarding building blocks.
 *
 * Kept deliberately small — does NOT re-export the full services/ tree or
 * the facades index — so that `apps/api/src/onboarding/` and the `apps/mcp`
 * `register_work` tool can pull in only the validators, helpers, and
 * minimal interfaces they actually use, without triggering ts-jest
 * type-checking through the heavy services / facades / generators chain.
 *
 * Concrete implementations of the interfaces declared here (e.g. the
 * `GitFacadeService` that fulfils `OnboardingGitProvider`) live in the
 * full facades module and are wired via DI at the application root.
 */

export {
    WorksManifestService,
    WorksManifestV1Schema,
    PRINTABLE_ASCII_PATTERN,
    SUBDOMAIN_PATTERN,
} from '../services/works-manifest.service';
export type { ParsedManifest, ManifestParseResult } from '../services/works-manifest.service';

export { isSafeWebhookUrl } from '../utils/ssrf-guard';
export {
    redactBody,
    redactHeaders,
    redactString,
    REDACTED_BODY_FIELDS,
    REDACTED_HEADERS,
} from '../utils/redaction';

export {
    WebhookDeliveryService,
    FetchWebhookHttpClient,
    WEBHOOK_HTTP_CLIENT,
    WEBHOOK_SIGNATURE_HEADER,
} from '../services/webhook-delivery.service';
export type {
    DeliveryResult,
    SignedDelivery,
    WebhookDeliveryRequest,
    WebhookHeaders,
    WebhookHttpClient,
} from '../services/webhook-delivery.service';

export { StateMarkerService, STATE_MARKER_DEFAULT_PATH } from '../services/state-marker.service';
export type {
    MarkerFileWriter,
    StateMarkerInput,
    StateMarkerPayload,
} from '../services/state-marker.service';

export { OnboardingRequestRepository } from '../database/repositories/onboarding-request.repository';
export { WebhookSubscriptionRepository } from '../database/repositories/webhook-subscription.repository';

/**
 * Minimal Git provider surface needed by the onboarding service. The full
 * `GitFacadeService` (in `../facades/git.facade.ts`) implements this. We
 * keep this interface here so the api-side service does not have to
 * import the concrete class — that import would transitively pull in
 * the entire agent runtime via the facades barrel.
 */
export interface OnboardingGitProvider {
    getUser(options: { providerId: string; token: string }): Promise<{
        readonly id: string | number;
        readonly login: string;
        readonly name?: string;
        readonly email?: string;
        readonly avatarUrl?: string;
    }>;

    getRepository(
        owner: string,
        repo: string,
        options: { providerId: string; token: string },
    ): Promise<
        | (Record<string, unknown> & {
              permissions?: { push?: boolean; admin?: boolean; pull?: boolean };
          })
        | null
    >;

    getFileContent(
        owner: string,
        repo: string,
        path: string,
        options: { providerId: string; token: string },
        ref?: string,
    ): Promise<{ content: string; encoding: string } | null>;
}

export const ONBOARDING_GIT_PROVIDER = Symbol.for('OnboardingGitProvider');

/**
 * Minimal account-upsert surface needed by the onboarding service. The
 * api-side `OnboardingAccountAdapter` (in `apps/api/src/onboarding/`) wraps
 * the existing `UserRepository`, `AuthAccountRepository`, and
 * `GitHubAppUserLinkRepository` to fulfil this contract — keeping the
 * heavy database chain out of the onboarding service's import graph.
 */
export interface OnboardingAccountUpsert {
    /**
     * Idempotent: given a GitHub identity, return the Ever Works account id.
     * Creates an account on first sight, links the GitHub identity to an
     * existing account on subsequent calls.
     */
    upsertFromGithub(input: {
        readonly githubUserId: string;
        readonly login: string;
        readonly email?: string;
        readonly avatarUrl?: string;
        readonly accessToken: string;
    }): Promise<{ accountId: string }>;
}

export const ONBOARDING_ACCOUNT_UPSERT = Symbol.for('OnboardingAccountUpsert');

/**
 * Minimal Work-creation surface needed by the onboarding pipeline. The
 * api-side adapter wraps the existing `WorksService.createWork` and the
 * downstream import + generation pipelines. Returns the new `workId` so
 * the OnboardingRequest row can be patched and the agent can poll status.
 */
export interface OnboardingWorkCreator {
    createFromManifest(input: {
        readonly accountId: string;
        readonly githubAccessToken: string;
        readonly manifestRepoUrl: string;
        readonly manifest: Record<string, unknown>;
        readonly subdomain: string;
        readonly onboardingId: string;
    }): Promise<{ workId: string }>;
}

export const ONBOARDING_WORK_CREATOR = Symbol.for('OnboardingWorkCreator');
