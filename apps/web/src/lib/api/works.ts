import 'server-only';
import { serverMutation } from './server-api';

/**
 * EW-617 G4 — server-side client for `POST /api/works/quick-create`.
 *
 * Wraps the wizard's "Generate now" button: takes the prompt + the user's
 * onboarding choices and asks the API to create a Work + start AI
 * generation in one round-trip. Returns the new work id + the generation
 * history id so the client can navigate + poll.
 */
export interface QuickCreateWorkRequest {
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly prompt: string;
    readonly organization?: boolean;
    readonly owner?: string;
    readonly gitProvider?: string;
    readonly deployProvider?: string;
    readonly storageProvider?: string;
    readonly websiteTemplateId?: string;
    readonly model?: string;
    /** EW-617 G7 — Cloudflare Turnstile token; verified server-side
     *  when `CAPTCHA_PROVIDER` is set on the API. */
    readonly captchaToken?: string;
    /** EW-617 G8 — funnel correlation UUID minted at wizard mount.
     *  Threaded into telemetry events. */
    readonly correlationId?: string;
}

export interface QuickCreateWorkResponse {
    readonly status: 'pending';
    readonly work: { readonly id: string; readonly slug: string; readonly name: string };
    readonly generation: { readonly historyId: string; readonly message: string };
}

export const worksAPI = {
    quickCreate(body: QuickCreateWorkRequest) {
        return serverMutation<QuickCreateWorkResponse>({
            endpoint: '/works/quick-create',
            data: body,
            method: 'POST',
            wrapInData: false,
        });
    },
};
