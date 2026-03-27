import { All, Controller, Req, Res } from '@nestjs/common';
import { Public } from '../decorators/public.decorator';
import { BetterAuthService } from '../services/better-auth.service';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';

function splitSetCookieHeader(headerValue: string): string[] {
    const cookies: string[] = [];
    let current = '';
    let inExpiresAttribute = false;

    for (let i = 0; i < headerValue.length; i++) {
        const char = headerValue[i];
        const nextPart = headerValue.slice(i).toLowerCase();

        if (!inExpiresAttribute && nextPart.startsWith('expires=')) {
            inExpiresAttribute = true;
        }

        if (char === ',') {
            if (inExpiresAttribute) {
                current += char;
                continue;
            }

            if (current.trim()) {
                cookies.push(current.trim());
            }
            current = '';
            continue;
        }

        if (inExpiresAttribute && char === ';') {
            inExpiresAttribute = false;
        }

        current += char;
    }

    if (current.trim()) {
        cookies.push(current.trim());
    }

    return cookies;
}

/**
 * Catch-all controller that delegates all /api/auth/better-auth/* requests
 * to BetterAuth's internal router.
 */
@Controller('api/auth/better-auth')
export class BetterAuthController {
    constructor(private readonly betterAuthService: BetterAuthService) {}

    @Public()
    @All('*path')
    async handleAuth(@Req() req: ExpressRequest, @Res() res: ExpressResponse) {
        // Convert Express request to Web Fetch API Request for BetterAuth
        const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
            if (value) {
                headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            }
        }

        const webRequest = new globalThis.Request(url, {
            method: req.method,
            headers,
            body:
                req.method !== 'GET' && req.method !== 'HEAD'
                    ? JSON.stringify(req.body)
                    : undefined,
        });

        const response = await this.betterAuthService.handleRequest(webRequest);

        // Forward BetterAuth response back to Express
        const setCookies = response.headers.getSetCookie?.() ?? [];
        response.headers.forEach((value, key) => {
            if (key.toLowerCase() === 'set-cookie') {
                return;
            }
            res.setHeader(key, value);
        });

        if (setCookies.length > 0) {
            res.setHeader('set-cookie', setCookies);
        } else {
            const rawSetCookie = response.headers.get('set-cookie');
            if (rawSetCookie) {
                res.setHeader('set-cookie', splitSetCookieHeader(rawSetCookie));
            }
        }

        res.status(response.status);

        const body = await response.text();
        if (body) {
            res.send(body);
        } else {
            res.end();
        }
    }
}
