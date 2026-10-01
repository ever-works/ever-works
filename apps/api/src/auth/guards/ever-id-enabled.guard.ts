import { CanActivate, Injectable } from '@nestjs/common';
import { EverIdSignInService } from '../services/ever-id-sign-in.service';

/**
 * APW-12 (Ever ID, FR-5, ACC-12-01) — while Ever ID is off, the sign-in family
 * (authorize, callback, sign-up confirmation, connect, the terminal exchange and
 * its client configuration) answers `404 ever_id_disabled` whatever the request
 * carries.
 *
 * A guard runs before the body is validated, so a malformed request learns
 * exactly what a well-formed one does — that Ever ID is not available here — and
 * neither reaches a service or the provider. The switch is read from the
 * database only (`IdentityProviderFacadeService.getState`, cached for seconds);
 * the plugin is not loaded. A provider marked unavailable answers
 * `503 provider_unavailable`, as the routes themselves do.
 *
 * Listing and disconnecting connected identities and sign-out notices are not
 * behind this guard: they keep working while Ever ID is off (ACC-12-04).
 */
@Injectable()
export class EverIdEnabledGuard implements CanActivate {
    constructor(private readonly signIn: EverIdSignInService) {}

    async canActivate(): Promise<boolean> {
        await this.signIn.requireEnabled();
        return true;
    }
}
