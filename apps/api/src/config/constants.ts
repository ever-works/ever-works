export const jwtConstants = {
    secret: () => process.env.JWT_SECRET || 'aesh4Dai_secret_key_here',
    accessTokenExpiration: () => {
        const expiration = process.env.JWT_ACCESS_TOKEN_EXPIRATION;
        // Return undefined to disable expiration
        return expiration === 'never' ? undefined : expiration || '7d';
    },
    refreshTokenExpiration: () => {
        const days = process.env.JWT_REFRESH_TOKEN_EXPIRATION_DAYS;
        // Return -1 to indicate no expiration
        return days === 'never' ? -1 : parseInt(days || '7', 10);
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
}

export const config = {
    debug: () => process.env.HTTP_DEBUG === 'true',

    webAppUrl: () => process.env.WEB_URL || 'http://localhost:3000',

    mail: {
        provider: (): 'smtp' | 'faker' => {
            const provider = process.env.MAILER_PROVIDER;
            return !provider || provider === 'none' ? 'faker' : 'smtp';
        },
        from: () => process.env.EMAIL_FROM || 'Ever Works <no-reply@ever.works>',
        smtpHost: () => process.env.SMTP_HOST || '127.0.0.1',
        smtpPort: () => parseInt(process.env.SMTP_PORT || '587'),
        smtpUser: () => process.env.SMTP_USER,
        smtpPassword: () => process.env.SMTP_PASSWORD,
        smtpSecure: () => process.env.SMTP_SECURE === 'true',
        smtpIgnoreTLS: () => process.env.SMTP_IGNORE_TLS === 'true',
    },

    google: {
        clientId: () => process.env.GOOGLE_CLIENT_ID,
        clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
        callbackUrl: () => {
            const webUrl = config.webAppUrl();
            return process.env.GOOGLE_CALLBACK_URL || `${webUrl}/api/auth/google/callback`;
        },
        connectCallbackUrl: () => {
            const webUrl = config.webAppUrl();
            return process.env.GOOGLE_CALLBACK_URL || `${webUrl}/api/auth/google/callback`;
        },
    },
    github: {
        clientId: () => process.env.GH_CLIENT_ID,
        clientSecret: () => process.env.GH_CLIENT_SECRET,
        callbackUrl: () => {
            const webUrl = config.webAppUrl();
            return process.env.GH_CALLBACK_URL || `${webUrl}/api/auth/github/callback`;
        },
        connectCallbackUrl: () => {
            const webUrl = config.webAppUrl();
            return process.env.GH_CALLBACK_URL || `${webUrl}/api/auth/github/callback`;
        },
    },
};
