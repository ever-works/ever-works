---
id: k8s-deployment
title: Kubernetes Deployment
sidebar_label: Kubernetes Deployment
sidebar_position: 13
---

# Kubernetes Deployment

Deploy your works to a Kubernetes cluster you control, as an alternative to the default Vercel deployment provider. Once configured, publishing a work builds a container image, pushes it to your registry, and applies a `Deployment`, `Service`, and (optionally) `Ingress` to your cluster.

:::tip When to use this
Use the Kubernetes provider when you need to host on your own infrastructure — your own EKS / GKE / AKS / k3s cluster, an on-prem cluster, or a managed K8s offering — rather than a managed PaaS like Vercel. Choose Vercel for the fastest path to a public URL with no infrastructure to operate.
:::

## Prerequisites

- A Kubernetes cluster running version **1.27 or newer**.
- A `kubeconfig` file with permissions to create/patch `Deployment`, `Service`, `Ingress`, and `Secret` resources in your target namespace.
- A container registry. By default Ever Works uses **GitHub Container Registry** (`ghcr.io`) reusing the GitHub account you already connected — no extra setup required. You can also pick **Docker Hub** or any **generic** OCI registry (Harbor, Quay, GitLab CR, self-hosted) and supply credentials.
- _(Optional)_ An Ingress controller installed in the cluster — for example, **ingress-nginx**, **Traefik**, or any class supported by your cloud. Ever Works probes the cluster on save and lists every detected `IngressClass` for you to choose from. Without an Ingress controller, your work is exposed via a `Service` only.
- _(Optional)_ `cert-manager` with a `ClusterIssuer` if you want automatic TLS for custom domains.

## How it works

1. **Configure once** — paste your `kubeconfig` and registry credentials in the Kubernetes plugin settings.
2. **Pick the provider** — set `deployProvider: k8s` on a work (Settings → Deployment, or `.works/works.yml`).
3. **Deploy** — the platform builds a container image of your generated website, pushes it to your registry with a deterministic tag, and applies the manifests to your namespace using server-side apply.
4. **Status** — the deployment facade polls the rollout state. Once the `Deployment` is `Available`, your work is reported as `ready`.
5. **Redeploy** — subsequent deploys are rolling updates of the same `Deployment`, so previous versions stay in the rollout history.

## Configure the plugin

1. Open **Settings → Plugins → Deployment** (`/en/settings/plugins/deployment`).
2. Find the **Kubernetes** card and click **Configure**.
3. Fill in the form:

| Field                    | Required | Notes                                                                                                                                                                                    |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **kubeconfig**           | yes      | Paste the contents of your `~/.kube/config` (or a service-account-scoped equivalent). Stored encrypted, never returned by the API.                                                       |
| **Context**              | no       | Defaults to the kubeconfig's `current-context`. Set this if you want to target a non-default context without editing the file.                                                           |
| **Namespace**            | no       | Defaults to `ever-works`. The namespace must already exist or your kubeconfig must have permission to create it.                                                                         |
| **Registry**             | no       | Defaults to **GitHub Container Registry** using your connected GitHub account. Switch to **Docker Hub** or **Generic** to use a different registry. See [Registries](#registries) below. |
| **Ingress class**        | no       | Populated from your cluster's `IngressClass` resources. Leave blank to use the cluster default.                                                                                          |
| **Default ingress host** | no       | Used when a work has no custom domain configured.                                                                                                                                        |
| **TLS issuer**           | no       | Name of a cert-manager `ClusterIssuer`. Adds the necessary annotations on the Ingress.                                                                                                   |
| **Replicas**             | no       | Defaults to `1`. Min 1, max 10 in v1.                                                                                                                                                    |

4. Click **Save & verify**. The platform validates the kubeconfig against the cluster API and reports back the cluster name, server URL, Kubernetes server version, and the list of ingress controllers it detected.

## Registries

You can deploy to any OCI-compatible registry. Three kinds ship today:

### GitHub Container Registry (default)

If you've already connected your GitHub account (most users have, since GitHub is also the default git provider), the plugin pushes images to `ghcr.io/<your-github-owner>/<work-slug>` automatically. The deploy workflow authenticates to GHCR with the workflow's built-in `GITHUB_TOKEN`.

- **Owner**: defaults to your GitHub login. Override with an org you have package-write access to.
- **Visibility**: defaults to **`auto`** — the image's visibility mirrors your website repository:
    - **Public website repo** → public image. No pull secret needed in your cluster; the Deployment has no `imagePullSecrets`.
    - **Private website repo** → private image. Ever Works provisions an `imagePullSecret` in the target namespace using a fine-grained `read:packages` token from your GitHub plugin settings.
    - You can override this by setting `visibility` to `public` or `private` explicitly.

If GitHub isn't connected, Ever Works tells you to connect it first and links you to the GitHub plugin's OAuth flow.

### Docker Hub

- **Username** + **access token** (a PAT with `read:packages, write:packages`). The token is stored encrypted; it's never returned by the API.

### Generic (Harbor, Quay, GitLab CR, self-hosted, …)

- **Server URL** (e.g. `registry.example.com`)
- **Username** + **password** / token

Adding a new registry kind (ECR/GCR/ACR or anything else) is a small contribution to `packages/plugins/k8s/src/registries/` — no contract change required.

## Ingress controllers

When you save a kubeconfig, Ever Works lists every `IngressClass` your cluster exposes:

- **ingress-nginx** — Ever Works adds nginx-specific annotations (TLS redirect, body size, …).
- **Traefik** — Ever Works adds Traefik router/entrypoint annotations.
- **Anything else** — falls back to a vanilla `Ingress`. Adding a new strategy is a small contribution to `packages/plugins/k8s/src/ingress/`.

If your cluster has multiple controllers, pick which one this work's Ingress should use. Leaving the field blank uses the cluster's default `IngressClass`.

:::warning kubeconfigs with `exec` plugins
Kubeconfigs that rely on `users[].user.exec` (for example, `aws-iam-authenticator`, `gke-gcloud-auth-plugin`, or Azure CLI auth) will not work in our deploy workflow runner — there is no `aws`/`gcloud`/`az` binary on the runner. Use a static service-account token kubeconfig instead. Generate one with:

```bash
# Create the namespace first if it doesn't exist
kubectl create namespace ever-works

# Service account scoped to the deployment namespace
kubectl create serviceaccount ever-works -n ever-works

# Namespace-scoped binding — DO NOT use `clusterrolebinding`; that would
# give the token write access to every namespace in the cluster.
kubectl create rolebinding ever-works \
  --clusterrole=edit \
  --serviceaccount=ever-works:ever-works \
  -n ever-works

# Then mint a token and embed it in a kubeconfig:
#   kubectl create token ever-works -n ever-works --duration=8760h
```

:::

## Pick the provider for a work

Either via the dashboard (Work → Settings → Deployment → Provider → **Kubernetes**) or in your work's `.works/works.yml`:

```yaml
deployProvider: k8s
```

The same `deployProvider` field works for any deploy plugin (`vercel`, `k8s`, future providers). When `.works/works.yml` and the dashboard disagree, the data repo wins (Ever Works treats the data repo as the source of truth) and a `deploy_provider_conflict` activity-log entry tells you about the change.

Once selected, the **Deploy** button on the work runs through the Kubernetes plugin instead of Vercel.

## Custom domains

Custom domains work the same way as on Vercel — see [Custom Domains](./custom-domains.md). For Kubernetes, the platform:

- Patches your work's `Ingress` to add the new host.
- Returns DNS guidance: a `CNAME` to the cluster's load-balancer hostname for subdomains, or an `A` record to the LB IP for apex domains.
- Verifies by resolving DNS and checking the answer points back at your cluster's ingress LB.

If you've configured a `tlsIssuer`, the Ingress is annotated for cert-manager and a TLS section is added; cert-manager will provision a certificate once DNS verifies.

## What gets applied to your cluster

For each deployed work, the plugin maintains:

| Resource                     | Name               | Notes                                                     |
| ---------------------------- | ------------------ | --------------------------------------------------------- |
| `Deployment`                 | `<work-slug>`      | Single container, port 3000, configured `replicas`.       |
| `Service`                    | `<work-slug>`      | Always `ClusterIP`, port 80 → 3000.                       |
| `Ingress`                    | `<work-slug>`      | Only if `ingressHost` or a verified custom domain exists. |
| `Secret` (`docker-registry`) | `<work-slug>-pull` | Only if registry credentials are set (private images).    |

:::note Reaching the work without an Ingress
The Service is always `ClusterIP` — it is **not** reachable from outside the cluster on its own. To make the work publicly accessible you need either (a) an `Ingress` (set `ingressHost` or a custom domain), or (b) a temporary `kubectl port-forward svc/<work-slug> 8080:80 -n <namespace>` for local testing. v1 does not auto-create a `LoadBalancer` Service — it would require a cloud-provider-specific load balancer dependency that not every cluster has.
:::

All resources carry these labels:

```
ever-works.io/managed: "true"
ever-works.io/work-id: "<work-id>"
app.kubernetes.io/name: "<work-slug>"
```

You can hand-edit fields the plugin doesn't own; we use server-side apply with field manager `ever-works-k8s-plugin`, so your edits won't be clobbered. To take ownership of a field the plugin owns, run `kubectl apply --force-conflicts`.

## Switching providers

If a work was deployed to Vercel and you switch it to Kubernetes (or vice-versa):

- **Custom domain rows persist** — they're stored in the platform DB. The next deploy on the new provider re-syncs them.
- **The old deployment is not torn down automatically** — clean up Vercel projects or Kubernetes resources manually.

## Troubleshooting

- **"kubeconfig YAML is invalid"** — the file isn't valid YAML. Try `kubectl --kubeconfig=path config view` locally first; if that errors, fix the file.
- **"kubeconfig is missing a current-context"** — set `current-context:` in the file or fill the **Context** field.
- **"x509: certificate has expired"** — your cluster CA or client cert is expired; regenerate the kubeconfig.
- **"403 Forbidden" applying manifests** — your service account lacks `edit` on the namespace. Bind it with `kubectl create rolebinding`.
- **Deploy stuck at `deploying`** — the new pod isn't passing readiness. `kubectl -n <ns> describe pod -l app.kubernetes.io/name=<slug>` to see why; the deploy facade gives up after ~10 minutes and reports `error`.
- **Image pull `ErrImagePull`** — registry credentials are wrong, or the registry is unreachable from the cluster. Verify with `kubectl run debug --image=<image>:<tag> --rm -it`.

## Limits and out-of-scope (v1)

- **One cluster per user.** All your works that target Kubernetes deploy to the same cluster (the kubeconfig you save in plugin settings). Per-work cluster overrides are not supported in v1; ask if you need them.
- **Single cluster per work.** Multi-cluster failover is not in v1.
- **Stateless only.** No databases or stateful workloads — the website is stateless.
- **No Helm/Kustomize input.** The plugin renders its own manifests; if you need custom manifests, edit the website template's `k8s/` folder.
- **No GitOps mode.** Argo CD / Flux integration is a separate, future feature.
- **No cluster provisioning.** Bring your own cluster, ingress controller, and (optionally) cert-manager.
- **Cloud-provider registries (ECR/GCR/ACR) and ingress controllers beyond nginx + Traefik are post-v1.** The registry/ingress strategy registries are the extension points — contributions welcome.

## See also

- [Custom Domains](./custom-domains.md)
- [Website Templates](./website-templates.md)
- [Plugin System](../plugin-system/built-in-plugins.md)
- Spec: [`docs/specs/features/k8s-deployment/spec.md`](../specs/features/k8s-deployment/spec.md)
- Plan: [`docs/specs/features/k8s-deployment/plan.md`](../specs/features/k8s-deployment/plan.md)
