'use server';

import { workAPI, websiteAPI, deployAPI } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { getTranslations } from 'next-intl/server';
import { checkGitProviderConnection } from './oauth';
import { revalidatePath } from 'next/cache';

export async function deploy(workId: string, teamScope?: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.deploy');
    const tWorks = await getTranslations('actions.works');

    try {
        const { work } = await workAPI.get(workId);

        // Check git provider connection
        const connectionCheck = await checkGitProviderConnection(work.gitProvider);
        if (!connectionCheck.connected) {
            return {
                success: false,
                error: tWorks('oauthRequired', { provider: work.gitProvider }),
                requiresGitProvider: true,
            };
        }

        const response = await deployAPI.deploy(workId, {
            teamScope,
        });

        revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));

        return {
            success: response.status === 'success' || response.status === 'pending',
            data: response,
            error: response.status === 'error' ? response.message : null,
        };
    } catch (error) {
        console.error('Deploy error:', error);
        return {
            success: false,
            data: null,
            error: error instanceof Error ? error.message : t('deployFailed'),
        };
    }
}

export async function updateWebsiteRepository(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.deploy');

    try {
        const response = await websiteAPI.updateRepository(workId);
        return {
            success: response.status === 'success',
            data: response,
            error: response.status === 'error' ? response.message : null,
        };
    } catch (error) {
        console.error('Update repository error:', error);
        return {
            success: false,
            data: null,
            error: error instanceof Error ? error.message : t('updateRepositoryFailed'),
        };
    }
}

export async function switchWebsiteTemplate(workId: string, websiteTemplateId: string | null) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.deploy');

    try {
        const normalizedTemplateId = websiteTemplateId?.trim() || null;
        const response = await websiteAPI.switchTemplate(workId, normalizedTemplateId);
        revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));

        return {
            success: response.status === 'success',
            data: response,
            error: response.status === 'error' ? response.message : null,
        };
    } catch (error) {
        console.error('Switch website template error:', error);
        return {
            success: false,
            data: null,
            error: error instanceof Error ? error.message : t('updateRepositoryFailed'),
        };
    }
}

export async function getDeploymentTeams(workId?: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        // If workId is provided, use the work-specific endpoint
        // which retrieves the token from plugin settings
        const response = workId
            ? await deployAPI.getTeamsForWork(workId)
            : await deployAPI.getDeploymentTeams();
        return {
            success: response.status === 'success',
            teams: response.status === 'success' ? response.teams : [],
        };
    } catch (error) {
        console.error('Get deployment teams error:', error);
        return {
            success: false,
            teams: [],
            error: error instanceof Error ? error.message : 'Failed to get deployment teams',
        };
    }
}

export async function lookupExistingDeployment(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await deployAPI.lookupExistingDeployment(workId);

        // Ensure the page revalidates when we discover a deployment
        if (response.status === 'success' && response.website) {
            revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));
        }

        return {
            success: response.status === 'success',
            website: response.website,
            deploymentState: response.deploymentState,
            found: response.found ?? false,
            error: response.status === 'error' ? response.message || undefined : null,
        };
    } catch (error) {
        console.error('Lookup existing deployment error:', error);
        return {
            success: false,
            website: undefined,
            deploymentState: undefined,
            found: false,
            error: error instanceof Error ? error.message : 'Failed to lookup deployment',
        };
    }
}

export async function getDomains(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await deployAPI.getDomains(workId);
        return {
            success: response.status === 'success',
            domains: response.domains ?? [],
        };
    } catch (error) {
        console.error('Get domains error:', error);
        return {
            success: false,
            domains: [] as { name: string; verified: boolean; verification?: any[] }[],
            error: error instanceof Error ? error.message : 'Failed to get domains',
        };
    }
}

export async function getWorkRuntimeEnv(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await deployAPI.getRuntimeEnv(workId);
        return {
            success: response.status === 'success',
            databaseUrl: response.databaseUrl ?? { configured: false, masked: null },
            managed: response.managed ?? [],
        };
    } catch (error) {
        console.error('Get runtime env error:', error);
        return {
            success: false,
            databaseUrl: { configured: false, masked: null as string | null },
            managed: [] as string[],
            error: error instanceof Error ? error.message : 'Failed to get runtime env',
        };
    }
}

export async function setWorkRuntimeEnv(workId: string, databaseUrl: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const trimmed = databaseUrl.trim();
    if (!/^postgres(ql)?:\/\/.+/i.test(trimmed)) {
        return {
            success: false,
            databaseUrl: { configured: false, masked: null as string | null },
            error: 'DATABASE_URL must be a postgres:// or postgresql:// connection string',
        };
    }

    try {
        const response = await deployAPI.setRuntimeEnv(workId, trimmed);
        revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));
        return {
            success: response.status === 'success',
            databaseUrl: response.databaseUrl ?? { configured: false, masked: null },
        };
    } catch (error) {
        console.error('Set runtime env error:', error);
        return {
            success: false,
            databaseUrl: { configured: false, masked: null as string | null },
            error: error instanceof Error ? error.message : 'Failed to set runtime env',
        };
    }
}

/**
 * EW-740 — read the per-Work managed subdomain ("Site URL / Subdomain"
 * card) state. Mirrors `getWorkRuntimeEnv` shape: always returns the
 * `subdomain` payload (filled with nulls on failure) plus an optional
 * `error` string so the UI can gate Save and avoid claiming "Not
 * configured" when the load merely failed.
 */
export async function getWorkSubdomain(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await deployAPI.getSubdomain(workId);
        return {
            success: response.status === 'success',
            subdomain: {
                subdomain: response.subdomain ?? null,
                fqdn: response.fqdn ?? null,
                url: response.url ?? null,
                recordOk: response.recordOk ?? false,
                editable: response.editable ?? false,
            },
        };
    } catch (error) {
        console.error('Get subdomain error:', error);
        return {
            success: false,
            subdomain: {
                subdomain: null as string | null,
                fqdn: null as string | null,
                url: null as string | null,
                recordOk: false,
                editable: false,
            },
            error: error instanceof Error ? error.message : 'Failed to get subdomain',
        };
    }
}

/**
 * EW-740 — set the per-Work managed subdomain. Validates the bare label
 * against the same regex the API uses (`SLUG_RE` from
 * `packages/agent/src/services/works-manifest.service.ts`) so the UI
 * surfaces the format error before round-tripping. Length bounds (3..63)
 * also mirror the API contract / RFC 1035 label rules.
 */
export async function setWorkSubdomain(workId: string, subdomain: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const trimmed = subdomain.trim().toLowerCase();
    const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
    if (trimmed.length < 3 || trimmed.length > 63 || !SUBDOMAIN_RE.test(trimmed)) {
        return {
            success: false,
            subdomain: {
                subdomain: null as string | null,
                fqdn: null as string | null,
                url: null as string | null,
                recordOk: false,
                editable: true,
            },
            error: 'Subdomain must be 3-63 characters of lowercase letters, digits, or hyphens, and cannot start or end with a hyphen.',
        };
    }

    try {
        const response = await deployAPI.setSubdomain(workId, trimmed);
        if (response.status === 'success') {
            revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));
        }
        return {
            success: response.status === 'success',
            subdomain: {
                subdomain: response.subdomain ?? null,
                fqdn: response.fqdn ?? null,
                url: response.url ?? null,
                recordOk: response.recordOk ?? false,
                editable: response.editable ?? false,
            },
        };
    } catch (error) {
        console.error('Set subdomain error:', error);
        return {
            success: false,
            subdomain: {
                subdomain: null as string | null,
                fqdn: null as string | null,
                url: null as string | null,
                recordOk: false,
                editable: true,
            },
            error: error instanceof Error ? error.message : 'Failed to set subdomain',
        };
    }
}

export async function addDomain(workId: string, domain: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    // Security: validate hostname format (RFC 1123 / RFC 5891) before forwarding to
    // the deploy plugin.  Rejects path-traversal strings, special characters, and
    // other values that could corrupt an external provider API call.
    const trimmedDomain = domain.trim();
    const hostnameRegex = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
    if (!hostnameRegex.test(trimmedDomain)) {
        return {
            success: false,
            domain: undefined,
            verified: false,
            error: 'Invalid domain name format',
        };
    }

    try {
        const response = await deployAPI.addDomain(workId, trimmedDomain);
        revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));
        return {
            success: response.status === 'success',
            domain: response.domain,
            verified: response.verified ?? false,
        };
    } catch (error) {
        console.error('Add domain error:', error);
        return {
            success: false,
            domain: undefined,
            verified: false,
            error: error instanceof Error ? error.message : 'Failed to add domain',
        };
    }
}

export async function removeDomain(workId: string, domain: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await deployAPI.removeDomain(workId, domain);
        revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));
        return {
            success: response.status === 'success',
        };
    } catch (error) {
        console.error('Remove domain error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to remove domain',
        };
    }
}

export async function verifyDomain(workId: string, domain: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await deployAPI.verifyDomain(workId, domain);
        revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));
        return {
            success: response.status === 'success',
            domain: response.domain,
        };
    } catch (error) {
        console.error('Verify domain error:', error);
        return {
            success: false,
            domain: undefined,
            error: error instanceof Error ? error.message : 'Failed to verify domain',
        };
    }
}

export async function updateWebsiteTemplateSettings(
    workId: string,
    settings: {
        websiteTemplateAutoUpdate?: boolean;
        websiteTemplateUseBeta?: boolean;
    },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.deploy');
    const tWorks = await getTranslations('actions.works');

    try {
        const { work } = await workAPI.get(workId);

        // When enabling auto-update, verify git provider connection exists
        if (settings.websiteTemplateAutoUpdate === true) {
            const connectionCheck = await checkGitProviderConnection(work.gitProvider);
            if (!connectionCheck.connected) {
                return {
                    success: false,
                    error: tWorks('oauthRequired', { provider: work.gitProvider }),
                    requiresGitProvider: true,
                };
            }
        }

        const response = await workAPI.update(workId, settings);

        revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));

        return {
            success: response.status === 'success',
            data: response.work,
            error: response.status === 'error' ? t('updateSettingsFailed') : null,
        };
    } catch (error) {
        console.error('Update website template settings error:', error);
        return {
            success: false,
            data: null,
            error: error instanceof Error ? error.message : t('updateSettingsFailed'),
        };
    }
}
