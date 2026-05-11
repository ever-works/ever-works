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
        const sanitisedUserId = sanitiseDnsLabel(userId);
        const candidate = `${base}-${sanitisedUserId}`;
        // K8s namespace names must be ≤ 63 chars (RFC 1123).
        return candidate.length > 63 ? candidate.slice(0, 63).replace(/-+$/, '') : candidate;
    }

    /**
     * Resolve the ingress host for a Work by substituting `{slug}` (and
     * `{user}` when present) in the env template.
     */
    resolveIngressHost(work: EverWorksProviderWorkRef, templateOverride?: string): string {
        const template = templateOverride ?? config.everWorks.deploy.getIngressHostTemplate();
        const userPart = (work.userSlug ?? '').trim() || work.userId.slice(0, 8);
        return template
            .replace(/\{slug\}/g, work.slug)
            .replace(/\{user\}/g, userPart)
            .replace(/\{workId\}/g, work.id);
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

        const inlineKubeconfig = env?.kubeconfig ?? config.everWorks.deploy.getKubeconfig();
        const pathKubeconfig = env?.kubeconfigPath ?? config.everWorks.deploy.getKubeconfigPath();

        let kubeconfig = inlineKubeconfig;
        if (!kubeconfig && pathKubeconfig) {
            const reader = options.readFile ?? ((path: string) => fs.readFile(path, 'utf-8'));
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

        return {
            kubeconfig,
            namespace: this.getNamespaceForUser(options.work.userId, env?.namespace),
            ingressHost: this.resolveIngressHost(options.work, env?.ingressHostTemplate),
            ingressClass: env?.ingressClass ?? config.everWorks.deploy.getIngressClass(),
            tlsIssuer: env?.tlsIssuer ?? config.everWorks.deploy.getTlsIssuer(),
            registry: (env?.registry ?? config.everWorks.deploy.getRegistry()) || undefined,
        };
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitiseDnsLabel(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
