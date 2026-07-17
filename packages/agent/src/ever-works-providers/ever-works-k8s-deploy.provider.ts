import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import { config } from '../config';
import {
    EverWorksDeployDisabledError,
    EverWorksDeployMisconfiguredError,
    type EverWorksDeployConfig,
    type EverWorksProviderWorkRef,
} from './types';

/** File-read shape used to load a kubeconfig from disk. Overridable in tests. */
export type EverWorksKubeconfigReader = (path: string) => Promise<string>;

interface BuildConfigOptions {
    readonly work: EverWorksProviderWorkRef;
    /** Override env for tests. */
    readonly envOverrides?: Partial<{
        readonly kubeconfig: string;
        readonly kubeconfigPath: string;
        readonly namespace: string;
        readonly ingressHostTemplate: string;
        readonly ingressClass: string;
        readonly tlsIssuer: string;
        readonly registry: string;
        readonly isEnabled: boolean;
    }>;
    /** Override fs.readFile for tests. */
    readonly readFile?: EverWorksKubeconfigReader;
}

/**
 * Builds the per-Work k8s deploy configuration from platform env vars and
 * the user-isolated namespace name. The actual deploy still flows through
 * the existing `k8s` plugin primitives; this provider just produces the
 * config object the plugin expects.
 *
 * The platform PAT / kubeconfig never leaves this service — `buildConfig()`
 * returns an object the caller can pass into the k8s plugin, but the
 * kubeconfig itself is read from env (or its `_PATH` sibling) at call time.
 */
@Injectable()
export class EverWorksK8sDeployProvider {
    /** True when the feature flag is on AND a kubeconfig source is configured. */
    isEnabled(): boolean {
        if (!config.everWorks.deploy.isEnabled()) return false;
        return (
            config.everWorks.deploy.getKubeconfig().length > 0 ||
            config.everWorks.deploy.getKubeconfigPath().length > 0
        );
    }

    /**
     * Per-user namespace name. Each user's Works are isolated in a
     * `{base}-{userId}` namespace so quota enforcement and resource limits
     * can be applied per-user.
     */
    getNamespaceForUser(userId: string, override?: string): string {
        const base = override ?? config.everWorks.deploy.getNamespace();
        return buildEverWorksTenantNamespace(userId, base);
    }

    /**
     * Resolve the ingress host for a Work by substituting `{slug}` (and
     * `{user}` when present) in the env template.
     */
    resolveIngressHost(work: EverWorksProviderWorkRef, templateOverride?: string): string {
        const template = templateOverride ?? config.everWorks.deploy.getIngressHostTemplate();
        // Security: DNS-label-sanitise every user-controlled substitution before it
        // lands in the ingress host. `work.slug`/`work.userSlug` are user-controlled
        // (create-Work API); a value like `foo.bar` or `../admin` would otherwise
        // inject extra subdomain levels or a malformed host into the Ingress spec.
        // Mirrors CloudflareDnsProvider.assertSlug()'s DNS-label expectation while
        // reusing the same normaliser used for the namespace name.
        const slugPart = sanitiseDnsLabel(work.slug);
        const userPart =
            sanitiseDnsLabel((work.userSlug ?? '').trim()) ||
            sanitiseDnsLabel(work.userId.slice(0, 8));
        const workIdPart = sanitiseDnsLabel(work.id);
        return template
            .replace(/\{slug\}/g, slugPart)
            .replace(/\{user\}/g, userPart)
            .replace(/\{workId\}/g, workIdPart);
    }

    /**
     * Build the deploy config object to hand off to the existing k8s plugin.
     * Throws `EverWorksDeployDisabledError` when the feature flag is off, or
     * `EverWorksDeployMisconfiguredError` when env is incomplete / unreadable.
     */
    async buildConfig(options: BuildConfigOptions): Promise<EverWorksDeployConfig> {
        const env = options.envOverrides;
        const enabled = env?.isEnabled ?? config.everWorks.deploy.isEnabled();
        if (!enabled) {
            throw new EverWorksDeployDisabledError();
        }

        const kubeconfig = await this.resolveKubeconfig({
            kubeconfig: env?.kubeconfig,
            kubeconfigPath: env?.kubeconfigPath,
            readFile: options.readFile,
        });

        return {
            kubeconfig,
            namespace: this.getNamespaceForUser(options.work.userId, env?.namespace),
            ingressHost: this.resolveIngressHost(options.work, env?.ingressHostTemplate),
            ingressClass: env?.ingressClass ?? config.everWorks.deploy.getIngressClass(),
            tlsIssuer: env?.tlsIssuer ?? config.everWorks.deploy.getTlsIssuer(),
            registry: (env?.registry ?? config.everWorks.deploy.getRegistry()) || undefined,
        };
    }

    /**
     * Resolve just the platform-held kubeconfig for the dedicated Ever Works
     * deploy cluster (Path A). Reads `EVER_WORKS_DEPLOY_KUBECONFIG` inline, or
     * `EVER_WORKS_DEPLOY_KUBECONFIG_PATH` from disk, matching `buildConfig`.
     * Throws `EverWorksDeployMisconfiguredError` when neither is set or the
     * file read fails. Exposed so the deploy facade can source the `K8S_TOKEN`
     * for a `deployProvider === 'ever-works'` deploy without also templating
     * an ingress host it doesn't need at credential-resolution time.
     */
    async resolveKubeconfig(source?: {
        readonly kubeconfig?: string;
        readonly kubeconfigPath?: string;
        readonly readFile?: EverWorksKubeconfigReader;
    }): Promise<string> {
        const inlineKubeconfig = source?.kubeconfig ?? config.everWorks.deploy.getKubeconfig();
        const pathKubeconfig =
            source?.kubeconfigPath ?? config.everWorks.deploy.getKubeconfigPath();

        let kubeconfig = inlineKubeconfig;
        if (!kubeconfig && pathKubeconfig) {
            const reader = source?.readFile ?? ((path: string) => fs.readFile(path, 'utf-8'));
            try {
                kubeconfig = await reader(pathKubeconfig);
            } catch (cause) {
                throw new EverWorksDeployMisconfiguredError(
                    `failed to read kubeconfig from ${pathKubeconfig}: ${(cause as Error).message}`,
                );
            }
        }

        if (!kubeconfig) {
            throw new EverWorksDeployMisconfiguredError(
                'neither EVER_WORKS_DEPLOY_KUBECONFIG nor EVER_WORKS_DEPLOY_KUBECONFIG_PATH is set',
            );
        }

        return kubeconfig;
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Deterministic per-tenant Kubernetes namespace for a user: `{base}-{userId}`,
 * DNS-label-sanitised and capped at the RFC-1123 63-char limit.
 *
 * Exported as the single source of truth for the per-tenant namespace scheme
 * so the authoritative server-side enforcement in the API deploy service
 * (`DeployService.resolveDeployNamespace`) and this provider's
 * `getNamespaceForUser` can never drift apart.
 */
export function buildEverWorksTenantNamespace(userId: string, base: string): string {
    const sanitisedUserId = sanitiseDnsLabel(userId);
    const candidate = `${base}-${sanitisedUserId}`;
    // K8s namespace names must be ≤ 63 chars (RFC 1123).
    return candidate.length > 63 ? candidate.slice(0, 63).replace(/-+$/, '') : candidate;
}

function sanitiseDnsLabel(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
