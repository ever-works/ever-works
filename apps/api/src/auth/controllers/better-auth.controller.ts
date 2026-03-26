import { All, Controller, Req, Res } from '@nestjs/common';
import { Public } from '../decorators/public.decorator';
import { BetterAuthService } from '../services/better-auth.service';
import { Request, Response } from 'express';

/**
 * Catch-all controller that delegates all /api/auth/better-auth/* requests
 * to BetterAuth's internal router.
 */
@Controller('auth/better-auth')
export class BetterAuthController {
    constructor(private readonly betterAuthService: BetterAuthService) {}

    @Public()
    @All('*path')
    async handleAuth(@Req() req: Request, @Res() res: Response) {
        // Convert Express request to standard Request for BetterAuth
        const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
            if (value) {
                headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            }
        }

        const webRequest = new Request(url, {
            method: req.method,
            headers,
            body:
                req.method !== 'GET' && req.method !== 'HEAD'
                    ? JSON.stringify(req.body)
                    : undefined,
        });

        const response = await this.betterAuthService.handleRequest(webRequest);

        // Forward BetterAuth response back to Express
        response.headers.forEach((value, key) => {
            res.setHeader(key, value);
        });
        res.status(response.status);

        const body = await response.text();
        if (body) {
            res.send(body);
        } else {
            res.end();
        }
    }
}
