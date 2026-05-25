import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    forwardRef,
    Get,
    Headers,
    OnModuleInit,
    Optional,
    Param,
    Post,
    Query,
    Inject,
} from '@nestjs/common';
import { WorkProposalsApiService } from '../work-proposals/work-proposals.service';
import superjson from 'superjson';
import { timingSafeEqual } from 'crypto';
import { Public } from '../auth/decorators/public.decorator';
import { config } from '@ever-works/agent/config';
import {
    WorkRepository,
    AuthAccountRepository,
    TemplateRepository,
    TemplateCustomizationRepository,
    UserTemplatePreferenceRepository,
    UserRepository,
    WorkKnowledgeDocumentRepository,
} from '@ever-works/agent/database';
import { Work, User } from '@ever-works/agent/entities';
import { CACHE_MANAGER, Cache } from '@ever-works/agent/cache';
import { WorkOperationsService } from '@ever-works/agent/work-operations';
import { WorkContextResponse } from '@ever-works/agent/tasks';
import { SkipThrottle } from '@nestjs/throttler';
import {
    DeployReadyPollerService,
    WorkOwnershipService,
    WorkScheduleDispatcherService,
    WorkScheduleService,
} from '@ever-works/agent/services';
import { MissionTickService } from '@ever-works/agent/missions';
import { DataSyncDispatcherService } from '../data-sync/data-sync-dispatcher.service';
import { NotificationService } from '@ever-works/agent/notifications';
import { GitFacadeService } from '@ever-works/agent/facades';
import { RemoteCallDto } from './dto/remote-call.dto';
import {
    PluginRepository,
    UserPluginRepository,
    WorkPluginRepository,
} from '@ever-works/agent/plugins';

/**
 * C-05 RPC half — methods that must never be reachable via `POST
 * /internal/trigger/remote/call`, regardless of the service being called.
 * Most are Object/Function builtins that an attacker could otherwise use
 * to walk the prototype chain, rebind `this`, or invoke arbitrary code.
 */
const DANGEROUS_METHOD_NAMES = new Set<string>([
    'constructor',
    'prototype',
    '__proto__',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toString',
    'toLocaleString',
    'valueOf',
    'apply',
    'call',
    'bind',
    'eval',
]);

const METHOD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * C-05 RPC half — at module-init time, build a per-service allow-list of
 * "methods declared directly on this service class" by inspecting the
 * prototype's own property names. Methods inherited from Object / Function
 * / NestJS lifecycle base classes are excluded automatically because they
 * live on a different prototype level.
 *
 * Combined with `DANGEROUS_METHOD_NAMES` and `METHOD_NAME_RE` checks in
 * `callRemote`, this means an attacker who learns `TRIGGER_INTERNAL_SECRET`
 * can only call methods that the platform team deliberately declared on
 * the registered services — not arbitrary prototype-chain methods.
 */
function buildMethodAllowList(instance: object): Set<string> {
    const allowed = new Set<string>();
    if (!instance || typeof instance !== 'object') return allowed;

    const considerName = (name: string) => {
        if (DANGEROUS_METHOD_NAMES.has(name)) return;
        if (!METHOD_NAME_RE.test(name)) return;
        if (name.startsWith('_')) return; // convention: private
        if (typeof (instance as Record<string, unknown>)[name] !== 'function') return;
        allowed.add(name);
    };

    // Own-property methods first — covers arrow-function class fields bound in
    // the constructor (`this.foo = () => ...`), which are how some NestJS
    // services preserve `this` for callbacks. Without this, those methods
    // would not be callable via the allow-list and the call would be rejected
    // even though it's a legitimate method on the registered instance.
    for (const name of Object.getOwnPropertyNames(instance)) considerName(name);

    // Prototype chain — class methods declared with the `method() {}` shorthand
    // live here. Stop at `Object.prototype` so we never expose `constructor`,
    // `hasOwnProperty`, etc.
    let proto: object | null = Object.getPrototypeOf(instance);
    while (proto && proto !== Object.prototype) {
        for (const name of Object.getOwnPropertyNames(proto)) considerName(name);
        proto = Object.getPrototypeOf(proto);
    }
    return allowed;
}

@SkipThrottle({ short: true, medium: true, long: true })
@Controller('internal/trigger')
export class TriggerInternalController implements OnModuleInit {
    private remoteMap: Record<string, object> = {};
    private allowedMethods: Record<string, Set<string>> = {};

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly ownershipService: WorkOwnershipService,
        private readonly workOperationsService: WorkOperationsService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private readonly scheduleDispatcher: WorkScheduleDispatcherService,
        private readonly workScheduleService: WorkScheduleService,
        private readonly notificationService: NotificationService,
        private readonly gitFacade: GitFacadeService,
        private readonly pluginRepository: PluginRepository,
        private readonly userPluginRepository: UserPluginRepository,
        private readonly workPluginRepository: WorkPluginRepository,
        private readonly authAccountRepository: AuthAccountRepository,
        private readonly templateRepository: TemplateRepository,
        private readonly templateCustomizationRepository: TemplateCustomizationRepository,
        private readonly userTemplatePreferenceRepository: UserTemplatePreferenceRepository,
        private readonly userRepository: UserRepository,
        // EW-628 G7 — dispatcher fanned out from the data-repo-sync cron.
        private readonly dataSyncDispatcher: DataSyncDispatcherService,
        // EW-617 G8 — exposed for the deploy-ready-poller cron task.
        private readonly deployReadyPoller: DeployReadyPollerService,
        // EW-641 — exposed for the KB mirror Trigger.dev task so it can
        // read + update WorkKnowledgeDocument rows over the internal
        // RPC channel without direct DB access from worker scope.
        private readonly workKnowledgeDocumentRepository: WorkKnowledgeDocumentRepository,
        // Phase 3 PR J — exposed for the mission-tick Trigger.dev cron
        // so it can drive `tickDue()` over the internal RPC channel.
        private readonly missionTickService: MissionTickService,
        @Optional()
        @Inject(forwardRef(() => WorkProposalsApiService))
        private readonly workProposalsApiService?: WorkProposalsApiService,
    ) {}

    onModuleInit() {
        this.remoteMap = {
            AuthAccountRepository: this.authAccountRepository,
            PluginRepository: this.pluginRepository,
            UserPluginRepository: this.userPluginRepository,
            WorkPluginRepository: this.workPluginRepository,
            WorkOperationsService: this.workOperationsService,
            NotificationService: this.notificationService,
            WorkRepository: this.workRepository,
            TemplateRepository: this.templateRepository,
            TemplateCustomizationRepository: this.templateCustomizationRepository,
            UserTemplatePreferenceRepository: this.userTemplatePreferenceRepository,
            UserRepository: this.userRepository,
            CacheManager: this.cacheManager,
            WorkScheduleDispatcherService: this.scheduleDispatcher,
            WorkScheduleService: this.workScheduleService,
            // EW-628 G7 — exposed for the data-repo-sync dispatcher cron.
            DataSyncDispatcherService: this.dataSyncDispatcher,
            // EW-617 G8 — exposed for the deploy-ready-poller cron task.
            DeployReadyPollerService: this.deployReadyPoller,
            // EW-641 — exposed for the KB mirror Trigger.dev task.
            WorkKnowledgeDocumentRepository: this.workKnowledgeDocumentRepository,
            // Phase 3 PR J — exposed for the mission-tick cron.
            MissionTickService: this.missionTickService,
            ...(this.workProposalsApiService
                ? { WorkProposalsApiService: this.workProposalsApiService }
                : {}),
        };

        // C-05 RPC half: build a per-service allow-list of callable methods.
        // Only methods declared directly on the service class (or one of its
        // parents in the chain, excluding Object.prototype) are callable
        // via /internal/trigger/remote/call.
        this.allowedMethods = Object.fromEntries(
            Object.entries(this.remoteMap).map(([name, instance]) => [
                name,
                buildMethodAllowList(instance),
            ]),
        );
    }

    @Get('works/:id/context')
    @Public()
    async getWorkContext(
        @Headers('x-trigger-secret') secret: string,
        @Param('id') workId: string,
        @Query('userId') userId: string,
    ): Promise<WorkContextResponse> {
        this.ensureSecret(secret);

        if (!userId) {
            throw new BadRequestException('Missing userId');
        }

        const { work } = await this.ownershipService.ensureAccess(workId, userId);

        const gitToken = await this.gitFacade.getAccessToken({
            userId,
            providerId: work.gitProvider,
            workId: work.id,
        });

        return {
            work: this.stripRelations(work),
            user: this.stripSensitiveUserData(work.user),
            gitToken: gitToken ?? undefined,
        };
    }

    @Post('remote/call')
    @Public()
    async callRemote(@Headers('x-trigger-secret') secret: string, @Body() body: RemoteCallDto) {
        this.ensureSecret(secret);

        // C-05 RPC half: hard input shape. We are NOT relying on Nest's
        // ValidationPipe alone — repeated locally so the security-critical
        // shape is obvious at the callsite.
        if (typeof body?.name !== 'string' || !METHOD_NAME_RE.test(body.name)) {
            throw new BadRequestException(`Invalid remote target: ${body?.name}`);
        }
        if (typeof body?.method !== 'string' || !METHOD_NAME_RE.test(body.method)) {
            throw new BadRequestException(`Invalid method: ${body?.method}`);
        }
        if (DANGEROUS_METHOD_NAMES.has(body.method)) {
            throw new BadRequestException(`Method not callable: ${body.method}`);
        }

        const instance = this.remoteMap[body.name];

        if (!instance) {
            throw new BadRequestException(`Unknown remote target: ${body.name}`);
        }

        // C-05 RPC half: enforce the per-service allow-list built at boot.
        // This is what stops the "arbitrary method on arbitrary service"
        // attack the audit flagged — any method not present in the
        // allow-list is rejected before we look up `fn`.
        const allowed = this.allowedMethods[body.name];
        if (!allowed || !allowed.has(body.method)) {
            throw new BadRequestException(
                `Method not in allow-list for ${body.name}: ${body.method}`,
            );
        }

        const fn = (instance as Record<string, unknown>)[body.method];

        if (typeof fn !== 'function') {
            throw new BadRequestException(`Unknown method: ${body.method}`);
        }

        // Deserialize args with SuperJSON (supports Date, Map, Set, etc.)
        const args = superjson.deserialize(body.args as any) as unknown[];

        const result = await (fn as (...a: unknown[]) => unknown).call(instance, ...args);

        // Serialize result with SuperJSON so the caller can restore rich types
        return { result: superjson.serialize(result) };
    }

    private ensureSecret(secret?: string) {
        const expectedSecret = config.trigger.getInternalSecret();

        if (!expectedSecret) {
            throw new ForbiddenException('Trigger internal secret is not configured');
        }

        // Constant-time comparison (C-05 / L-09). Always compares against an
        // equal-length buffer so the timing cost is uniform regardless of the
        // submitted secret's length — a naive `length !== length || compare`
        // short-circuit would let an attacker binary-search the secret length.
        if (typeof secret !== 'string' || secret.length === 0) {
            throw new ForbiddenException('Invalid trigger secret');
        }
        const expectedBuf = Buffer.from(expectedSecret, 'utf8');
        const providedBuf = Buffer.from(secret, 'utf8');
        const lengthsMatch = expectedBuf.length === providedBuf.length;
        const comparisonBuf = lengthsMatch ? providedBuf : Buffer.alloc(expectedBuf.length);
        const bytesMatch = timingSafeEqual(expectedBuf, comparisonBuf);
        if (!lengthsMatch || !bytesMatch) {
            throw new ForbiddenException('Invalid trigger secret');
        }
    }

    // H-06: project an explicit allow-list of User fields. The previous
    // implementation dropped `password` and spread the rest — meaning OAuth
    // `accessToken`/`refreshToken` on `authAccounts` relations, password-reset
    // tokens, and email-verification tokens all flowed to the Trigger.dev worker.
    // The worker only needs identity + a handful of preference flags.
    private stripSensitiveUserData(user: User): WorkContextResponse['user'] {
        return {
            id: user.id,
            email: user.email,
            username: user.username,
            // Preserve the original shape the worker is typed against —
            // `JSON.parse(JSON.stringify(...))` here strips class metadata
            // and any field that happens to be `undefined`.
            ...JSON.parse(
                JSON.stringify({
                    avatar: user.avatar ?? null,
                    emailVerified: user.emailVerified,
                    isActive: user.isActive,
                    registrationProvider: user.registrationProvider,
                    isAnonymous: user.isAnonymous,
                    committerName: user.committerName ?? null,
                    committerEmail: user.committerEmail ?? null,
                }),
            ),
        } as WorkContextResponse['user'];
    }

    private stripRelations(work: Work) {
        const { user, ...rest } = work;
        return JSON.parse(JSON.stringify(rest));
    }
}
