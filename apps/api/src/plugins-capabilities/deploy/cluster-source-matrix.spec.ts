import {
    allowedClusterSourcesFor,
    CLUSTER_SOURCE_DESCRIPTIONS,
    CLUSTER_SOURCE_LABELS,
    ClusterSource,
    isAdminOnlyOrg,
    isEverWorksSharedOrg,
    normalizeClusterSource,
    resolveKubeconfigForClusterSource,
    validateClusterSourceForOwner,
} from './cluster-source-matrix';

describe('cluster-source-matrix — deploy matrix (renamed: k8s-works internal, k8s-works-shared shared)', () => {
    describe('isEverWorksSharedOrg', () => {
        it.each(['ever-works', 'EVER-WORKS', 'Ever-Works', '  ever-works  ', 'ever-works-cloud'])(
            'returns true for %s',
            (owner) => expect(isEverWorksSharedOrg(owner)).toBe(true),
        );
        it.each(['acme', 'octocat', 'ever-works-customer', ''])('returns false for %s', (owner) =>
            expect(isEverWorksSharedOrg(owner)).toBe(false),
        );
    });

    describe('isAdminOnlyOrg', () => {
        it('matches only the ever-works org', () => {
            expect(isAdminOnlyOrg('ever-works')).toBe(true);
            expect(isAdminOnlyOrg('EVER-WORKS')).toBe(true);
            expect(isAdminOnlyOrg('ever-works-cloud')).toBe(false);
            expect(isAdminOnlyOrg('acme')).toBe(false);
        });
    });

    describe('normalizeClusterSource — canonicalises + remaps the legacy alias', () => {
        it.each(['k8s-works', 'k8s-works-shared', 'custom-kubeconfig'] as const)(
            'passes through the current value %s',
            (value) => expect(normalizeClusterSource(value)).toBe(value),
        );
        it('remaps the legacy k8s-gauzy → k8s-works (internal cluster)', () => {
            expect(normalizeClusterSource('k8s-gauzy')).toBe('k8s-works');
        });
        it('does NOT remap k8s-works (post-rename it is unambiguously the internal cluster)', () => {
            // Guards the migration/coerce contract: a runtime `k8s-works` must
            // stay `k8s-works`, never be re-interpreted as the old shared value.
            expect(normalizeClusterSource('k8s-works')).toBe('k8s-works');
        });
        it('returns undefined for anything unrecognised', () => {
            expect(normalizeClusterSource('nonsense')).toBeUndefined();
            expect(normalizeClusterSource('')).toBeUndefined();
        });
    });

    describe('allowedClusterSourcesFor — drives the admin-aware UI dropdown', () => {
        it('admin, no Work context → [k8s-works, k8s-works-shared, custom-kubeconfig]', () => {
            expect(allowedClusterSourcesFor(true)).toEqual([
                'k8s-works',
                'k8s-works-shared',
                'custom-kubeconfig',
            ]);
        });
        it('non-admin, no Work context → [k8s-works-shared, custom-kubeconfig] (never k8s-works)', () => {
            expect(allowedClusterSourcesFor(false)).toEqual([
                'k8s-works-shared',
                'custom-kubeconfig',
            ]);
        });
        it('admin + ever-works org → [k8s-works, k8s-works-shared] (custom excluded — shared org)', () => {
            expect(allowedClusterSourcesFor(true, 'ever-works')).toEqual([
                'k8s-works',
                'k8s-works-shared',
            ]);
        });
        it('admin + ever-works-cloud → [k8s-works-shared] (k8s-works needs ever-works org; custom excluded)', () => {
            expect(allowedClusterSourcesFor(true, 'ever-works-cloud')).toEqual([
                'k8s-works-shared',
            ]);
        });
        it('admin + customer org → [k8s-works-shared, custom-kubeconfig] (k8s-works needs ever-works org)', () => {
            expect(allowedClusterSourcesFor(true, 'acme')).toEqual([
                'k8s-works-shared',
                'custom-kubeconfig',
            ]);
        });
        it('non-admin + customer org → [k8s-works-shared, custom-kubeconfig]', () => {
            expect(allowedClusterSourcesFor(false, 'acme')).toEqual([
                'k8s-works-shared',
                'custom-kubeconfig',
            ]);
        });
        it('non-admin + ever-works org → [k8s-works-shared] only (never k8s-works, custom excluded)', () => {
            expect(allowedClusterSourcesFor(false, 'ever-works')).toEqual(['k8s-works-shared']);
        });
    });

    describe('validateClusterSourceForOwner — admin-gated k8s-works + org rules', () => {
        const ok = null;
        const admin = { isPlatformAdmin: true };
        const nonAdmin = { isPlatformAdmin: false };

        // k8s-works (internal cluster) requires BOTH isPlatformAdmin AND ever-works org.
        it('ever-works + k8s-works ✓ for an admin', () => {
            expect(validateClusterSourceForOwner('ever-works', 'k8s-works', admin)).toBe(ok);
        });
        it('ever-works + k8s-works ✗ for a non-admin (K8S_WORKS_NOT_ALLOWED — not admin)', () => {
            const result = validateClusterSourceForOwner('ever-works', 'k8s-works', nonAdmin);
            expect(result?.code).toBe('K8S_WORKS_NOT_ALLOWED');
            expect(result?.message).toMatch(/restricted to platform admins/i);
        });
        it('ever-works-cloud + k8s-works ✗ even for an admin (K8S_WORKS_NOT_ALLOWED — wrong org)', () => {
            const result = validateClusterSourceForOwner('ever-works-cloud', 'k8s-works', admin);
            expect(result?.code).toBe('K8S_WORKS_NOT_ALLOWED');
            expect(result?.message).toContain('ever-works');
        });
        it('customer-owned + k8s-works ✗ even for an admin (K8S_WORKS_NOT_ALLOWED — wrong org)', () => {
            const result = validateClusterSourceForOwner('acme', 'k8s-works', admin);
            expect(result?.code).toBe('K8S_WORKS_NOT_ALLOWED');
            expect(result?.message).toContain('acme');
        });
        it('fails closed when options are omitted (defaults isPlatformAdmin=false)', () => {
            expect(validateClusterSourceForOwner('ever-works', 'k8s-works')?.code).toBe(
                'K8S_WORKS_NOT_ALLOWED',
            );
        });

        // k8s-works-shared (shared customer cluster) — always allowed, any owner/admin.
        it.each(['ever-works', 'ever-works-cloud', 'acme'])(
            '%s + k8s-works-shared ✓ (the default, no gate)',
            (owner) => {
                expect(validateClusterSourceForOwner(owner, 'k8s-works-shared', admin)).toBe(ok);
                expect(validateClusterSourceForOwner(owner, 'k8s-works-shared', nonAdmin)).toBe(ok);
            },
        );

        // custom-kubeconfig vs shared org (cross-tenant PAT) — unchanged from EW-616.
        it('ever-works + custom-kubeconfig ✗ (cross-tenant PAT exposure)', () => {
            const result = validateClusterSourceForOwner('ever-works', 'custom-kubeconfig', admin);
            expect(result?.code).toBe('CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG');
            expect(result?.message).toContain('ever-works');
        });
        it('ever-works-cloud + custom-kubeconfig ✗ (cross-tenant PAT exposure)', () => {
            const result = validateClusterSourceForOwner(
                'ever-works-cloud',
                'custom-kubeconfig',
                nonAdmin,
            );
            expect(result?.code).toBe('CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG');
        });
        it('customer-owned + custom-kubeconfig ✓ (BYOC default)', () => {
            expect(validateClusterSourceForOwner('acme', 'custom-kubeconfig', nonAdmin)).toBe(ok);
        });
        it('custom-kubeconfig + missing kubeconfig ✗ (CUSTOM_KUBECONFIG_MISSING_KUBECONFIG)', () => {
            const result = validateClusterSourceForOwner('acme', 'custom-kubeconfig', {
                hasKubeconfig: false,
            });
            expect(result?.code).toBe('CUSTOM_KUBECONFIG_MISSING_KUBECONFIG');
        });
        it('case insensitive: EVER-WORKS-CLOUD + custom-kubeconfig rejected like ever-works-cloud', () => {
            const result = validateClusterSourceForOwner('EVER-WORKS-CLOUD', 'custom-kubeconfig');
            expect(result?.code).toBe('CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG');
        });

        // Legacy alias defense-in-depth: an un-migrated k8s-gauzy normalises to
        // k8s-works and is gated the same way.
        it('legacy k8s-gauzy is gated as k8s-works (non-admin → K8S_WORKS_NOT_ALLOWED)', () => {
            const result = validateClusterSourceForOwner(
                'ever-works',
                'k8s-gauzy' as ClusterSource,
                nonAdmin,
            );
            expect(result?.code).toBe('K8S_WORKS_NOT_ALLOWED');
        });
        it('legacy k8s-gauzy + admin + ever-works ✓ (same as k8s-works)', () => {
            expect(
                validateClusterSourceForOwner('ever-works', 'k8s-gauzy' as ClusterSource, admin),
            ).toBe(ok);
        });
    });

    describe('resolveKubeconfigForClusterSource — env-var substitution', () => {
        it('k8s-works → reads EVER_WORKS_K8S_WORKS_KUBECONFIG (internal cluster)', () => {
            const env = { EVER_WORKS_K8S_WORKS_KUBECONFIG: 'internal-yaml' };
            expect(resolveKubeconfigForClusterSource('k8s-works', 'user-yaml', env)).toBe(
                'internal-yaml',
            );
        });
        it('k8s-works → throws when its env var is missing', () => {
            expect(() => resolveKubeconfigForClusterSource('k8s-works', '', {})).toThrow(
                /EVER_WORKS_K8S_WORKS_KUBECONFIG is not configured/,
            );
        });
        it('k8s-works → throws when its env var is whitespace', () => {
            expect(() =>
                resolveKubeconfigForClusterSource('k8s-works', '', {
                    EVER_WORKS_K8S_WORKS_KUBECONFIG: '   ',
                }),
            ).toThrow();
        });
        it('k8s-works-shared → reads EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG', () => {
            const env = { EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG: 'shared-yaml' };
            expect(resolveKubeconfigForClusterSource('k8s-works-shared', 'user-yaml', env)).toBe(
                'shared-yaml',
            );
        });
        it('k8s-works-shared → throws a clear "not available yet" error when unprovisioned', () => {
            expect(() => resolveKubeconfigForClusterSource('k8s-works-shared', '', {})).toThrow(
                /not available yet/i,
            );
        });
        it('legacy k8s-gauzy → normalises to k8s-works env var', () => {
            const env = { EVER_WORKS_K8S_WORKS_KUBECONFIG: 'internal-yaml' };
            expect(
                resolveKubeconfigForClusterSource('k8s-gauzy' as ClusterSource, 'user-yaml', env),
            ).toBe('internal-yaml');
        });
        it('custom-kubeconfig → passes through the user kubeconfig (env vars ignored)', () => {
            const env = {
                EVER_WORKS_K8S_WORKS_KUBECONFIG: 'internal-yaml',
                EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG: 'shared-yaml',
            };
            expect(resolveKubeconfigForClusterSource('custom-kubeconfig', 'user-yaml', env)).toBe(
                'user-yaml',
            );
        });
    });

    describe('option metadata completeness', () => {
        it('every ClusterSource has a label and a description', () => {
            const sources: ClusterSource[] = ['k8s-works', 'k8s-works-shared', 'custom-kubeconfig'];
            for (const source of sources) {
                expect(CLUSTER_SOURCE_LABELS[source]).toBeTruthy();
                expect(CLUSTER_SOURCE_DESCRIPTIONS[source]).toBeTruthy();
            }
        });
        it("only the admin-only k8s-works description mentions the 'ever-works' org requirement", () => {
            expect(CLUSTER_SOURCE_DESCRIPTIONS['k8s-works']).toMatch(/ever-works/i);
            expect(CLUSTER_SOURCE_DESCRIPTIONS['k8s-works-shared']).not.toMatch(/admin/i);
        });
    });
});
