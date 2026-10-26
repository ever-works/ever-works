# @ever-works/digitalocean-machines-plugin

The first **machine-provider** plugin (Fleet epic FL-17, CONTRACTS R-15): cloud computers at
DigitalOcean that join your Fleet as ordinary computers, billed to **your own** DigitalOcean account.

- **Category / capability:** `machine-provider` / `machine-provider` (resolved only through
  `MachineProviderFacadeService`; core code never names this plugin).
- **Settings:** `apiToken` (secret, user scope — a personal access token with read and write scope),
  `defaultRegion` (user scope).
- **What it calls:** `GET /v2/account`, `GET /v2/regions`, `GET /v2/sizes`, `POST|DELETE /v2/account/keys`,
  `POST /v2/droplets`, `GET /v2/droplets[/{id}]`, `POST /v2/droplets/{id}/actions`, `DELETE /v2/droplets/{id}`,
  `GET /v2/customers/my/balance`. The base URL is fixed; the token goes only in the `Authorization` header.
- **Create:** the platform generates the first-boot `#cloud-config` (installs the node runtime and enrols with a
  one-time, 15-minute token). The plugin uploads a throwaway public key (whose private half nobody kept), creates
  the droplet (`ubuntu-24-04-x64`, monitoring on, tags `ever-works` + `ever-works-node:<nodeId>`) and deletes the
  key object again.
- **Billing:** DigitalOcean bills a droplet from creation until it is destroyed, also while powered off — the
  options say so (`billsWhileOff: true`) and the dialog shows it before Create.

Tests run against an in-memory fake of the API (`src/testing/fake-digitalocean-api.ts`):

```bash
pnpm --filter @ever-works/digitalocean-machines-plugin test
```
