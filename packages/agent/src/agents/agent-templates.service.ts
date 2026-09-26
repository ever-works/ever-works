import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { AgentScope } from '../entities/agent.entity';
// APW-04 T2 — repo-backed templates. Imported as its own statement (rather
// than widening the enum import above, which this additions-only slice may
// not rewrite) because the catalog path must state the entity's all-false
// permission default explicitly: a manifest can never widen an Agent.
import { AGENT_PERMISSIONS_DEFAULT } from '../entities/agent.entity';
import { AgentsService } from './agents.service';
import { AgentFileService } from './agent-file.service';
import type { AgentDto } from './types';
import { getAgentTemplate, listAgentTemplates, type AgentTemplate } from './agent-templates';
import type { OwnershipScope } from '../database/ownership-scope';
// APW-04 T2 — the repo-template reader and its catalog rules (plan §7.1).
import {
    createRepoAgentTemplateSource,
    isInstantiableRepoAgentTemplateSlug,
    REPO_TEMPLATE_GUARDRAILS,
    RepoAgentTemplateReader,
    RepoAgentTemplateRefusedError,
} from './repo-agent-template.reader';
// A VALUE import, on purpose: the constructor injects it by token (see there). No file
// cycle — nothing `facades/git.facade.ts` imports reaches this file.
import { GitFacadeService } from '../facades/git.facade';

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
    /**
     * AW-20 — the area of work the created Agent owns. Optional, so every
     * existing call site compiles and creates a laneless Agent unchanged.
     */
    lane?: string | null;
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

    /**
     * APW-04 T2 — the reader built on demand when the host did not inject one.
     * Memoized so a burst of instantiations shares one reader (and one
     * mutable-ref warning) instead of re-reading the catalog per call.
     */
    private fallbackRepoReader?: RepoAgentTemplateReader;

    constructor(
        private readonly agents: AgentsService,
        // `@Optional()` mirrors the AgentsService posture for hand-rolled
        // unit tests; production DI always provides it via AgentsModule.
        @Optional() private readonly files?: AgentFileService,
        // APW-04 T2 — repo-backed templates. Optional for the same reason: a
        // host that provides it (or a unit test that doubles it) wins, and
        // the fallback reads the PUBLIC catalog with no credentials.
        @Optional() private readonly repoReader?: RepoAgentTemplateReader,
        // APW-04 T2 — when this deployment runs the platform GitHub App, the
        // catalog read is authenticated; without it the reader still reads
        // the public repository tokenlessly.
        //
        // `@Inject(GitFacadeService)` is load-bearing: this file used to import
        // the class with `import type`, so the emitted `design:paramtypes` entry
        // was `Object` (under SWC and tsc alike), nothing provides `Object`, and
        // — the parameter being `@Optional()` — the service was built WITHOUT
        // the facade that `AgentsModule`'s `FacadesModule` import supplies.
        // `__tests__/agent-templates.git-token.spec.ts` pins it.
        @Optional()
        @Inject(GitFacadeService)
        private readonly git?: GitFacadeService,
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
            lane: input.lane ?? null,
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

    /**
     * APW-04 T2 (plan §7.1, blocker 4) — create an Agent from a REPO-BACKED
     * catalog template.
     *
     * The additive sibling of {@link createFromTemplate}: that one activates
     * the IN-CODE presets in `agent-templates.ts`, this one reads
     * `templates/<slug>/` out of the `ever-works/agents` catalog at
     * `EVER_WORKS_AGENTS_REF` (ADR-014 forbids adding the App Provisioner as
     * an in-code preset). Everything observable afterwards is the same as a
     * preset activation — owner-scoped create, `SOUL.md` written through
     * `AgentFileService`, guardrails seeded, the fresh DTO returned — with
     * three rules the plan is explicit about:
     *
     *  - **Allow-list.** Only `REPO_TEMPLATE_INSTANTIABLE_SLUGS` may be
     *    instantiated; anything else is a 404, exactly like an unknown
     *    preset slug, so the catalog cannot be used to create arbitrary
     *    Agents server-side in P1.
     *  - **Fail closed.** A missing/unknown manifest key, an unreadable file
     *    or an escaping path raises {@link RepoAgentTemplateRefusedError}
     *    carrying the refusal code — never a half-built Agent.
     *  - **The catalog can describe an Agent; it can never widen one.**
     *    Permissions are the entity's all-false default (never the
     *    manifest's flags) and guardrails are `require_approval`, whatever
     *    the file says (FR-10, plan §7.4).
     */
    async createFromRepoTemplate(
        userId: string,
        slug: string,
        input: CreateAgentFromTemplateInput = {},
        ownershipScope?: OwnershipScope,
    ): Promise<AgentDto> {
        if (!isInstantiableRepoAgentTemplateSlug(slug)) {
            throw new NotFoundException(`Agent template "${slug}" not found.`);
        }

        const read = await this.resolveRepoAgentTemplateReader().read(slug);
        if (read.status !== 'ok') {
            throw new RepoAgentTemplateRefusedError(slug, read);
        }
        const template = read.template;

        const createInput = {
            scope: input.scope ?? AgentScope.TENANT,
            missionId: input.missionId ?? null,
            ideaId: input.ideaId ?? null,
            workId: input.workId ?? null,
            name: input.name?.trim() || template.name,
            title: template.title,
            capabilities: template.capabilities,
            lane: input.lane ?? null,
            // All false, taken from the entity's own default. The manifest's
            // `permissions` mapping was validated for SHAPE only and is never
            // applied (FR-10: the Provisioner's tools are granted separately,
            // by exact name, through the tool-grant matrix).
            permissions: { ...AGENT_PERMISSIONS_DEFAULT },
        };
        const created = ownershipScope
            ? await this.agents.create(userId, createInput, ownershipScope)
            : await this.agents.create(userId, createInput);

        // Same ordering as the preset path: the Agent row exists first, so a
        // failed file write surfaces loudly instead of leaving no Agent.
        if (this.files) {
            await this.files.write({
                userId,
                agentId: created.id,
                name: 'SOUL.md',
                body: template.soul,
            });
        } else {
            this.logger.warn(
                `AgentFileService unavailable — created "${created.id}" from repo template "${slug}" without SOUL.md.`,
            );
        }

        return ownershipScope
            ? this.agents.setGuardrails(
                  userId,
                  created.id,
                  REPO_TEMPLATE_GUARDRAILS,
                  ownershipScope,
              )
            : this.agents.setGuardrails(userId, created.id, REPO_TEMPLATE_GUARDRAILS);
    }

    /**
     * The repo-template reader: the injected one when the host provides it,
     * else one built from whatever git facade this service was given (an
     * absent facade degrades to the tokenless public read — never to a
     * refusal, because the catalog repository is public).
     */
    private resolveRepoAgentTemplateReader(): RepoAgentTemplateReader {
        if (this.repoReader) {
            return this.repoReader;
        }

        this.fallbackRepoReader ??= new RepoAgentTemplateReader(
            createRepoAgentTemplateSource(this.git),
        );
        return this.fallbackRepoReader;
    }
}
