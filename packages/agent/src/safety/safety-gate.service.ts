import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    RAIL_REFUSAL_SUBJECT_TYPES,
    SAFETY_ALLOW,
    UNCLASSIFIED_ACTION_POLICY,
    type RailRefusalSubjectType,
    type SafetyVerdict,
} from '@ever-works/contracts';
import { RUN_KILL_SWITCH, type RunKillSwitch } from '../agents/run-kill-switch';
import { classifyAction } from './action-category';
import { AutonomyGrantService } from './autonomy-grant.service';
import { RailRefusalService } from './rail-refusal.service';
import { defaultSafetyRailChain } from './rails';
import {
    composeSafetyRails,
    type SafetyCapCheck,
    type SafetyGrantCheck,
    type SafetyRailContext,
    type SafetyRailSubject,
    type SafetyRuleCheck,
    type SafetyScopePause,
} from './safety-rails';
import { SafetyStateCache, type SafetySnapshot } from './safety-state.cache';
import type { SafetyGate, SafetyGateInput, SafetyGateVerdict } from './safety-gate.port';
import { WorkspacePauseService } from './workspace-pause.service';

/**
 * Safety rails (AW-24) — the single enforcement point.
 *
 * Classify the action, evaluate every rail in the published order, record
 * whatever the verdict was, and answer. That is the whole service: the rules
 * live in pure files next door and the individual decisions belong to the
 * mechanisms that already own them.
 *
 * ## Why this is the load-bearing claim of the epic
 *
 * FR-14: every rail is evaluated IN THE PLATFORM PROCESS, from persisted
 * records, after the model has produced its intent and before the side effect
 * happens. A rail that lives in the prompt is not a rail. Nothing the model
 * can write reaches `SafetyRailContext` — which is why that type has no field
 * for an instruction, an argument or a document.
 *
 * ## Never throws for a policy reason
 *
 * A refusal is a verdict, not an exception. An INTERNAL failure — a rail that
 * threw, a chain that mis-composed — is caught here and converted into the
 * fail-closed verdict, because the alternative is an unhandled error on the
 * tool loop's hot path silently becoming "allowed".
 */
@Injectable()
export class SafetyGateService implements SafetyGate {
    private readonly logger = new Logger(SafetyGateService.name);
    private readonly chain = composeSafetyRails(defaultSafetyRailChain());

    constructor(
        private readonly grants: AutonomyGrantService,
        private readonly pauses: WorkspacePauseService,
        private readonly refusals: RailRefusalService,
        private readonly cache: SafetyStateCache,
        // The platform stop flag (EW-778). Unbound on an install with no
        // fleet stack — the rail then passes through, exactly as the run
        // admission chain's kill-switch middleware does.
        @Optional() @Inject(RUN_KILL_SWITCH) private readonly killSwitch?: RunKillSwitch,
        // The remaining three rails delegate to mechanisms that already own
        // their decisions. Each is optional and appended last, so every
        // existing positional constructor call keeps working and an install
        // that binds none of them behaves exactly as it did before.
        @Optional() private readonly scopePause?: SafetyScopePause,
        @Optional() private readonly grantCheck?: SafetyGrantCheck,
        @Optional() private readonly capCheck?: SafetyCapCheck,
        @Optional() private readonly ruleCheck?: SafetyRuleCheck,
    ) {}

    async evaluate(input: SafetyGateInput): Promise<SafetyGateVerdict> {
        const subject = toSubject(input);
        const category = classifyAction(input.entryPointId, {
            pluginId: input.pluginId ?? null,
            toolName: input.toolName ?? null,
            manifestCategories: input.manifestCategories ?? null,
        });

        let snapshot: SafetySnapshot;
        try {
            snapshot = await this.snapshot(input, subject);
        } catch (error) {
            // A snapshot this service could not build is the fail-closed case
            // the whole epic is written around: it must never become "allow".
            this.logger.error(
                `Safety gate could not read its own state for user ${subject.userId} — ` +
                    `refusing (safe mode): ${
                        error instanceof Error ? error.message : String(error)
                    }`,
            );
            return this.refuseSafeMode(subject, category, input);
        }

        const context: SafetyRailContext = {
            entryPointId: input.entryPointId,
            toolName: input.toolName ?? null,
            category,
            subject,
            ladder: snapshot.ladder,
            pause: snapshot.pause,
            widenAttemptObserved: input.widenAttemptObserved === true,
            logger: this.logger,
            platformStop: this.killSwitch,
            scopePause: this.scopePause,
            grants: this.grantCheck,
            caps: this.capCheck,
            rules: this.ruleCheck,
        };

        let verdict: SafetyVerdict;
        try {
            verdict = await this.chain(context);
        } catch (error) {
            this.logger.error(
                `Safety gate chain failed for "${input.entryPointId}" — refusing (fail-closed): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return this.refuseSafeMode(subject, category, input);
        }

        const unclassified = category === null;
        if (unclassified && UNCLASSIFIED_ACTION_POLICY === 'warn') {
            // P1 counts it and lets it through. Never guessed into a
            // permissive category, and never silently ignored either.
            this.logger.warn(
                `Safety gate: nothing classifies "${input.entryPointId}"` +
                    `${input.pluginId ? ` (plugin ${input.pluginId})` : ''} — allowed and counted.`,
            );
        }

        if (verdict.decision !== 'allow') {
            await this.refusals.record({
                userId: subject.userId,
                railId: verdict.railId ?? 'ladder',
                category: verdict.category,
                verdict: verdict.decision === 'held' ? 'held' : 'refused',
                reasonCode: verdict.reasonCode ?? 'policy-refused',
                subjectType: subject.subjectType,
                subjectId: subject.subjectId ?? null,
                agentId: subject.agentId ?? null,
                runId: subject.runId ?? null,
                summary: verdict.summary ?? 'Refused by a safety rail.',
                requested: requestedOf(input),
                ceiling: (verdict.ceiling as Record<string, unknown> | null) ?? null,
                proposalId: verdict.proposalId ?? null,
            });
            if (verdict.railId === 'workspace-pause') {
                await this.pauses.countRefusedStart({
                    tenantId: subject.tenantId ?? '',
                    organizationId: subject.organizationId ?? null,
                });
            }
        }

        return { ...verdict, unclassified: unclassified ? true : undefined };
    }

    /** Invalidate the cached snapshot for a workspace after a rung write. */
    invalidate(ownerUserId: string, workspaceScopeId: string): void {
        this.cache.invalidate({ ownerUserId, workspaceScopeId });
    }

    private async snapshot(
        input: SafetyGateInput,
        subject: SafetyRailSubject,
    ): Promise<SafetySnapshot> {
        return this.cache.get(
            {
                ownerUserId: subject.userId,
                workspaceScopeId: subject.workspaceScopeId,
                agentId: subject.agentId ?? null,
                tenantId: input.tenantId ?? null,
                organizationId: input.organizationId ?? null,
            },
            async (key) => {
                const [ladder, pause] = await Promise.all([
                    this.grants.resolve(key.ownerUserId, {
                        workspaceScopeId: key.workspaceScopeId,
                        agentId: key.agentId,
                    }),
                    this.pauses.state(
                        key.tenantId
                            ? { tenantId: key.tenantId, organizationId: key.organizationId }
                            : null,
                    ),
                ]);
                return {
                    ladder,
                    pause,
                    safe: ladder.safeMode || pause.unverified,
                    loadedAt: Date.now(),
                };
            },
        );
    }

    /** The one fail-closed answer, recorded like any other refusal. */
    private async refuseSafeMode(
        subject: SafetyRailSubject,
        category: string | null,
        input: SafetyGateInput,
    ): Promise<SafetyGateVerdict> {
        const verdict: SafetyGateVerdict = {
            decision: 'refused',
            railId: 'ladder',
            category,
            rung: 'ask',
            reasonCode: 'safe-mode',
            summary:
                'Safe mode — we could not read your safety settings, so this is stopping for you.',
            safeMode: true,
        };
        await this.refusals.record({
            userId: subject.userId,
            railId: 'ladder',
            category: (category as never) ?? null,
            verdict: 'refused',
            reasonCode: 'safe-mode',
            subjectType: subject.subjectType,
            subjectId: subject.subjectId ?? null,
            agentId: subject.agentId ?? null,
            runId: subject.runId ?? null,
            summary: verdict.summary as string,
            requested: requestedOf(input),
        });
        return verdict;
    }
}

function toSubject(input: SafetyGateInput): SafetyRailSubject {
    return {
        userId: input.userId,
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
        subjectType: toSubjectType(input.subjectType),
        subjectId: input.subjectId ?? input.runId ?? null,
        // The Organization is the workspace; an account with no Organization
        // addresses its bare-tenant workspace by its tenant id, exactly as
        // `tool_grants` addresses the tenant scope.
        workspaceScopeId: input.organizationId ?? input.tenantId ?? input.userId,
        tenantId: input.tenantId ?? null,
        organizationId: input.organizationId ?? null,
    };
}

function toSubjectType(value: string | null | undefined): RailRefusalSubjectType {
    return (RAIL_REFUSAL_SUBJECT_TYPES as readonly string[]).includes(value ?? '')
        ? (value as RailRefusalSubjectType)
        : 'run';
}

/**
 * What the refusal row records about the request.
 *
 * Identifying parameters ONLY (FR-70): the entry point, the tool name and the
 * plugin. Never an argument, never a body, never a credential — which is why
 * this function takes the whole input and returns three fields rather than
 * spreading anything.
 */
function requestedOf(input: SafetyGateInput): Record<string, unknown> {
    const requested: Record<string, unknown> = { entryPointId: input.entryPointId };
    if (input.toolName) requested.toolName = input.toolName;
    if (input.pluginId) requested.pluginId = input.pluginId;
    return requested;
}

/** Re-exported so a consumer can compare against the shared allow verdict. */
export { SAFETY_ALLOW };
