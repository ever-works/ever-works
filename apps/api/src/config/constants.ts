export const jwtConstants = {
    secret: () => process.env.JWT_SECRET || 'aesh4Dai_secret_key_here',
    accessTokenExpiration: () => {
        const expiration = process.env.JWT_ACCESS_TOKEN_EXPIRATION;
        // Return undefined to disable expiration
        return expiration === 'never' ? undefined : (expiration || '15m');
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
