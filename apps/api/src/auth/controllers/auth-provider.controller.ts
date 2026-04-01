import { All, Controller, Req, Res } from '@nestjs/common';
import { Public } from '../decorators/public.decorator';
import { AuthProviderService } from '../services/auth-provider.service';
import { splitSetCookieHeader } from '@ever-works/plugin';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';

/**
 * Catch-all controller that delegates all /api/auth/provider/* requests
 * to the configured auth provider's internal router.
 */
@Controller('api/auth/provider')
export class AuthProviderController {
    constructor(private readonly authProviderService: AuthProviderService) {}

    @Public()
    @All('*path')
    async handleAuth(@Req() req: ExpressRequest, @Res() res: ExpressResponse) {
        // Convert Express request to Web Fetch API Request for the auth provider
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

        const response = await this.authProviderService.handleRequest(webRequest);

        // Forward auth provider response back to Express
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
