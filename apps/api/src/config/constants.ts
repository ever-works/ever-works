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

    webAppUrl: () => process.env.WEB_URL || 'http://localhost:3000',

    auth: {
        secret: () => {
            const secret = process.env.AUTH_SECRET;
            if (!secret) {
                throw new Error('AUTH_SECRET environment variable is required');
            }
            return secret;
        },
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
            'A SaaS platform for building and managing directories',
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

    directory: {
        staleTimeoutHours: () => parseInt(process.env.DIRECTORY_STALE_TIMEOUT_HOURS || '2', 10),
    },
};
