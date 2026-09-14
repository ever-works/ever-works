import type { IAiProviderPlugin } from '@ever-works/plugin';
import type { ModelAccountRepository } from '../../database/repositories/model-account.repository';
import type { ModelAccount } from '../../entities/model-account.entity';
import type { ModelProviderDescriptor } from '../model-provider-catalog.service';

/**
 * Test doubles shared by the model-routing specs: an in-memory
 * `model_accounts` table with the subset of the repository surface the
 * services use, and an AI provider descriptor built from a settings schema.
 */

type Where = Partial<Record<keyof ModelAccount, unknown>>;

function matches(row: ModelAccount, where: Where): boolean {
    return Object.entries(where).every(([key, value]) => row[key as keyof ModelAccount] === value);
}

function sortRows(
    rows: ModelAccount[],
    order?: Partial<Record<keyof ModelAccount, 'ASC' | 'DESC'>>,
) {
    if (!order) return rows;
    const keys = Object.keys(order) as Array<keyof ModelAccount>;
    return [...rows].sort((a, b) => {
        for (const key of keys) {
            const direction = order[key] === 'DESC' ? -1 : 1;
            const left = a[key] as unknown as string | number;
            const right = b[key] as unknown as string | number;
            if (left < right) return -1 * direction;
            if (left > right) return 1 * direction;
        }
        return 0;
    });
}

export class InMemoryModelAccounts {
    rows: ModelAccount[] = [];
    private seq = 0;

    readonly table = {
        find: async (options: {
            where: Where;
            order?: Partial<Record<keyof ModelAccount, 'ASC' | 'DESC'>>;
        }) =>
            sortRows(
                this.rows.filter((row) => matches(row, options.where)),
                options.order,
            ).map((row) => ({ ...row })),
        save: async (row: ModelAccount) => this.upsert(row),
        create: (entry: Partial<ModelAccount>) => ({ ...entry }) as ModelAccount,
        delete: async (where: Where) => {
            this.rows = this.rows.filter((row) => !matches(row, where));
        },
    };

    readonly repository = {
        create: (entry: Partial<ModelAccount>) => ({ ...entry }) as ModelAccount,
        save: async (row: ModelAccount) => this.upsert(row),
        inTransaction: async <T>(
            _workspaceKey: string,
            _provider: string | null,
            work: (tx: unknown) => Promise<T>,
        ) => {
            const snapshot = this.rows.map((row) => ({ ...row }));
            try {
                return await work(this.table);
            } catch (error) {
                this.rows = snapshot;
                throw error;
            }
        },
        listInWorkspace: async (workspaceKey: string, providerPluginId?: string) =>
            this.table.find({
                where: providerPluginId ? { workspaceKey, providerPluginId } : { workspaceKey },
                order: { providerPluginId: 'ASC', position: 'ASC' },
            }),
        findInWorkspace: async (id: string, workspaceKey: string) =>
            this.clone(this.rows.find((row) => row.id === id && row.workspaceKey === workspaceKey)),
        findById: async (id: string) => this.clone(this.rows.find((row) => row.id === id)),
        anyExist: async () => this.rows.length > 0,
        existsInWorkspace: async (workspaceKey: string) =>
            this.rows.some((row) => row.workspaceKey === workspaceKey),
        touchLastUsed: jest.fn(async (id: string, now: Date, notBefore: Date) => {
            const row = this.rows.find((candidate) => candidate.id === id);
            if (row && (!row.lastUsedAt || row.lastUsedAt < notBefore)) row.lastUsedAt = now;
        }),
        updateHealth: jest.fn(async (id: string, patch: Partial<ModelAccount>) => {
            const row = this.rows.find((candidate) => candidate.id === id);
            if (row) Object.assign(row, patch);
        }),
        listDueForCheck: async (cutoff: Date, limit: number) =>
            this.rows
                .filter((row) => row.enabled && (!row.lastCheckedAt || row.lastCheckedAt < cutoff))
                .slice(0, limit)
                .map((row) => ({ ...row })),
        claimForCheck: jest.fn(async (id: string, now: Date, cutoff: Date) => {
            const row = this.rows.find((candidate) => candidate.id === id);
            if (!row || (row.lastCheckedAt && row.lastCheckedAt >= cutoff)) return false;
            row.lastCheckedAt = now;
            return true;
        }),
    };

    asRepository(): ModelAccountRepository {
        return this.repository as unknown as ModelAccountRepository;
    }

    seed(entry: Partial<ModelAccount>): ModelAccount {
        return this.upsert({
            workspaceKey: 'org:o1',
            userId: 'u1',
            providerPluginId: 'provider-a',
            label: `Account ${this.seq + 1}`,
            position: 1,
            health: 'working',
            enabled: true,
            credentials: { apiKey: 'sk-seeded-secret' },
            credentialVersion: 1,
            consecutiveFailures: 0,
            ...entry,
        } as ModelAccount);
    }

    private upsert(row: ModelAccount): ModelAccount {
        if (!row.id) {
            this.seq += 1;
            row = { ...row, id: `acc-${this.seq}`, createdAt: new Date(), updatedAt: new Date() };
        }
        const index = this.rows.findIndex((candidate) => candidate.id === row.id);
        const stored = { ...row, updatedAt: new Date() } as ModelAccount;
        if (index >= 0) this.rows[index] = { ...this.rows[index], ...stored };
        else this.rows.push(stored);
        return { ...stored };
    }

    private clone(row: ModelAccount | undefined): ModelAccount | null {
        return row ? { ...row } : null;
    }
}

export function providerDescriptor(
    id: string,
    plugin: Partial<IAiProviderPlugin> = {},
    secretKeys: string[] = ['apiKey'],
): ModelProviderDescriptor {
    return {
        providerPluginId: id,
        providerName: `Provider ${id}`,
        credentialFields: secretKeys.map((key) => ({ key, title: key, description: null })),
        plugin: {
            id,
            providerName: `Provider ${id}`,
            isAvailable: jest.fn().mockResolvedValue(true),
            listModels: jest.fn().mockResolvedValue([]),
            ...plugin,
        } as unknown as IAiProviderPlugin,
    };
}
