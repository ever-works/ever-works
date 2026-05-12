import { EverWorksK8sDeployProvider } from '../ever-works-k8s-deploy.provider';
import {
    EverWorksDeployDisabledError,
    EverWorksDeployMisconfiguredError,
    type EverWorksProviderWorkRef,
} from '../types';

const WORK: EverWorksProviderWorkRef = {
    id: 'b8a4f8e0-1234-4def-aaaa-bbbbbbbbbbbb',
    slug: 'my-tools',
    userId: 'user-1',
    userSlug: 'evereq',
};

describe('EverWorksK8sDeployProvider', () => {
    const ORIGINAL_ENV = { ...process.env };

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    describe('isEnabled', () => {
        it('returns false when the feature flag is off', () => {
            process.env.DEPLOY_EVER_WORKS_ENABLED = 'false';
            process.env.EVER_WORKS_DEPLOY_KUBECONFIG = 'fake';
            const p = new EverWorksK8sDeployProvider();
            expect(p.isEnabled()).toBe(false);
        });

        it('returns false when both kubeconfig and path are empty', () => {
            process.env.DEPLOY_EVER_WORKS_ENABLED = 'true';
            process.env.EVER_WORKS_DEPLOY_KUBECONFIG = '';
            process.env.EVER_WORKS_DEPLOY_KUBECONFIG_PATH = '';
            const p = new EverWorksK8sDeployProvider();
            expect(p.isEnabled()).toBe(false);
        });

        it('returns true when flag is on and inline kubeconfig is set', () => {
            process.env.DEPLOY_EVER_WORKS_ENABLED = 'true';
            process.env.EVER_WORKS_DEPLOY_KUBECONFIG = 'fake-kubeconfig';
            const p = new EverWorksK8sDeployProvider();
            expect(p.isEnabled()).toBe(true);
        });
    });

    describe('getNamespaceForUser', () => {
        it('builds a per-user namespace under the env base', () => {
            const p = new EverWorksK8sDeployProvider();
            expect(p.getNamespaceForUser('user-1', 'tenants')).toBe('tenants-user-1');
        });

        it('uses the env namespace when no override is supplied', () => {
            process.env.EVER_WORKS_DEPLOY_NAMESPACE = 'custom-base';
            const p = new EverWorksK8sDeployProvider();
            expect(p.getNamespaceForUser('user-1')).toBe('custom-base-user-1');
        });

        it('sanitises invalid characters and falls back to default base', () => {
            const p = new EverWorksK8sDeployProvider();
            expect(p.getNamespaceForUser('User_2 !weird', 'base')).toBe('base-user-2-weird');
        });

        it('truncates to 63 chars (RFC 1123 limit)', () => {
            const p = new EverWorksK8sDeployProvider();
            const long = 'a'.repeat(80);
            const ns = p.getNamespaceForUser(long, 'tenants');
            expect(ns.length).toBeLessThanOrEqual(63);
        });
    });

    describe('resolveIngressHost', () => {
        it('substitutes {slug} in the template', () => {
            const p = new EverWorksK8sDeployProvider();
            expect(p.resolveIngressHost(WORK, '{slug}.ever.works')).toBe('my-tools.ever.works');
        });

        it('substitutes {user} in the template', () => {
            const p = new EverWorksK8sDeployProvider();
            expect(p.resolveIngressHost(WORK, '{user}-{slug}.example.com')).toBe(
                'evereq-my-tools.example.com',
            );
        });

        it('uses the env template by default', () => {
            process.env.EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE = '{slug}.test.dev';
            const p = new EverWorksK8sDeployProvider();
            expect(p.resolveIngressHost(WORK)).toBe('my-tools.test.dev');
        });
    });

    describe('buildConfig', () => {
        it('throws EverWorksDeployDisabledError when the feature flag is off', async () => {
            const p = new EverWorksK8sDeployProvider();
            await expect(
                p.buildConfig({ work: WORK, envOverrides: { isEnabled: false } }),
            ).rejects.toBeInstanceOf(EverWorksDeployDisabledError);
        });

        it('returns a fully-resolved config when inline kubeconfig is set', async () => {
            const p = new EverWorksK8sDeployProvider();
            const cfg = await p.buildConfig({
                work: WORK,
                envOverrides: {
                    isEnabled: true,
                    kubeconfig: 'apiVersion: v1\nkind: Config',
                    namespace: 'tenants',
                    ingressHostTemplate: '{slug}.ever.works',
                    ingressClass: 'nginx',
                    tlsIssuer: 'letsencrypt-prod',
                    registry: 'ghcr.io/ever-works',
                },
            });

            expect(cfg).toEqual({
                kubeconfig: 'apiVersion: v1\nkind: Config',
                namespace: 'tenants-user-1',
                ingressHost: 'my-tools.ever.works',
                ingressClass: 'nginx',
                tlsIssuer: 'letsencrypt-prod',
                registry: 'ghcr.io/ever-works',
            });
        });

        it('reads kubeconfig from disk when only a path is provided', async () => {
            const p = new EverWorksK8sDeployProvider();
            const readFile = jest.fn().mockResolvedValue('disk-kubeconfig');
            const cfg = await p.buildConfig({
                work: WORK,
                envOverrides: {
                    isEnabled: true,
                    kubeconfigPath: '/var/secrets/kubeconfig',
                    namespace: 'tenants',
                    ingressHostTemplate: '{slug}.ever.works',
                    ingressClass: 'nginx',
                    tlsIssuer: 'letsencrypt-prod',
                },
                readFile,
            });
            expect(readFile).toHaveBeenCalledWith('/var/secrets/kubeconfig');
            expect(cfg.kubeconfig).toBe('disk-kubeconfig');
        });

        it('throws EverWorksDeployMisconfiguredError when neither kubeconfig nor path is set', async () => {
            const p = new EverWorksK8sDeployProvider();
            await expect(
                p.buildConfig({
                    work: WORK,
                    envOverrides: {
                        isEnabled: true,
                        kubeconfig: '',
                        kubeconfigPath: '',
                    },
                }),
            ).rejects.toBeInstanceOf(EverWorksDeployMisconfiguredError);
        });

        it('throws EverWorksDeployMisconfiguredError when reading the path fails', async () => {
            const p = new EverWorksK8sDeployProvider();
            const readFile = jest.fn().mockRejectedValue(new Error('ENOENT'));
            await expect(
                p.buildConfig({
                    work: WORK,
                    envOverrides: {
                        isEnabled: true,
                        kubeconfigPath: '/missing',
                    },
                    readFile,
                }),
            ).rejects.toBeInstanceOf(EverWorksDeployMisconfiguredError);
        });
    });
});
