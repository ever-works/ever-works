---
id: custom-domains
title: Custom Domains
sidebar_label: Custom Domains
sidebar_position: 12
---

# Custom Domains

Custom Domains let you assign your own domain name to a work's deployed website. Instead of accessing your work at a provider-assigned URL (e.g., `my-work.vercel.app`), visitors can reach it at `work.yourdomain.com`.

:::tip When to use this
Use custom domains when you want a branded URL for your work — for example, `tools.mycompany.com` instead of a `.vercel.app` subdomain.
:::

## Prerequisites

- Work must be deployed to a provider that supports custom domains (e.g., Vercel)
- You must own or control the domain's DNS settings
- A deployment provider plugin must be enabled and configured

## How It Works

1. **Add domain** — register your domain via the API or dashboard. The domain is saved to the database.
2. **Sync to provider** — the platform pushes the domain to your deployment provider (e.g., Vercel).
3. **Configure DNS** — point your domain to the provider using the DNS records returned by the verification step.
4. **Verify** — trigger DNS verification to confirm your domain is correctly configured.
5. **Auto-promote** — once verified, if the work's current URL is a provider-assigned subdomain (e.g., `.vercel.app`), it is automatically updated to the custom domain.

### DNS Configuration

After adding a domain, configure your DNS based on the domain type:

| Domain Type                          | DNS Record                         | Example                           |
| ------------------------------------ | ---------------------------------- | --------------------------------- |
| Subdomain (e.g., `blog.example.com`) | `CNAME` pointing to provider       | `CNAME blog cname.vercel-dns.com` |
| Apex domain (e.g., `example.com`)    | `A` record pointing to provider IP | `A @ 76.76.21.21`                 |

The exact values depend on your deployment provider. Check the verification response for provider-specific DNS instructions.

### Provider Switching

Domain records are stored in the Ever Works database as the primary source of truth. If you switch deployment providers, your domain records persist and can be re-synced to the new provider.

## API

All endpoints require JWT or API key authentication and work edit permission.

### List Domains

| Method | Endpoint                        | Description                        |
| ------ | ------------------------------- | ---------------------------------- |
| `GET`  | `/api/deploy/works/:id/domains` | List all custom domains for a work |

```bash
curl http://localhost:3100/api/deploy/works/<work-id>/domains \
  -H "Authorization: Bearer <token>"
```

**Response:**

```json
{
	"domains": [
		{
			"domain": "tools.example.com",
			"verified": true,
			"environment": "production",
			"provider": "vercel"
		}
	]
}
```

### Add Domain

| Method | Endpoint                        | Description         |
| ------ | ------------------------------- | ------------------- |
| `POST` | `/api/deploy/works/:id/domains` | Add a custom domain |

```bash
curl -X POST http://localhost:3100/api/deploy/works/<work-id>/domains \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"domain": "tools.example.com"}'
```

**Request body:**

| Field    | Type   | Required | Description                             |
| -------- | ------ | -------- | --------------------------------------- |
| `domain` | string | Yes      | Domain name (e.g., `tools.example.com`) |

**Response** includes provider verification details (DNS records to configure).

### Remove Domain

| Method   | Endpoint                                | Description            |
| -------- | --------------------------------------- | ---------------------- |
| `DELETE` | `/api/deploy/works/:id/domains/:domain` | Remove a custom domain |

```bash
curl -X DELETE http://localhost:3100/api/deploy/works/<work-id>/domains/tools.example.com \
  -H "Authorization: Bearer <token>"
```

Removes the domain from both the database and the deployment provider.

### Verify Domain

| Method | Endpoint                                       | Description              |
| ------ | ---------------------------------------------- | ------------------------ |
| `POST` | `/api/deploy/works/:id/domains/:domain/verify` | Trigger DNS verification |

```bash
curl -X POST http://localhost:3100/api/deploy/works/<work-id>/domains/tools.example.com/verify \
  -H "Authorization: Bearer <token>"
```

**Response:**

```json
{
	"verified": true,
	"domain": "tools.example.com"
}
```

If DNS is not yet configured, `verified` will be `false`. Re-run verification after updating your DNS records.

## Domain Record Fields

| Field         | Type    | Description                                    |
| ------------- | ------- | ---------------------------------------------- |
| `domain`      | string  | The domain name                                |
| `verified`    | boolean | Whether DNS verification has passed            |
| `environment` | string  | Deployment environment (default: `production`) |
| `provider`    | string  | Which deployment provider manages this domain  |

## Related

- [Deployment](/api/deployment) — Work deployment and provider configuration
- [API Keys](./api-keys) — Programmatic authentication for domain management
- [Plugin System](/plugin-system/) — Deploy provider plugins (Vercel, etc.)
