export const jwtConstants = {
    secret: () => process.env.JWT_SECRET || 'aesh4Dai_secret_key_here',
    accessTokenExpiration: () => {
        const expiration = process.env.JWT_ACCESS_TOKEN_EXPIRATION;
        // Return undefined to disable expiration
        return expiration === 'never' ? undefined : expiration || '15m';
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

export enum AuthProviders {
    LOCAL = 'local',
    GITHUB = 'github',
    GOOGLE = 'google',
}

export const config = {
    google: {
        clientId: () => process.env.GOOGLE_CLIENT_ID,
        clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
        callbackUrl: () => {
            return (
                process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3100/api/auth/google/callback'
            );
        },
        connectCallbackUrl: () => {
            return (
                process.env.GOOGLE_CONNECT_CALLBACK_URL ||
                'http://localhost:3100/api/auth/connections/google/callback'
            );
        },
    },
    github: {
        clientId: () => process.env.GITHUB_CLIENT_ID,
        clientSecret: () => process.env.GITHUB_CLIENT_SECRET,
        callbackUrl: () => {
            return (
                process.env.GITHUB_CALLBACK_URL || 'http://localhost:3100/api/auth/github/callback'
            );
        },
        connectCallbackUrl: () => {
            return (
                process.env.GITHUB_CONNECT_CALLBACK_URL ||
                'http://localhost:3100/api/auth/connections/github/callback'
            );
        },
    },
};
