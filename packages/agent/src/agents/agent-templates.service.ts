import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { AgentScope } from '../entities/agent.entity';
import { AgentsService } from './agents.service';
import { AgentFileService } from './agent-file.service';
import type { AgentDto } from './types';
import { getAgentTemplate, listAgentTemplates, type AgentTemplate } from './agent-templates';
import type { OwnershipScope } from '../database/ownership-scope';

/**
 * Optional placement overrides accepted by {@link AgentTemplatesService.createFromTemplate}.
 * Everything else (prompt, permissions, guardrails, capabilities) comes
 * from the template itself — overrides only cover naming and scope so a
 * template can be activated into a Mission/Idea/Work context.
 */
export interface CreateAgentFromTemplateInput {
    name?: string | null;
    scope?: AgentScope;
    missionId?: string | null;
    ideaId?: string | null;
    workId?: string | null;
}

/**
 * Wave 10 — prebuilt agent-template activation.
 *
 * Thin orchestration over the existing Agent surfaces: `AgentsService.create`
 * creates the row (owner-scoped, DRAFT status, same validation as manual
 * creation), `AgentFileService.write` persists the template's system
 * prompt as SOUL.md, and `AgentsService.setGuardrails` seeds the
 * review-before-act guardrails. No new persistence concepts — templates
 * are catalog data and the result is an ordinary Agent row.
 */
@Injectable()
export class AgentTemplatesService {
    private readonly logger = new Logger(AgentTemplatesService.name);

    constructor(
        private readonly agents: AgentsService,
        // `@Optional()` mirrors the AgentsService posture for hand-rolled
        // unit tests; production DI always provides it via AgentsModule.
        @Optional() private readonly files?: AgentFileService,
    ) {}

    /** The full prebuilt-template catalog. */
    list(): readonly AgentTemplate[] {
        return listAgentTemplates();
    }

    /** One template by slug — 404 when unknown. */
    get(slug: string): AgentTemplate {
        const template = getAgentTemplate(slug);
        if (!template) {
            throw new NotFoundException(`Agent template "${slug}" not found.`);
        }
        return template;
    }

    /**
     * Create an Agent for `userId` from the template `slug`.
     *
     * Owner-scoped and additive: the caller becomes the owner, the Agent
     * starts in DRAFT (same as any manual create), and name conflicts
     * surface as the standard 409 so callers can retry with an override.
     */
    async createFromTemplate(
        userId: string,
        slug: string,
        input: CreateAgentFromTemplateInput = {},
        ownershipScope?: OwnershipScope,
    ): Promise<AgentDto> {
        const template = this.get(slug);
        const scope = input.scope ?? AgentScope.TENANT;

        const createInput = {
            scope,
            missionId: input.missionId ?? null,
            ideaId: input.ideaId ?? null,
            workId: input.workId ?? null,
            name: input.name?.trim() || template.name,
            title: template.title,
            capabilities: template.capabilities,
            permissions: template.defaultPermissions,
        };
        const created = ownershipScope
            ? await this.agents.create(userId, createInput, ownershipScope)
            : await this.agents.create(userId, createInput);

        // Persist the template's system prompt as the Agent's SOUL.md.
        // Best-effort ordering: the Agent row exists first, so a failed
        // file write surfaces loudly instead of leaving no Agent at all.
        if (this.files) {
            await this.files.write({
                userId,
                agentId: created.id,
                name: 'SOUL.md',
                body: template.systemPrompt,
            });
        } else {
            this.logger.warn(
                `AgentFileService unavailable — created "${created.id}" from template "${slug}" without SOUL.md.`,
            );
        }

        // Seed the review-before-act guardrails and return the fresh DTO.
        return ownershipScope
            ? this.agents.setGuardrails(
                  userId,
                  created.id,
                  template.defaultGuardrails,
                  ownershipScope,
              )
            : this.agents.setGuardrails(userId, created.id, template.defaultGuardrails);
    }
}
