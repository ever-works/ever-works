import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import { MessageResponse } from './types';
import { OAuthProvider } from './enums';

// DTOs - Auth
export interface RegisterDto {
    username: string;
    email: string;
    password: string;
    emailVerificationCallbackUrl?: string;
}

export interface LoginDto {
    email: string;
    password: string;
}

export interface UpdatePasswordDto {
    currentPassword: string;
    newPassword: string;
}

export interface UpdateProfileDto {
    username?: string;
    avatar?: string;
    committerName?: string | null;
    committerEmail?: string | null;
    /** EW-602: opt-in/out for budget threshold alert emails. */
    emailBudgetAlerts?: boolean;
}

// DTOs - Email Verification
export interface VerifyEmailDto {
    token: string;
}

export interface ForgotPasswordDto {
    email: string;
    resetPasswordCallbackUrl?: string;
}

export interface ResetPasswordDto {
    token: string;
    newPassword: string;
}

// Response Types
export interface AuthResponse {
    access_token: string;
    user: UserProfile;
}

export interface UserProfile {
    id: string;
    username: string;
    email: string;
    avatar?: string;
    emailVerified?: boolean;
    committerName?: string | null;
    committerEmail?: string | null;
    /** EW-602: per-user toggle for budget alert emails. Defaults to true. */
    emailBudgetAlerts?: boolean;
    /** EW-602: self-hosted platform admin flag (gates /admin/usage). */
    isPlatformAdmin?: boolean;
    oauthTokens?: Array<{
        provider: string;
        createdAt?: string;
    }>;
}

export interface OAuthUrlResponse {
    url: string;
    /**
     * Server-minted CSRF state nonce. Callers MUST mirror this into their
     * own host-scoped `oauth_state` cookie and verify it on the OAuth
     * callback. The OAuth provider's `redirect_uri` points at the web
     * (`${WEB_URL}/api/oauth/:p/callback`), so the api.ever.works cookie
     * the API also sets is never carried on the callback request in the
     * normal user flow — the web's mirrored cookie is what closes the
     * CSRF loop. See `docs/specs/security/THREAT-MODEL.md` (C-03).
     */
    state: string;
}

export interface TokenValidationResponse {
    valid: boolean;
    message: string;
    email?: string;
    expiresAt?: Date;
}

export const authAPI = {
    // Authentication
    register: async (data: RegisterDto) => {
        return serverMutation<AuthResponse>({
            endpoint: '/auth/register',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    login: async (data: LoginDto) => {
        return serverMutation<AuthResponse>({
            endpoint: '/auth/login',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    logout: async () => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/logout',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    logoutAll: async () => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/logout-all',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    // Profile
    getProfile: async () => {
        return serverFetch<AuthResponse['user']>('/auth/profile');
    },

    getFreshProfile: async () => {
        return serverFetch<AuthResponse['user']>('/auth/profile/fresh');
    },

    updatePassword: async (data: UpdatePasswordDto) => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/update-password',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    updateProfile: async (data: UpdateProfileDto) => {
        return serverMutation<AuthResponse['user']>({
            endpoint: '/auth/profile',
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    // OAuth URLs
    //
    // The API server mints the CSRF state nonce and returns it alongside the
    // OAuth URL. Callers MUST set their own `oauth_state` cookie to that
    // returned value and check it on the OAuth callback. Do NOT supply a
    // client-side state — the API ignores it.
    getOAuthAuthUrl: async (providerId: OAuthProvider) => {
        return serverFetch<OAuthUrlResponse>(`/oauth/${providerId}/url`);
    },

    /**
     * Exchange an OAuth callback `code` for an authenticated session.
     *
     * Forwards the validated `state` along two channels so the API's C-03
     * state check (`OAuthController.authRedirect`) succeeds even though the
     * request is server-to-server and doesn't carry the browser's
     * `ew_oauth_state` cookie:
     *
     *   - `?state=<state>` query parameter
     *   - `Cookie: ew_oauth_state=<state>` request header
     *
     * The caller (web `handleOAuthCallback`) has already verified that this
     * `state` equals the value the API minted on `/api/oauth/:p/url` and
     * mirrored into the host-scoped `oauth_state` cookie on the web origin,
     * so forwarding both is equivalent to the browser-direct path the API
     * was originally written for.
     */
    connectOAuthCallback: async (providerId: OAuthProvider, code: string, state: string) => {
        const params = new URLSearchParams({ code, state });
        return serverFetch<AuthResponse>(`/oauth/${providerId}/callback?${params.toString()}`, {
            headers: { cookie: `ew_oauth_state=${state}` },
        });
    },

    // Email Verification
    sendVerification: async () => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/send-verification',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    verifyEmail: async (data: VerifyEmailDto) => {
        return serverMutation<AuthResponse>({
            endpoint: '/auth/verify-email',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    forgotPassword: async (data: ForgotPasswordDto) => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/forgot-password',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    resetPassword: async (data: ResetPasswordDto) => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/reset-password',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    validateEmailVerificationToken: async (token: string) => {
        return serverFetch<TokenValidationResponse>(
            `/auth/validate-email-token?token=${encodeURIComponent(token)}`,
        );
    },

    validatePasswordResetToken: async (token: string) => {
        return serverFetch<TokenValidationResponse>(
            `/auth/validate-reset-token?token=${encodeURIComponent(token)}`,
        );
    },
};
