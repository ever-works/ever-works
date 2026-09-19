import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { APP_WORK_GIT_PROVIDER_ID } from '../app-works/app-upstream-state.service';
import {
    AuthAccountRepository,
    buildPluginProviderId,
} from '../database/repositories/auth-account.repository';
import { WorkMemberRepository } from '../database/repositories/work-member.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkMemberRole } from '../entities/types';
import { AuthAccount } from '../entities/auth-account.entity';
import { Work } from '../entities/work.entity';
import { GitFacadeService } from '../facades/git.facade';

/**
 * APW-09 T43 — the App Work's **credential of record** and its handover
 * (FR-43, XC-18, ACC-09-32).
 *
 * ## The rule this file exists to make structural
 *
 * Forking an App Work is done with the member who created it, with that
 * member's own connection (APW-01 FR-15, decision D2), and that connection is
 * the App Work's credential of record. Every background job that acts on the
 * member's behalf **without a member present** — scheduled sync, Actions
 * hygiene, build polling and upstream pull request status polling, the last of
 * which runs for months (FR-43, `spec.md:343-354`) — resolves its token here
 * and never through a Work-resolved read that may answer with a platform PAT
 * or a GitHub App installation token. A pull request opened with a platform
 * credential is attributed to the platform, not to the person who wrote it.
 *
 * The member of record is **derived, not stored twice**: it is the Work's
 * creator (`Work.userId`, the OWNER), which is the member APW-01 FR-15 made
 * the fork with. No new column is needed for the read, and none is invented
 * here.
 *
 * ## FR-43 and FR-24 are two different credentials — the fault line is a method
 *
 * {@link UpstreamCredentialService.resolveForBackgroundJob} answers the
 * credential of record. {@link UpstreamCredentialService.resolveForPublishingMember}
 * answers the **publishing member's own** token, and is the only door
 * preparation, open and push (FR-24, FR-21) go through: a contribution run is
 * the publishing member's operation and is unaffected by a pause or by a
 * handover (`spec.md:353-354`). The two are separate methods with separate
 * return shapes on purpose, because a single "resolve a token" entry point is
 * exactly how a job ends up acting as the wrong member — the defect XC-18
 * names. The spec pins both directions with two distinct members and two
 * distinct tokens (`__tests__/upstream-credential.service.spec.ts`).
 *
 * ## No fallback, ever
 *
 * The token comes from `GitFacadeService.getMemberAccountToken({ userId,
 * providerId })` — APW-09 T4's member-token door, which takes no `workId` and
 * therefore cannot reach `tryResolveEverWorksGitPlatformToken` or
 * `getInstallationTokenForWork` (`git.facade.ts:533-563`, plan §2.3). When it
 * answers `null` this service pauses; it never asks the Work-scoped
 * `getAccessToken`, which is the one read that *can* hand back a platform
 * credential (plan §9.2:908 — "no fallback to any other token, ever").
 *
 * ## Unusable is a pause with a name, not a failure
 *
 * FR-43's four reasons are the closed set in
 * {@link UPSTREAM_CREDENTIAL_PAUSE_REASONS}. Three are derived from what the
 * platform can see without a provider call — membership of the Work, the
 * connected account row, its expiry and its scopes — so a paused job makes
 * **no provider call** while it is paused. The fourth, `access_lost`, is the
 * residual at this boundary (the connection is present and its token
 * unexpired, yet the facade's own usability gate refuses it) plus the reading
 * of a refusal a job already received from the provider
 * ({@link UpstreamCredentialService.pauseReasonForProviderRefusal}).
 *
 * Nothing upstream is deleted, closed or rewritten by a pause, and a handover
 * never re-authors an existing pull request: this service performs **no**
 * provider call at all, so neither can happen here.
 *
 * ## The handover's record lives on APW-02's state row, and the store is bound
 *
 * {@link UPSTREAM_CREDENTIAL_STORE} is the durable record a handover writes.
 * `tasks.md:789` states the record "is APW-02's upstream state where it already
 * carries one"; until 2026-09-19 the state row carried none
 * (`packages/agent/src/entities/work-upstream-state.entity.ts` had no credential
 * column), so the handover **failed closed** with the named refusal
 * `handover_unavailable` — it never reported a success it had not durably
 * recorded. Both halves of that gap are now closed, additively:
 *
 *   - the column is `work_upstream_states.credentialMemberUserId` (nullable,
 *     no default, so every existing row is unchanged), created by
 *     `apps/api/src/migrations/1792090000000-AddWorkUpstreamCredentialMember.ts`;
 *   - the token is bound to
 *     `upstream-pull-requests/upstream-credential.store.ts`
 *     (`UpstreamCredentialStateStore`, reading and writing through
 *     `WorkUpstreamStateRepository.findCredentialMemberUserId` /
 *     `setCredentialMemberUserId`) by this epic's own
 *     `UpstreamPullRequestsModule`, which imports APW-02's `AppWorksModule` for
 *     that repository and `DatabaseModule` / `FacadesModule` for the
 *     collaborators this service injects — and which is registered in
 *     `apps/api/src/api.module.ts`, so the binding is in the graph the API boots
 *     with rather than in a module nothing imports. It is not a line in
 *     `AppWorksModule` on purpose: `WorkRepository` is injected here
 *     **non-optionally**, and that module is compiled bare by two specs that
 *     shell `DatabaseModule` precisely so a collaborator a later service quietly
 *     requires fails there — which it did, on the first attempt.
 *
 * A handover therefore records, and the next background job reads what it wrote
 * — from the row, not from memory. The refusal stays reachable and stays honest:
 * a hand-rolled construction that passes no store, and the store's own refusal
 * when the Work has no state row to record on
 * (`UpstreamCredentialStateStore.write`), both keep a handover from being
 * reported as done when it was not.
 */

/**
 * FR-43's closed set — why the credential of record cannot be used.
 *
 * - `member_left` — the member of record is no longer on the App Work (they
 *   left the organization, or were removed from it).
 * - `access_lost` — the connection is present and unexpired, but it is no
 *   longer usable for this App Work (the residual at this boundary, and the
 *   reading of a provider `403` that does not name a missing scope).
 * - `disconnected` — there is no connected provider account, its access token
 *   is gone or expired, or a provider `401`.
 * - `scope_withdrawn` — connected with a live token, but the OAuth scopes a
 *   push and a pull request need are no longer granted.
 */
export const UPSTREAM_CREDENTIAL_PAUSE_REASONS = [
    'member_left',
    'access_lost',
    'disconnected',
    'scope_withdrawn',
] as const;

export type UpstreamCredentialPauseReason = (typeof UPSTREAM_CREDENTIAL_PAUSE_REASONS)[number];

/**
 * The OAuth scopes a background job needs to act on the member's behalf.
 *
 * The same single scope the facade's own usability gate requires for GitHub
 * (`git.facade.ts:417-424`): push to the member's fork and open the pull
 * request. Kept here as a named constant rather than inlined so the pause
 * reason and the gate can never disagree about what "the scope was withdrawn"
 * means.
 */
export const UPSTREAM_CREDENTIAL_REQUIRED_SCOPES: readonly string[] = ['repo'];

/**
 * The copy the paused surface renders (spec §6.1:481, plan §8.1:847).
 *
 * The pause carries **keys and parameters, never assembled English** (FR-36),
 * so the tab can render "Waiting for {member} to reconnect GitHub." and the
 * handover action in all 21 locale bundles.
 */
export const UPSTREAM_CREDENTIAL_I18N = {
    paused: 'dashboard.workDetail.upstream.credentialPaused',
    handover: 'dashboard.workDetail.upstream.credentialHandover',
} as const;

/**
 * The durable record of a handover — **bound in the real graph**.
 *
 * `write` records the member whose connection becomes the credential of record
 * for background work not yet started; `read` answers that member, or `null`
 * when no handover has been recorded. The store is APW-02's upstream state row,
 * which now carries the member id in its `credentialMemberUserId` column
 * (`apps/api/src/migrations/1792090000000-AddWorkUpstreamCredentialMember.ts`);
 * `UpstreamCredentialStateStore` is the implementation, and this epic's
 * `UpstreamPullRequestsModule` binds this token to it.
 *
 * 🛑 **Memory is still not an option.** The record has to outlive the process
 * that performed the handover: a handover that vanished on the next process
 * start would leave two members each believing they are the credential of
 * record, which is worse than the pause it was meant to clear. So an unbound
 * token is a refusal by name (`handover_unavailable`), and a bound store that
 * cannot write the row refuses too — it throws rather than answering `void` over
 * a handover it did not record.
 */
export interface UpstreamCredentialRecordStore {
    read(workId: string): Promise<string | null>;
    write(workId: string, memberUserId: string): Promise<void>;
}

/**
 * DI token for {@link UpstreamCredentialRecordStore}.
 *
 * Bound by this epic's `UpstreamPullRequestsModule` to
 * `UpstreamCredentialStateStore`, the row implementation in
 * `./upstream-credential.store.ts` (T43's binding). It stays
 * `@Optional()` at the injection site, so a hand-rolled construction — a unit
 * test, a lean CLI context — can still pass no store and get the named refusal
 * instead of a crash.
 */
export const UPSTREAM_CREDENTIAL_STORE = Symbol('UPSTREAM_CREDENTIAL_STORE');

/** Which member the record names, and why. */
export type UpstreamCredentialSource = 'creator' | 'handover';

/** The member the record names, as the tab and the jobs read it. */
export interface UpstreamCredentialRecord {
    workId: string;
    memberUserId: string;
    source: UpstreamCredentialSource;
    providerId: string;
}

/** The member the copy names (`{member}`), and the key that renders it. */
export interface UpstreamCredentialPause {
    workId: string;
    reason: UpstreamCredentialPauseReason;
    member: {
        userId: string;
        login: string | null;
    };
    messageKey: typeof UPSTREAM_CREDENTIAL_I18N.paused;
    actionKey: typeof UPSTREAM_CREDENTIAL_I18N.handover;
    params: { member: string };
}

/** A token resolved for a background job — the credential of record's own. */
export interface UpstreamBackgroundCredential {
    userId: string;
    providerId: string;
    token: string;
}

/**
 * What a background job gets: either the credential of record, or the pause it
 * must take instead of failing. The unusable arm carries **no token field at
 * all**, so a caller cannot reach for one that does not exist.
 *
 * The two arms are named interfaces rather than inline members because the
 * agent package compiles with `strictNullChecks: false`
 * (`packages/agent/tsconfig.json:23`), where TypeScript does **not** narrow a
 * union by a `true`/`false` literal discriminant. {@link isUpstreamCredentialPause}
 * is the predicate that narrows instead, and it does so with the flag either
 * way.
 */
export interface UpstreamCredentialUsableResolution {
    usable: true;
    workId: string;
    memberUserId: string;
    source: UpstreamCredentialSource;
    credential: UpstreamBackgroundCredential;
}

export interface UpstreamCredentialPausedResolution {
    usable: false;
    workId: string;
    reason: UpstreamCredentialPauseReason;
    pause: UpstreamCredentialPause;
}

export type UpstreamCredentialResolution =
    | UpstreamCredentialUsableResolution
    | UpstreamCredentialPausedResolution;

/** Does this resolution mean "pause, do not act"? */
export function isUpstreamCredentialPause(
    resolution: UpstreamCredentialResolution,
): resolution is UpstreamCredentialPausedResolution {
    return resolution.usable === false;
}

/** Why a handover did not happen — every arm is a named refusal. */
export type UpstreamCredentialHandoverRefusal =
    | 'not_found'
    | 'not_edit_access'
    | 'credential_unusable'
    | 'handover_unavailable';

export type UpstreamCredentialHandover =
    | {
          ok: true;
          workId: string;
          memberUserId: string;
          previousMemberUserId: string;
          source: 'handover';
      }
    | {
          ok: false;
          workId: string;
          refusal: UpstreamCredentialHandoverRefusal;
          /** Present when the caller's own connection is what refused. */
          reason?: UpstreamCredentialPauseReason;
      };

/**
 * The publishing member's own credential (FR-24) — a different member, on
 * purpose, and a different refusal code.
 */
export type UpstreamPublishingResolution =
    | {
          usable: true;
          workId: string;
          memberUserId: string;
          credential: UpstreamBackgroundCredential;
      }
    | {
          usable: false;
          workId: string;
          memberUserId: string;
          /** plan §9.2:908 — a member token missing `repo` / revoked. */
          code: 'connectionScope';
      };

/**
 * The App Work itself is gone. Not a pause: a job that cannot find the Work it
 * was dispatched for must stop loudly, and pausing would leave a row that never
 * resolves. The API's equivalent answer is `404 not_found`.
 */
export class UpstreamCredentialNotFoundError extends Error {
    readonly code = 'not_found';

    constructor(readonly workId: string) {
        super(`App Work ${workId} was not found`);
        this.name = 'UpstreamCredentialNotFoundError';
    }
}

@Injectable()
export class UpstreamCredentialService {
    private readonly logger = new Logger(UpstreamCredentialService.name);

    constructor(
        private readonly works: WorkRepository,
        // Every dependency below is `@Optional()` and appended in a stable
        // order, so a hand-rolled construction (a unit test, a lean CLI
        // context) can pass a prefix of them — the same shape
        // `AppUpstreamStateService` uses for its own optional readers.
        // Unbound, resolution FAILS CLOSED: a credential the service cannot
        // verify is never returned as usable.
        @Optional() private readonly members?: WorkMemberRepository,
        @Optional() private readonly accounts?: AuthAccountRepository,
        @Optional() private readonly git?: GitFacadeService,
        @Optional()
        @Inject(UPSTREAM_CREDENTIAL_STORE)
        private readonly store?: UpstreamCredentialRecordStore,
    ) {}

    // ── the read ─────────────────────────────────────────────────────────────

    /**
     * The App Work's credential of record: the member whose connection
     * performed the fork, or the member a handover recorded.
     *
     * `null` only when the Work does not exist — which the jobs treat as a
     * named stop, not as a pause ({@link UpstreamCredentialNotFoundError}).
     */
    async credentialOfRecord(workId: string): Promise<UpstreamCredentialRecord | null> {
        const work = await this.works.findById(workId);
        if (!work) {
            return null;
        }

        const providerId = providerIdOf(work);
        const record = await this.readRecordMember(work);

        return {
            workId,
            memberUserId: record.memberUserId,
            source: record.source,
            providerId,
        };
    }

    /**
     * The pause state the Upstream tab renders, or `null` while the credential
     * of record is usable (FR-43; the read `apps/api/src/works/
     * upstream-pull-requests.controller.ts` will expose beside the list).
     *
     * Deriving it costs no provider call: membership, the account row, its
     * expiry and its scopes are all local reads. That is what lets a paused
     * Work keep its list, its rows and their last known states visible (§6.1)
     * while no background job touches the provider.
     */
    async pauseFor(workId: string): Promise<UpstreamCredentialPause | null> {
        const resolution = await this.resolveForBackgroundJob(workId);

        return isUpstreamCredentialPause(resolution) ? resolution.pause : null;
    }

    // ── FR-43 — the background job's credential ──────────────────────────────

    /**
     * `resolveForBackgroundJob(workId)` — what every background job of plan §7
     * and APW-05's build polling callers resolves through, in place of a
     * Work-resolved token.
     *
     * The `usable: false` arm is the pause: the job records the reason, writes
     * no Activity row of the `app.upstream_pr.refused` kind and makes no
     * upstream call (T43, `tasks.md:790-792`). Nothing about the App Work
     * changes — a pause is not a state transition.
     */
    async resolveForBackgroundJob(workId: string): Promise<UpstreamCredentialResolution> {
        const work = await this.works.findById(workId);
        if (!work) {
            throw new UpstreamCredentialNotFoundError(workId);
        }

        const providerId = providerIdOf(work);
        const record = await this.readRecordMember(work);

        const reason = await this.unusableReason(work, record.memberUserId, providerId);
        if (reason) {
            return {
                usable: false,
                workId,
                reason,
                pause: await this.buildPause(work, record.memberUserId, providerId, reason),
            };
        }

        const token = await this.memberToken(record.memberUserId, providerId);
        if (!token) {
            // The gate above said the account looks usable and the facade still
            // would not answer: pause rather than reach for any other token.
            return {
                usable: false,
                workId,
                reason: 'disconnected',
                pause: await this.buildPause(work, record.memberUserId, providerId, 'disconnected'),
            };
        }

        return {
            usable: true,
            workId,
            memberUserId: record.memberUserId,
            source: record.source,
            credential: { userId: record.memberUserId, providerId, token },
        };
    }

    /**
     * The reason a provider refusal the job **already received** names, or
     * `null` when the refusal is not the credential's (plan §9.2 is explicit
     * that a status read's `404` is the row going `closed`, not a pause).
     *
     * Pure: it classifies a response the caller holds, so classifying makes no
     * call of its own.
     */
    pauseReasonForProviderRefusal(
        status: number,
        code?: string | null,
    ): UpstreamCredentialPauseReason | null {
        if (status === 401) {
            return 'disconnected';
        }

        if (status !== 403) {
            return null;
        }

        return /scope/i.test(code ?? '') ? 'scope_withdrawn' : 'access_lost';
    }

    // ── FR-24 — the publishing member's own token, never the record ──────────

    /**
     * Preparation, open and push resolve **the publishing member's own**
     * connection, which is not the credential of record and is unaffected by
     * it (FR-24, FR-21; `spec.md:353-354`). This method deliberately does not
     * read the record or the store: a member who is not the credential of
     * record still publishes with their own token, and a pause on the record
     * changes nothing here.
     *
     * `null` from the member-token door is `connectionScope`, the refusal
     * plan §9.2:908 names — never a fallback to another credential.
     */
    async resolveForPublishingMember(
        workId: string,
        memberUserId: string,
    ): Promise<UpstreamPublishingResolution> {
        const work = await this.works.findById(workId);
        if (!work) {
            throw new UpstreamCredentialNotFoundError(workId);
        }

        const providerId = providerIdOf(work);
        const token = await this.memberToken(memberUserId, providerId);

        if (!token) {
            return { usable: false, workId, memberUserId, code: 'connectionScope' };
        }

        return {
            usable: true,
            workId,
            memberUserId,
            credential: { userId: memberUserId, providerId, token },
        };
    }

    // ── FR-43 — the handover ─────────────────────────────────────────────────

    /**
     * Make the caller's own connection the credential of record, for work not
     * yet started (`tasks.md:794-795`).
     *
     * **Edit access is required**: the Work's creator, or a member with at
     * least the EDITOR role. A VIEWER and a stranger are refused
     * `not_edit_access` — and a refusal is a return value, so the API can
     * answer `403` without this service knowing what a status code is.
     *
     * The handover changes a record and nothing else: it makes no provider
     * call, opens nothing, updates nothing and re-authors nothing already
     * opened. Jobs already running hold a token, not this record, so a
     * handover takes effect for work not yet started by construction.
     */
    async handover(workId: string, callerUserId: string): Promise<UpstreamCredentialHandover> {
        const work = await this.works.findById(workId);
        if (!work) {
            return { ok: false, workId, refusal: 'not_found' };
        }

        if (!(await this.hasEditAccess(work, callerUserId))) {
            return { ok: false, workId, refusal: 'not_edit_access' };
        }

        if (!this.store) {
            // Fail closed. A success here would be a lie the member acts on:
            // the next background job would still resolve the old member.
            this.logger.warn(
                `Handover for App Work ${workId} refused: no credential-of-record store is bound`,
            );
            return { ok: false, workId, refusal: 'handover_unavailable' };
        }

        const providerId = providerIdOf(work);
        const previous = await this.readRecordMember(work);

        // The caller's own connection must be usable, or the handover would
        // re-pause on the very next tick — the reason is reported so the
        // surface can say which one it is instead of "failed".
        const reason = await this.unusableReason(work, callerUserId, providerId);
        if (reason) {
            return { ok: false, workId, refusal: 'credential_unusable', reason };
        }

        await this.store.write(workId, callerUserId);

        return {
            ok: true,
            workId,
            memberUserId: callerUserId,
            previousMemberUserId: previous.memberUserId,
            source: 'handover',
        };
    }

    // ── internals ────────────────────────────────────────────────────────────

    /**
     * The member the record names: the handover's member when one is recorded,
     * else the Work's creator — the member APW-01 FR-15 made the fork with.
     */
    private async readRecordMember(
        work: Work,
    ): Promise<{ memberUserId: string; source: UpstreamCredentialSource }> {
        const handedOver = this.store ? await this.store.read(work.id) : null;

        if (handedOver) {
            return { memberUserId: handedOver, source: 'handover' };
        }

        return { memberUserId: work.userId, source: 'creator' };
    }

    /**
     * `null` when the credential of record is usable, else FR-43's reason.
     * Local reads only — see the class docstring.
     */
    private async unusableReason(
        work: Work,
        memberUserId: string,
        providerId: string,
    ): Promise<UpstreamCredentialPauseReason | null> {
        if (!(await this.isOnWork(work, memberUserId))) {
            return 'member_left';
        }

        if (!this.accounts) {
            // Unbound: the service cannot verify the connection, so it must
            // not claim the credential is usable.
            return 'disconnected';
        }

        const connected = await this.accounts.findConnectedProviderAccount(
            memberUserId,
            providerId,
            {
                usePluginProviderId: true,
                requiredScopes: UPSTREAM_CREDENTIAL_REQUIRED_SCOPES,
            },
        );

        if (connected) {
            return null;
        }

        const raw = await this.rawAccount(memberUserId, providerId);

        if (!raw?.accessToken) {
            return 'disconnected';
        }

        if (isExpired(raw, Date.now())) {
            return 'disconnected';
        }

        if (!hasScopes(raw, UPSTREAM_CREDENTIAL_REQUIRED_SCOPES)) {
            return 'scope_withdrawn';
        }

        // Present and unexpired with the scopes granted, yet the usability gate
        // refused it: the connection no longer reaches this App Work.
        return 'access_lost';
    }

    /**
     * The member-token door of FR-24 (plan §2.3). `getMemberAccountToken`
     * takes no `workId`, which is what makes the platform PAT and the
     * installation token unreachable from here; `getAccessToken` is
     * deliberately **not** called anywhere in this file.
     */
    private async memberToken(memberUserId: string, providerId: string): Promise<string | null> {
        if (!this.git) {
            return null;
        }

        try {
            return await this.git.getMemberAccountToken({ userId: memberUserId, providerId });
        } catch {
            // A throwing credential read is an unusable credential, never a
            // job failure: the caller pauses.
            return null;
        }
    }

    private async buildPause(
        work: Work,
        memberUserId: string,
        providerId: string,
        reason: UpstreamCredentialPauseReason,
    ): Promise<UpstreamCredentialPause> {
        const login = await this.loginOf(work, memberUserId, providerId);

        return {
            workId: work.id,
            reason,
            member: { userId: memberUserId, login },
            messageKey: UPSTREAM_CREDENTIAL_I18N.paused,
            actionKey: UPSTREAM_CREDENTIAL_I18N.handover,
            // A login is the member's GitHub identity, which is what
            // "reconnect GitHub" names; the member id is the fallback so the
            // sentence never renders an empty slot.
            params: { member: login ?? memberUserId },
        };
    }

    private async loginOf(
        work: Work,
        memberUserId: string,
        providerId: string,
    ): Promise<string | null> {
        const raw = await this.rawAccount(memberUserId, providerId);
        const login = (raw?.metadata?.login as string | undefined) ?? raw?.username ?? null;

        if (login) {
            return login;
        }

        // The connection is gone (a `member_left` or `disconnected` pause):
        // the Work's own user row still names the creator.
        return work.userId === memberUserId ? (work.user?.username ?? null) : null;
    }

    private async rawAccount(
        memberUserId: string,
        providerId: string,
    ): Promise<AuthAccount | null> {
        if (!this.accounts) {
            return null;
        }

        const pluginAccount = await this.accounts.findProviderAccount(
            memberUserId,
            buildPluginProviderId(providerId),
        );

        if (pluginAccount) {
            return pluginAccount;
        }

        return this.accounts.findProviderAccount(memberUserId, providerId);
    }

    private async isOnWork(work: Work, memberUserId: string): Promise<boolean> {
        if (work.isCreator(memberUserId)) {
            return true;
        }

        if (!this.members) {
            // Unbound: a member the service cannot place on the Work is not
            // assumed to be on it.
            return false;
        }

        return (await this.members.findMember(work.id, memberUserId)) !== null;
    }

    /** The Work's creator, or any member with at least the EDITOR role. */
    private async hasEditAccess(work: Work, callerUserId: string): Promise<boolean> {
        if (work.isCreator(callerUserId)) {
            return true;
        }

        if (!this.members) {
            return false;
        }

        return this.members.hasRole(work.id, callerUserId, WorkMemberRole.EDITOR);
    }
}

/** The provider every App Works read uses unless the Work names its own. */
function providerIdOf(work: Work): string {
    return work.gitProvider || APP_WORK_GIT_PROVIDER_ID;
}

function isExpired(account: AuthAccount, nowMs: number): boolean {
    const expiresAt = account.accessTokenExpiresAt;

    return expiresAt ? expiresAt.getTime() <= nowMs : false;
}

/** The repository's own scope parser, kept identical to it on purpose. */
function hasScopes(account: AuthAccount, required: readonly string[]): boolean {
    if (required.length === 0) {
        return true;
    }

    const granted = new Set(
        (account.scope ?? '')
            .split(/[,\s]+/)
            .map((value) => value.trim())
            .filter(Boolean),
    );

    return required.every((scope) => granted.has(scope));
}
