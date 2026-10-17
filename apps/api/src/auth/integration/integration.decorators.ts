import { SetMetadata } from '@nestjs/common';
import type { IntegrationScope } from '@ever-works/contracts';

/** Metadata key: the scopes an integration key needs on this route. */
export const REQUIRE_SCOPES_KEY = 'ew:integration:requireScopes';

/** Metadata key: the route answers integration keys without an org pin header. */
export const INTEGRATION_ORG_OPTIONAL_KEY = 'ew:integration:orgOptional';

/** Metadata key: only a signed-in person's session may call this route. */
export const SESSION_CREDENTIAL_ONLY_KEY = 'ew:integration:sessionCredentialOnly';

/**
 * EW-P1-2 — opens a route to integration keys (`ew_int_…`) that hold EVERY
 * listed scope. `@RequireScopes()` with no scopes admits any integration key
 * (e.g. `whoami`).
 *
 * Integration keys are refused on every route WITHOUT this decorator
 * (`IntegrationPrincipalGuard`, deny by default), so it is the one switch that
 * exposes a route to an integration. Sessions and personal `ew_live_` keys
 * are never scope-checked (plan doc 02 §2).
 *
 * Unless the route also carries {@link IntegrationOrgOptional}, the request
 * must name one of the key's pinned Organizations in `X-Scope-Slug` (or
 * `X-Organization-Id`), else `403 org_not_pinned`.
 */
export const RequireScopes = (...scopes: IntegrationScope[]) =>
    SetMetadata(REQUIRE_SCOPES_KEY, scopes);

/**
 * EW-P1-2 — an integration route that does not act inside one Organization
 * (`GET /api/integrations/v1/whoami`). An org header that IS sent must still
 * name a pinned Organization.
 */
export const IntegrationOrgOptional = () => SetMetadata(INTEGRATION_ORG_OPTIONAL_KEY, true);

/**
 * EW-P1-2 — only a person signed in with a session may call this route: no
 * personal `ew_live_` key, no fleet-run token, no integration key, no
 * delegated Ever ID token. Enforced by `IntegrationForbiddenGuard`; used on
 * the routes that MINT credentials (create and rotate an API key), which
 * closes the gap where any API key could mint more keys.
 */
export const SessionCredentialOnly = () => SetMetadata(SESSION_CREDENTIAL_ONLY_KEY, true);
