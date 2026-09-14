import { ActivityActionType } from '../../entities/activity-log.types';
import type { ActivityLogService } from '../../activity-log/activity-log.service';
import type { ModelAccountHealthService } from '../model-account-health.service';
import { ModelAccountService } from '../model-account.service';
import type { ModelProviderCatalogService } from '../model-provider-catalog.service';
import { InMemoryModelAccounts, providerDescriptor } from './model-routing.fakes';

const ORG = { userId: 'u1', tenantId: 't1', organizationId: 'o1' };
const SECRET = 'sk-live-0123456789abcdef';

describe('ModelAccountService', () => {
    let store: InMemoryModelAccounts;
    let checkCredentials: jest.Mock;
    let log: jest.Mock;
    let service: ModelAccountService;
    const providerA = providerDescriptor('provider-a');
    const providerC = providerDescriptor('provider-c');
    const noSecrets = providerDescriptor('local-provider', {}, []);
    const supplementary = { ...providerDescriptor('helper-provider'), supplementary: true };

    beforeEach(() => {
        store = new InMemoryModelAccounts();
        checkCredentials = jest
            .fn()
            .mockResolvedValue({ ok: true, rejected: false, expiresAt: null });
        log = jest.fn().mockResolvedValue(undefined);
        const providers = {
            getProvider: jest.fn(
                async (id: string) =>
                    ({
                        'provider-a': providerA,
                        'provider-c': providerC,
                        'local-provider': noSecrets,
                        'helper-provider': supplementary,
                    })[id] ?? null,
            ),
            listProviders: jest.fn(async () => [providerA, noSecrets]),
            providerName: (id: string) => `Provider ${id}`,
        } as unknown as ModelProviderCatalogService;
        service = new ModelAccountService(
            store.asRepository(),
            providers,
            { checkCredentials, probe: jest.fn() } as unknown as ModelAccountHealthService,
            { log } as unknown as ActivityLogService,
        );
    });

    const add = (label: string, extra: Record<string, unknown> = {}) =>
        service.create(ORG, {
            providerPluginId: 'provider-a',
            label,
            credentials: { apiKey: SECRET },
            ...extra,
        });

    it('adds a second account on the same provider, numbered in order', async () => {
        await add('Company key');
        const second = await add('Overflow key');
        expect(second.position).toBe(2);
        const listed = await service.list(ORG);
        expect(listed.map((row) => [row.label, row.position])).toEqual([
            ['Company key', 1],
            ['Overflow key', 2],
        ]);
    });

    it('puts an account first when asked, pushing the others down', async () => {
        await add('Company key');
        await add('Urgent key', { position: 'first' });
        const listed = await service.list(ORG);
        expect(listed.map((row) => [row.label, row.position])).toEqual([
            ['Urgent key', 1],
            ['Company key', 2],
        ]);
    });

    it('never returns the credential it stored, in any shape', async () => {
        const created = await add('Company key');
        const listed = await service.list(ORG);
        const reordered = await service.reorder(ORG, {
            providerPluginId: 'provider-a',
            orderedIds: [created.id],
        });
        for (const body of [created, listed, reordered]) {
            const json = JSON.stringify(body);
            expect(json).not.toContain(SECRET);
            expect(json).not.toContain(SECRET.slice(-6));
            expect(json).not.toContain('credentials');
            expect(json).not.toContain('credentialVersion');
        }
        // …while the row itself holds it, for the call path.
        expect(store.rows[0].credentials).toEqual({ apiKey: SECRET });
    });

    it('saves nothing when the provider rejects the credential', async () => {
        checkCredentials.mockResolvedValue({ ok: false, rejected: true, expiresAt: null });
        await expect(add('Company key')).rejects.toMatchObject({
            response: { code: 'credential_rejected' },
        });
        expect(store.rows).toHaveLength(0);
        expect(log).not.toHaveBeenCalled();
    });

    it('refuses a duplicate name on the same provider, case-insensitively, before checking the key', async () => {
        await add('Company key');
        checkCredentials.mockClear();
        await expect(add('company KEY')).rejects.toMatchObject({
            response: { code: 'duplicate_label' },
        });
        expect(checkCredentials).not.toHaveBeenCalled();
    });

    it('caps accounts at 8 per provider and 32 per workspace', async () => {
        for (let index = 0; index < 8; index += 1) await add(`Key ${index}`);
        await expect(add('Key 9')).rejects.toMatchObject({
            response: { code: 'limit_reached', scope: 'provider', limit: 8 },
        });

        for (let index = 0; index < 24; index += 1) {
            store.seed({ providerPluginId: `other-${index}`, label: 'Other', position: 1 });
        }
        await expect(
            service.create(ORG, {
                providerPluginId: 'provider-a',
                label: 'Anything',
                credentials: { apiKey: SECRET },
            }),
        ).rejects.toMatchObject({ response: { code: 'limit_reached' } });
        const seededElsewhere = store.rows.filter((row) => row.providerPluginId !== 'provider-a');
        expect(seededElsewhere).toHaveLength(24);
    });

    it('adds under the workspace-wide lock as well as the provider lock', async () => {
        await add('Company key');
        expect(store.repository.inTransaction).toHaveBeenCalledWith(
            'org:o1',
            'provider-a',
            expect.any(Function),
            { lockWorkspace: true },
        );
    });

    it('lets only one of two concurrent adds for different providers take the last workspace slot', async () => {
        // 31 of 32: four other providers, the last one a slot short of full.
        for (let index = 0; index < 31; index += 1) {
            store.seed({
                providerPluginId: `other-${Math.floor(index / 8)}`,
                label: `Other ${index}`,
                position: (index % 8) + 1,
            });
        }

        const results = await Promise.allSettled([
            add('Company key'),
            service.create(ORG, {
                providerPluginId: 'provider-c',
                label: 'Company key',
                credentials: { apiKey: SECRET },
            }),
        ]);

        expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
        const refused = results.find(
            (result) => result.status === 'rejected',
        ) as PromiseRejectedResult;
        expect(refused.reason).toMatchObject({
            response: { code: 'limit_reached', scope: 'workspace', limit: 32 },
        });
        expect(store.rows).toHaveLength(32);
    });

    it('refuses an account for a supplementary provider, which the provider list never offers', async () => {
        await expect(
            service.create(ORG, {
                providerPluginId: 'helper-provider',
                label: 'x',
                credentials: { apiKey: 'k' },
            }),
        ).rejects.toMatchObject({ response: { code: 'unknown_provider' } });
        expect(checkCredentials).not.toHaveBeenCalled();
        expect(store.rows).toHaveLength(0);
    });

    it('stamps a personal account with its owner, and an organization account with none', async () => {
        await add('Company key');
        await service.create(
            { userId: 'u1', tenantId: 't1', organizationId: null },
            { providerPluginId: 'provider-a', label: 'Mine', credentials: { apiKey: SECRET } },
        );
        expect(store.rows.map((row) => [row.workspaceKey, row.userId, row.ownerUserId])).toEqual([
            ['org:o1', 'u1', null],
            ['user:u1', 'u1', 'u1'],
        ]);
    });

    it('refuses a rename to a name another account already has, case-insensitively, under the provider lock', async () => {
        await add('Company key');
        const second = await add('Overflow key');
        store.repository.inTransaction.mockClear();

        await expect(
            service.update(ORG, second.id, { label: 'COMPANY key' }),
        ).rejects.toMatchObject({ response: { code: 'duplicate_label' } });
        expect(store.repository.inTransaction).toHaveBeenCalledWith(
            'org:o1',
            'provider-a',
            expect.any(Function),
        );
        expect(store.rows.find((row) => row.id === second.id)?.label).toBe('Overflow key');
    });

    it('lets only one of two concurrent renames to case-equivalent names win', async () => {
        const first = await add('One');
        const second = await add('Two');

        const results = await Promise.allSettled([
            service.update(ORG, first.id, { label: 'Shared' }),
            service.update(ORG, second.id, { label: 'shared' }),
        ]);

        expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(store.rows.filter((row) => row.label.toLowerCase() === 'shared')).toHaveLength(1);
    });

    it('never writes back a position a reorder changed while a rename was on its way', async () => {
        const first = await add('One');
        const second = await add('Two');
        const staleFirst = { ...store.rows.find((row) => row.id === first.id)! };
        await service.reorder(ORG, {
            providerPluginId: 'provider-a',
            orderedIds: [second.id, first.id],
        });
        // The rename loaded the row before the reorder committed.
        (store.repository as { findInWorkspace: unknown }).findInWorkspace = async () => ({
            ...staleFirst,
        });

        const renamed = await service.update(ORG, first.id, { label: 'Renamed' });

        expect(renamed).toMatchObject({ label: 'Renamed', position: 2 });
        expect(store.rows.find((row) => row.id === first.id)).toMatchObject({
            label: 'Renamed',
            position: 2,
        });
    });

    it('keeps accounts in different workspaces apart', async () => {
        await add('Company key');
        const personal = { userId: 'u1', tenantId: 't1', organizationId: null };
        await expect(
            service.create(personal, {
                providerPluginId: 'provider-a',
                label: 'Company key',
                credentials: { apiKey: SECRET },
            }),
        ).resolves.toMatchObject({ position: 1 });
        expect(await service.list(personal)).toHaveLength(1);
        await expect(
            service.update(personal, store.rows[0].id, { label: 'Stolen' }),
        ).rejects.toMatchObject({ response: { code: 'not_found' } });
    });

    it('refuses an unknown provider, a provider with no secret field, and an unknown credential field', async () => {
        await expect(
            service.create(ORG, {
                providerPluginId: 'nope',
                label: 'x',
                credentials: { apiKey: 'k' },
            }),
        ).rejects.toMatchObject({ response: { code: 'unknown_provider' } });
        await expect(
            service.create(ORG, {
                providerPluginId: 'local-provider',
                label: 'x',
                credentials: {},
            }),
        ).rejects.toMatchObject({ response: { code: 'no_credential_fields' } });
        await expect(
            service.create(ORG, {
                providerPluginId: 'provider-a',
                label: 'x',
                credentials: { baseUrl: 'http://169.254.169.254' },
            }),
        ).rejects.toMatchObject({ response: { code: 'invalid_credentials' } });
        await expect(
            service.create(ORG, {
                providerPluginId: 'provider-a',
                label: '  ',
                credentials: { apiKey: 'k' },
            }),
        ).rejects.toMatchObject({ response: { code: 'invalid_label' } });
    });

    it('reorders in one save and refuses a stale order without writing anything', async () => {
        const first = await add('Company key');
        const second = await add('Overflow key');
        const reordered = await service.reorder(ORG, {
            providerPluginId: 'provider-a',
            orderedIds: [second.id, first.id],
            expectedOrder: [first.id, second.id],
        });
        expect(reordered.map((row) => [row.label, row.position])).toEqual([
            ['Overflow key', 1],
            ['Company key', 2],
        ]);

        // A second editor still holding the old order is refused.
        await expect(
            service.reorder(ORG, {
                providerPluginId: 'provider-a',
                orderedIds: [first.id, second.id],
                expectedOrder: [first.id, second.id],
            }),
        ).rejects.toMatchObject({ response: { code: 'stale_order' } });
        // An order that drops or invents an account is refused too.
        await expect(
            service.reorder(ORG, { providerPluginId: 'provider-a', orderedIds: [first.id] }),
        ).rejects.toMatchObject({ response: { code: 'stale_order' } });
        expect((await service.list(ORG)).map((row) => row.label)).toEqual([
            'Overflow key',
            'Company key',
        ]);
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({ actionType: ActivityActionType.MODEL_ACCOUNT_REORDERED }),
        );
    });

    it('pauses and resumes without losing position, name or credential', async () => {
        await add('Company key');
        const second = await add('Overflow key');
        const paused = await service.update(ORG, second.id, { enabled: false });
        expect(paused).toMatchObject({ health: 'paused', position: 2, label: 'Overflow key' });
        const resumed = await service.update(ORG, second.id, { enabled: true });
        expect(resumed).toMatchObject({ health: 'working', position: 2, label: 'Overflow key' });
        expect(store.rows.find((row) => row.id === second.id)?.credentials).toEqual({
            apiKey: SECRET,
        });
        const actions = log.mock.calls.map(([entry]) => entry.actionType);
        expect(actions).toContain(ActivityActionType.MODEL_ACCOUNT_PAUSED);
        expect(actions).toContain(ActivityActionType.MODEL_ACCOUNT_RESUMED);
    });

    it('replaces a credential in place, keeping the row, and names only the field in the log', async () => {
        const created = await add('Company key');
        store.rows[0].health = 'invalid';
        const reconnected = await service.replaceCredentials(ORG, created.id, {
            apiKey: 'sk-new-secret-value',
        });
        expect(reconnected).toMatchObject({ id: created.id, position: 1, health: 'working' });
        expect(store.rows).toHaveLength(1);
        expect(store.rows[0].credentialVersion).toBe(2);
        const logged = JSON.stringify(log.mock.calls);
        expect(logged).toContain('apiKey');
        expect(logged).not.toContain('sk-new-secret-value');
        expect(logged).not.toContain(SECRET);
    });

    it('keeps the old credential when a replacement is rejected', async () => {
        const created = await add('Company key');
        checkCredentials.mockResolvedValue({ ok: false, rejected: true, expiresAt: null });
        await expect(
            service.replaceCredentials(ORG, created.id, { apiKey: 'sk-typo' }),
        ).rejects.toMatchObject({ response: { code: 'credential_rejected' } });
        expect(store.rows[0].credentials).toEqual({ apiKey: SECRET });
    });

    it('closes the gap in the order when an account is removed', async () => {
        const first = await add('One');
        await add('Two');
        await add('Three');
        const { renumbered } = await service.remove(ORG, first.id);
        expect(renumbered.map((row) => [row.label, row.position])).toEqual([
            ['Two', 1],
            ['Three', 2],
        ]);
    });

    it('lists every installed provider with its own credential fields', async () => {
        await add('Company key');
        const providers = await service.listProviders(ORG);
        expect(providers).toEqual([
            expect.objectContaining({
                providerPluginId: 'provider-a',
                acceptsAccounts: true,
                accountCount: 1,
                credentialFields: [{ key: 'apiKey', title: 'apiKey', description: null }],
            }),
            expect.objectContaining({ providerPluginId: 'local-provider', acceptsAccounts: false }),
        ]);
    });
});
