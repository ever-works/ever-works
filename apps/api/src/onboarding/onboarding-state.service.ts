import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import {
    OrganizationOnboardingProfileRepository,
    UserRepository,
} from '@ever-works/agent/database';
import {
    ONBOARDING_DEFAULT_STATE,
    ROLE_OPTIONS,
    TEAM_SIZE_OPTIONS,
    type OnboardingProfile,
    type OnboardingStateResponse,
    type OnboardingStatePatchRequest,
    type OnboardingWizardStateV2,
} from '@ever-works/contracts/api';
// Concrete path (not the `../scope` barrel): the barrel re-exports
// `ScopeModule`, and pulling a module into a service's import graph is
// how circular-module init bugs start. The service itself is provided
// globally, so only the class is needed here.
import { ScopeContextService } from '../scope/scope-context.service';

/**
 * Owns reads + writes for the v2 onboarding wizard's server-side state.
 *
 * State lives on `users.onboarding_state` (TypeORM `simple-json`) plus two
 * timestamp columns (`onboardingCompletedAt`, `onboardingDismissedAt`). All
 * three default to NULL — `getState` synthesises the version-2 default
 * payload until the user makes their first choice.
 *
 * Audit item A53 — the "What do you do" answers (`state.profile`) are
 * ALSO mirrored onto `organization_onboarding_profiles` whenever the
 * request resolves an organization scope, so the answers are visible to
 * the whole organization instead of being trapped on one user row. The
 * user blob stays the source of truth for the wizard UI; the org row is
 * a read model surfaced back as `organizationProfile`.
 */
@Injectable()
export class OnboardingStateService {
    private readonly logger = new Logger(OnboardingStateService.name);

    constructor(
        private readonly userRepository: UserRepository,
        // Both @Optional(): the org mirror is a best-effort enrichment, and
        // keeping them optional lets unit specs construct the service with
        // just the user repository (and keeps non-HTTP callers — CLI,
        // workers — working outside any request scope).
        @Optional() private readonly scopeContext?: ScopeContextService,
        @Optional()
        private readonly orgProfileRepository?: OrganizationOnboardingProfileRepository,
    ) {}

    async getState(userId: string): Promise<OnboardingStateResponse> {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException(`User ${userId} not found`);
        }
        return {
            completedAt: user.onboardingCompletedAt
                ? user.onboardingCompletedAt.toISOString()
                : null,
            dismissedAt: user.onboardingDismissedAt
                ? user.onboardingDismissedAt.toISOString()
                : null,
            state: normaliseState(user.onboardingState),
            organizationProfile: await this.readOrganizationProfile(),
        };
    }

    async patchState(
        userId: string,
        patch: OnboardingStatePatchRequest,
    ): Promise<OnboardingStateResponse> {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException(`User ${userId} not found`);
        }

        const current = normaliseState(user.onboardingState);
        const next = mergeState(current, patch.state ?? {});

        // Idempotent: skip the USER write if nothing actually changed. The
        // org mirror still runs when the patch carried a profile — another
        // member may have overwritten the org row since, and this request
        // is an explicit re-statement of this user's answers (last writer
        // inside the organization wins).
        if (deepEqual(current, next)) {
            return {
                completedAt: user.onboardingCompletedAt
                    ? user.onboardingCompletedAt.toISOString()
                    : null,
                dismissedAt: user.onboardingDismissedAt
                    ? user.onboardingDismissedAt.toISOString()
                    : null,
                state: current,
                organizationProfile: patch.state?.profile
                    ? await this.mirrorOrganizationProfile(userId, current.profile)
                    : await this.readOrganizationProfile(),
            };
        }

        const updated = await this.userRepository.update(userId, {
            onboardingState: next,
        });

        // A53 — mirror the answers at org level. Only when the patch
        // actually carried a `profile` (an unrelated step transition must
        // not re-stamp the org row) and only inside a resolved org scope.
        const organizationProfile = patch.state?.profile
            ? await this.mirrorOrganizationProfile(userId, next.profile)
            : await this.readOrganizationProfile();

        return {
            completedAt: updated?.onboardingCompletedAt
                ? updated.onboardingCompletedAt.toISOString()
                : null,
            dismissedAt: updated?.onboardingDismissedAt
                ? updated.onboardingDismissedAt.toISOString()
                : null,
            state: next,
            organizationProfile,
        };
    }

    // ─── Organization-scoped mirror (A53) ───────────────────────────────

    /**
     * Resolve the organization the current request runs in, or `null`
     * when there is none (no scope service wired, called outside a
     * request, or a user who has not created an Organization yet).
     */
    private currentOrganizationId(): string | null {
        if (!this.scopeContext || !this.orgProfileRepository) return null;
        return this.scopeContext.getOrganizationId();
    }

    /** Read the org-level profile for the active scope; `null` when absent. */
    private async readOrganizationProfile(): Promise<OnboardingProfile | null> {
        const organizationId = this.currentOrganizationId();
        if (!organizationId) return null;
        try {
            const row = await this.orgProfileRepository!.findByOrg(organizationId);
            if (!row) return null;
            return (
                normaliseProfile({
                    roles: row.roles ?? undefined,
                    teamSize: row.teamSize ?? undefined,
                }) ?? null
            );
        } catch (error) {
            // Best-effort enrichment — a read failure must never turn a
            // successful onboarding save into a 500.
            this.logger.warn(
                `Failed to read organization onboarding profile for ${organizationId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    /**
     * Persist the merged profile onto the active organization. Values are
     * already id-validated by `OnboardingStatePatchInnerDto` and merged by
     * `mergeProfile`, so the row simply follows the user's latest answers.
     */
    private async mirrorOrganizationProfile(
        userId: string,
        profile: OnboardingProfile | undefined,
    ): Promise<OnboardingProfile | null> {
        const organizationId = this.currentOrganizationId();
        if (!organizationId) return null;
        try {
            const row = await this.orgProfileRepository!.upsert(organizationId, {
                roles: profile?.roles ? [...profile.roles] : null,
                teamSize: profile?.teamSize ?? null,
                updatedByUserId: userId,
            });
            return (
                normaliseProfile({
                    roles: row.roles ?? undefined,
                    teamSize: row.teamSize ?? undefined,
                }) ?? null
            );
        } catch (error) {
            this.logger.warn(
                `Failed to persist organization onboarding profile for ${organizationId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    async markCompleted(userId: string): Promise<OnboardingStateResponse> {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException(`User ${userId} not found`);
        }

        // Idempotent: if already marked, return the existing payload.
        if (user.onboardingCompletedAt) {
            return this.getState(userId);
        }

        const now = new Date();
        const updated = await this.userRepository.update(userId, {
            onboardingCompletedAt: now,
        });

        this.logger.log(`Onboarding completed for user ${userId}`);

        return {
            completedAt: now.toISOString(),
            dismissedAt: updated?.onboardingDismissedAt
                ? updated.onboardingDismissedAt.toISOString()
                : null,
            state: normaliseState(updated?.onboardingState),
            organizationProfile: await this.readOrganizationProfile(),
        };
    }

    async markDismissed(userId: string): Promise<OnboardingStateResponse> {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException(`User ${userId} not found`);
        }

        if (user.onboardingDismissedAt) {
            return this.getState(userId);
        }

        const now = new Date();
        const updated = await this.userRepository.update(userId, {
            onboardingDismissedAt: now,
        });

        return {
            completedAt: updated?.onboardingCompletedAt
                ? updated.onboardingCompletedAt.toISOString()
                : null,
            dismissedAt: now.toISOString(),
            state: normaliseState(updated?.onboardingState),
            organizationProfile: await this.readOrganizationProfile(),
        };
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Wave 11 — known "What do you do" ids. Persisted values outside these
// sets are DROPPED on read (drop-if-unrecognised, never defaulted), so
// a stale/foreign payload can't smuggle arbitrary strings back out.
const KNOWN_ROLE_IDS: ReadonlySet<string> = new Set(ROLE_OPTIONS.map((option) => option.id));
const KNOWN_TEAM_SIZE_IDS: ReadonlySet<string> = new Set(
    TEAM_SIZE_OPTIONS.map((option) => option.id),
);

/** Coerce a possibly-null / legacy payload into a complete v2 state. */
function normaliseState(raw: OnboardingWizardStateV2 | null | undefined): OnboardingWizardStateV2 {
    if (!raw) return { ...ONBOARDING_DEFAULT_STATE };

    const profile = normaliseProfile(raw.profile);
    return {
        version: 2,
        lastStep: typeof raw.lastStep === 'number' && raw.lastStep >= 0 ? raw.lastStep : 0,
        ai: { choice: raw.ai?.choice ?? ONBOARDING_DEFAULT_STATE.ai.choice },
        storage: { choice: raw.storage?.choice ?? ONBOARDING_DEFAULT_STATE.storage.choice },
        db: { choice: raw.db?.choice ?? ONBOARDING_DEFAULT_STATE.db.choice },
        deploy: { choice: raw.deploy?.choice ?? ONBOARDING_DEFAULT_STATE.deploy.choice },
        skippedSteps: Array.isArray(raw.skippedSteps) ? [...raw.skippedSteps] : [],
        pluginsReviewed: raw.pluginsReviewed === true,
        // EW-722: contract-declared optional `prompt` (EW-617 G4) round-trips
        // when persisted; non-string legacy values are dropped.
        ...(typeof raw.prompt === 'string' ? { prompt: raw.prompt } : {}),
        // Wave 11 — optional profile answers round-trip after id filtering.
        ...(profile ? { profile } : {}),
    };
}

/**
 * Wave 11 — sanitise a persisted profile blob: keep only known role /
 * team-size ids, drop everything else. Returns undefined when nothing
 * valid remains so the field disappears instead of persisting `{}`.
 */
function normaliseProfile(
    raw: OnboardingProfile | null | undefined,
): OnboardingProfile | undefined {
    if (!raw || typeof raw !== 'object') return undefined;

    const roles = Array.isArray(raw.roles)
        ? raw.roles.filter(
              (role): role is string => typeof role === 'string' && KNOWN_ROLE_IDS.has(role),
          )
        : undefined;
    const teamSize =
        typeof raw.teamSize === 'string' && KNOWN_TEAM_SIZE_IDS.has(raw.teamSize)
            ? raw.teamSize
            : undefined;

    const profile: { roles?: string[]; teamSize?: string } = {};
    if (roles && roles.length > 0) profile.roles = roles;
    if (teamSize) profile.teamSize = teamSize;
    return profile.roles || profile.teamSize ? profile : undefined;
}

function mergeState(
    current: OnboardingWizardStateV2,
    patch: NonNullable<OnboardingStatePatchRequest['state']>,
): OnboardingWizardStateV2 {
    // Wave 11 — profile deep-merges per field: a patch that only sends
    // `roles` keeps the persisted `teamSize` (and vice versa); omitting
    // `profile` entirely keeps the current value. Values arriving here
    // were already id-validated by `OnboardingStatePatchInnerDto`.
    const mergedProfile = mergeProfile(current.profile, patch.profile);
    return {
        version: 2,
        lastStep: typeof patch.lastStep === 'number' ? patch.lastStep : current.lastStep,
        ai: { choice: patch.ai?.choice ?? current.ai.choice },
        storage: { choice: patch.storage?.choice ?? current.storage.choice },
        db: {
            choice: patch.db?.choice ?? current.db?.choice ?? ONBOARDING_DEFAULT_STATE.db.choice,
        },
        deploy: { choice: patch.deploy?.choice ?? current.deploy.choice },
        skippedSteps: Array.isArray(patch.skippedSteps)
            ? [...patch.skippedSteps]
            : [...current.skippedSteps],
        pluginsReviewed:
            typeof patch.pluginsReviewed === 'boolean'
                ? patch.pluginsReviewed
                : current.pluginsReviewed,
        // EW-722: persist the contract-declared `prompt` (validated to
        // ≤ 5000 chars by `OnboardingStatePatchInnerDto`); keep the current
        // value when the patch omits it, matching the other fields.
        ...(typeof patch.prompt === 'string'
            ? { prompt: patch.prompt }
            : typeof current.prompt === 'string'
              ? { prompt: current.prompt }
              : {}),
        ...(mergedProfile ? { profile: mergedProfile } : {}),
    };
}

function mergeProfile(
    current: OnboardingProfile | undefined,
    patch: OnboardingProfile | undefined,
): OnboardingProfile | undefined {
    if (!patch) return current;

    const roles = Array.isArray(patch.roles) ? [...patch.roles] : current?.roles;
    const teamSize = typeof patch.teamSize === 'string' ? patch.teamSize : current?.teamSize;

    const profile: { roles?: string[]; teamSize?: string } = {};
    if (roles && roles.length > 0) profile.roles = [...roles];
    if (teamSize) profile.teamSize = teamSize;
    return profile.roles || profile.teamSize ? profile : undefined;
}

function deepEqual(a: OnboardingWizardStateV2, b: OnboardingWizardStateV2): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export const __test__ = { normaliseState, mergeState };
