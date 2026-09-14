import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { MODEL_ROUTING_LIMITS } from '@ever-works/contracts';
import type { ModelAccountView, ModelProviderView } from '@ever-works/contracts';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ModelAccountRepository } from '../database/repositories/model-account.repository';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { ModelAccount } from '../entities/model-account.entity';
import { ModelAccountHealthService } from './model-account-health.service';
import { toModelAccountView } from './model-account.view';
import {
    ModelProviderCatalogService,
    type ModelProviderDescriptor,
} from './model-provider-catalog.service';
import {
    modelAccountCredentialRejected,
    modelAccountDuplicateLabel,
    modelAccountInvalidCredentials,
    modelAccountInvalidLabel,
    modelAccountLimitReached,
    modelAccountNotFound,
    modelAccountStaleOrder,
    modelProviderTakesNoAccounts,
    modelProviderUnknown,
} from './model-routing.errors';
import { modelWorkspaceKey, type ModelWorkspaceScope } from './model-workspace';

export interface CreateModelAccountInput {
    providerPluginId: string;
    label: string;
    credentials: Record<string, unknown>;
    /** Where the new account goes in its provider's order. Default `last`. */
    position?: 'first' | 'last';
}

export interface UpdateModelAccountInput {
    label?: string;
    /** false = pause, true = resume. */
    enabled?: boolean;
}

export interface ReorderModelAccountsInput {
    providerPluginId: string;
    /** Every account id of the provider, in the new order. */
    orderedIds: string[];
    /**
     * The order the editor loaded. When it no longer matches what is stored,
     * the save is refused and nothing is written.
     */
    expectedOrder?: string[];
}

/**
 * Model accounts (AW-16) — a workspace's accounts per AI provider.
 *
 * Invariants held here, inside one transaction per write:
 *   - at most 8 accounts per provider and 32 per workspace;
 *   - names are unique within a provider (case-insensitively);
 *   - positions are contiguous 1..N within a provider and are the only order;
 *   - a credential is saved only after the provider accepted it;
 *   - pausing, renaming or replacing a credential keeps the row, its position
 *     and its history.
 *
 * Every change writes one activity entry naming the account and the field,
 * never a value. Reads return {@link ModelAccountView}, which carries no
 * credential of any kind.
 */
@Injectable()
export class ModelAccountService {
    private readonly logger = new Logger(ModelAccountService.name);

    constructor(
        private readonly accounts: ModelAccountRepository,
        private readonly providers: ModelProviderCatalogService,
        private readonly health: ModelAccountHealthService,
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    async list(scope: ModelWorkspaceScope, providerPluginId?: string): Promise<ModelAccountView[]> {
        const rows = await this.accounts.listInWorkspace(
            modelWorkspaceKey(scope),
            providerPluginId,
        );
        const now = new Date();
        return rows.map((row) =>
            toModelAccountView(row, this.providers.providerName(row.providerPluginId), now),
        );
    }

    async listProviders(scope: ModelWorkspaceScope): Promise<ModelProviderView[]> {
        const [providers, rows] = await Promise.all([
            this.providers.listProviders(),
            this.accounts.listInWorkspace(modelWorkspaceKey(scope)),
        ]);
        return providers.map((provider) => ({
            providerPluginId: provider.providerPluginId,
            providerName: provider.providerName,
            credentialFields: provider.credentialFields,
            acceptsAccounts: provider.credentialFields.length > 0,
            accountCount: rows.filter((row) => row.providerPluginId === provider.providerPluginId)
                .length,
        }));
    }

    async create(
        scope: ModelWorkspaceScope,
        input: CreateModelAccountInput,
    ): Promise<ModelAccountView> {
        const workspaceKey = modelWorkspaceKey(scope);
        const provider = await this.requireProvider(input.providerPluginId);
        const label = normalizeLabel(input.label);
        const credentials = pickCredentials(provider, input.credentials, true);

        // Cheap refusals first, so an over-limit or duplicate add never spends
        // a provider check. They are re-checked inside the transaction.
        this.assertCanAdd(await this.accounts.listInWorkspace(workspaceKey), provider, label);

        const check = await this.health.checkCredentials(provider, credentials, scope.userId);
        if (!check.ok) {
            throw modelAccountCredentialRejected(provider.providerName);
        }

        const now = new Date();
        const saved = await this.accounts.inTransaction(
            workspaceKey,
            provider.providerPluginId,
            async (tx) => {
                const existing = await tx.find({
                    where: { workspaceKey },
                    order: { position: 'ASC' },
                });
                this.assertCanAdd(existing, provider, label);
                const siblings = existing.filter(
                    (row) => row.providerPluginId === provider.providerPluginId,
                );
                let position = siblings.length + 1;
                if (input.position === 'first') {
                    position = 1;
                    for (const sibling of siblings) {
                        sibling.position += 1;
                    }
                    await saveAll(tx, siblings);
                }
                return tx.save(
                    tx.create({
                        userId: scope.userId,
                        tenantId: scope.tenantId,
                        organizationId: scope.organizationId,
                        workspaceKey,
                        providerPluginId: provider.providerPluginId,
                        label,
                        position,
                        health: 'working',
                        enabled: true,
                        credentials,
                        credentialVersion: 1,
                        credentialExpiresAt: check.expiresAt,
                        lastCheckedAt: now,
                    }),
                );
            },
        );

        await this.logActivity(scope, ActivityActionType.MODEL_ACCOUNT_ADDED, saved, {
            position: saved.position,
        });
        return toModelAccountView(saved, provider.providerName, now);
    }

    async update(
        scope: ModelWorkspaceScope,
        id: string,
        input: UpdateModelAccountInput,
    ): Promise<ModelAccountView> {
        const workspaceKey = modelWorkspaceKey(scope);
        const account = await this.requireAccount(id, workspaceKey);
        const events: Array<[ActivityActionType, Record<string, unknown>]> = [];

        if (input.label !== undefined) {
            const label = normalizeLabel(input.label);
            if (label !== account.label) {
                const siblings = await this.accounts.listInWorkspace(
                    workspaceKey,
                    account.providerPluginId,
                );
                if (siblings.some((row) => row.id !== account.id && sameLabel(row.label, label))) {
                    throw modelAccountDuplicateLabel(label);
                }
                account.label = label;
                events.push([ActivityActionType.MODEL_ACCOUNT_UPDATED, { field: 'label' }]);
            }
        }
        if (input.enabled !== undefined && input.enabled !== account.enabled) {
            account.enabled = input.enabled;
            events.push([
                input.enabled
                    ? ActivityActionType.MODEL_ACCOUNT_RESUMED
                    : ActivityActionType.MODEL_ACCOUNT_PAUSED,
                { field: 'enabled' },
            ]);
        }

        const saved = events.length > 0 ? await this.accounts.save(account) : account;
        for (const [actionType, details] of events) {
            await this.logActivity(scope, actionType, saved, details);
        }
        return toModelAccountView(saved, this.providers.providerName(saved.providerPluginId));
    }

    /**
     * Replace an account's credential in place (reconnect). Same row, same
     * position, same name, same history; the new credential is checked first
     * and nothing is written if the provider refuses it.
     */
    async replaceCredentials(
        scope: ModelWorkspaceScope,
        id: string,
        credentials: Record<string, unknown>,
    ): Promise<ModelAccountView> {
        const account = await this.requireAccount(id, modelWorkspaceKey(scope));
        const provider = await this.requireProvider(account.providerPluginId);
        const next = pickCredentials(provider, credentials, true);
        const check = await this.health.checkCredentials(provider, next, scope.userId);
        if (!check.ok) {
            throw modelAccountCredentialRejected(provider.providerName);
        }
        const now = new Date();
        account.credentials = next;
        account.credentialVersion = (account.credentialVersion ?? 1) + 1;
        account.credentialExpiresAt = check.expiresAt;
        account.health = 'working';
        account.lastCheckedAt = now;
        account.cooldownReason = null;
        account.cooldownUntil = null;
        account.consecutiveFailures = 0;
        const saved = await this.accounts.save(account);
        await this.logActivity(scope, ActivityActionType.MODEL_ACCOUNT_RECONNECTED, saved, {
            fields: Object.keys(next).sort(),
        });
        return toModelAccountView(saved, provider.providerName, now);
    }

    async reorder(
        scope: ModelWorkspaceScope,
        input: ReorderModelAccountsInput,
    ): Promise<ModelAccountView[]> {
        const workspaceKey = modelWorkspaceKey(scope);
        const moved: Array<{ accountId: string; fromPosition: number; toPosition: number }> = [];
        const rows = await this.accounts.inTransaction(
            workspaceKey,
            input.providerPluginId,
            async (tx) => {
                const current = await tx.find({
                    where: { workspaceKey, providerPluginId: input.providerPluginId },
                    order: { position: 'ASC' },
                });
                const currentIds = current.map((row) => row.id);
                if (input.expectedOrder && !sameOrder(input.expectedOrder, currentIds)) {
                    throw modelAccountStaleOrder();
                }
                if (
                    input.orderedIds.length !== currentIds.length ||
                    new Set(input.orderedIds).size !== input.orderedIds.length ||
                    !input.orderedIds.every((accountId) => currentIds.includes(accountId))
                ) {
                    throw modelAccountStaleOrder();
                }
                const byId = new Map(current.map((row) => [row.id, row]));
                const changed: ModelAccount[] = [];
                input.orderedIds.forEach((accountId, index) => {
                    const row = byId.get(accountId)!;
                    if (row.position !== index + 1) {
                        moved.push({
                            accountId,
                            fromPosition: row.position,
                            toPosition: index + 1,
                        });
                        row.position = index + 1;
                        changed.push(row);
                    }
                });
                await saveAll(tx, changed);
                return input.orderedIds.map((accountId) => byId.get(accountId)!);
            },
        );
        for (const move of moved) {
            const row = rows.find((candidate) => candidate.id === move.accountId);
            if (row) {
                await this.logActivity(scope, ActivityActionType.MODEL_ACCOUNT_REORDERED, row, {
                    fromPosition: move.fromPosition,
                    toPosition: move.toPosition,
                });
            }
        }
        const providerName = this.providers.providerName(input.providerPluginId);
        return rows.map((row) => toModelAccountView(row, providerName));
    }

    /** Remove an account and close the gap it leaves in its provider's order. */
    async remove(
        scope: ModelWorkspaceScope,
        id: string,
    ): Promise<{ removed: ModelAccountView; renumbered: ModelAccountView[] }> {
        const workspaceKey = modelWorkspaceKey(scope);
        const account = await this.requireAccount(id, workspaceKey);
        const providerName = this.providers.providerName(account.providerPluginId);
        const renumbered = await this.accounts.inTransaction(
            workspaceKey,
            account.providerPluginId,
            async (tx) => {
                await tx.delete({ id: account.id, workspaceKey });
                const remaining = await tx.find({
                    where: { workspaceKey, providerPluginId: account.providerPluginId },
                    order: { position: 'ASC' },
                });
                const changed: ModelAccount[] = [];
                remaining.forEach((row, index) => {
                    if (row.position !== index + 1) {
                        row.position = index + 1;
                        changed.push(row);
                    }
                });
                await saveAll(tx, changed);
                return remaining;
            },
        );
        await this.logActivity(scope, ActivityActionType.MODEL_ACCOUNT_REMOVED, account, {
            position: account.position,
        });
        return {
            removed: toModelAccountView(account, providerName),
            renumbered: renumbered.map((row) => toModelAccountView(row, providerName)),
        };
    }

    /** Check one account now (the row's "check again" action). */
    async check(scope: ModelWorkspaceScope, id: string): Promise<ModelAccountView> {
        const account = await this.requireAccount(id, modelWorkspaceKey(scope));
        await this.health.probe(account);
        const refreshed = (await this.accounts.findById(account.id)) ?? account;
        return toModelAccountView(
            refreshed,
            this.providers.providerName(refreshed.providerPluginId),
        );
    }

    private assertCanAdd(
        existing: readonly ModelAccount[],
        provider: ModelProviderDescriptor,
        label: string,
    ): void {
        if (existing.length >= MODEL_ROUTING_LIMITS.accountsPerWorkspace) {
            throw modelAccountLimitReached('workspace', MODEL_ROUTING_LIMITS.accountsPerWorkspace);
        }
        const siblings = existing.filter(
            (row) => row.providerPluginId === provider.providerPluginId,
        );
        if (siblings.length >= MODEL_ROUTING_LIMITS.accountsPerProvider) {
            throw modelAccountLimitReached('provider', MODEL_ROUTING_LIMITS.accountsPerProvider);
        }
        if (siblings.some((row) => sameLabel(row.label, label))) {
            throw modelAccountDuplicateLabel(label);
        }
    }

    private async requireProvider(providerPluginId: string): Promise<ModelProviderDescriptor> {
        const provider = await this.providers.getProvider(providerPluginId);
        if (!provider) throw modelProviderUnknown(providerPluginId);
        if (provider.credentialFields.length === 0) {
            throw modelProviderTakesNoAccounts(provider.providerName);
        }
        return provider;
    }

    private async requireAccount(id: string, workspaceKey: string): Promise<ModelAccount> {
        const account = await this.accounts.findInWorkspace(id, workspaceKey);
        if (!account) throw modelAccountNotFound();
        return account;
    }

    private async logActivity(
        scope: ModelWorkspaceScope,
        actionType: ActivityActionType,
        account: ModelAccount,
        details: Record<string, unknown> = {},
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId: scope.userId,
                action: actionType,
                actionType,
                status: ActivityStatus.COMPLETED,
                summary: `Model account "${account.label}" — ${actionType}`,
                details: {
                    accountId: account.id,
                    label: account.label,
                    providerPluginId: account.providerPluginId,
                    organizationId: scope.organizationId,
                    ...details,
                },
            });
        } catch (error) {
            this.logger.warn(`Failed to log activity ${actionType}: ${error}`);
        }
    }
}

function normalizeLabel(value: string): string {
    const label = typeof value === 'string' ? value.trim() : '';
    if (label.length < 1 || label.length > MODEL_ROUTING_LIMITS.accountLabelMaxLength) {
        throw modelAccountInvalidLabel();
    }
    return label;
}

function sameLabel(a: string, b: string): boolean {
    return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Keep only the provider's declared secret fields, as non-empty strings.
 * An unknown field is refused rather than dropped, so a typo in a field name
 * cannot silently save an account with no credential.
 */
function pickCredentials(
    provider: ModelProviderDescriptor,
    raw: Record<string, unknown>,
    requireOne: boolean,
): Record<string, string> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw modelAccountInvalidCredentials('Credentials must be an object of fields.');
    }
    const allowed = new Set(provider.credentialFields.map((field) => field.key));
    const picked: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!allowed.has(key)) {
            throw modelAccountInvalidCredentials(
                `${provider.providerName} has no credential field '${key}'.`,
            );
        }
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'string') {
            throw modelAccountInvalidCredentials(`Credential field '${key}' must be text.`);
        }
        const trimmed = value.trim();
        if (trimmed) picked[key] = trimmed;
    }
    if (requireOne && Object.keys(picked).length === 0) {
        throw modelAccountInvalidCredentials('Enter a credential to add this account.');
    }
    return picked;
}

async function saveAll(tx: Repository<ModelAccount>, rows: ModelAccount[]): Promise<void> {
    for (const row of rows) {
        await tx.save(row);
    }
}
