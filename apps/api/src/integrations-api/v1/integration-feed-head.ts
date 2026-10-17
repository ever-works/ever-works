/**
 * The newest change-feed `seq` an integration key may see — `whoami.feedHead`
 * (contract v1 B.2). Gauzy records it before an initial sync and replays the
 * feed from it afterwards.
 *
 * Bound in `IntegrationsApiV1Module` to `DomainEventFeedService.head()` (EW-P1-1):
 * the GLOBAL head (the relay's last assigned seq, `'0'` when empty). Positions
 * are global across organizations, so the input is informational. When the
 * token is unbound (a reduced module graph) `whoami` answers `'0'`.
 */
export const INTEGRATION_FEED_HEAD = Symbol('INTEGRATION_FEED_HEAD');

export interface IntegrationFeedHead {
    head(input: { tenantId: string; organizationIds: string[] }): Promise<string>;
}

export const NO_FEED_HEAD = '0';
