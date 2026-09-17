import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
    type AutonomyGrantScopeType,
    type LadderedActionCategory,
    type ResolvedLadder,
    type TrustRung,
} from '@ever-works/contracts';
import { AutonomyGrantRepository } from './autonomy-grant.repository';
import {
    ladderEntry,
    resolveLadder,
    validateRungWrite,
    type AutonomyGrantRow,
} from './trust-ladder';

/**
 * The actor a rung write requires.
 *
 * `isHuman: true` is a LITERAL, not a boolean: a caller cannot construct this
 * type with `isHuman: someFlag`, so the only way to reach the write path is to
 * have come through the human-actor guard that produces it (FR-31). An API
 * key, an agent, a schedule, a trigger or a webhook simply cannot make one.
 */
export interface HumanActor {
    userId: string;
    isHuman: true;
}

export interface LadderScope {
    /** The Organization id, or the tenant id for a bare-tenant workspace. */
    workspaceScopeId: string;
    agentId?: string | null;
}

export interface WriteRungInput extends LadderScope {
    ownerUserId: string;
    scopeType: AutonomyGrantScopeType;
    scopeId: string;
    category: LadderedActionCategory;
    rung: TrustRung;
    note?: string | null;
}

/**
 * Safety rails (AW-24) — resolving the ladder and writing one rung.
 *
 * The RULES live in `trust-ladder.ts` (pure, tested on its own). This service
 * is the IO half: it loads the rows for the scopes that matter, hands them to
 * the resolver, and — on a write — validates against the ladder as it stands
 * before persisting.
 *
 * ## Fail closed
 *
 * `resolve()` never throws. A read it could not complete returns a ladder in
 * SAFE MODE: every laddered category behaves as **Ask** (or at its ceiling,
 * where that is stricter), and the ladder says `safeMode: true` so the screen
 * can say so out loud. FR-18 — reads and already-running work are unaffected,
 * which is the gate's business rather than this service's.
 */
@Injectable()
export class AutonomyGrantService {
    private readonly logger = new Logger(AutonomyGrantService.name);

    constructor(private readonly repository: AutonomyGrantRepository) {}

    /** The ladder in force for a workspace, or for one Agent inside it. */
    async resolve(ownerUserId: string, scope: LadderScope): Promise<ResolvedLadder> {
        const scopes: Array<{ scopeType: AutonomyGrantScopeType; scopeId: string }> = [
            { scopeType: 'workspace', scopeId: scope.workspaceScopeId },
        ];
        if (scope.agentId) scopes.push({ scopeType: 'agent', scopeId: scope.agentId });

        let rows: AutonomyGrantRow[];
        try {
            rows = await this.repository.findForScopes(ownerUserId, scopes);
        } catch (error) {
            this.logger.error(
                `Trust ladder could not be read for user ${ownerUserId} — resolving every ` +
                    `laddered category to Ask (safe mode): ${
                        error instanceof Error ? error.message : String(error)
                    }`,
            );
            return resolveLadder([], { ...scope, safeMode: true });
        }
        return resolveLadder(rows, scope);
    }

    /**
     * Write one rung. Only a person may (FR-31) — which is why the actor type
     * cannot be fabricated.
     *
     * Validation runs against the ladder as it stands RIGHT NOW rather than
     * against a value the caller supplied, so a stale screen cannot skip a
     * rung by sending an out-of-date `current`.
     */
    async write(actor: HumanActor, input: WriteRungInput): Promise<ResolvedLadder> {
        const ladder = await this.resolve(input.ownerUserId, {
            workspaceScopeId: input.workspaceScopeId,
            agentId: input.scopeType === 'agent' ? input.scopeId : (input.agentId ?? null),
        });
        if (ladder.safeMode) {
            throw new BadRequestException(
                'Your safety settings could not be read, so nothing can be changed until they can.',
            );
        }

        const entry = ladderEntry(ladder, input.category);
        if (!entry) {
            throw new BadRequestException(`"${input.category}" is not a kind of work we ladder.`);
        }

        const violation = validateRungWrite({
            category: input.category,
            current: entry.rung,
            next: input.rung,
            workspaceRung: input.scopeType === 'agent' ? (entry.workspaceRung ?? entry.rung) : null,
        });
        if (violation) throw new BadRequestException(violation);

        await this.repository.upsert({
            userId: input.ownerUserId,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            category: input.category,
            rung: input.rung,
            setByUserId: actor.userId,
            note: input.note ?? null,
        });

        return this.resolve(input.ownerUserId, {
            workspaceScopeId: input.workspaceScopeId,
            agentId: input.agentId ?? null,
        });
    }

    /**
     * Delete one rung, reverting that (scope, category) to inherit.
     *
     * A row that is not the caller's reads as NOT FOUND rather than
     * forbidden — a foreign identifier must never confirm that it exists.
     */
    async revert(
        actor: HumanActor,
        ownerUserId: string,
        grantId: string,
        scope: LadderScope,
    ): Promise<ResolvedLadder> {
        const removed = await this.repository.deleteById(ownerUserId, grantId);
        if (!removed) throw new NotFoundException('Rung not found');
        this.logger.log(
            `Trust ladder: ${actor.userId} reverted "${removed.category}" at ${removed.scopeType} ` +
                `scope to inherit.`,
        );
        return this.resolve(ownerUserId, scope);
    }
}
