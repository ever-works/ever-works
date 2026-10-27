---
id: creating-machine-provider-plugin
title: 'Creating a Machine-Provider Plugin'
sidebar_label: 'Machine-Provider Plugin'
sidebar_position: 12
---

# Creating a machine-provider plugin

A **machine provider** creates cloud computers: machines at a cloud provider, on the owner's **own** account, that
install the Ever Works node on first boot and enrol themselves into the Fleet. The first one is
[`digitalocean-machines`](./built-in-plugins.md#machine-providers). This page is the contract review for a second one —
what the platform hands a provider, what it expects back, and the two promises a provider makes about money:
`billsWhileOff` and `usage`.

The capability is `machine-provider` (`PLUGIN_CAPABILITIES.MACHINE_PROVIDER`); the category is `machine-provider`. The
platform reaches every provider through `MachineProviderFacadeService` and never names one: user copy reads the
plugin's own `providerName`. The interface is `IMachineProviderPlugin` in
`packages/plugin/src/contracts/capabilities/machine-provider.interface.ts`.

## What the platform does, and what it leaves to you

The platform owns everything that is about Ever Works:

- the **registration** — written before you are called, so a create you never answer is still visible (and is marked
  failed after ten minutes);
- the **bootstrap script** — `#cloud-config` user data that installs the chosen software and the pinned node runtime,
  writes a one-time, 15-minute enrolment token to a private file, enrols by file and starts the runtime with
  `--work --manage`;
- the **price check** — a create is refused when the price the person (or Agent) acknowledged differs from what your
  `listOptions` answers now;
- the **cost model** — per second from the hourly list price, capped at the monthly list price per calendar month;
- the **idle policy**, the **kill switch**, the **audit rows** and every confirmation.

You own only the conversation with the provider: list what can be created, create it, power it, destroy it, read it
back, and — where you can — say what the account has spent.

## The methods

| Method                               | What it must do                                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isConfigured(settings)`             | True when the settings carry what you need (a token, or a completed sign-in).                                                                                                                                                         |
| `listOptions(settings)`              | Regions, sizes with **list prices in cents** (`priceHourlyCents` may be fractional, `priceMonthlyCents` is whole), the software presets you can boot, `billsWhileOff`, `currency`, the account label and the image label.             |
| `create(input, settings)`            | Create the machine with `input.bootstrapScript` as its first-boot user data **untouched**, every tag in `input.tags`, and `input.publicKey` (if given) as its only login key. Answer the machine's id (`machineRef`) and state.       |
| `power(ref, action, settings)`       | `action` is `on` or `off`: a power-on, or a graceful power-off. Resolve once the provider accepted it; the platform polls `getMachine` for the result.                                                                                |
| `destroy(ref, settings)`             | Delete the machine and its disk. A machine that is already gone **resolves**.                                                                                                                                                         |
| `getMachine(ref, settings)`          | The machine as the provider knows it — `state: 'gone'` when it no longer exists (a 404 is `gone`, not an error). Include `regionId` / `sizeId` when the provider reports them: reconciliation uses them to price a machine it adopts. |
| `listTagged(tag, settings)`          | Every machine carrying `tag`, with its tags. Reconciliation calls it with `ever-works` to repair rows and find unclaimed machines.                                                                                                    |
| `usage(refs, settings)` _(optional)_ | The provider's own month-to-date figure for the account, in cents, when the token may read it.                                                                                                                                        |

Every changing method is idempotent by `ref`. Refuse with `MachineProviderError(code, hint)`: the hint is shown to the
person as `<providerName>: <hint>`, so make it one plain line ("droplet limit reached for this account") and never put
a token, a body or a header in it.

## Secrets and keys

- The API token is a plugin setting with `x-secret: true` and `x-scope: user`. It reaches you in `settings` on every
  call and must go nowhere but the provider's `Authorization` header — never a log line, an error, or a response.
- The bootstrap carries the enrolment token. Pass it through and never log it.
- `publicKey` is a throwaway: its private half was discarded before you were called. If the provider needs a key
  object to avoid emailing a root password, create it for the call and delete it again afterwards (the first provider
  does exactly this). Never ask the platform for a private key; there is none.
- Sign-in with the provider (`oauth`) is optional and env-gated: advertise the `oauth` capability from a getter only when
  the operator registered an application (client id **and** secret set), as `digitalocean-machines` and the deployment
  plugins do, and list `oauth` in the manifest's capabilities too (the registry indexes the manifest). Name the
  admin-scope settings `clientId` / `clientSecret` (with `x-envVar`) — the platform's OAuth service reads exactly those.
  After a sign-in the facade hands you the stored access token as `settings.oauthAccessToken`; prefer a saved
  `apiToken` when both exist. The token path must keep working without sign-in.

## Tags

`input.tags` always contains `ever-works`, `ever-works-node:<nodeId>` and `ever-works-site:<fingerprint>` (the
deployment that created it). Attach all of them, converted only as far as the provider's tag alphabet requires.
Reconciliation recognises a machine by them: a machine tagged with a Node that has no reference recorded is repaired; a
machine carrying this deployment's site tag that no registration knows is shown to its owner as **unclaimed** with
Destroy. A machine without this deployment's site tag is never touched — it may belong to another Ever Works
deployment on the same account.

## `billsWhileOff` — what a powered-off machine costs

Answer `true` when the provider keeps billing a powered-off machine at its size (most do: the disk, the address and the
reservation stay). The platform then

- says so before every power-off ("<provider> still bills this size while it is off");
- keeps counting the machine's cost while it is off;
- words the idle policy's "powered off" item as "it still bills while off", and points at Destroy as the way to stop
  the bill.

Answer `false` only when the provider genuinely stops billing a powered-off machine; the cost model then counts only
the running stretches of the machine's power timeline.

## `usage` — the provider's own figure

`usage` is the provider's **account-wide** month-to-date spend, not a per-machine bill: it covers everything on the
account, including machines Ever Works did not create. The platform reads it once per provider and owner every ten
minutes and shows it **beside** its own estimate, labelled as the provider's — it is never added to the estimate and
never reaches model-spend Budgets. Answer `{ source: 'provider' }` without a figure when the token may not read billing
(a 403 is not an error). Leave `usage` out entirely when the provider has no such figure.

## Testing

Ship an in-memory fake of the provider's API (`src/testing/`), and specs for: options mapped to cents; create sends the
tags, the user data and the throwaway key (and deletes the key object); destroy idempotent on 404; `getMachine` 404 →
`gone`; power sequencing; the token never in an error or a log; `oauth` advertised only with both env values set. The
repo-level guard `machine-provider.facade.guard.spec.ts` fails if core code names your plugin id.

## See also

- [Cloud computers](../features/fleet-cloud-computers.md) — what a person sees.
- [Built-in plugins › Machine Providers](./built-in-plugins.md#machine-providers) — the plugin count and settings.
- [Creating a plugin](./creating-a-plugin.md) — the manifest, settings schema and packaging every plugin shares.
