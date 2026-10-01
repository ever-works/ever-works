import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, mergeMap } from 'rxjs';
import { EVER_ID_DEFAULT_DISPLAY_NAME, type EverIdAvailability } from '@ever-works/contracts';
import { IdentityProviderFacadeService } from '@ever-works/agent/facades';

/**
 * APW-12 (Ever ID, FR-6) — appends the one additive field `everId: { enabled,
 * displayName }` to `GET /api/auth/providers`.
 *
 * Done as an interceptor on purpose: the existing handler, its return value and
 * every existing field stay exactly as they were (ACC-12-05), and the field is
 * added only on the wire. `enabled` is true only when an administrator turned
 * Ever ID on, it is configured and not marked unavailable; working that out
 * reads the database (and, when on, the plugin's own settings) — never the
 * identity provider. Any failure answers `enabled: false`.
 */
@Injectable()
export class EverIdProvidersInterceptor implements NestInterceptor {
    constructor(private readonly facade: IdentityProviderFacadeService) {}

    intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
        return next.handle().pipe(
            mergeMap(async (body: unknown) => {
                if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
                return { ...(body as Record<string, unknown>), everId: await this.availability() };
            }),
        );
    }

    private async availability(): Promise<EverIdAvailability> {
        try {
            const enabled = await this.facade.isAvailable();
            const displayName = enabled
                ? await this.facade.getDisplayName()
                : EVER_ID_DEFAULT_DISPLAY_NAME;
            return { enabled, displayName };
        } catch {
            return { enabled: false, displayName: EVER_ID_DEFAULT_DISPLAY_NAME };
        }
    }
}
