import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type {
    OnboardingSeedResponse,
    OnboardingSeedResultEntry,
    OnboardingSeedSuggestionsResponse,
} from '@ever-works/contracts/api';
import { AgentTemplatesService } from './agent-templates.service';
import { resolveRoleSeedSuggestions, type ResolveRoleSeedOptions } from './role-seeding';

/**
 * Server-side starter seeding for the onboarding role step.
 *
 * The browser used to own this: it fetched the whole agent catalog,
 * intersected `suggestedRoles` locally, and fired one create per card.
 * Moving it here buys three things the client version could not have:
 *
 *  - **One authority.** The role → kit mapping is the same for the web
 *    wizard, the desktop shell and any API caller, because there is one
 *    copy of it and it is not in a bundle.
 *  - **Idempotence.** Seeding twice (a refresh, a back-navigation, a
 *    double click) reports `already-exists` instead of creating a second
 *    "Content Marketer". The client had no way to know.
 *  - **Partial success.** One template failing does not abort the kit;
 *    each entry carries its own outcome, so the user gets the four
 *    agents that worked plus an honest note about the one that did not.
 *
 * Nothing here is gated on the user's answers — seeding is opt-in, and
 * a user who seeds nothing has a fully functional account.
 */
@Injectable()
export class OnboardingRoleSeedingService {
    private readonly logger = new Logger(OnboardingRoleSeedingService.name);

    constructor(private readonly templates: AgentTemplatesService) {}

    /** Resolve (but do not create) the starter kit for a set of roles. */
    suggest(
        roles: readonly string[] | undefined | null,
        options: ResolveRoleSeedOptions = {},
    ): OnboardingSeedSuggestionsResponse {
        return resolveRoleSeedSuggestions(roles, options);
    }

    /**
     * Activate the starter agents for `roles` on behalf of `userId`.
     *
     * Sequential on purpose: `AgentsService.create` enforces a per-user
     * name uniqueness check, and firing the kit in parallel would race
     * that check into a spurious conflict for templates that share no
     * name at all. A kit is three or four rows — the latency is not the
     * interesting number here, the correctness is.
     */
    async seed(
        userId: string,
        roles: readonly string[] | undefined | null,
        options: ResolveRoleSeedOptions = {},
    ): Promise<OnboardingSeedResponse> {
        const suggestions = this.suggest(roles, options);
        const entries: OnboardingSeedResultEntry[] = [];

        for (const suggestion of suggestions.agents) {
            try {
                const created = await this.templates.createFromTemplate(userId, suggestion.slug);
                entries.push({ slug: suggestion.slug, outcome: 'created', agentId: created.id });
            } catch (error) {
                // A name conflict means this template is ALREADY activated
                // for this user — the expected outcome of re-running the
                // step, not an error worth surfacing as one.
                if (error instanceof ConflictException) {
                    entries.push({
                        slug: suggestion.slug,
                        outcome: 'already-exists',
                        agentId: null,
                    });
                    continue;
                }
                // Best-effort per template: log the detail, return a short
                // reason. The message is catalog/validation text, never
                // credential or user data.
                this.logger.warn(
                    `Role seeding could not activate template "${suggestion.slug}": ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                entries.push({
                    slug: suggestion.slug,
                    outcome: 'failed',
                    agentId: null,
                    reason: 'Could not create this agent — try it from the Agents page.',
                });
            }
        }

        return {
            roles: suggestions.roles,
            agents: entries,
            skills: suggestions.skills,
            createdCount: entries.filter((entry) => entry.outcome === 'created').length,
            skippedCount: entries.filter((entry) => entry.outcome === 'already-exists').length,
            failedCount: entries.filter((entry) => entry.outcome === 'failed').length,
        };
    }
}
