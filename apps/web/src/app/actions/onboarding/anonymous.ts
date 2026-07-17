'use server';

import { authAPI } from '@/lib/api';
import { setAuthAccessCookie } from '@/lib/auth/cookies';
import { ApiResponseError } from '@/lib/api/server-api';

// The API's CreateAnonymousDto.correlationId is @IsUUID('4'); with
// forbidNonWhitelisted a non-UUID value 400s the whole mint. Only forward valid.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Not exported: a `'use server'` module may only export async functions, so
// this result shape stays module-private (the client consumes it structurally).
interface StartAnonymousResult {
    success: boolean;
    error?: string;
    reason?: 'throttled' | 'captcha' | 'error';
    userId?: string;
}

export async function startAnonymousOnboarding(input: {
    captchaToken?: string;
    correlationId?: string;
}): Promise<StartAnonymousResult> {
    const correlationId =
        input.correlationId && UUID_V4.test(input.correlationId) ? input.correlationId : undefined;

    try {
        const res = await authAPI.createAnonymous({
            captchaToken: input.captchaToken || undefined,
            correlationId,
        });
        // Persist the opaque anon token as the SAME encrypted httpOnly cookie the
        // login flow sets, so every downstream RSC fetch / server action is authed.
        await setAuthAccessCookie(res.access_token);
        return { success: true, userId: res.user.id };
    } catch (error) {
        if (error instanceof ApiResponseError) {
            if (error.statusCode === 429) {
                return {
                    success: false,
                    reason: 'throttled',
                    error: 'Too many attempts — please try again shortly.',
                };
            }
            if (error.statusCode === 400) {
                return {
                    success: false,
                    reason: 'captcha',
                    error: 'We couldn’t verify your browser. Please sign up to continue.',
                };
            }
        }
        return {
            success: false,
            reason: 'error',
            error: 'Could not start a guest session. Please sign up to continue.',
        };
    }
}
