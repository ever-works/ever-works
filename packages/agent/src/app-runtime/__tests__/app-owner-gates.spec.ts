/**
 * Works-security (2026-10-18) — the owner-only App actions' switches and the cluster credential
 * confirmation rule (`app-owner-gates.ts`).
 */

import {
    appDataDeleteOwnerOnly,
    appLicenseAttestSessionOnly,
    appTargetChangeRequiresOwner,
    clusterCredentialNeedsOwnerConfirmation,
} from '../app-owner-gates';

describe('app-owner-gates switches', () => {
    it.each([
        ['appTargetChangeRequiresOwner', appTargetChangeRequiresOwner, 'APP_TARGET_CHANGE_REQUIRES_OWNER'],
        ['appDataDeleteOwnerOnly', appDataDeleteOwnerOnly, 'APP_DATA_DELETE_OWNER_ONLY'],
        ['appLicenseAttestSessionOnly', appLicenseAttestSessionOnly, 'APP_LICENSE_ATTEST_SESSION_ONLY'],
    ] as const)('%s is ON unless exactly false', (_name, fn, env) => {
        expect(fn({})).toBe(true);
        expect(fn({ [env]: '' })).toBe(true);
        expect(fn({ [env]: 'true' })).toBe(true);
        expect(fn({ [env]: '0' })).toBe(true);
        expect(fn({ [env]: 'off' })).toBe(true);
        expect(fn({ [env]: 'false' })).toBe(false);
        expect(fn({ [env]: ' FALSE ' })).toBe(false);
    });
});

describe('clusterCredentialNeedsOwnerConfirmation', () => {
    it('never for a target that is not your-cluster', () => {
        expect(clusterCredentialNeedsOwnerConfirmation(null)).toBe(false);
        expect(
            clusterCredentialNeedsOwnerConfirmation({
                target: 'ever-works-apps',
                targetSettings: { clusterCredential: { savedByOwner: false } },
            }),
        ).toBe(false);
    });

    it('a credential a non-owner saved needs the owner until confirmed', () => {
        expect(
            clusterCredentialNeedsOwnerConfirmation({
                target: 'your-cluster',
                targetSettings: { clusterCredential: { savedByUserId: 'e', savedByOwner: false } },
                clusterFingerprint: 'fp',
            }),
        ).toBe(true);
        expect(
            clusterCredentialNeedsOwnerConfirmation({
                target: 'your-cluster',
                targetSettings: {
                    clusterCredential: {
                        savedByOwner: false,
                        ownerConfirmedAt: '2026-10-18T00:00:00.000Z',
                    },
                },
            }),
        ).toBe(false);
        expect(
            clusterCredentialNeedsOwnerConfirmation({
                target: 'your-cluster',
                targetSettings: { clusterCredential: { savedByOwner: true } },
            }),
        ).toBe(false);
    });

    it('a credential of unknown origin needs the owner only before the first deploy', () => {
        const legacy = { target: 'your-cluster', targetSettings: {}, clusterCheck: { ok: true } };
        expect(clusterCredentialNeedsOwnerConfirmation(legacy)).toBe(true);
        expect(clusterCredentialNeedsOwnerConfirmation({ ...legacy, clusterFingerprint: 'fp' })).toBe(
            false,
        );
        expect(clusterCredentialNeedsOwnerConfirmation({ ...legacy, currentDeploymentId: 'd' })).toBe(
            false,
        );
        // No check on record: nothing was stored, so there is nothing to confirm.
        expect(
            clusterCredentialNeedsOwnerConfirmation({ target: 'your-cluster', clusterCheck: null }),
        ).toBe(false);
    });
});
