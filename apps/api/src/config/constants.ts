export const authConstants = {
    bcryptSaltRounds: 10,
    refreshTokenLength: 32,
    refreshTokenCleanupDays: 30,
};

export enum AuthProvider {
    LOCAL = 'local',
    GITHUB = 'github',
    GOOGLE = 'google',
    FACEBOOK = 'facebook',
    LINKEDIN = 'linkedin',
}

export const config = {
    debug: () => process.env.HTTP_DEBUG === 'true',

    // L-02: WEB_URL must be set in production. Falling back to
    // `http://localhost:3000` in prod silently breaks every email link,
    // every OAuth callback URL builder, every CORS allow-list. Surface
    // the misconfiguration at boot instead of in a customer-facing flow.
    webAppUrl: () => {
        const value = process.env.WEB_URL;
        if (value) return value;
        if (process.env.NODE_ENV === 'production') {
            throw new Error(
                'WEB_URL environment variable is required in production. ' +
                    'Set it to the public origin of the web app, e.g. https://app.ever.works.',
            );
        }
        return 'http://localhost:3000';
    },

    auth: {
        // H-14 (companion to apps/web/src/lib/auth/crypto.ts): the web tier
        // refuses to seal the auth cookie when AUTH_SECRET is shorter than
        // 32 characters, because the previous "pad short secrets with a
        // constant" path produced a predictable key. The API consumes the
        // same env var for JWT signing, so anchor both tiers on the same
        // minimum here and surface the misconfiguration at first call —
        // which `main.ts` triggers eagerly at boot — instead of mid-flow
        // during an OAuth callback (see 2026-05-18 incident).
        secret: () => {
            const secret = process.env.AUTH_SECRET;
            if (!secret) {
                throw new Error('AUTH_SECRET environment variable is required');
            }
            if (secret.length < 32) {
                throw new Error(
                    'AUTH_SECRET must be at least 32 characters of high-entropy material ' +
                        '(e.g. `openssl rand -base64 48`). The web tier refuses to seal cookies ' +
                        'with a shorter secret, so logins silently break in the OAuth callback.',
                );
            }
            return secret;
        },
    },

    // #21: PLATFORM_ENCRYPTION_KEY is the master key used to encrypt
    // operator-supplied secrets at rest (plugin/integration credentials).
    // A missing key in a real deployment means either secrets are stored
    // in plaintext or every encrypt/decrypt call fails deep inside a
    // request — both surface late and opaquely. Fail fast at boot
    // (main.ts calls this right after auth.secret()) so the
    // misconfiguration is visible immediately. Local development/test
    // runs (where NODE_ENV is 'development', 'test', or simply unset)
    // are exempt so contributors don't need to provision a key to boot,
    // mirroring the local-friendly fallbacks elsewhere in this config.
    platformEncryptionKey: () => {
        const key = process.env.PLATFORM_ENCRYPTION_KEY;
        const nodeEnv = process.env.NODE_ENV;
        const isLocal =
            nodeEnv === 'development' ||
            nodeEnv === 'test' ||
            nodeEnv === undefined ||
            nodeEnv === '';
        if (!key && !isLocal) {
            throw new Error(
                'PLATFORM_ENCRYPTION_KEY environment variable is required in non-local environments. ' +
                    'It is the master key used to encrypt operator-supplied secrets at rest; ' +
                    'set it (e.g. `openssl rand -base64 48`) and re-deploy.',
            );
        }
        return key;
    },

    branding: {
        appName: () => process.env.APP_NAME || process.env.NEXT_PUBLIC_APP_NAME || 'Ever Works',
        companyOwner: () =>
            process.env.COMPANY_OWNER || process.env.NEXT_PUBLIC_COMPANY_OWNER || 'Ever Co.',
        platformWebsite: () =>
            process.env.PLATFORM_WEBSITE ||
            process.env.NEXT_PUBLIC_COMPANY_OWNER_WEBSITE ||
            'https://ever.works',
        appDescription: () =>
            process.env.APP_DESCRIPTION ||
            process.env.NEXT_PUBLIC_SITE_DESCRIPTION ||
            'A SaaS platform for building and managing works',
    },

    mail: {
        provider: (): 'smtp' | 'resend' | 'faker' => {
            const provider = process.env.MAILER_PROVIDER;
            if (!provider || provider === 'none') return 'faker';
            if (provider === 'resend') return 'resend';
            return 'smtp';
        },
        from: () => {
            const appName = config.branding.appName();
            const emailFrom = process.env.EMAIL_FROM;
            if (emailFrom) {
                return emailFrom;
            }
            // Extract email from EMAIL_FROM or use default
            const defaultEmail = process.env.EMAIL_FROM_EMAIL || 'ever@ever.works';
            return `${appName} <${defaultEmail}>`;
        },
        smtpHost: () => process.env.SMTP_HOST || '127.0.0.1',
        smtpPort: () => parseInt(process.env.SMTP_PORT || '587'),
        smtpUser: () => process.env.SMTP_USER,
        smtpPassword: () => process.env.SMTP_PASSWORD,
        smtpSecure: () => process.env.SMTP_SECURE === 'true',
        smtpIgnoreTLS: () => process.env.SMTP_IGNORE_TLS === 'true',
        // #31: verify the SMTP relay's TLS certificate by default so outbound
        // mail (password-reset, magic-link, account-deletion tokens) can't be
        // intercepted via a MITM presenting an invalid cert. Verification stays
        // ON unless an operator explicitly opts out with
        // `SMTP_REJECT_UNAUTHORIZED=false` (e.g. a local MailHog/Mailpit relay
        // with a self-signed cert). Centralised here so mail.module.ts reads it
        // through the config surface instead of touching process.env inline.
        smtpRejectUnauthorized: () => process.env.SMTP_REJECT_UNAUTHORIZED !== 'false',
        resend: {
            apiKey: () => process.env.RESEND_APIKEY,
            emailFrom: () => {
                return process.env.RESEND_EMAIL_FROM || config.mail.from();
            },
        },
    },

    google: {
        clientId: () => process.env.GOOGLE_CLIENT_ID,
        clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
        callbackUrl: () => {
            const webUrl = config.webAppUrl();
            return process.env.GOOGLE_CALLBACK_URL || `${webUrl}/api/oauth/google/callback`;
        },
        connectCallbackUrl: () => {
            const webUrl = config.webAppUrl();
            return process.env.GOOGLE_CALLBACK_URL || `${webUrl}/api/oauth/google/callback`;
        },
    },
    github: {
        clientId: () => process.env.GH_CLIENT_ID,
        clientSecret: () => process.env.GH_CLIENT_SECRET,
        callbackUrl: () => {
            const webUrl = config.webAppUrl();
            return process.env.GH_CALLBACK_URL || `${webUrl}/api/oauth/github/callback`;
        },
    },
    githubApp: {
        appId: () => process.env.GITHUB_APP_ID,
        clientId: () => process.env.GITHUB_APP_CLIENT_ID,
        clientSecret: () => process.env.GITHUB_APP_CLIENT_SECRET,
        privateKey: () => process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        webhookSecret: () => process.env.GITHUB_APP_WEBHOOK_SECRET,
        slug: () => process.env.GITHUB_APP_SLUG || 'ever-works',
        setupUrl: () => {
            const webUrl = config.webAppUrl();
            return process.env.GITHUB_APP_SETUP_URL || `${webUrl}/api/github-app/setup`;
        },
        callbackUrl: () => {
            const webUrl = config.webAppUrl();
            return process.env.GITHUB_APP_CALLBACK_URL || `${webUrl}/api/github-app/callback`;
        },
    },
    facebook: {
        clientId: () => process.env.FACEBOOK_CLIENT_ID,
        clientSecret: () => process.env.FACEBOOK_CLIENT_SECRET,
        callbackUrl: () => {
            const webUrl = config.webAppUrl();
            return process.env.FACEBOOK_CALLBACK_URL || `${webUrl}/api/oauth/facebook/callback`;
        },
    },
    linkedin: {
        clientId: () => process.env.LINKEDIN_CLIENT_ID,
        clientSecret: () => process.env.LINKEDIN_CLIENT_SECRET,
        callbackUrl: () => {
            const webUrl = config.webAppUrl();
            return process.env.LINKEDIN_CALLBACK_URL || `${webUrl}/api/oauth/linkedin/callback`;
        },
    },

    work: {
        staleTimeoutHours: () => parseInt(process.env.WORK_STALE_TIMEOUT_HOURS || '2', 10),
    },

    features: {
        /**
         * Master switch for the agent zero-friction onboarding endpoint
         * (`POST /api/register-work`) and the matching MCP tool. Default
         * `true` once the feature reaches Phase 8 of its rollout; gate
         * remains here so an operator can disable the public surface
         * quickly via env var without redeploy.
         */
        zeroFrictionOnboarding: () =>
            (process.env.FEATURE_ZERO_FRICTION_ONBOARDING ?? 'true').toLowerCase() !== 'false',

        /**
         * EW-693 — opt-in switch for the dynamic plugin distribution
         * feature surface (catalog endpoint, install/uninstall API,
         * admin allowlist). Independent of `config.plugins.distributionMode`
         * so an operator can pre-deploy the runtime in `bundled` mode
         * and flip this on later. Default `false`; in `bundled` mode
         * the new surfaces simply 501 / return empty until enabled.
         */
        dynamicPlugins: () =>
            (process.env.FEATURE_DYNAMIC_PLUGINS ?? 'false').toLowerCase() === 'true',
    },

    /**
     * EW-693 — Dynamic plugin distribution. The default mode is
     * `bundled` everywhere (SaaS and self-host alike). Switching to
     * `dynamic` requires explicit env config and a writable
     * `PLUGIN_INSTALL_DIR`. Wire is read by `apps/api/src/api.module.ts`
     * → `AgentPluginsModule.forRootAsync` (see Phase 4 / T15).
     */
    plugins: {
        /**
         * `bundled` (default) → existing behaviour: every plugin
         * shipped in the image, discovered at boot, no registry calls.
         * `dynamic` → only core plugins bundled; distributable plugins
         * pulled from the configured registry on first enable
         * (per-replica installs, no shared RWX volume needed).
         *
         * Anything other than `dynamic` (incl. empty, missing,
         * `'BUNDLED'`, typos) coerces to `bundled` — fail-safe.
         */
        distributionMode: (): 'bundled' | 'dynamic' => {
            const raw = (process.env.PLUGIN_DISTRIBUTION_MODE ?? '').toLowerCase();
            return raw === 'dynamic' ? 'dynamic' : 'bundled';
        },

        /**
         * Primary registry the installer resolves packages from.
         * Defaults to public npm. Self-hosters mirror the catalog to
         * their own registry and point this at it. The installer pins
         * exact versions + integrity (FR-10), so HTTPS-only is
         * recommended but not enforced here (the installer will refuse
         * on a TLS error from the resolver).
         */
        registryUrl: (): string => process.env.PLUGIN_REGISTRY_URL || 'https://registry.npmjs.org',

        /**
         * Secondary registry for GitHub Packages (`@ever-works` scope).
         * The installer falls back to this when an allowlist entry's
         * `source` is `github-packages` or when the primary registry
         * returns 404 for a first-party package. Default mirrors the
         * publish workflow target.
         */
        registryGithubUrl: (): string =>
            process.env.PLUGIN_REGISTRY_GITHUB_URL || 'https://npm.pkg.github.com',

        /**
         * Bearer token for the registry. SECRET — never log this value.
         * Empty when unset (public npm packages don't need auth; GitHub
         * Packages does, but in CI the workflow injects GITHUB_TOKEN
         * directly). The installer reads it lazily so missing-token
         * errors surface on first install, not at boot.
         */
        registryToken: (): string | undefined => process.env.PLUGIN_REGISTRY_TOKEN || undefined,

        /**
         * Writable directory where dynamically-installed plugins are
         * placed so Node can `import()` them. Defaults to `/app/plugins`
         * (matches the Docker image WORKDIR convention). In `bundled`
         * mode this is the same directory already used by the loader
         * for built-in plugins; in `dynamic` mode it MUST be writable
         * — the boot reconciler (Phase 5 / T19) refuses to start when
         * the directory is read-only.
         */
        installDir: (): string => process.env.PLUGIN_INSTALL_DIR || '/app/plugins',

        /**
         * Fail-fast at boot: when `dynamic` mode is selected, at least
         * `PLUGIN_REGISTRY_URL` must be non-empty. Default-resolution
         * always returns a value (public npm), so this guard only
         * fires when the operator has explicitly cleared it — usually
         * indicating an internal-mirror setup is in flight but not
         * configured yet. Better loud at boot than a confusing 502
         * on first install.
         *
         * Called from `apps/api/src/api.module.ts`'s
         * `AgentPluginsModule.forRootAsync` factory before the module
         * spins up.
         */
        validate: (): void => {
            const mode = config.plugins.distributionMode();
            if (mode !== 'dynamic') return;
            const primary = (process.env.PLUGIN_REGISTRY_URL ?? '').trim();
            const github = (process.env.PLUGIN_REGISTRY_GITHUB_URL ?? '').trim();
            // Default-fallback (public npm) keeps `registryUrl()` non-empty.
            // The guard is on the RAW env: if the operator explicitly cleared
            // PLUGIN_REGISTRY_URL, we expect them to set the GitHub fallback
            // (or another registry URL) explicitly. Neither set → fail.
            if (primary === '' && github === '') {
                throw new Error(
                    'PLUGIN_DISTRIBUTION_MODE=dynamic requires at least one of ' +
                        'PLUGIN_REGISTRY_URL or PLUGIN_REGISTRY_GITHUB_URL to be set. ' +
                        'Set PLUGIN_REGISTRY_URL=https://registry.npmjs.org (or your mirror) ' +
                        'and re-deploy. Bundled-mode deployments are unaffected.',
                );
            }
        },
    },
};
