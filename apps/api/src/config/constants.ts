export const jwtConstants = {
    secret: () => {
        const secret = process.env.JWT_SECRET;
        if (!secret) {
            throw new Error('JWT_SECRET environment variable is required');
        }
        return secret;
    },
    accessTokenExpiration: (): any => {
        const expiration = process.env.JWT_ACCESS_TOKEN_EXPIRATION;
        // Return undefined to disable expiration
        return expiration === 'never' ? undefined : expiration || '7d';
    },
    refreshTokenExpiration: () => {
        const days = process.env.JWT_REFRESH_TOKEN_EXPIRATION_DAYS;
        // Return -1 to indicate no expiration
        return days === 'never' ? -1 : parseInt(days || '14', 10);
    },
    isTokenExpirationDisabled: () => {
        return process.env.JWT_DISABLE_EXPIRATION === 'true';
    },
};

export const authConstants = {
    bcryptSaltRounds: 10,
    refreshTokenLength: 32,
    refreshTokenCleanupDays: 30,
};

export enum AuthProvider {
    LOCAL = 'local',
    GITHUB = 'github',
    GOOGLE = 'google',
    LINKEDIN = 'linkedin',
    FACEBOOK = 'facebook',
    TWITTER = 'twitter',
}

export const config = {
    debug: () => process.env.HTTP_DEBUG === 'true',

    webAppUrl: () => process.env.WEB_URL || 'http://localhost:3000',

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

    linkedin: {
        clientId: () => process.env.LINKEDIN_CLIENT_ID,
        clientSecret: () => process.env.LINKEDIN_CLIENT_SECRET,
    },
    facebook: {
        clientId: () => process.env.FACEBOOK_CLIENT_ID,
        clientSecret: () => process.env.FACEBOOK_CLIENT_SECRET,
    },
    twitter: {
        clientId: () => process.env.TWITTER_CLIENT_ID,
        clientSecret: () => process.env.TWITTER_CLIENT_SECRET,
    },

    authProvider: {
        secret: () => process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET,
        // The auth provider's public URL must match the browser-facing origin because
        // OAuth routes are exposed through the Next.js proxy on the web host.
        url: () => process.env.BETTER_AUTH_URL || config.webAppUrl(),
    },

    directory: {
        staleTimeoutHours: () => parseInt(process.env.DIRECTORY_STALE_TIMEOUT_HOURS || '2', 10),
    },
};
