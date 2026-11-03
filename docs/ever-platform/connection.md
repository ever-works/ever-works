# Connecting Ever Works to Ever Platform

A self-hosted Ever Works installation can be connected to Ever Platform
(app.ever.co). An organization on Ever Platform can then turn on integrations
for it: today, **Sign in with Ever ID** through the installation's own sign-in
client, and the answers to **people's export and deletion requests**.

The connection is off by default and nothing is sent until you connect.

## Turning it on

| Variable                       | Default               | Meaning                                                                                                          |
| ------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `EVER_CONNECT_ENABLED`         | unset (off)           | `true` loads the module. Unset or anything else: no route, no timer, no request.                                 |
| `EVER_CONNECT_CODE`            | unset                 | A connect code from app.ever.co (`EVC-XXXX-XXXX-XXXX`), used once at the first start that sees it.               |
| `EVER_CONNECT_FEED_MODE`       | `longpoll`            | How the event feed is read: `longpoll` (an open request of up to 25 seconds) or `interval` (every 15 minutes).   |
| `EVER_PLATFORM_API_URL`        | `https://api.ever.co` | The Ever Platform API. `https` only (plain `http` only for a local or private address, such as a test platform). |
| `PLUGIN_SECRET_ENCRYPTION_KEY` | unset                 | When set, the connect key and the Ever ID sign-in client are stored encrypted. Set it in production.             |

A platform administrator can also connect and manage the connection through the
API (each route needs a platform administrator; the ones that change something
also need an interactive session, not an API key):

| Route                                                          | What it does                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /api/ever-connect/status`                                 | The connection, the integrations, the Ever ID client and the outbox.       |
| `POST /api/ever-connect/connect` `{code}`                      | Connect with a connect code.                                               |
| `POST /api/ever-connect/disconnect`                            | Disconnect (Ever Platform is told; the connection ends here in any case).  |
| `POST /api/ever-connect/integrations/refresh`                  | Read the integration states from Ever Platform again.                      |
| `POST /api/ever-connect/integrations/:key/accept` `{accepted}` | Accept or decline an installation-wide integration enabled in app.ever.co. |

## What connecting does

- The installation makes a **connect key** (an Ed25519 key pair, different from
  the anonymous-statistics key) and sends its public half with the code. The
  private half never leaves the installation; it signs the short-lived requests
  for the installation's access token, which is kept in memory only.
- The installation then reads its **event feed** (one replica at a time) and
  learns which integrations an organization turned on.
- Every integration needs a consent given in app.ever.co. Installation-wide
  integrations, such as Sign in with Ever ID, also wait for a platform
  administrator of this installation to accept them.
- Disconnecting ends every integration here, removes the stored Ever ID client
  and discards the connect key (a new connection makes a new key).

## Sign in with Ever ID

When Sign in with Ever ID is enabled for the installation in app.ever.co and
accepted here, the installation asks Ever Platform for its own sign-in client:

- **Sent:** the sign-in return address `<WEB_URL>/api/auth/ever-id/callback` and
  the back-channel logout address `<WEB_URL>/api/auth/ever-id/backchannel-logout`
  (both on the web host; the web hands logout notices to the API).
- **Received:** the issuer, the client id and the client secret. The secret is
  handed over once; it is stored (encrypted when `PLUGIN_SECRET_ENCRYPTION_KEY`
  is set) and never shown or logged.

The Ever ID sign-in (Settings → Ever ID) uses this client unless you configured
it yourself: any of `EVER_ID_ISSUER_URL`, `EVER_ID_CLIENT_ID` or
`EVER_ID_CLIENT_SECRET` keeps your own configuration. Turning Ever ID sign-in on
stays an administrator's step. When the integration ends (turned off or revoked
in app.ever.co, or the installation disconnects), the stored client is removed;
local accounts and their connected identities stay.

**Which accounts are linked:** when someone connects an Ever ID (at sign-up or
in Settings), signs in with it, or disconnects it, the installation tells Ever
Platform: the local account id, the Ever ID issuer and subject, that the person
linked it, and the account's tenant id. Never an e-mail address or a name. Ever
Platform records a link only for someone who signed in through this
installation's own client, so an Ever ID connected before the client existed is
reported at that person's next sign-in.

## People's export and deletion requests

When a person asks Ever Platform to export or delete their Ever ID data, each
connected installation that holds a link to them receives the request on its
feed. The request names the person only by hashes of their Ever ID identities.
The installation answers once per request:

- **Deletion:** the matching connected identities (and the sessions they
  opened) are removed. The accounts themselves are not deleted automatically
  yet, so the answer is `failed` with the reason `account_deletion_pending` and
  the account's Activity records it; delete the account here (Settings → Danger
  Zone) to finish. No matching account: `no_account`.
- **Export:** the answer is `failed` with `export_not_available` until a
  per-person export is wired in; the person can export their account here
  (Settings). No matching account: `no_account`.

An answer is never `retained_legal` without a stated legal basis, and a request
delivered again is answered with the same result.

## `/.well-known/ever-connect`

While the module is loaded, `GET /.well-known/ever-connect` answers `404`. It is
reserved for the statement Ever Platform reads while it checks an
installation's published address; that check is not active yet.

## Outbound calls

Every request goes to `EVER_PLATFORM_API_URL`, with the installation's token:

| When                             | Request                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| Connect                          | `POST /v1/connect/redeem`                                                              |
| Each request (token, every hour) | `POST /v1/instances/token`                                                             |
| Reading the feed                 | `GET /v1/instances/me/events`, `POST /v1/instances/me/events/ack`                      |
| Integration states               | `GET /v1/instances/me/integrations`, `POST /v1/instances/me/integrations/{key}/accept` |
| Sign in with Ever ID             | `POST` / `GET /v1/instances/me/oidc-client`                                            |
| Linked accounts                  | `POST /v1/instances/me/person-links`, `DELETE /v1/instances/me/person-links/{ref}`     |
| Answers to requests              | `POST /v1/instances/me/ack`                                                            |
| Disconnect                       | `POST /v1/instances/me/disconnect`                                                     |
