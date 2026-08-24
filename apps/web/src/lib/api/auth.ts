import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import { MessageResponse } from './types';
import { OAuthProvider } from './enums';

/**
 * One legal document the signup form displayed next to the terms checkbox.
 *
 * Echoed back to the API verbatim so the acceptance record can be pinned to the
 * exact text: the `sha256` is the digest of the document source as published by
 * `@ever-co/legal`, which is what lets the wording someone agreed to be
 * reproduced byte for byte years later. The API re-checks every field against
 * the corpus — a value that arrived from a browser is a claim, not evidence.
 */
export interface TermsAcceptanceClaim {
    documentId: string;
    version: string;
    sha256: string;
    locale: string;
}

/** A required document as published by `GET /terms/required`. */
export interface TermsAcceptanceDocument extends TermsAcceptanceClaim {
    url?: string;
    title?: string;
    effectiveDate?: string;
}

// DTOs - Auth
export interface RegisterDto {
    username: string;
    email: string;
    password: string;
    emailVerificationCallbackUrl?: string;
    /**
     * What the user ticked the box for.
     *
     * The signup checkbox was an uncontrolled `<input type="checkbox" required>`
     * that never entered `formData` and never reached this DTO — the submit was
     * gated and the value discarded. This is the field that was missing.
     */
    terms?: TermsAcceptanceClaim[];
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

/**
 * EW-070 — body of the SIGNED-OUT verification resend.
 *
 * Distinct from `sendVerification()` below, which posts to the
 * session-guarded `/auth/send-verification`. An unverified account cannot
 * obtain a session (login answers 403), so that route is unreachable exactly
 * when a resend is needed.
 */
export interface ResendVerificationDto {
    email: string;
    emailVerificationCallbackUrl?: string;
}

export interface ForgotPasswordDto {
    email: string;
    resetPasswordCallbackUrl?: string;
}

export interface ResetPasswordDto {
    token: string;
    newPassword: string;
}

// 1f — Magic-link / passwordless login. See `EW-633`.
export interface RequestMagicLinkDto {
    email: string;
    magicLinkCallbackUrl?: string;
}

export interface RedeemMagicLinkDto {
    token: string;
}

// EW-617 G2 — zero-friction anonymous session. Mints a temporary (email-less)
// user so onboarding can run before sign-up. Captcha-gated in production; the
// browser supplies a fresh Turnstile token. `correlationId` must be a UUID v4.
export interface CreateAnonymousDto {
    captchaToken?: string;
    correlationId?: string;
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
    /**
     * The legal documents a new account must accept, as currently published.
     *
     * Fetched rather than hard-coded so the version and digest the user is shown
     * are the ones the server will accept, and so the object that gates the
     * submit button is the object that gets posted back.
     */
    getRequiredTerms: async (locale?: string) => {
        const query = locale ? `?locale=${encodeURIComponent(locale)}` : '';
        return serverFetch<TermsAcceptanceDocument[]>(`/terms/required${query}`);
    },

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

    /**
     * EW-070 — public resend. Always resolves with the same message whether or
     * not the address has an account here, so callers must not branch on the
     * body: there is nothing in it to branch on.
     */
    resendVerification: async (data: ResendVerificationDto) => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/resend-verification',
            data,
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
            // Email callbacks live under /api and intentionally bypass the
            // workspace proxy. Authentication tokens are never org-scoped.
            publicRouteScope: 'personal',
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
            { publicRouteScope: 'personal' },
        );
    },

    // Magic link — issuance response is intentionally uniform regardless
    // of whether the email exists, see `auth.service.ts#requestMagicLink`.
    requestMagicLink: async (data: RequestMagicLinkDto) => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/magic-link',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    redeemMagicLink: async (data: RedeemMagicLinkDto) => {
        return serverMutation<AuthResponse>({
            endpoint: '/auth/magic-link/redeem',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },
    // EW-617 G2 — mint a temporary anonymous session. API_URL already ends in
    // `/api`, so this resolves to POST https://api.ever.works/api/auth/anonymous.
    createAnonymous: async (data: CreateAnonymousDto) => {
        return serverMutation<AuthResponse>({
            endpoint: '/auth/anonymous',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },
};
