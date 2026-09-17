import { Injectable, Logger } from '@nestjs/common';
import type { RosterSkillBinder } from '@ever-works/agent/agents';
import { SkillsFacadeService } from '@ever-works/agent/facades';
import { SkillsService } from '@ever-works/agent/skills';
import { SkillBindingRepository, SkillRepository } from '@ever-works/agent/database';

/**
 * AW-20 P1 — the implementation behind `ROSTER_SKILL_BINDER`.
 *
 * Provisioning asks "attach this catalog slug to that agent" and does not
 * care how; this adapter is the how. It lives api-side because resolving
 * a catalog entry goes through `SkillsFacadeService`, which walks the
 * enabled skills-provider plugins — the provisioning service has to stay
 * runtime-free so it can run from the worker and be unit tested.
 *
 * ## No plugin id appears here
 *
 * The slug is resolved through the capability facade, which asks whichever
 * skills providers the user has enabled. Nothing names a provider
 * (Constitution II), so an operator who swaps the first-party catalog for
 * their own keeps a working roster.
 *
 * ## Idempotent, because a lane retry calls it again
 *
 * Installing is skipped when the user already owns the Skill at their own
 * scope, and binding is skipped when the Agent is already bound. A second
 * provisioning run therefore neither duplicates a Skill nor stacks
 * bindings — it simply confirms what is already true.
 */
@Injectable()
export class RosterSkillBinderAdapter implements RosterSkillBinder {
    private readonly logger = new Logger(RosterSkillBinderAdapter.name);

    constructor(
        private readonly skills: SkillsService,
        private readonly skillRepository: SkillRepository,
        private readonly bindings: SkillBindingRepository,
        private readonly catalog: SkillsFacadeService,
    ) {}

    async attach(input: {
        readonly userId: string;
        readonly agentId: string;
        readonly skillSlug: string;
        readonly organizationId: string | null;
    }): Promise<void> {
        const skillId = await this.ensureInstalled(input.userId, input.skillSlug);

        const existing = await this.bindings.findBySkillId(skillId, input.userId);
        if (existing.some((row) => row.targetType === 'agent' && row.targetId === input.agentId)) {
            return;
        }

        await this.skills.createBinding(input.userId, {
            skillId,
            targetType: 'agent',
            targetId: input.agentId,
            injectIntoAgent: true,
        });
    }

    /**
     * The Skill row for this slug at the caller's own scope, installing it
     * from the catalog when they do not have it yet.
     *
     * Installed at `tenant` scope — the person's own library — rather than
     * at agent scope, so a second roster agent that wants the same Skill
     * reuses one row instead of importing a private copy per agent.
     */
    private async ensureInstalled(userId: string, slug: string): Promise<string> {
        const owned = await this.skillRepository.findByOwnerSlug('tenant', userId, slug);
        if (owned) return owned.id;

        const found = await this.catalog.getEntry(slug, { userId });
        if (!found) {
            throw new Error(`Catalog skill "${slug}" is not available.`);
        }

        try {
            const installed = await this.skills.installFromCatalog(userId, {
                catalogProviderId: found.providerId,
                catalogSlug: slug,
                ownerType: 'tenant',
                ownerId: userId,
                entry: found.entry,
            });
            return installed.id;
        } catch (error) {
            // A conflict means a concurrent lane installed it first — the
            // outcome we wanted. Re-read rather than failing the lane.
            const raced = await this.skillRepository.findByOwnerSlug('tenant', userId, slug);
            if (raced) return raced.id;
            this.logger.warn(
                `Could not install catalog skill "${slug}": ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            throw error;
        }
    }
}
