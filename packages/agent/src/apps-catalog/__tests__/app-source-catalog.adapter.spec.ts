import type { AppSourceCatalogPort } from '../../app-works/app-source-catalog.port';
import {
    AppsCatalogCredentialUnavailableError,
    type AppBlueprintResolution,
} from '../app-blueprint-resolver.service';
import {
    AppBlueprintApplyUnavailableError,
    AppSourceCatalogAdapter,
} from '../app-source-catalog.adapter';

/**
 * APW-03 — `AppSourceCatalogAdapter`, the binding of APW-01's `APP_SOURCE_CATALOG_PORT`.
 *
 * The resolver is a jest double here (its own behaviour is `app-blueprint-resolver.spec.ts`);
 * what this file pins is the mapping, the error contract the consumers depend on, and the
 * **apply gate**: no Blueprint is ever offered while nothing can apply it.
 */

function hit(overrides: Partial<Extract<AppBlueprintResolution, { status: 'hit' }>> = {}) {
    return {
        status: 'hit' as const,
        source: 'probe' as const,
        repo: 'ever-works/cal-diy-template',
        id: 'cal-diy',
        version: '0.1.0',
        name: 'Cal.diy',
        displayName: 'Cal.diy',
        spdx: 'MIT',
        prompts: [] as { name: string; description?: string; required: boolean }[],
        ...overrides,
    };
}

function resolverDouble(answer: AppBlueprintResolution | Error) {
    return {
        resolve: jest.fn(async () => {
            if (answer instanceof Error) throw answer;
            return answer;
        }),
    };
}

const APPLY_STUB = { request: jest.fn() };

describe('AppSourceCatalogAdapter', () => {
    it('implements AppSourceCatalogPort', () => {
        const adapter = new AppSourceCatalogAdapter(undefined, undefined);
        // Type-level: this line does not compile if the adapter drifts from the port.
        const port: AppSourceCatalogPort = adapter;
        expect(typeof port.matchBlueprint).toBe('function');
        expect(typeof port.classifyLicense).toBe('function');
    });

    describe('matchBlueprint', () => {
        it('rejects when no resolver is in the graph — consumers answer "unavailable"', async () => {
            const adapter = new AppSourceCatalogAdapter(undefined, APPLY_STUB as never);

            await expect(adapter.matchBlueprint({ owner: 'a', repo: 'b' })).rejects.toThrow(
                /resolver/i,
            );
        });

        it.each(['notListed', 'lookupFailed', 'blueprintNotFound'] as const)(
            'answers null for none/%s',
            async (reason) => {
                const resolver = resolverDouble({ status: 'none', reason });
                const adapter = new AppSourceCatalogAdapter(resolver as never, APPLY_STUB as never);

                await expect(adapter.matchBlueprint({ owner: 'a', repo: 'b' })).resolves.toBeNull();
            },
        );

        it('passes the coordinates and an explicit blueprintId through unchanged', async () => {
            const resolver = resolverDouble({ status: 'none', reason: 'blueprintNotFound' });
            const adapter = new AppSourceCatalogAdapter(resolver as never, APPLY_STUB as never);

            await adapter.matchBlueprint({
                owner: 'Calcom',
                repo: 'cal.diy',
                blueprintId: 'cal-diy',
            });

            expect(resolver.resolve).toHaveBeenCalledWith({
                owner: 'Calcom',
                repo: 'cal.diy',
                blueprintId: 'cal-diy',
            });
        });

        it('maps a generic resolver throw to null (T26)', async () => {
            const adapter = new AppSourceCatalogAdapter(
                resolverDouble(new Error('boom')) as never,
                APPLY_STUB as never,
            );

            await expect(adapter.matchBlueprint({ owner: 'a', repo: 'b' })).resolves.toBeNull();
        });

        it('rethrows the credential error — "could not look" is never "no match"', async () => {
            const adapter = new AppSourceCatalogAdapter(
                resolverDouble(new AppsCatalogCredentialUnavailableError()) as never,
                APPLY_STUB as never,
            );

            await expect(adapter.matchBlueprint({ owner: 'a', repo: 'b' })).rejects.toBeInstanceOf(
                AppsCatalogCredentialUnavailableError,
            );
        });
    });

    describe('the apply gate (APP_BLUEPRINT_APPLY_SERVICE, APW-03 T28)', () => {
        it('rejects a hit while no apply service is bound', async () => {
            const adapter = new AppSourceCatalogAdapter(resolverDouble(hit()) as never, undefined);

            await expect(adapter.matchBlueprint({ owner: 'a', repo: 'b' })).rejects.toBeInstanceOf(
                AppBlueprintApplyUnavailableError,
            );
        });

        it('rejects an explicit hit while no apply service is bound', async () => {
            const adapter = new AppSourceCatalogAdapter(
                resolverDouble(hit({ source: 'explicit' })) as never,
                undefined,
            );

            await expect(
                adapter.matchBlueprint({ owner: 'a', repo: 'b', blueprintId: 'cal-diy' }),
            ).rejects.toBeInstanceOf(AppBlueprintApplyUnavailableError);
        });

        it('still answers an honest miss while no apply service is bound', async () => {
            const adapter = new AppSourceCatalogAdapter(
                resolverDouble({ status: 'none', reason: 'notListed' }) as never,
                undefined,
            );

            await expect(adapter.matchBlueprint({ owner: 'a', repo: 'b' })).resolves.toBeNull();
        });

        it('maps a hit once the apply service is bound — the class is computed, never declared', async () => {
            const resolution = {
                ...hit({ source: 'explicit', spdx: 'BUSL-1.1' }),
                // What a Blueprint DECLARES about its own class is ignored (R-3), and nothing
                // beyond the descriptor ever travels on a prompt.
                licenseClass: 'green',
                prompts: [
                    {
                        name: 'ADMIN_EMAIL',
                        description: 'Where alerts go',
                        required: true,
                        example: 'admin@example.com',
                    },
                    { name: 'NOTE', required: false },
                ],
            } as unknown as AppBlueprintResolution;
            const adapter = new AppSourceCatalogAdapter(
                resolverDouble(resolution) as never,
                APPLY_STUB as never,
            );

            const match = await adapter.matchBlueprint({ owner: 'a', repo: 'b' });

            expect(match).toEqual({
                id: 'cal-diy',
                version: '0.1.0',
                verified: false,
                name: 'Cal.diy',
                displayName: 'Cal.diy',
                matchSource: 'explicit',
                spdx: 'BUSL-1.1',
                licenseClass: 'amber',
                prompts: [
                    { name: 'ADMIN_EMAIL', description: 'Where alerts go', required: true },
                    { name: 'NOTE', required: false },
                ],
            });
        });

        it('omits prompts when the Blueprint declares none, and answers unknown for no licence', async () => {
            const adapter = new AppSourceCatalogAdapter(
                resolverDouble(hit({ spdx: undefined, displayName: undefined })) as never,
                APPLY_STUB as never,
            );

            const match = await adapter.matchBlueprint({ owner: 'a', repo: 'b' });

            expect(match).toEqual({
                id: 'cal-diy',
                version: '0.1.0',
                verified: false,
                name: 'Cal.diy',
                matchSource: 'probe',
                licenseClass: 'unknown',
            });
        });
    });

    describe('classifyLicense', () => {
        const adapter = new AppSourceCatalogAdapter(undefined, undefined);

        it.each([
            [null, 'unknown'],
            ['MIT', 'green'],
            ['BUSL-1.1', 'amber'],
            ['PolyForm-Noncommercial-1.0.0', 'red'],
            ['GPL-3.0-only', 'unknown'],
            // The owner decision (2026-09-25): GitHub's NOASSERTION is red, as ACC-NEG-01's
            // fixture has it.
            ['NOASSERTION', 'red'],
        ] as const)('%j ⇒ %s, with no resolver and no apply service', async (spdx, expected) => {
            await expect(adapter.classifyLicense(spdx)).resolves.toBe(expected);
        });
    });
});
