import { DatabaseType } from '@src/database';

type AppType = 'cli' | 'api';

export const config = {
    getEnvironment() {
        return process.env.NODE_ENV;
    },
    getAppType(): AppType {
        return (process.env.APP_TYPE as AppType) || 'api';
    },
    isCli() {
        return this.getAppType() === 'cli';
    },

    trigger: {
        isEnabled() {
            return process.env.TRIGGER_ENABLED === 'true';
        },
        getSecretKey() {
            return process.env.TRIGGER_SECRET_KEY;
        },
        getApiUrl() {
            return process.env.TRIGGER_API_URL || 'https://api.trigger.dev';
        },
        getMachine() {
            return process.env.TRIGGER_MACHINE || undefined;
        },
        getInternalBaseUrl() {
            return process.env.TRIGGER_INTERNAL_API_URL;
        },
        getInternalSecret() {
            return process.env.TRIGGER_INTERNAL_SECRET;
        },
        shouldUseTrigger() {
            return this.isEnabled() && Boolean(this.getInternalSecret());
        },
    },

    // Database configuration
    database: {
        getType() {
            return (process.env.DATABASE_TYPE as DatabaseType) || 'better-sqlite3';
        },
        isSqlite() {
            return Boolean(config.database.getType()?.includes('sqlite'));
        },
        getUrl() {
            return process.env.DATABASE_URL;
        },
        getHost() {
            return process.env.DATABASE_HOST;
        },
        getPort() {
            return process.env.DATABASE_PORT;
        },
        autoMigrate() {
            return process.env.DATABASE_AUTOMIGRATE !== 'false';
        },
        loggingEnabled() {
            return process.env.DATABASE_LOGGING === 'true';
        },
        sslMode() {
            return process.env.DATABASE_SSL_MODE === 'true';
        },
        databaseCaCert() {
            return process.env.DATABASE_CA_CERT;
        },
        getPath() {
            return process.env.DATABASE_PATH;
        },
        getInMemory() {
            return process.env.DATABASE_IN_MEMORY === 'true';
        },
        getUsername() {
            return process.env.DATABASE_USERNAME;
        },
        getPassword() {
            return process.env.DATABASE_PASSWORD;
        },
        getDatabaseName() {
            return process.env.DATABASE_NAME;
        },
    },

    // GitHub configuration
    github: {
        getApiKey() {
            return process.env.GH_APIKEY;
        },
        getOwner() {
            return process.env.GH_OWNER;
        },
    },

    githubApp: {
        getAppId() {
            return process.env.GITHUB_APP_ID;
        },
        getPrivateKey() {
            return process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
        },
    },

    // Git configuration
    git: {
        getName() {
            return process.env.GIT_NAME;
        },
        getEmail() {
            return process.env.GIT_EMAIL;
        },
    },

    // Sentry configuration
    sentry: {
        getDsn() {
            return process.env.SENTRY_DSN;
        },
        getProjectId() {
            return process.env.SENTRY_PROJECT_ID;
        },
    },

    // PostHog configuration
    posthog: {
        getApiKey() {
            return process.env.POSTHOG_API_KEY;
        },
        getHost() {
            return process.env.POSTHOG_HOST;
        },
    },

    subscriptions: {
        isEnabled() {
            return process.env.SUBSCRIPTIONS_ENABLED === 'true';
        },
        scheduledUpdatesEnabled() {
            return process.env.SCHEDULED_UPDATES_ENABLED !== 'false';
        },
        getDispatchIntervalMinutes() {
            return parseInt(process.env.SCHEDULED_UPDATES_DISPATCH_INTERVAL_MINUTES || '5');
        },
        getMaxBatch() {
            return parseInt(process.env.SCHEDULED_UPDATES_MAX_BATCH || '25');
        },
        getDefaultPlanCode() {
            return (process.env.SUBSCRIPTIONS_DEFAULT_PLAN as string) || 'free';
        },
        getMaxFailureBeforePause() {
            return parseInt(process.env.SCHEDULED_UPDATES_MAX_FAILURE_BEFORE_PAUSE || '3');
        },
        getScheduleStuckTimeoutMinutes() {
            return parseInt(process.env.SCHEDULE_STUCK_TIMEOUT_MINUTES || '180');
        },
        getPayPerUsePriceCents() {
            const usd = parseFloat(process.env.PAY_PER_USE_PRICE_USD || '5');
            return Math.max(0, Math.round(usd * 100));
        },
    },

    websiteTemplate: {
        autoUpdateEnabled() {
            return process.env.WEBSITE_TEMPLATE_AUTO_UPDATE_ENABLED !== 'false';
        },
        getCatalogOrganization() {
            return process.env.WEBSITE_TEMPLATE_CATALOG_ORG || 'ever-works';
        },
        getDefaultTemplateId() {
            return process.env.WEBSITE_TEMPLATE_DEFAULT_ID || 'classic';
        },
        getBetaBranch() {
            return process.env.WEBSITE_TEMPLATE_BETA_BRANCH || 'stage';
        },
        getMinimalOwner() {
            return process.env.WEBSITE_TEMPLATE_MINIMAL_OWNER || 'ever-works';
        },
        getMinimalRepo() {
            return process.env.WEBSITE_TEMPLATE_MINIMAL_REPO;
        },
        getMinimalBranch() {
            return process.env.WEBSITE_TEMPLATE_MINIMAL_BRANCH || 'main';
        },
        getMinimalBetaBranch() {
            return process.env.WEBSITE_TEMPLATE_MINIMAL_BETA_BRANCH || null;
        },
    },

    billing: {
        getDefaultCurrency() {
            return process.env.BILLING_DEFAULT_CURRENCY || 'usd';
        },
        stripe: {
            getSecretKey() {
                return process.env.STRIPE_SECRET_KEY;
            },
            getWebhookSecret() {
                return process.env.STRIPE_WEBHOOK_SECRET;
            },
        },
    },

    branding: {
        getAppName() {
            return process.env.APP_NAME || process.env.NEXT_PUBLIC_APP_NAME || 'Ever Works';
        },
        getCompanyOwner() {
            return process.env.COMPANY_OWNER || process.env.NEXT_PUBLIC_COMPANY_OWNER || 'Ever Co.';
        },
        getPlatformWebsite() {
            return (
                process.env.PLATFORM_WEBSITE ||
                process.env.NEXT_PUBLIC_COMPANY_OWNER_WEBSITE ||
                'https://ever.works'
            );
        },
    },

    // Ever Works platform-default providers used by the onboarding wizard.
    // Each is env-gated until the underlying external resource is provisioned.
    everWorks: {
        // "Ever Works Git" storage option — push customer repos to a
        // platform-owned GitHub org using a server-held PAT, so users can
        // ship without bringing their own GitHub account.
        git: {
            isEnabled() {
                return process.env.STORAGE_EVER_WORKS_GIT_ENABLED === 'true';
            },
            getOrg() {
                return process.env.EVER_WORKS_CUSTOMERS_GITHUB_ORG || 'ever-works-cloud';
            },
            getPat() {
                return process.env.EVER_WORKS_CUSTOMERS_GITHUB_PAT || '';
            },
            getVisibility(): 'private' | 'public' {
                return process.env.EVER_WORKS_CUSTOMERS_GITHUB_VISIBILITY === 'public'
                    ? 'public'
                    : 'private';
            },
        },

        // "Ever Works" deployment option — deploy to a platform-owned
        // Kubernetes cluster configured from env, with a per-user active-Works
        // cap so a single user can't exhaust the shared cluster.
        deploy: {
            isEnabled() {
                return process.env.DEPLOY_EVER_WORKS_ENABLED === 'true';
            },
            getKubeconfig() {
                return process.env.EVER_WORKS_DEPLOY_KUBECONFIG || '';
            },
            getKubeconfigPath() {
                return process.env.EVER_WORKS_DEPLOY_KUBECONFIG_PATH || '';
            },
            getNamespace() {
                return process.env.EVER_WORKS_DEPLOY_NAMESPACE || 'ever-works-tenants';
            },
            getIngressHostTemplate() {
                return process.env.EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE || '{slug}.ever.works';
            },
            getIngressClass() {
                return process.env.EVER_WORKS_DEPLOY_INGRESS_CLASS || 'nginx';
            },
            getTlsIssuer() {
                return process.env.EVER_WORKS_DEPLOY_TLS_ISSUER || 'letsencrypt-prod';
            },
            getRegistry() {
                return process.env.EVER_WORKS_DEPLOY_REGISTRY || '';
            },
            getMaxWorksPerUser() {
                const raw = parseInt(process.env.EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER || '3', 10);
                return Number.isFinite(raw) && raw > 0 ? raw : 3;
            },
        },
    },
};
