import { Module, type Type } from '@nestjs/common';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { DatabaseModule } from '@ever-works/agent/database';
import { UNBOUND_EVER_CONNECT_PROVIDERS } from './identity/ever-connect-identity.ports';
import { EverIdClientSettings } from './identity/ever-id-client.settings';
import { EverIdLoginHandler } from './identity/ever-id-login.handler';
import { PersonLinkReporter } from './identity/person-link.reporter';
import { PersonRequestsHandler } from './identity/person-requests.handler';
import {
    EVER_CONNECT_ADDRESS_CHECK,
    EverConnectWellKnownController,
    NoEverConnectAddressCheck,
} from './well-known.controller';

/**
 * Ever Connect: what a self-hosted installation connected to Ever Platform
 * does for Sign in with Ever ID and for people's data requests.
 *
 * - {@link EverIdLoginHandler}: the installation's own Ever ID sign-in client
 *   (requested, read until ready, stored, offered to the sign-in plugin).
 * - {@link PersonLinkReporter}: which local accounts are linked to an Ever ID.
 * - {@link PersonRequestsHandler}: answers to deletion and export requests.
 * - `GET /.well-known/ever-connect`: the address statement during a check.
 *
 * The connection itself (connect code, token, feed, integration states, the
 * report queue) belongs to the Ever Connect module's connection services, which
 * bind the ports of `identity/ever-connect-identity.ports.ts`. Until they are
 * bound the ports answer "not connected": no request leaves the installation
 * and nothing is written.
 *
 * Imported only with `EVER_CONNECT_ENABLED=true` ({@link everConnectModuleImports}).
 */
@Module({
    imports: [DatabaseModule, ActivityLogModule],
    controllers: [EverConnectWellKnownController],
    providers: [
        ...UNBOUND_EVER_CONNECT_PROVIDERS,
        { provide: EVER_CONNECT_ADDRESS_CHECK, useClass: NoEverConnectAddressCheck },
        EverIdClientSettings,
        PersonLinkReporter,
        EverIdLoginHandler,
        PersonRequestsHandler,
    ],
    exports: [EverIdLoginHandler, PersonLinkReporter, PersonRequestsHandler],
})
export class EverConnectModule {}

/** Whether the Ever Connect module is switched on: `EVER_CONNECT_ENABLED=true`, nothing else. */
export function isEverConnectEnabled(
    env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
    return env.EVER_CONNECT_ENABLED?.trim().toLowerCase() === 'true';
}

/**
 * What `ApiModule` imports for Ever Connect: `[EverConnectModule]` when
 * `EVER_CONNECT_ENABLED=true`; otherwise — by default — NOTHING: no route
 * (`/.well-known/ever-connect` answers 404 like any unknown address), no
 * listener, no timer.
 */
export function everConnectModuleImports(
    env: Readonly<Record<string, string | undefined>> = process.env,
): Type[] {
    return isEverConnectEnabled(env) ? [EverConnectModule] : [];
}
