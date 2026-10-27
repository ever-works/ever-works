// The facades barrel loads most of the agent package; the service needs the class as a token only.
jest.mock('@ever-works/agent/facades', () => ({ GitFacadeService: class GitFacadeService {} }));

import {
    AppsCatalogManifestService,
    CLOSED_MANAGED_TIER,
    managedHostingAvailability,
    toListingItem,
} from './apps-catalog-manifest.service';

/**
 * APW-03 T23 / APW-10 T31 (lane aw-blueprints) — the catalog states managed-hosting
 * availability as `available` or the FIRST failing reason (FR-35, ACC-03-21/47/48), and
 * the tier part is the managed tier as `APPS_TIER_POLICY` reports it on every answer:
 *
 *   licenseNotGreen → upstreamAgreementMissing → entryDisallows → blueprintNotVerified →
 *   managedTierDisabled
 *
 * The availability function is pure: the tier is passed in, and the answer does not move
 * when `EVER_WORKS_APPS_MANAGED_ENABLED` does (R-5).
 */

function row(overrides: Record<string, unknown> = {}) {
    return {
        slug: 'umami',
        name: 'Umami',
        kind: 'app',
        status: 'beta',
        appSource: { repo: 'umami-software/umami', defaultBranch: 'master' },
        template: { repo: 'ever-works/umami-template', ref: 'v0.1.0' },
        blueprint: { id: 'umami', version: '0.1.0', verified: true },
        license: { spdx: 'MIT', class: 'green' },
        managedHosting: { allowed: true },
        ...overrides,
    };
}

const OPEN_ANY = { open: true, scope: 'any' as const };
const OPEN_VERIFIED = { open: true, scope: 'verified-blueprints' as const };

function item(overrides: Record<string, unknown> = {}) {
    const listed = toListingItem(row(overrides));
    if (!listed) throw new Error('row was not listed');
    return listed;
}

describe('APW-03 T23 — the row reasons (licence, agreement, entry)', () => {
    it('a green row that allows managed hosting is available to an open tier', () => {
        expect(item().managed).toBe('available');
        expect(managedHostingAvailability(item(), OPEN_ANY)).toBe('available');
    });

    it('an unknown licence is licenseNotGreen, first, whatever the tier', () => {
        const unknown = item({ license: { spdx: 'Custom', class: 'unknown' } });
        expect(managedHostingAvailability(unknown, OPEN_ANY)).toBe('licenseNotGreen');
        expect(managedHostingAvailability(unknown, CLOSED_MANAGED_TIER)).toBe('licenseNotGreen');
    });

    it('amber needs a recorded upstream agreement (R-3)', () => {
        expect(
            managedHostingAvailability(
                item({ license: { spdx: 'AGPL-3.0-only', class: 'amber' } }),
                OPEN_ANY,
            ),
        ).toBe('upstreamAgreementMissing');
        expect(
            managedHostingAvailability(
                item({
                    license: { spdx: 'AGPL-3.0-only', class: 'amber' },
                    managedHosting: {
                        allowed: true,
                        upstreamAgreement: { recordedAt: '2026-09-01' },
                    },
                }),
                OPEN_ANY,
            ),
        ).toBe('available');
    });

    it('an entry that does not allow managed hosting is entryDisallows', () => {
        expect(
            managedHostingAvailability(item({ managedHosting: { allowed: false } }), OPEN_ANY),
        ).toBe('entryDisallows');
    });

    it('a red row is never listed at all', () => {
        expect(toListingItem(row({ license: { spdx: 'SSPL-1.0', class: 'red' } }))).toBeNull();
    });
});

describe('APW-10 T31 — the tier reasons', () => {
    it('a tier for verified Blueprints only refuses an unverified one (blueprintNotVerified)', () => {
        const unverified = item({ blueprint: { id: 'umami', version: '0.1.0', verified: false } });
        expect(managedHostingAvailability(unverified, OPEN_VERIFIED)).toBe('blueprintNotVerified');
        expect(managedHostingAvailability(unverified, OPEN_ANY)).toBe('available');
    });

    it('a closed tier is managedTierDisabled for an entry that allows managed hosting', () => {
        expect(managedHostingAvailability(item(), { open: false, scope: 'any' })).toBe(
            'managedTierDisabled',
        );
        // Unbound policy ⇒ closed, verified Blueprints only (R-5).
        expect(CLOSED_MANAGED_TIER).toEqual({ open: false, scope: 'verified-blueprints' });
        expect(managedHostingAvailability(item(), CLOSED_MANAGED_TIER)).toBe('managedTierDisabled');
    });

    it('is pure: the environment flag does not move the answer', () => {
        const saved = process.env.EVER_WORKS_APPS_MANAGED_ENABLED;
        try {
            const answers = ['true', 'false'].map((value) => {
                process.env.EVER_WORKS_APPS_MANAGED_ENABLED = value;
                return [
                    managedHostingAvailability(item(), OPEN_ANY),
                    managedHostingAvailability(item(), CLOSED_MANAGED_TIER),
                ];
            });
            expect(answers[0]).toEqual(answers[1]);
        } finally {
            if (saved === undefined) delete process.env.EVER_WORKS_APPS_MANAGED_ENABLED;
            else process.env.EVER_WORKS_APPS_MANAGED_ENABLED = saved;
        }
    });
});

describe('APW-10 T31 — the service reads the tier through APPS_TIER_POLICY on every answer', () => {
    const saved = {
        catalog: process.env.EVER_WORKS_APPS_CATALOG_TOKEN,
        github: process.env.GITHUB_TOKEN,
    };
    beforeEach(() => {
        delete process.env.EVER_WORKS_APPS_CATALOG_TOKEN;
        delete process.env.GITHUB_TOKEN;
    });
    afterAll(() => {
        if (saved.catalog !== undefined) process.env.EVER_WORKS_APPS_CATALOG_TOKEN = saved.catalog;
        if (saved.github !== undefined) process.env.GITHUB_TOKEN = saved.github;
    });

    function service(policy?: {
        isOpen: () => boolean;
        managedScope: () => 'any' | 'verified-blueprints';
    }) {
        const instance = new AppsCatalogManifestService({} as never, policy as never);
        instance.fetchImpl = async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ schemaVersion: 1, templates: [row()] }),
        });
        return instance;
    }

    it('answers available with the tier it judged, when the tier is open', async () => {
        const answer = await service({ isOpen: () => true, managedScope: () => 'any' }).list();
        expect(answer.managedTier).toEqual({ open: true, scope: 'any' });
        expect(answer.items[0].managed).toBe('available');
    });

    it('answers managedTierDisabled while the policy is unbound or closed, from the same cache', async () => {
        const policy = { open: true };
        const instance = service({ isOpen: () => policy.open, managedScope: () => 'any' });
        expect((await instance.list()).items[0].managed).toBe('available');
        policy.open = false;
        // The tier is read per answer, not cached with the manifest.
        expect((await instance.list()).items[0].managed).toBe('managedTierDisabled');
        expect((await instance.get('umami'))?.managed).toBe('managedTierDisabled');

        const unbound = await service().list();
        expect(unbound.managedTier).toEqual(CLOSED_MANAGED_TIER);
        expect(unbound.items[0].managed).toBe('managedTierDisabled');
    });

    it('reads a policy that throws as closed, never as open', async () => {
        const answer = await service({
            isOpen: () => {
                throw new Error('kubeconfig unreadable');
            },
            managedScope: () => 'any',
        }).list();
        expect(answer.managedTier).toEqual(CLOSED_MANAGED_TIER);
        expect(answer.items[0].managed).toBe('managedTierDisabled');
    });
});
