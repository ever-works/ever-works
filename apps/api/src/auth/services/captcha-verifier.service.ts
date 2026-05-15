import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

/**
 * EW-617 G7 — Cloudflare Turnstile (or any compatible /siteverify
 * provider) token verifier.
 *
 * Wraps a single POST to the verify endpoint with a server-side secret
 * and returns a normalized `VerifyResult`. Used by:
 *  - `POST /api/auth/anonymous` (gates landing → anon-user creation)
 *  - `POST /api/works/quick-create` (gates Generate-now from landing)
 *
 * When `CAPTCHA_PROVIDER` is unset (default in dev) the verifier
 * returns success without an HTTP call, so the existing per-IP
 * throttles (G2/G4) remain the only line of defense in dev/preview.
 * Production sets `CAPTCHA_PROVIDER=turnstile` + `CAPTCHA_SECRET`.
 *
 * Provider-agnostic: the verify URL and the JSON shape used by
 * Cloudflare Turnstile, hCaptcha, and reCAPTCHA v3 are all close
 * enough that one impl covers them — the only thing that differs is
 * the response field for the score (we don't read it; the boolean
 * `success` is enough for our threat model).
 */

export interface CaptchaConfig {
    /** 'turnstile' | 'hcaptcha' | 'recaptcha' — `null` means disabled. */
    readonly provider: string | null;
    readonly secret: string | null;
    /** Optional override (tests use a mock; staging may mirror). */
    readonly verifyUrl: string | null;
}

export interface CaptchaVerifyInput {
    readonly token: string | null | undefined;
    readonly remoteIp?: string | null;
}

export interface CaptchaVerifyResult {
    readonly success: boolean;
    readonly skipped: boolean;
    readonly errorCodes?: readonly string[];
    readonly hostname?: string;
}

const DEFAULT_VERIFY_URLS: Record<string, string> = {
    turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    hcaptcha: 'https://hcaptcha.com/siteverify',
    recaptcha: 'https://www.google.com/recaptcha/api/siteverify',
};

export const CAPTCHA_FETCH = Symbol('CAPTCHA_FETCH');

@Injectable()
export class CaptchaVerifierService {
    private readonly logger = new Logger(CaptchaVerifierService.name);
    private cachedConfig: CaptchaConfig | undefined;

    constructor(
        @Optional() @Inject(CAPTCHA_FETCH) private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    /** Read env once and cache. Test hook: `resetCacheForTest`. */
    getConfig(): CaptchaConfig {
        if (this.cachedConfig !== undefined) return this.cachedConfig;
        const provider = process.env.CAPTCHA_PROVIDER?.trim().toLowerCase() || null;
        const secret = process.env.CAPTCHA_SECRET?.trim() || null;
        const verifyUrl =
            process.env.CAPTCHA_VERIFY_URL?.trim() ||
            (provider ? (DEFAULT_VERIFY_URLS[provider] ?? null) : null);
        this.cachedConfig = { provider, secret, verifyUrl };
        return this.cachedConfig;
    }

    isEnabled(): boolean {
        const c = this.getConfig();
        return Boolean(c.provider && c.secret && c.verifyUrl);
    }

    async verify(input: CaptchaVerifyInput): Promise<CaptchaVerifyResult> {
        if (!this.isEnabled()) {
            // No captcha configured — let traffic through. The
            // upstream endpoint's per-IP throttle still applies.
            return { success: true, skipped: true };
        }

        if (!input.token || typeof input.token !== 'string') {
            return { success: false, skipped: false, errorCodes: ['missing-input-response'] };
        }

        const config = this.getConfig();
        const body = new URLSearchParams({
            secret: config.secret!,
            response: input.token,
        });
        if (input.remoteIp) {
            body.set('remoteip', input.remoteIp);
        }

        try {
            const response = await this.fetchImpl(config.verifyUrl!, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
            });
            const json = (await response.json().catch(() => ({}))) as {
                success?: boolean;
                'error-codes'?: string[];
                hostname?: string;
            };
            const success = response.ok && json.success === true;
            if (!success) {
                this.logger.warn(
                    `captcha verify failed status=${response.status} codes=${(
                        json['error-codes'] ?? []
                    ).join(',')}`,
                );
            }
            return {
                success,
                skipped: false,
                errorCodes: json['error-codes'],
                hostname: json.hostname,
            };
        } catch (cause) {
            // Provider outage: do NOT block legitimate traffic. Throttles
            // remain the safety net; ops will see the warn log + alert
            // on the elevated rate.
            this.logger.warn(
                `captcha verify threw (treating as success to avoid blocking): ${
                    (cause as Error).message
                }`,
            );
            return { success: true, skipped: true, errorCodes: ['verifier-exception'] };
        }
    }

    /** Test-only — flush the env cache so a new `CAPTCHA_*` env can be read. */
    resetCacheForTest(): void {
        this.cachedConfig = undefined;
    }
}
