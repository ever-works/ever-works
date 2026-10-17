# Task Breakdown: Integration keys and the integration principal

**Feature ID**: `integration-keys` · **Plan**: [`./plan.md`](./plan.md) · **Plan item**: EW-P1-2

## Done (EW-P1-2)

- [x] T1. Contracts: `packages/contracts/src/integrations/` — kind, prefix, scope vocabulary v1, Ever Gauzy preset,
      headers, error codes, limits, label helper, wire types; `ApiKeyKind` + `'integration'`; barrel area.
- [x] T2. Entity + migration `1795060100000-AddIntegrationApiKeys` (Postgres, MySQL, better-sqlite3; working `down`).
- [x] T3. `TaskAuthorType` (`user | agent | integration`) for `tasks.createdByType` and `task_chat_messages.authorType`;
      `task_chat_messages.externalAuthor`.
- [x] T4. `AuthSessionGuard`: `ew_int_` branch → integration principal; `401 invalid_key` envelope.
- [x] T5. `ApiKeyService.validateIntegrationKey`, rotation grace lookup, `rotateKey` (in place).
- [x] T6. `IntegrationKeyService`: create (tenant owner, pins, scopes, cap 20), list, revoke (deactivate + event), audit.
- [x] T7. `IntegrationPrincipalGuard`: deny by default, `@RequireScopes`, org pin, act-as on writes.
- [x] T8. `IntegrationForbiddenGuard` on key-management, account, security, billing and admin controllers;
      `@SessionCredentialOnly()` on create/rotate (closes the `ew_live_` mint hole).
- [x] T9. Throttle tier per key (reads/writes/burst), `429 rate_limited` + `Retry-After`.
- [x] T10. `IntegrationAuditInterceptor` → `integration_write` rows (`actorKind = 'external'`); key lifecycle rows.
- [x] T11. `GET /api/integrations/v1/whoami` (+ `IntegrationOnlyGuard`, `INTEGRATION_FEED_HEAD` hook).
- [x] T12. `POST /api/tasks` and `POST /api/tasks/:id/chat` open to `tasks:write` with attribution and D9 guards.
- [x] T13. Web task chat renders integration authors.
- [x] T14. Tests: HTTP-level suite, migration suite, contracts suite; Playwright specs updated for the two intentional
      behaviour changes (mint refused, rotate exists) plus an end-to-end integration-key flow.

## Follow-ups (other items)

- [x] EW-P1-1: bind `INTEGRATION_FEED_HEAD` to the domain-event feed head (`DomainEventFeedService.head()`, the global
      head) in `IntegrationsApiV1Module`; the domain-event context interceptor (#2611) maps the integration principal
      (`request.user.integration.keyId`, `.actAsUserId`) into the event actor.
- [ ] EW-P1-1: record the integration-key lifecycle (created / rotated / revoked) through the domain-event recorder in
      the same transaction as the key write, so the security audit is durable. Today's `integration_key_*` activity rows
      are best-effort, like every activity row; the key row itself is kept on revoke.
- [ ] EW-P1-3: make `organization_members` authoritative and tighten `IntegrationPrincipalGuard.isOnOrganizationRoster`;
      org-wide reads within pins.
- [ ] EW-P1-4: integration resources under `/api/integrations/v1` (each with `@RequireScopes`), the error envelope for
      validation errors, `externalAuthor` on comment creates.
- [ ] EW-P1-5: disable a key's webhook subscriptions on `integration-key.revoked`.
- [x] EW-P1-7: Settings → API keys integration dialog (Ever Gauzy preset, deep link), list with Rotate; Integrations
      card (`IntegrationKeysSection`, `EverGauzyIntegrationCard`, `/settings/integrations/ever-gauzy`).
- [ ] EW-P1-5: list the key's webhook subscriptions on the Ever Gauzy card; revoke disables both.
- [x] EW-P2-6: org owner/admin roles may create integration keys (admins: the organizations they administer; pins
      re-read per request).
