// The auth barrel pulls `better-auth` (ESM); the controller needs `Public` only.
jest.mock('../auth', () => {
    const { SetMetadata } = jest.requireActual('@nestjs/common');
    return { Public: () => SetMetadata('isPublic', true) };
});

import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { LICENSE_REGISTRY_SNAPSHOT } from '@ever-works/agent/app-license';
import { config } from '@ever-works/agent/config';
import {
    AppsCatalogLicensesController,
    licenseRegistryListing,
} from './apps-catalog-licenses.controller';

/**
 * APW-03 T25 (lane aw-blueprints) — `GET /api/apps-catalog/licenses`, the licence registry
 * read (plan §4.1:549): public, cached for five minutes, the snapshot named as such, every
 * amber and red licence carrying its attestation TEXT ID (never the text), and refused
 * while App Works is off.
 */
describe('AppsCatalogLicensesController (APW-03 T25)', () => {
    afterEach(() => jest.restoreAllMocks());

    it('answers the bundled registry as the snapshot it is, sorted green → amber → red', () => {
        jest.spyOn(config.everWorks.apps, 'worksEnabled').mockReturnValue(true);
        const answer = new AppsCatalogLicensesController().licenses();
        expect(answer.registrySource).toBe('snapshot');
        expect(answer.legalReviewed).toBe(false);
        expect(answer.updatedAt).toBe(LICENSE_REGISTRY_SNAPSHOT.updatedAt);
        expect(answer.items).toHaveLength(LICENSE_REGISTRY_SNAPSHOT.licenses.length);
        const classes = answer.items.map((entry) => entry.class);
        expect(classes).toEqual(
            [...classes].sort(
                (a, b) =>
                    ['green', 'amber', 'red'].indexOf(a) - ['green', 'amber', 'red'].indexOf(b),
            ),
        );
        expect(answer.classes.green).toEqual({
            managedHosting: true,
            yourCluster: true,
            attestation: false,
        });
        expect(answer.classes.amber.managedHosting).toBe('upstream-agreement');
        expect(answer.classes.red.managedHosting).toBe(false);
        expect(answer.unknownClass).not.toBe('green');
    });

    it('carries the attestation text id for amber and red, and never the text', () => {
        jest.spyOn(config.everWorks.apps, 'worksEnabled').mockReturnValue(true);
        const answer = new AppsCatalogLicensesController().licenses();
        for (const entry of answer.items.filter((row) => row.class !== 'green')) {
            const source = LICENSE_REGISTRY_SNAPSHOT.licenses.find(
                (row) => row.spdx === entry.spdx,
            );
            if (source?.attestation) {
                expect(entry.attestationTextId).toBe(source.attestation.textId);
            }
        }
        const serialised = JSON.stringify(answer);
        for (const row of LICENSE_REGISTRY_SNAPSHOT.licenses) {
            if (row.attestation) expect(serialised).not.toContain(row.attestation.text);
        }
    });

    it('is refused while App Works is off', () => {
        jest.spyOn(config.everWorks.apps, 'worksEnabled').mockReturnValue(false);
        try {
            new AppsCatalogLicensesController().licenses();
            throw new Error('expected a refusal');
        } catch (error) {
            expect(error).toBeInstanceOf(HttpException);
            expect((error as HttpException).getStatus()).toBe(400);
            expect((error as HttpException).getResponse()).toMatchObject({
                code: 'app_works_disabled',
            });
        }
    });

    it('is public, cached for five minutes, under api/apps-catalog/licenses', () => {
        const handler = AppsCatalogLicensesController.prototype.licenses;
        expect(Reflect.getMetadata('path', AppsCatalogLicensesController)).toBe('api/apps-catalog');
        expect(Reflect.getMetadata('path', handler)).toBe('licenses');
        expect(Reflect.getMetadata('isPublic', handler)).toBe(true);
        const headers = Reflect.getMetadata('__headers__', handler) as Array<{
            name: string;
            value: string;
        }>;
        expect(headers).toEqual(
            expect.arrayContaining([{ name: 'Cache-Control', value: 'public, max-age=300' }]),
        );
    });

    it('projects any registry purely, copying obligations', () => {
        const registry = {
            ...LICENSE_REGISTRY_SNAPSHOT,
            licenses: [
                {
                    spdx: 'Zlib',
                    name: 'zlib',
                    class: 'green' as const,
                    obligations: ['attribution'],
                },
                {
                    spdx: 'AGPL-3.0-only',
                    name: 'AGPL',
                    class: 'amber' as const,
                    obligations: ['network-source-offer'],
                    attestation: { textId: 'agpl-v1', text: 'I confirm …' },
                },
            ],
        };
        const answer = licenseRegistryListing(registry, {
            registrySource: 'live',
            legalReviewed: true,
        });
        expect(answer.items).toEqual([
            { spdx: 'Zlib', name: 'zlib', class: 'green', obligations: ['attribution'] },
            {
                spdx: 'AGPL-3.0-only',
                name: 'AGPL',
                class: 'amber',
                obligations: ['network-source-offer'],
                attestationTextId: 'agpl-v1',
            },
        ]);
        expect(answer.items[0].obligations).not.toBe(registry.licenses[0].obligations);
        expect(answer).toMatchObject({ registrySource: 'live', legalReviewed: true });
    });
});
