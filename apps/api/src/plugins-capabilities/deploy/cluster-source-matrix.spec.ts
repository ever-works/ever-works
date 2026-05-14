import {
    allowedClusterSourcesFor,
    isAdminOnlyOrg,
    isEverWorksSharedOrg,
    resolveKubeconfigForClusterSource,
    validateClusterSourceForOwner,
} from './cluster-source-matrix';

describe('cluster-source-matrix — EW-616 deploy matrix', () => {
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
        it('matches only the legacy ever-works org', () => {
            expect(isAdminOnlyOrg('ever-works')).toBe(true);
            expect(isAdminOnlyOrg('EVER-WORKS')).toBe(true);
            expect(isAdminOnlyOrg('ever-works-cloud')).toBe(false);
            expect(isAdminOnlyOrg('acme')).toBe(false);
        });
    });

    describe('allowedClusterSourcesFor — drives the UI dropdown', () => {
        it('ever-works org → [k8s-works, k8s-gauzy] (admin path)', () => {
            expect(allowedClusterSourcesFor('ever-works')).toEqual(['k8s-works', 'k8s-gauzy']);
        });

        it('ever-works-cloud org → [k8s-works] only', () => {
            expect(allowedClusterSourcesFor('ever-works-cloud')).toEqual(['k8s-works']);
        });

        it('customer-owned org → [custom-kubeconfig, k8s-works]', () => {
            expect(allowedClusterSourcesFor('acme')).toEqual(['custom-kubeconfig', 'k8s-works']);
        });
    });

    describe('validateClusterSourceForOwner — the 9 matrix cells', () => {
        const ok = null;

        // Row 1: ever-works (admin path) — k8s-works ✓, k8s-gauzy ✓, custom ✗
        it('ever-works + k8s-works ✓', () => {
            expect(validateClusterSourceForOwner('ever-works', 'k8s-works')).toBe(ok);
        });
        it('ever-works + k8s-gauzy ✓ (admin path)', () => {
            expect(validateClusterSourceForOwner('ever-works', 'k8s-gauzy')).toBe(ok);
        });
        it('ever-works + custom-kubeconfig ✗ (cell C — cross-tenant PAT exposure)', () => {
            const result = validateClusterSourceForOwner('ever-works', 'custom-kubeconfig');
            expect(result?.code).toBe('CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG');
            expect(result?.message).toContain('ever-works');
        });

        // Row 2: ever-works-cloud (shared customer org) — only k8s-works
        it('ever-works-cloud + k8s-works ✓ (the default for new customers)', () => {
            expect(validateClusterSourceForOwner('ever-works-cloud', 'k8s-works')).toBe(ok);
        });
        it('ever-works-cloud + k8s-gauzy ✗ (admin-only cluster)', () => {
            const result = validateClusterSourceForOwner('ever-works-cloud', 'k8s-gauzy');
            expect(result?.code).toBe('K8S_GAUZY_NOT_ALLOWED');
        });
        it('ever-works-cloud + custom-kubeconfig ✗ (cell C)', () => {
            const result = validateClusterSourceForOwner('ever-works-cloud', 'custom-kubeconfig');
            expect(result?.code).toBe('CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG');
        });

        // Row 3: customer-owned org — k8s-works ✓, k8s-gauzy ✗, custom ✓
        it('customer-owned + k8s-works ✓ (customer image on platform cluster)', () => {
            expect(validateClusterSourceForOwner('acme', 'k8s-works')).toBe(ok);
        });
        it('customer-owned + k8s-gauzy ✗ (admin-only cluster)', () => {
            const result = validateClusterSourceForOwner('acme', 'k8s-gauzy');
            expect(result?.code).toBe('K8S_GAUZY_NOT_ALLOWED');
            expect(result?.message).toContain('acme');
        });
        it('customer-owned + custom-kubeconfig ✓ (the BYOC default)', () => {
            expect(validateClusterSourceForOwner('acme', 'custom-kubeconfig')).toBe(ok);
        });

        it('custom-kubeconfig + missing kubeconfig ✗ (operator error)', () => {
            const result = validateClusterSourceForOwner('acme', 'custom-kubeconfig', {
                hasKubeconfig: false,
            });
            expect(result?.code).toBe('CUSTOM_KUBECONFIG_MISSING_KUBECONFIG');
        });

        it('case insensitive: EVER-WORKS-CLOUD + custom-kubeconfig is rejected like ever-works-cloud', () => {
            const result = validateClusterSourceForOwner('EVER-WORKS-CLOUD', 'custom-kubeconfig');
            expect(result?.code).toBe('CUSTOM_KUBECONFIG_NOT_ALLOWED_FOR_SHARED_ORG');
        });
    });

    describe('resolveKubeconfigForClusterSource — env-var substitution', () => {
        it('k8s-works → reads EVER_WORKS_K8S_WORKS_KUBECONFIG', () => {
            const env = { EVER_WORKS_K8S_WORKS_KUBECONFIG: 'apiVersion: v1\nkind: Config\n' };
            expect(resolveKubeconfigForClusterSource('k8s-works', 'user-kubeconfig', env)).toBe(
                'apiVersion: v1\nkind: Config\n',
            );
        });

        it('k8s-works → throws when env var is missing', () => {
            expect(() => resolveKubeconfigForClusterSource('k8s-works', '', {})).toThrow(
                /EVER_WORKS_K8S_WORKS_KUBECONFIG is not configured/,
            );
        });

        it('k8s-works → throws when env var is empty/whitespace', () => {
            expect(() =>
                resolveKubeconfigForClusterSource('k8s-works', '', {
                    EVER_WORKS_K8S_WORKS_KUBECONFIG: '   ',
                }),
            ).toThrow();
        });

        it('k8s-gauzy → reads EVER_WORKS_K8S_GAUZY_KUBECONFIG', () => {
            const env = { EVER_WORKS_K8S_GAUZY_KUBECONFIG: 'gauzy-kubeconfig' };
            expect(resolveKubeconfigForClusterSource('k8s-gauzy', 'user-kubeconfig', env)).toBe(
                'gauzy-kubeconfig',
            );
        });

        it('k8s-gauzy → throws when env var is missing', () => {
            expect(() => resolveKubeconfigForClusterSource('k8s-gauzy', '', {})).toThrow(
                /EVER_WORKS_K8S_GAUZY_KUBECONFIG is not configured/,
            );
        });

        it('custom-kubeconfig → passes through the user kubeconfig (env vars ignored)', () => {
            const env = {
                EVER_WORKS_K8S_WORKS_KUBECONFIG: 'platform-yaml',
                EVER_WORKS_K8S_GAUZY_KUBECONFIG: 'gauzy-yaml',
            };
            expect(resolveKubeconfigForClusterSource('custom-kubeconfig', 'user-yaml', env)).toBe(
                'user-yaml',
            );
        });
    });
});
