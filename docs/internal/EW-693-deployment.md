# EW-693 — Dynamic Plugin Distribution: Deployment Notes

> **Operator runbook** for shipping the dual-mode platform image. Pairs
> with the spec at `docs/specs/features/dynamic-plugin-distribution/`.

## What ships

The platform image is dual-mode. The default build is **identical** to
pre-EW-693 — every plugin is bundled — and existing deployments don't
need to touch anything. Operators who want a leaner image and runtime
plugin installs opt in to **dynamic mode** at build time and runtime.

| Image variant | Build arg | Plugins in image | Runtime mode env |
| ------------- | --------- | ---------------- | ---------------- |
| **Bundled** (default) | `--build-arg PLUGIN_DISTRIBUTION_MODE=bundled` or omit | All plugins (`core` + `registry`) | `PLUGIN_DISTRIBUTION_MODE=bundled` (env) |
| **Dynamic** (opt-in) | `--build-arg PLUGIN_DISTRIBUTION_MODE=dynamic` | **Core only** (`distribution: 'core'` or `systemPlugin: true`) | `PLUGIN_DISTRIBUTION_MODE=dynamic` |

The Dockerfile sets the runtime `ENV PLUGIN_DISTRIBUTION_MODE` from the
build arg so a `dynamic` image runs in `dynamic` mode by default — but
the env var still wins. An operator can override at deploy time
(`PLUGIN_DISTRIBUTION_MODE=bundled` on a dynamic image) to disable
runtime installs without rebuilding.

## Dockerfile changes

`.deploy/docker/api/Dockerfile` has a single new step:

```dockerfile
ARG PLUGIN_DISTRIBUTION_MODE=bundled
RUN if [ "$PLUGIN_DISTRIBUTION_MODE" = "dynamic" ]; then \
        PLUGINS_DIR=/app/deploy/plugins node /app/scripts/strip-non-core-plugins.js; \
    else \
        echo "==> EW-693: bundled image (...) — keeping every plugin."; \
    fi
```

`scripts/strip-non-core-plugins.js` mirrors the SDK's
`resolvePluginDistribution` rule:

- `manifest.distribution === 'core'` ⇒ keep.
- `manifest.distribution === 'registry'` ⇒ remove.
- Else: `systemPlugin === true` ⇒ keep; everything else ⇒ remove.

The strip step is **idempotent**. Re-running it is safe.

## Runtime config (apps/api/src/config/constants.ts)

| Env var | Default | Purpose |
| ------- | ------- | ------- |
| `PLUGIN_DISTRIBUTION_MODE` | `bundled` | `bundled` (default) or `dynamic`. Anything else coerces to `bundled` (fail-safe). |
| `PLUGIN_REGISTRY_URL` | `https://registry.npmjs.org` | Primary npm-compatible registry. Self-hosters mirror to a private one and set this. |
| `PLUGIN_REGISTRY_GITHUB_URL` | `https://npm.pkg.github.com` | Secondary registry; used when an allowlist row's `source` is `github-packages`. |
| `PLUGIN_REGISTRY_TOKEN` | (unset) | Bearer token. SECRET. Pulled from a Kubernetes secret in prod. |
| `PLUGIN_INSTALL_DIR` | `/app/plugins` | Writable dir Node `import()`s installed plugins from. Must be writable in `dynamic` mode. |
| `FEATURE_DYNAMIC_PLUGINS` | `false` | Independent master switch for the dynamic-distribution feature surface (catalog endpoint, install/uninstall API). |

`config.plugins.validate()` runs at boot from
`AgentPluginsModule.forRootAsync` and **throws** when `dynamic` is
selected with both `PLUGIN_REGISTRY_URL` and `PLUGIN_REGISTRY_GITHUB_URL`
empty/whitespace. Better loud at boot than a confusing 502 on the first
install.

## Kubernetes manifest

`.deploy/k8s/k8s-manifest.prod.yaml` (api Deployment) ships two
additions for `dynamic` mode that are also safe for `bundled`:

1. **emptyDir volume mounted at `/app/plugins`**. Per-pod ephemeral —
   matches FR-13 (lazy install-on-use), no shared RWX volume required.
   For warm-start pods, swap `emptyDir` for a `persistentVolumeClaim`
   (`ReadWriteOnce`). 2 GiB sizeLimit covers ~40 distributable plugins
   at typical sizes; bump if your catalog is larger.
2. **`startupProbe` allowing ~5 minutes for boot reconcile warmup**
   (60 attempts × 5 s). The warmup is a no-op in `bundled` mode, so
   this is also safe there.

The existing `livenessProbe` and `readinessProbe` are unchanged.

The runtime envs (`PLUGIN_DISTRIBUTION_MODE`, `PLUGIN_REGISTRY_*`,
`PLUGIN_INSTALL_DIR`) belong in the deployment manifest's `env:` or in
a referenced Secret/ConfigMap. The exact wiring is operator-specific —
the manifest in this PR adds the volume + probe but leaves env config
to whichever workflow renders the deployment YAML for each cluster.

## Entrypoint / boot ordering

`apps/api/src/api.module.ts` `onApplicationBootstrap` now calls both:

```ts
async onApplicationBootstrap() {
    await this.pluginBootstrap.bootstrap();
    await this.pluginBootstrap.warmupDynamicPlugins(); // EW-693 / FR-13a
}
```

The HTTP server only starts serving **after** Nest finishes module
initialization, so `warmupDynamicPlugins()` completes before the
readiness probe can flip green. In `bundled` mode the warmup is an
explicit no-op (the installer's `distributionMode` check short-
circuits) so existing deployments see no behaviour change.

`.deploy/docker/api/entrypoint.sh` is unchanged — its only job is
forwarding to `node /app/dist/main`, and that one process now handles
both legacy bundled boot and EW-693 warmup.

## Vercel and other read-only-FS serverless targets

`PLUGIN_INSTALL_DIR` must be **writable** in `dynamic` mode — the
installer extracts tarballs and symlinks into `node_modules/`. Vercel
serverless functions run on a **read-only filesystem** (only `/tmp` is
writable, and it's ephemeral per invocation), so:

- **`bundled` mode is supported on Vercel** — every plugin is in the
  image, no FS writes happen at runtime.
- **`dynamic` mode is NOT supported on Vercel** without a writable
  persistent store. The installer would fail with `EROFS` on first
  install. If you must run dynamic mode on a serverless target, point
  `PLUGIN_INSTALL_DIR` at `/tmp` AND accept that every cold start
  re-installs every enabled plugin (a non-trivial latency hit).

The `app.ever.works` SaaS runs on Kubernetes (where the manifest in
this PR provisions the writable volume), so the Vercel constraint is
operator-self-host-only.

## Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| API boots, log shows `EW-693 boot warmup: pre-installing N dynamic plugin(s) from DB` then `EW-693 warmup failed for X: EROFS` | `/app/plugins` not writable | Add the `plugin-install-dir` emptyDir mount from `k8s-manifest.prod.yaml`, or set `PLUGIN_INSTALL_DIR` to a writable path. |
| API boots, every install returns 502 | Registry unreachable from pod | Verify pod can reach `PLUGIN_REGISTRY_URL`; set `PLUGIN_REGISTRY_GITHUB_URL` as fallback. |
| API refuses to boot with `PLUGIN_DISTRIBUTION_MODE=dynamic requires...` | Both registry URLs explicitly cleared | Set at least one of `PLUGIN_REGISTRY_URL` / `PLUGIN_REGISTRY_GITHUB_URL`. |
| Install returns 409 with "not permitted" | Non-first-party package missing allowlist row | `POST /api/admin/plugins/allowlist` (platform-admin only) with `{packageName, versionRange}`. |
| Install returns 424 | Integrity mismatch (FR-10) | Verify the version pin on the allowlist row matches what the registry serves; or clear the optional `integrity` field on the row and re-attempt. |

## What's deliberately NOT in this PR

- Facade adoption of the execution router (Phase 7) — the router is
  ready but per-facade switchover is a follow-up. Bundled mode is
  unaffected; dynamic mode's long-running calls still work because
  the router falls back to in-process when no facade routes through it.
- Hot unload / live re-instantiation of a plugin without process
  restart. Spec §6.
- Per-tenant private registries. Spec §6.
- Strong per-plugin sandboxing beyond Trigger.dev isolation. Spec §6.

See `docs/specs/features/dynamic-plugin-distribution/spec.md` §6 for
the full out-of-scope list and `plan.md` §10 for the phased rollout.
