---
id: app-runtime
title: 'App Builds & Deployments'
sidebar_label: Builds & Deployments
description: How an App Work is built and run — the four build strategies, builds in your own repository's GitHub Actions with the image in GitHub's container registry, the None, Your cluster and Ever Works Apps deploy targets, and the address it gets. A preview; this page says what runs today.
---

# App Builds & Deployments

An [App Work](./app-works.md) is built from its own repository and run on a **deploy target** you choose. This page covers the three pieces in order: how the image is produced, where it runs, and which address it answers on.

:::warning Preview — off by default
App Works are a **preview**, switched off on every installation until an operator turns them on — see the switches below. **In this preview an App Work cannot be built or deployed end to end:** nothing in the product starts a Build yet, and the worker that applies an App to a cluster refuses every Deployment it receives. This page describes the rules the platform already enforces, so you know what to expect, and says for each part what runs today.

| Switch                            | Read by                                      | Default          | What it does                                                                                                        |
| --------------------------------- | -------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `EVER_WORKS_APP_WORKS_ENABLED`    | API (and the web app when it has no PostHog) | `false`          | Only the exact value `true` turns App Works on.                                                                     |
| `works-app` (PostHog flag)        | Web app                                      | Off when missing | Gates the dashboard's **App** chip (not shipped yet). Fails closed: only a strict `true` shows it.                  |
| `EVER_WORKS_APP_LAUNCHER_ENABLED` | API                                          | `false`          | Turns on the [App Launcher](./app-launcher.md), where live App Works appear.                                        |
| `APP_WORKS_CLOUD_PUSH_ENABLED`    | API                                          | `false`          | Lets cloud agent runs push App Work branches — see [Evolving the app](./app-works.md#evolving-the-app-with-agents). |

Two more variables matter on this page: `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED` ([below](#the-isolated-worker)) and `EVER_WORKS_APPS_DOMAIN` ([below](#addresses)). All of them are in the [Environment Variables reference](../environment-variables.md#app-works-preview).
:::

## Builds

How the image is produced is the `build.strategy` of the [App spec](./app-works.md#the-app-spec):

| `strategy`   | What happens                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dockerfile` | A **Build** runs the repository's Dockerfile (`build.dockerfile`, default `Dockerfile`; optional `context`, `target` and `args`).                                                          |
| `auto`       | Reserved for a builder that works out how to build the repository by itself. No build plugin supports it yet, so a Build of an `auto` App spec is blocked (`strategyNotSupported`).        |
| `image`      | **No Build.** The Deployment runs the image named in `build.image`. Pin it by digest (`<repository>@sha256:<64 hex>`): a tag-only reference is a warning, and the managed tier refuses it. |
| `none`       | Nothing is built and there is nothing to deploy. Used by an App spec with no components.                                                                                                   |

### Where a Build runs

A Build runs in **your repository's own GitHub Actions**, through the `github-actions-build` plugin — not on Ever Works machines.

- The platform writes one workflow file, `.github/workflows/ever-works-build.yml`. On a fork or a private copy it commits the file straight to the Work's tracked branch. It opens a pull request from the branch `ever-works/build-workflow` instead, and never commits to the tracked branch, when the repository is linked, when the tracked branch is protected, or when you have edited the workflow file by hand.
- Every value the build needs from the platform travels as a **repository secret** named `EW_<NAME>`; no stored value is written into the workflow file. Literal build arguments you wrote in the App spec are written as they are.
- A pull request from another repository cannot run the build job, which is the only job that can read those secrets.
- The image is built and checked for leaked secrets in its metadata **before** it is pushed. It is then pushed to GitHub's container registry as `ghcr.io/<owner>/<repo>/ever-works-app`, tagged `sha-<commit>`.
- A Build counts as **deployable** only when it succeeded **and** the platform has confirmed its image digest against the registry. An unconfirmed digest never reaches a cluster.
- Builds that stall are picked up again by a sweep every 2 minutes (run by Trigger.dev when that is the job runtime, and by the API itself otherwise).

:::warning Builds spend your GitHub Actions minutes
A Build runs on GitHub's runners in the repository that holds the App Work, so its minutes are billed to that repository's owner under their own GitHub plan.
:::

On a fork or a private copy, the workflows inherited from the original project are switched off so they do not run on your account; the Ever Works build workflow is the one exception. See [What happens next](./app-works.md#what-happens-next).

**Today:** the build pipeline — preparing the repository, dispatching the workflow, watching the run, confirming the digest — is implemented, but **nothing in the product starts a Build**: there is no Builds tab, no Builds API route and no automatic trigger yet. An App spec with `strategy: image` does not need a Build.

## Deploy targets

Every App Work has one deploy target, chosen when it is created (the `deployProvider` field of the create request). There is no route to change it yet.

| Target                      | How you choose it                                                                       | What it means                                                                                                                                                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **None — don't deploy yet** | Leave `deployProvider` out. This is the default.                                        | Nothing runs anywhere. You can still let agents change the code. A deploy request is refused with `target_none`, and no license can refuse this target, because it runs nothing.                                                                                                                          |
| **Your cluster**            | Name the Kubernetes deployment plugin (`k8s`), configured with **your own** kubeconfig. | The App runs in a Kubernetes cluster you control, reached only with that Work's own kubeconfig. The platform's managed cluster sources are refused for an App Work. A passing cluster connection check must be on record before a Deployment starts; the route that runs that check is not available yet. |
| **Ever Works Apps**         | `deployProvider: "ever-works"`.                                                         | Hosting managed by Ever Works. **Not available:** creating with it is refused with `managed_hosting_unavailable`.                                                                                                                                                                                         |

See [Kubernetes Deployment](./k8s-deployment.md) for configuring the Kubernetes plugin itself.

### What your cluster receives

Each App Work gets its own namespace, named `ew-<slug>-<8 characters of the Work id>`. Inside it, the platform renders the App spec's components as Deployments with their Services and an Ingress, the App spec's `jobs` (such as migrations) as Jobs and its `cron` entries as CronJobs, plus the namespace's quota, limits, service account, configuration and secrets. By default the namespace also gets **default-deny network policies** with explicit allowances: traffic inside the namespace, DNS, outbound traffic to **public** addresses only (private, shared, link-local, loopback, multicast and reserved ranges are blocked, so an app cannot reach a host on a private network), ingress to the published components, and the app's own dependencies.

## Deploying

```bash
curl -X POST https://api.ever.works/api/works/<id>/deploy \
  -H "Authorization: Bearer $EVER_WORKS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

`POST /api/works/:id/deploy` needs **edit** access to the App Work. The body may name a `buildId` to deploy an earlier green Build, and `confirmClusterChange: true` when the cluster changed since the last connection check. The route never waits for the rollout:

| Answer                         | Meaning                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `202`                          | The Deployment was created and dispatched, or queued behind a running one (the latest request wins). The answer carries its id. |
| `409 APP_DEPLOY_IN_PROGRESS`   | Another Deployment holds the lock; the answer names it.                                                                         |
| `422 APP_DEPLOY_PRECONDITIONS` | Something must be fixed first. The answer lists **every** unmet precondition, not just the first.                               |
| `422 worker_not_isolated`      | No isolated worker is available — see [below](#the-isolated-worker). Nothing was created.                                       |
| `422 notAnAppWork`             | The Work is not an App Work. Other Works deploy through their own [deploy route](../api/deployment.md).                         |
| `404`                          | The Work does not exist, is not visible to you, or belongs to another account — one answer for all three.                       |

The preconditions you are most likely to see:

| Code                                                               | Meaning                                                                                                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `target_none`                                                      | The App Work's deploy target is **None**.                                                                                        |
| `target_not_checked`                                               | No passing cluster connection check is on record for the App Work.                                                               |
| `cluster_changed_unconfirmed`                                      | The check was made against a different cluster than the one the App runs on; send `confirmClusterChange: true`.                  |
| `spec_invalid`                                                     | Fix the errors on **Settings → App spec**.                                                                                       |
| `no_green_build`, `no_green_build_for_head`, `build_image_missing` | A `dockerfile` or `auto` App needs a green Build with a confirmed image — of the current commit, unless you name an earlier one. |
| `nothing_to_deploy`                                                | `build.strategy` is `none`.                                                                                                      |
| `env_required_unset`, `job_auth_env_unset`, `cron_auth_env_unset`  | A variable the App spec requires has no value.                                                                                   |
| `dependency_not_ready`                                             | A database or other dependency the app declares is not provisioned yet.                                                          |
| `license_attestation_missing`, `license_blocks_target`             | The [license](./app-works.md#licenses) does not allow this target yet.                                                           |
| `paused`, `deploy_in_progress`, `app_work_deleting`                | The App Work is paused, busy, or being deleted.                                                                                  |

### The isolated worker

A Deployment is carried out by a worker that talks to the cluster, never by the API process. In production that worker must be **attested** as isolated — an operator sets `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true` (default `false`) to state that it has no route to internal networks. Until then every deploy request answers `422 worker_not_isolated` and creates nothing. Outside production the worker is always treated as attested. A job runtime that can run the App deploy job is also required.

**Today:** the deploy route evaluates the preconditions above and, when they pass, dispatches the Deployment — but the worker re-checks them when it picks the Deployment up, and that re-check still stops at the isolated-worker step for every Deployment. The worker's runtime environment, image-pull credentials and cluster target are also not connected yet. So **no Deployment completes** in this preview.

## Addresses

A running App Work publishes one **primary** address, chosen in this order:

1. a custom domain set as the primary — and only while it is **verified**; an unverified domain is never published;
2. otherwise a **managed subdomain**, `<label>.<apps domain>`, when the Work holds a managed label;
3. otherwise no managed address — custom domains keep working.

The **apps domain** is `EVER_WORKS_APPS_DOMAIN`. When it is unset, it is the platform's own domain (`EVER_WORKS_DOMAIN`, default `ever.works`), so an App is served as `<label>.ever.works` out of the box. An operator who sets a dedicated apps domain must pick one that is not equal to, under, or a parent of the platform's own domain or the hosts of its API and web URLs; an unusable value logs an error and turns the managed subdomain off rather than guessing.

**Today:** the platform does not yet allocate a managed label or write its DNS record for an App Work, and a Deployment is what publishes an address — so no App Work has an address yet. See [Managed Hosting](./managed-hosting.md) and [Custom Domains](./custom-domains.md) for how other Works get theirs.

## Related

- [App Works](./app-works.md) — creating an App Work, the App spec, licenses, upstream sync and the change guard.
- [App Blueprints](./app-blueprints.md) — ready-made App specs, for example Umami's image-based one.
- [Kubernetes Deployment](./k8s-deployment.md) — the Kubernetes plugin, kubeconfigs and connection checks.
- [Custom Domains](./custom-domains.md) and [Managed Hosting](./managed-hosting.md) — how Works get their addresses.
- [Job Runtimes](./job-runtimes.md) — the engines that run Builds' and Deployments' background jobs.
