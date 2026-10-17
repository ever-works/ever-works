// Barrel stubs, as every controller spec in this app does (see
// `work-app-deploy.controller.spec.ts`): the services and auth barrels pull ESM-only
// packages jest cannot parse. The attestation-text helper is stubbed with the
// registry's real ids; their own behaviour is pinned by
// `packages/agent/src/app-license/__tests__/app-license.service.spec.ts`.
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));
jest.mock('@ever-works/agent/app-spec', () => ({
    AppSpecService: class AppSpecService {},
}));
jest.mock('@ever-works/agent/app-license', () => {
    const textFor = (spdx: string | null) =>
        spdx === 'BUSL-1.1'
            ? {
                  textId: 'busl-1.1-v1',
                  text: 'I confirm the Business Source License terms apply to me.',
              }
            : {
                  textId: 'unknown-license-v1',
                  text: 'I could not find a license the registry recognises.',
              };
    return {
        attestationTextFor: textFor,
        // The same rule as `app-license.service.ts`'s `attestationIsValid`.
        attestationIsValid: (state: {
            attestation?: any;
            licenseSpdx?: string | null;
            licenseClass?: string | null;
        }) => {
            const a = state?.attestation;
            if (!a) return false;
            return (
                (a.spdx ?? '') === (state.licenseSpdx ?? '') &&
                a.class === (state.licenseClass ?? 'unknown') &&
                a.textId === textFor(state.licenseSpdx ?? null).textId
            );
        },
    };
});
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { HttpException, NotFoundException } from '@nestjs/common';
import { WorkAppLicenseController, attestationCovers } from './work-app-license.controller';

function controllerWith(state: Record<string, unknown> | null, work: Record<string, unknown> = {}) {
    const ownership = {
        ensureCanView: jest.fn().mockResolvedValue({
            work: { id: 'w1', kind: 'app', userId: 'owner-1', ...work },
            member: null,
            role: 'OWNER',
            isCreator: true,
        }),
    };
    const appSpec = {
        getState: jest.fn().mockResolvedValue({ workId: 'w1', status: 'ok', state }),
    };
    return {
        controller: new WorkAppLicenseController(ownership as never, appSpec as never),
        ownership,
        appSpec,
    };
}

const WORK_ID = '7f3e7c1e-1b7a-4d55-9b0e-1f2c3d4e5f60';

describe('WorkAppLicenseController — GET /api/works/:id/app-license', () => {
    it('an amber licence with no attestation needs one and carries the registry text', async () => {
        const { controller } = controllerWith({
            licenseSpdx: 'BUSL-1.1',
            licenseClass: 'amber',
            licenseCommitSha: 'abc123',
            licenseMixed: false,
            licenseScanIncomplete: false,
            licenseObligations: ['attribution'],
            attestation: null,
        });
        const view = await controller.read({ userId: 'owner-1' } as never, WORK_ID);
        expect(view).toMatchObject({
            spdx: 'BUSL-1.1',
            class: 'amber',
            commitSha: 'abc123',
            attestationRequired: true,
            isOwner: true,
            obligations: ['attribution'],
        });
        expect(view.attestationText?.textId).toBe('busl-1.1-v1');
        expect(view.attestationText?.text.length).toBeGreaterThan(10);
    });

    it('a current attestation covers it; a green licence needs none and carries no text', async () => {
        const attestation = {
            userId: 'owner-1',
            attestedAt: '2026-10-17T10:00:00.000Z',
            spdx: 'BUSL-1.1',
            class: 'amber',
            textId: 'busl-1.1-v1',
            textSha256: 'x',
            commitSha: 'abc123',
        };
        const covered = controllerWith({
            licenseSpdx: 'BUSL-1.1',
            licenseClass: 'amber',
            attestation,
        });
        expect(
            (await covered.controller.read({ userId: 'owner-1' } as never, WORK_ID))
                .attestationRequired,
        ).toBe(false);

        const green = controllerWith({ licenseSpdx: 'MIT', licenseClass: 'green' });
        const view = await green.controller.read({ userId: 'member-2' } as never, WORK_ID);
        expect(view).toMatchObject({
            attestationRequired: false,
            attestationText: null,
            isOwner: false,
        });
    });

    it('an unclassified licence is treated as unknown, like the attest route', async () => {
        const { controller } = controllerWith(null);
        const view = await controller.read({ userId: 'owner-1' } as never, WORK_ID);
        expect(view).toMatchObject({ class: null, attestationRequired: true });
        expect(view.attestationText?.textId).toBe('unknown-license-v1');
    });

    it('answers one 404 for an unreachable Work and 422 for another kind', async () => {
        const hidden = controllerWith(null);
        hidden.ownership.ensureCanView.mockRejectedValueOnce(new NotFoundException());
        await expect(
            hidden.controller.read({ userId: 'x' } as never, WORK_ID),
        ).rejects.toMatchObject({
            status: 404,
        });

        const website = controllerWith(null, { kind: 'website' });
        const refusal = await website.controller
            .read({ userId: 'owner-1' } as never, WORK_ID)
            .catch((e) => e);
        expect(refusal).toBeInstanceOf(HttpException);
        expect((refusal as HttpException).getStatus()).toBe(422);
        expect(website.appSpec.getState).not.toHaveBeenCalled();
    });
});

describe('attestationCovers', () => {
    const base = {
        userId: 'u',
        attestedAt: '',
        spdx: 'BUSL-1.1',
        class: 'amber',
        textId: 't1',
        textSha256: '',
        commitSha: '',
    } as const;
    it('needs the same SPDX, class and text', () => {
        expect(attestationCovers(base as never, 'BUSL-1.1', 'amber', 't1')).toBe(true);
        expect(attestationCovers(base as never, 'BUSL-1.1', 'red', 't1')).toBe(false);
        expect(attestationCovers(base as never, 'MIT', 'amber', 't1')).toBe(false);
        expect(attestationCovers(base as never, 'BUSL-1.1', 'amber', 't2')).toBe(false);
        expect(attestationCovers(null, 'BUSL-1.1', 'amber', 't1')).toBe(false);
    });
});
