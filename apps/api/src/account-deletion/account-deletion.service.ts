import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import {
    AccountDeletionSummary,
    ApiKey,
    AuthSession,
    BillingProfile,
    Organization,
    OrganizationMember,
    Tenant,
    User,
    Work,
} from '@ever-works/agent/entities';
import { getOptionalProvider } from '@ever-works/agent/utils';
import { WorkLifecycleService } from '@ever-works/agent/services';
import {
    BillingProviderNotConfiguredError,
    BillingService,
    NoActiveSubscriptionError,
    PaygService,
} from '@ever-works/agent/subscriptions';
import { AuthProvider } from '../auth/providers/auth-provider.abstract';
import { AUTH_PROVIDER } from '../auth/providers/auth-provider.constants';
import { AccountDeletionRequestStore } from './account-deletion-request.store';
import { AccountDeletionMailer } from './account-deletion.mailer';
import { hashDeletionEmail, maskEmail } from './account-deletion.tokens';
import { PERSONAL_ROWS_WITHOUT_FK, TENANT_CONTENT_OWNER_COLUMNS } from './account-deletion.inventory';
import { getActiveStorageBackend } from '../uploads/storage-backend.factory';

/** What happens to one workspace (Tenant) the account belongs to. */
export type WorkspaceOutcome = 'workspace-deleted' | 'workspace-transferred' | 'account-removed';

export interface WorkspacePreview {
    /** Display name of the workspace (the owner's Tenant), never an address. */
    workspace: string;
    /** `OWNER` for the Tenant owner; otherwise the roster role. */
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    organizations: string[];
    /** Other people in the workspace. */
    otherMembers: number;
    outcome: WorkspaceOutcome;
    /** True when the account is the workspace's only owner (the Tenant owner always is). */
    soleAdmin: boolean;
    /** Username of who takes the workspace over (`workspace-transferred` only). */
    newOwner?: string | null;
}

export interface AccountDeletionPreview {
    email: string | null;
    accounts: WorkspacePreview[];
    /** Works deleted with the account (personal ones + those of a workspace that goes). */
    worksDeleted: number;
    /** Works the account created in a workspace that stays — handed to its owner. */
    worksKept: number;
    apiKeys: number;
    /** A paid plan or pay-as-you-go subscription that will be canceled. */
    hasSubscription: boolean;
}

export interface AccountDeletionResult {
    deleted: true;
    accounts: number;
    workspacesDeleted: number;
    summary: AccountDeletionSummary;
}

export type AccountDeletionTrigger =
    | { source: 'in_product' }
    | { source: 'email_link'; requestId: string };

/** A deletion that could not run to the end. The code is safe to show and to store. */
export class AccountDeletionFailedError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = 'AccountDeletionFailedError';
    }
}

interface WorkspacePlan {
    tenant: Tenant;
    organizations: Organization[];
    owned: boolean;
    otherMemberIds: string[];
    /** Who receives what the account created in this workspace (null = the workspace goes). */
    successorId: string | null;
    successorName: string | null;
    role: WorkspacePreview['role'];
}

/**
 * The one deletion routine — the in-product "Delete my account" and the
 * email-link confirm both end here.
 *
 * Ever Works' model: a user owns at most ONE Tenant (their workspace, which
 * holds their Organizations) or is a member of somebody else's Tenant
 * (`users.tenantId`, granted by an Organization invitation), or has neither
 * (personal Works only).
 *
 * - Sole member of their own workspace → the workspace, its Organizations and
 *   everything in them go with the account (the `tenants.ownerUserId`
 *   cascade, then the per-table cascades).
 * - Owner of a workspace with other members → the workspace is handed to the
 *   longest-standing admin (else member): `tenants.ownerUserId` moves, and the
 *   content the account created there is re-attributed to the new owner so the
 *   `users` cascades do not take it. The confirm screens warn about this first.
 * - Member of someone else's workspace → their membership, sessions and
 *   personal data go; the content they created there is re-attributed to the
 *   workspace owner and stays.
 *
 * Always: the plan subscription is set to cancel and pay-as-you-go is stopped
 * (the payment provider keeps the invoices and the customer record), every
 * session is revoked, API keys go with the row, uploaded files are removed
 * from storage, a PII-free audit row is written and an "account deleted"
 * email is sent. Git repositories in the user's own GitHub account are not
 * touched — they are the user's, on GitHub.
 */
@Injectable()
export class AccountDeletionService {
    private readonly logger = new Logger(AccountDeletionService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly store: AccountDeletionRequestStore,
        private readonly mailer: AccountDeletionMailer,
        private readonly moduleRef: ModuleRef,
        @Optional() @Inject(AUTH_PROVIDER) private readonly authProvider?: AuthProvider,
    ) {}

    async preview(userId: string): Promise<AccountDeletionPreview> {
        const user = await this.requireUser(userId);
        const plans = await this.planWorkspaces(this.dataSource.manager, user);
        const works = await this.dataSource.getRepository(Work).find({
            where: { userId },
            select: ['id', 'tenantId'],
        });
        const keptTenants = new Set(plans.filter((p) => p.successorId).map((p) => p.tenant.id));
        const worksKept = works.filter((w) => w.tenantId && keptTenants.has(w.tenantId)).length;
        const deletedTenants = new Set(plans.filter((p) => !p.successorId).map((p) => p.tenant.id));
        const workspaceWorks = deletedTenants.size
            ? await this.dataSource.getRepository(Work).count({
                  where: { tenantId: In([...deletedTenants]), userId: Not(userId) },
              })
            : 0;
        return {
            email: maskEmail(user.email),
            accounts: plans.map((plan) => this.toPreview(plan)),
            worksDeleted: works.length - worksKept + workspaceWorks,
            worksKept,
            apiKeys: await this.dataSource.getRepository(ApiKey).count({ where: { userId } }),
            hasSubscription: await this.hasSubscription(userId),
        };
    }

    /**
     * Delete the account. `email` is read here, used for the receipt email and
     * the audit hash, and never stored in clear.
     */
    async execute(userId: string, trigger: AccountDeletionTrigger): Promise<AccountDeletionResult> {
        const user = await this.requireUser(userId);
        const email = user.email;
        const startedAt = new Date();
        const summary: AccountDeletionSummary = {};

        try {
            const plans = await this.planWorkspaces(this.dataSource.manager, user);

            // 1. Billing first: a live subscription must never outlive the account.
            summary.subscriptionsCanceled = await this.stopBilling(userId);

            // 2. Workspaces that stay: hand over ownership and the account's content.
            summary.contentReassigned = 0;
            for (const plan of plans) {
                if (!plan.successorId) continue;
                summary.contentReassigned += await this.handOver(plan, user.id);
                if (plan.owned) summary.workspaceTransferred = true;
            }

            // 3. Works that go: tear down what the platform runs for them
            //    (App runtime, DNS, checkouts) — never the user's Git repositories.
            const keptTenants = new Set(plans.filter((p) => p.successorId).map((p) => p.tenant.id));
            summary.worksDeleted = await this.deleteWorks(user, keptTenants);

            // 4. Uploaded files (outside the database).
            summary.filesDeleted = await this.deleteFiles(user.id);

            // 5. Personal rows no foreign key would remove (settings, credentials, consents).
            const keptOrgIds = keptTenants.size
                ? (
                      await this.dataSource.getRepository(Organization).find({
                          where: { tenantId: In([...keptTenants]) },
                          select: ['id'],
                      })
                  ).map((o) => o.id)
                : [];
            await this.deletePersonalRows(user.id, [...keptTenants], keptOrgIds);

            // 6. Sessions, then the row (API keys, memberships and personal data cascade).
            summary.sessionsRevoked = await this.revokeSessions(user.id);
            summary.apiKeysRevoked = await this.dataSource
                .getRepository(ApiKey)
                .count({ where: { userId: user.id } });
            summary.membershipsRemoved = await this.dataSource
                .getRepository(OrganizationMember)
                .count({ where: { userId: user.id } });
            const deletedPlans = plans.filter((p) => !p.successorId && p.owned);
            summary.organizationsDeleted = deletedPlans.reduce((n, p) => n + p.organizations.length, 0);
            summary.workspaceDeleted = deletedPlans.length > 0;

            await this.dataSource.transaction(async (manager) => {
                // A workspace that goes is removed explicitly: on the migrated
                // schema `tenants.ownerUserId` and `organizations.tenantId` would
                // cascade anyway, but a synchronize-built schema (SQLite, local
                // dev) has no such constraints and would leave both behind.
                for (const plan of deletedPlans) {
                    await manager.getRepository(Organization).delete({ tenantId: plan.tenant.id });
                    await manager.getRepository(Tenant).delete({ id: plan.tenant.id });
                }
                await manager.getRepository(User).delete({ id: user.id });
            });
        } catch (error) {
            const code = error instanceof AccountDeletionFailedError ? error.code : 'deletion_failed';
            this.logger.error(
                `account-deletion failed for ${user.id} at ${code}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            await this.recordFailure(trigger, email, code).catch(() => undefined);
            throw error instanceof AccountDeletionFailedError
                ? error
                : new AccountDeletionFailedError(code);
        }

        const completedAt = new Date();
        await this.recordCompletion(trigger, email, summary, startedAt, completedAt);
        if (email) {
            await this.mailer.sendDeletedConfirmation({ to: email, deletedAt: completedAt, summary });
        }
        this.logger.log(
            `account-deletion completed (${trigger.source}): works=${summary.worksDeleted} ` +
                `reassigned=${summary.contentReassigned} orgs=${summary.organizationsDeleted} ` +
                `workspaceDeleted=${summary.workspaceDeleted === true} ` +
                `transferred=${summary.workspaceTransferred === true}`,
        );
        return {
            deleted: true,
            accounts: 1,
            workspacesDeleted: summary.workspaceDeleted ? 1 : 0,
            summary,
        };
    }

    /** The account's address, for the typed confirmation. Never logged. */
    async emailOf(userId: string): Promise<string | null> {
        const user = await this.dataSource
            .getRepository(User)
            .findOne({ where: { id: userId }, select: ['id', 'email'] });
        return user?.email ?? null;
    }

    // ------------------------------------------------------------------ plan

    private async requireUser(userId: string): Promise<User> {
        const user = await this.dataSource.getRepository(User).findOne({ where: { id: userId } });
        if (!user) {
            throw new NotFoundException('account_not_found');
        }
        return user;
    }

    private async planWorkspaces(manager: EntityManager, user: User): Promise<WorkspacePlan[]> {
        const tenants = manager.getRepository(Tenant);
        const plans: WorkspacePlan[] = [];

        const owned = await tenants.findOne({ where: { ownerUserId: user.id } });
        if (owned) {
            plans.push(await this.planFor(manager, owned, user, true));
        }
        if (user.tenantId && user.tenantId !== owned?.id) {
            const joined = await tenants.findOne({ where: { id: user.tenantId } });
            if (joined) {
                plans.push(await this.planFor(manager, joined, user, false));
            }
        }
        return plans;
    }

    private async planFor(
        manager: EntityManager,
        tenant: Tenant,
        user: User,
        owned: boolean,
    ): Promise<WorkspacePlan> {
        const organizations = await manager
            .getRepository(Organization)
            .find({ where: { tenantId: tenant.id }, order: { createdAt: 'ASC' } });
        const others = await manager.getRepository(User).find({
            where: { tenantId: tenant.id, id: Not(user.id) },
            select: ['id', 'username', 'isAnonymous', 'createdAt'],
            order: { createdAt: 'ASC' },
        });
        const roster = await manager.getRepository(OrganizationMember).find({
            where: { tenantId: tenant.id },
            order: { joinedAt: 'ASC' },
        });

        let successorId: string | null = null;
        if (owned && others.length > 0) {
            // Longest-standing admin, else longest-standing member, else any other user —
            // never someone who already owns a Tenant (`tenants.ownerUserId` is UNIQUE).
            const owners = new Set(
                (
                    await manager.getRepository(Tenant).find({
                        where: { ownerUserId: In(others.map((o) => o.id)) },
                        select: ['id', 'ownerUserId'],
                    })
                ).map((t) => t.ownerUserId),
            );
            const otherIds = new Set(others.filter((o) => !owners.has(o.id)).map((o) => o.id));
            const admin = roster.find((r) => r.role === 'admin' && otherIds.has(r.userId));
            const member = roster.find((r) => otherIds.has(r.userId));
            const eligible = others.filter((o) => otherIds.has(o.id));
            const named = eligible.find((o) => !o.isAnonymous) ?? eligible[0];
            successorId = admin?.userId ?? member?.userId ?? named?.id ?? null;
        } else if (!owned) {
            successorId = tenant.ownerUserId;
        }

        const ownRoles = roster.filter((r) => r.userId === user.id).map((r) => r.role);
        const role: WorkspacePreview['role'] = owned
            ? 'OWNER'
            : ownRoles.includes('admin')
              ? 'ADMIN'
              : 'MEMBER';
        const successor = successorId
            ? await manager.getRepository(User).findOne({
                  where: { id: successorId },
                  select: ['id', 'username'],
              })
            : null;
        const memberOrgIds = new Set(roster.filter((r) => r.userId === user.id).map((r) => r.organizationId));
        const visibleOrgs = owned ? organizations : organizations.filter((o) => memberOrgIds.has(o.id));

        return {
            tenant,
            organizations: visibleOrgs,
            owned,
            otherMemberIds: owned ? others.map((o) => o.id) : [],
            successorId,
            successorName: successor?.username ?? null,
            role,
        };
    }

    private toPreview(plan: WorkspacePlan): WorkspacePreview {
        const outcome: WorkspaceOutcome = !plan.owned
            ? 'account-removed'
            : plan.successorId
              ? 'workspace-transferred'
              : 'workspace-deleted';
        return {
            workspace: plan.organizations[0]?.displayName ?? plan.tenant.displayName,
            role: plan.role,
            organizations: plan.organizations.map((o) => o.displayName ?? o.slug),
            otherMembers: plan.owned ? plan.otherMemberIds.length : 0,
            outcome,
            soleAdmin: plan.owned,
            newOwner: outcome === 'workspace-transferred' ? plan.successorName : undefined,
        };
    }

    // --------------------------------------------------------------- execute

    private async hasSubscription(userId: string): Promise<boolean> {
        const profile = await this.dataSource
            .getRepository(BillingProfile)
            .findOne({ where: { userId } })
            .catch(() => null);
        return planIsLive(profile) || paygIsLive(profile);
    }

    /**
     * Cancel the plan subscription (at period end — the provider keeps the
     * invoices and the customer record) and stop pay-as-you-go now. Nothing
     * to cancel / no payment provider is fine; a provider ERROR stops the
     * deletion, so a subscription can never outlive the account.
     */
    private async stopBilling(userId: string): Promise<number> {
        const profile = await this.dataSource
            .getRepository(BillingProfile)
            .findOne({ where: { userId } })
            .catch(() => null);
        if (!profile) return 0;

        let canceled = 0;
        if (planIsLive(profile) && !profile.cancelAtPeriodEnd) {
            const billing = getOptionalProvider<BillingService>(this.moduleRef, BillingService);
            if (billing) {
                try {
                    await billing.cancelSubscription(userId);
                    canceled += 1;
                } catch (error) {
                    if (!isNothingToCancel(error)) {
                        throw new AccountDeletionFailedError('billing_cancel_failed');
                    }
                }
            }
        } else if (planIsLive(profile)) {
            canceled += 1; // already set to cancel at period end
        }
        if (paygIsLive(profile)) {
            const payg = getOptionalProvider<PaygService>(this.moduleRef, PaygService);
            if (payg) {
                try {
                    await payg.disable(userId);
                    canceled += 1;
                } catch (error) {
                    if (!isNothingToCancel(error)) {
                        throw new AccountDeletionFailedError('billing_cancel_failed');
                    }
                }
            }
        }
        return canceled;
    }

    /**
     * Keep a workspace's content when the account leaves it: move the Tenant to
     * its successor (when the account owned it) and re-attribute every content
     * row the account created in it, so the `users` cascades cannot take them.
     */
    private async handOver(plan: WorkspacePlan, userId: string): Promise<number> {
        const successorId = plan.successorId as string;
        const manager = this.dataSource.manager;
        if (plan.owned) {
            await manager.getRepository(Tenant).update({ id: plan.tenant.id }, { ownerUserId: successorId });
        }
        const orgIds = (
            await manager.getRepository(Organization).find({
                where: { tenantId: plan.tenant.id },
                select: ['id'],
            })
        ).map((o) => o.id);
        const escape = (name: string) => manager.connection.driver.escape(name);

        let moved = 0;
        for (const target of this.existingContentColumns(manager)) {
            if (target.scope === 'organizationId' && orgIds.length === 0) continue;
            // One statement per table, outside a shared transaction: a row the
            // successor cannot take (a per-user unique name, say) must not stop
            // the others; it is left to the cascade and counted as not moved.
            try {
                const qb = manager
                    .createQueryBuilder()
                    .update(target.table)
                    .set({ [target.column]: successorId })
                    .where(`${escape(target.column)} = :userId`, { userId });
                if (target.scope === 'tenantId') {
                    qb.andWhere(`${escape('tenantId')} = :tenantId`, { tenantId: plan.tenant.id });
                } else {
                    qb.andWhere(`${escape('organizationId')} IN (:...orgIds)`, { orgIds });
                }
                const result = await qb.execute();
                moved += result.affected ?? 0;
            } catch (error) {
                this.logger.warn(
                    `account-deletion: could not hand ${target.table} rows to the workspace owner (${
                        error instanceof Error ? error.name : 'error'
                    })`,
                );
            }
        }
        return moved;
    }

    /** The {@link TENANT_CONTENT_OWNER_COLUMNS} this database actually has. */
    private existingContentColumns(manager: EntityManager) {
        const present: typeof TENANT_CONTENT_OWNER_COLUMNS = [];
        for (const target of TENANT_CONTENT_OWNER_COLUMNS) {
            const meta = manager.connection.entityMetadatas.find((m) => m.tableName === target.table);
            if (!meta) continue;
            const has = (name: string) => meta.columns.some((c) => c.databaseName === name);
            if (has(target.column) && has(target.scope)) {
                present.push(target);
            }
        }
        return present;
    }

    /**
     * Works that go with the account, through the Work delete path so the
     * platform's own resources (App runtime workloads, the ever.works CNAME,
     * local checkouts) are released. Repository deletion is switched off: a
     * repository in the user's GitHub account is theirs. Best effort per Work —
     * the row cascade below removes whatever is left.
     */
    private async deleteWorks(user: User, keptTenants: Set<string>): Promise<number> {
        const works = await this.dataSource.getRepository(Work).find({
            where: { userId: user.id },
            select: ['id', 'slug', 'tenantId', 'kind'],
        });
        const going = works.filter((w) => !(w.tenantId && keptTenants.has(w.tenantId)));
        const lifecycle = getOptionalProvider<WorkLifecycleService>(this.moduleRef, WorkLifecycleService);
        if (lifecycle) {
            for (const work of going) {
                try {
                    await lifecycle.deleteWork(
                        work.id,
                        {
                            delete_data_repository: false,
                            delete_markdown_repository: false,
                            delete_website_repository: false,
                            delete_stored_data: true,
                            confirm_slug: work.slug,
                        },
                        user,
                    );
                } catch (error) {
                    this.logger.warn(
                        `account-deletion: work ${work.id} teardown failed (${
                            error instanceof Error ? error.name : 'error'
                        }); its row goes with the account`,
                    );
                }
            }
        }
        return going.length;
    }

    /**
     * Delete {@link PERSONAL_ROWS_WITHOUT_FK}. Rows inside a workspace that
     * stays are left alone. Two passes, so a row another listed row depends
     * on is retried once the dependant is gone; a table that still refuses is
     * logged and left (its id points at nothing once the account is gone).
     */
    private async deletePersonalRows(userId: string, keptTenantIds: string[], keptOrgIds: string[]): Promise<void> {
        const manager = this.dataSource.manager;
        const escape = (name: string) => manager.connection.driver.escape(name);
        let pending = PERSONAL_ROWS_WITHOUT_FK.filter((target) => {
            const meta = manager.connection.entityMetadatas.find((m) => m.tableName === target.table);
            if (!meta) return false;
            const has = (name: string) => meta.columns.some((c) => c.databaseName === name);
            return has(target.column) && (!target.scope || has(target.scope));
        });
        for (let pass = 0; pass < 2 && pending.length > 0; pass += 1) {
            const failed: typeof pending = [];
            for (const target of pending) {
                try {
                    const qb = manager
                        .createQueryBuilder()
                        .delete()
                        .from(target.table)
                        .where(escape(target.column) + ' = :userId', { userId });
                    const kept = target.scope === 'tenantId' ? keptTenantIds : target.scope ? keptOrgIds : [];
                    if (target.scope && kept.length > 0) {
                        const col = escape(target.scope);
                        qb.andWhere('(' + col + ' IS NULL OR ' + col + ' NOT IN (:...kept))', { kept });
                    }
                    await qb.execute();
                } catch (error) {
                    failed.push(target);
                    if (pass === 1) {
                        this.logger.warn(
                            'account-deletion: ' + target.table + ' rows could not be removed (' +
                                (error instanceof Error ? error.name : 'error') + ')',
                        );
                    }
                }
            }
            pending = failed;
        }
    }

    private async deleteFiles(userId: string): Promise<number> {
        try {
            const backend = (await getActiveStorageBackend()) as {
                deleteAllByOwner?: (ownerId: string) => Promise<{ deleted: number }>;
            };
            if (typeof backend?.deleteAllByOwner !== 'function') return 0;
            return (await backend.deleteAllByOwner(userId)).deleted;
        } catch (error) {
            this.logger.warn(
                `account-deletion: storage clean-up failed (${error instanceof Error ? error.name : 'error'})`,
            );
            return 0;
        }
    }

    private async revokeSessions(userId: string): Promise<number> {
        const sessions = this.dataSource.getRepository(AuthSession);
        const count = await sessions.count({ where: { userId } }).catch(() => 0);
        if (this.authProvider) {
            await this.authProvider.signOutAll(userId);
        } else {
            await sessions.delete({ userId });
        }
        return count;
    }

    // ----------------------------------------------------------------- audit

    private async recordCompletion(
        trigger: AccountDeletionTrigger,
        email: string | null,
        summary: AccountDeletionSummary,
        startedAt: Date,
        completedAt: Date,
    ): Promise<void> {
        try {
            if (trigger.source === 'email_link') {
                await this.store.update(trigger.requestId, {
                    status: 'completed',
                    userId: null,
                    completedAt,
                    summary,
                });
                return;
            }
            await this.store.insert({
                source: 'in_product',
                emailHash: email ? hashDeletionEmail(email) : 'anonymous',
                tokenHash: null,
                userId: null,
                status: 'completed',
                expiresAt: null,
                consumedAt: startedAt,
                completedAt,
                summary,
            });
        } catch (error) {
            // The account is already gone; a missing audit row must not undo that.
            this.logger.error(
                `account-deletion: audit record could not be written (${
                    error instanceof Error ? error.name : 'error'
                })`,
            );
        }
    }

    private async recordFailure(
        trigger: AccountDeletionTrigger,
        email: string | null,
        code: string,
    ): Promise<void> {
        if (trigger.source === 'email_link') {
            await this.store.update(trigger.requestId, { status: 'failed', failureCode: code });
            return;
        }
        await this.store.insert({
            source: 'in_product',
            emailHash: email ? hashDeletionEmail(email) : 'anonymous',
            tokenHash: null,
            userId: null,
            status: 'failed',
            expiresAt: null,
            failureCode: code,
        });
    }
}

const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired']);

function planIsLive(profile: BillingProfile | null): boolean {
    return (
        !!profile?.providerSubscriptionId &&
        !!profile.subscriptionStatus &&
        !ENDED_STATUSES.has(profile.subscriptionStatus)
    );
}

function paygIsLive(profile: BillingProfile | null): boolean {
    if (!profile) return false;
    if (profile.paygEnabled) return true;
    return !!profile.paygSubscriptionId && !!profile.paygStatus && !ENDED_STATUSES.has(profile.paygStatus);
}

function isNothingToCancel(error: unknown): boolean {
    return (
        error instanceof NoActiveSubscriptionError ||
        error instanceof BillingProviderNotConfiguredError ||
        (error instanceof Error &&
            (error.name === 'NoActiveSubscriptionError' ||
                error.name === 'BillingProviderNotConfiguredError'))
    );
}
