# Architecture: Web Dashboard (`apps/web`)

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers building or modifying dashboard
pages, server actions, plugin UIs, or i18n.

---

## 1. Purpose

The Ever Works dashboard is a Next.js 16 App Router application backed
by React 19, Tailwind CSS 4, and `next-intl`. It is the platform's
primary UI surface — every directory CRUD, plugin configuration,
generation kick-off, and member invitation flows through it. This spec
covers the **route structure**, **server-component vs client-component
strategy**, **server actions**, **API integration**, **i18n
plumbing**, **plugin form rendering**, and **auth integration**.

The user-facing `docs/web-dashboard/` tree (start with
[`dashboard-layout`](../../web-dashboard/dashboard-layout.md))
documents the visible behaviour of each page; this spec documents
the underlying mechanics.

## 2. Top-Level Structure

```
apps/web/src/
├── app/                              # Next.js App Router root
│   ├── layout.tsx                    # Root layout (no locale, just global)
│   ├── globals.css
│   ├── global-error.tsx              # Top-level error boundary
│   ├── not-found.tsx                 # Top-level 404
│   ├── favicon.ico
│   ├── [locale]/                     # Locale-prefixed routes (next-intl)
│   │   ├── layout.tsx                # Locale-aware layout
│   │   ├── (auth)/                   # Route group: login / register / forgot-password
│   │   ├── (dashboard)/              # Route group: authed pages
│   │   │   ├── layout.tsx
│   │   │   ├── layout-client.tsx     # Client wrapper for the dashboard chrome
│   │   │   ├── (home)/
│   │   │   ├── activity/
│   │   │   ├── directories/
│   │   │   ├── plugins/
│   │   │   ├── settings/
│   │   │   ├── error.tsx
│   │   │   └── toasts.tsx
│   │   └── [...rest]/                # Catch-all 404 inside locale
│   ├── actions/                      # Server actions (one file per domain)
│   └── api/                          # Next.js Route Handlers (BFF for client code)
├── components/                       # Cross-feature UI components
├── lib/                              # API client, schemas, helpers
├── hooks/
├── i18n/                             # next-intl config + locale files
├── messages/                         # Per-locale message bundles
└── middleware.ts                     # next-intl middleware + auth redirect
```

The two **route groups** (`(auth)`, `(dashboard)`) compose into the
locale segment without adding URL segments — `/en/login` resolves to
`(auth)/login/page.tsx`. Code organisation reads like the user
journey, URLs stay clean.

## 3. Locale & i18n Pipeline

`next-intl` drives every locale-aware piece of the app:

1. **`middleware.ts`** detects the locale from the URL path
   (`/en/...`, `/fr/...`) or the `accept-language` header for
   cold visits, and redirects `/login` → `/<default>/login`.
2. **`[locale]/layout.tsx`** receives the locale param, loads the
   matching message bundle from `messages/<locale>.json`, and wraps
   the tree in `<NextIntlClientProvider>`.
3. **Pages** call `getTranslations(namespace)` (server) or
   `useTranslations(namespace)` (client) to read messages.
4. **Server actions** access the locale via `getLocale()` so success /
   error messages localise correctly.

Locale set today: `en`, `fr`, `es`, `de`, `zh`, `ar`, `ru`, `pt`, `it`,
`nl`, `pl`, `bg`, `he` (per `apps/docs/docusaurus.config.ts` mirroring,
the dashboard subset is in `i18n/config.ts`).

A `scripts/translate-messages.mjs` job (run via `pnpm --filter
ever-works-web translate:messages`) feeds new English keys to a
machine translator and emits per-locale `messages/<locale>.json`
diffs. Human translators clean up before merge.

## 4. Server vs Client Components

The default is **server components** — rendering happens on the API
worker, RSC payload streams to the browser. The dashboard is mostly
data-display + form-submission, both of which fit RSC well.

A page becomes a **client component** (`'use client'` at the top)
only when it needs:

- Interactive widgets that React 19 still requires `useState`/`useEffect`
  for (drag-drop reordering, charts, autocomplete).
- Real-time data via WebSocket / SSE (live generation progress,
  AI conversation stream).
- localStorage / cookies read at render time (theme toggle, dismissed
  banner state).

Mixed pages are common: a server component for the data fetch + form
shell, with one or two client islands for the interactive bits.
Reference: every directory detail page composes this way.

## 5. Server Actions

`apps/web/src/app/actions/` holds **server actions** — async functions
marked `'use server'` that the dashboard's forms submit to. Each
action:

1. Resolves the current user via `auth()` (a thin wrapper over a
   server-side fetch that exchanges the session cookie for an
   `AuthenticatedUser`).
2. Calls the API via the typed `apiClient` in `lib/api/`.
3. Translates errors to localised user-facing messages.
4. Optionally calls `revalidatePath(...)` or `revalidateTag(...)` to
   bust the RSC cache for affected pages.
5. Returns a `{success, data?, error?}` shape forms can render
   inline.

Actions are **thin** — they don't hold business logic. The API enforces
permissions; the action just relays. This mirrors the
[`auth`](./auth.md) guard model — every business rule lives on the API
side, the dashboard is a presentation layer with auth-aware data
fetching.

## 6. The API Client

`lib/api/client.ts` exports a typed client wrapping `fetch`. Key
properties:

- **Type-safe** — every endpoint has a generated DTO type from
  `@ever-works/contracts` (zod schemas → TypeScript via
  `zod-to-json-schema`).
- **Cookie-aware** — server-side calls forward the session cookie;
  client-side calls automatically include credentials.
- **Error-typed** — non-2xx responses throw an `ApiError` with
  `status`, `code`, `message`, surfaced cleanly in actions.
- **Locale-aware** — sends `Accept-Language` so the API can localise
  error messages (the dashboard usually overrides them with its own
  locale, but consistent fallback matters).

Client-side direct calls (e.g. AI conversation streaming) go through
the same client via `'use client'` components that import from
`lib/api/client.ts`.

## 7. Plugin Form Rendering

The dashboard renders plugin settings forms **dynamically** from the
plugin's JSON Schema (see [Plugin SDK §8](./plugin-sdk.md) and
[Settings System](./settings-system.md)). The renderer:

1. Fetches the plugin's `settingsSchema` via
   `GET /api/plugins/:pluginId/schema`.
2. Walks the schema, mapping each property to a widget by `x-widget`
   or JSON Schema type:

    | Schema type / x-widget         | Widget          |
    | ------------------------------ | --------------- |
    | `string` / default             | Text input      |
    | `string` + `x-widget=password` | Password input  |
    | `string` + `enum`              | Select          |
    | `string` + `x-widget=textarea` | Textarea        |
    | `number`                       | Number input    |
    | `boolean`                      | Toggle          |
    | `object`                       | Nested fieldset |
    | `array`                        | Repeater        |

3. Applies `x-showIf` for conditional rendering.
4. Handles `x-secret` specially:
    - For an existing setting, shows a "set" badge + "rotate" button —
      never the value.
    - For a new value, shows a password input that submits via the
      `update` endpoint.
5. Validates client-side via Ajv (compiled at runtime from the same
   schema); the API runs a second validation pass.

The renderer lives in `components/plugin-settings/`. It's the same
component for admin / user / directory plugin pages — the differences
are in which scope endpoint the form posts to.

## 8. Auth Integration

The dashboard's auth flow:

1. **Login page** → POSTs credentials to the API → receives JWT +
   refresh token → server action sets HTTP-only session cookie →
   redirects to `(dashboard)`.
2. **`(dashboard)/layout.tsx`** runs `auth()` server-side. If no
   session, redirects to `/login`.
3. Every subsequent page call passes the session cookie; the API
   client unwraps it to a JWT for upstream calls.
4. **Refresh on 401** — the API client intercepts 401s, calls the
   refresh endpoint, retries the original request once.
5. **Logout** clears the cookie + invalidates the refresh token
   server-side.

OAuth login flows (GitHub, Google) are handled by API redirects — the
dashboard sends the user to `/api/auth/<provider>/start`, the API
handles the round-trip, then redirects back to a dashboard route
with a fresh session cookie.

See [`auth`](./auth.md) for the API-side counterpart.

## 9. Real-Time UI

Two real-time surfaces:

| Surface             | Transport                    | Used for                        |
| ------------------- | ---------------------------- | ------------------------------- |
| Generation progress | WebSocket (`/ws/generation`) | Live step-by-step status + cost |
| AI chat             | NDJSON over `fetch` stream   | Token-by-token AI conversation  |

Both are read by client components only. The server-side dashboard
boots into RSC; client islands subscribe after hydration.

The WebSocket protocol mirrors the executor's `pipeline:state-changed`
events from [`pipeline-executor`](./pipeline-executor.md#4-state-machine).
Each event is a JSON message that updates a Zustand store; the UI
re-renders only the affected components via `useSyncExternalStore`.

## 10. Forms & Mutation Flow

Most forms follow the **server-action submit + revalidate** pattern:

```tsx
'use client';
function CreateDirectoryForm() {
	const [state, formAction] = useActionState(createDirectoryAction, null);
	return (
		<form action={formAction}>
			<input name="name" />
			<button>Create</button>
			{state?.error && <p>{state.error}</p>}
		</form>
	);
}
```

The `useActionState` hook gives forms inline error/success state
without managing it manually. After success, the action calls
`revalidatePath('/directories')` and `redirect('/directories/<slug>')`.

Complex client-side state (multi-step wizards, drag-drop) uses
**Zustand** stores scoped to the page; we deliberately avoid Redux.

## 11. Styling

- **Tailwind CSS 4** — utility-first via `@tailwindcss/postcss`. New
  in v4: `@theme` CSS-based configuration (no JS config file
  needed).
- **shadcn/ui** components — under `components/ui/`. We use the
  `radix` base to get accessibility primitives.
- **CSS variables** for theming — `--primary`, `--background`,
  `--foreground` etc. drive light/dark mode.
- **`tailwind-merge`** to dedupe conflicting class names in dynamic
  composition.

The design system is documented in
[`docs/web-dashboard/ui-component-library.md`](../../web-dashboard/ui-component-library.md).

## 12. Testing

| Layer             | Tool       | Run                              |
| ----------------- | ---------- | -------------------------------- |
| End-to-end        | Playwright | `cd apps/web && pnpm test:e2e`   |
| Visual regression | Playwright | `pnpm test:e2e -- --grep visual` |

There are deliberately **no unit tests for components** — the
dashboard is mostly composition over the API and `next-intl`; integration
tests catch real bugs faster than React-Testing-Library mocks would.

The Playwright suite covers:

- Login / register / forgot-password flows (with mocked OAuth providers).
- Directory creation in all three methods (AI / Manual / Import).
- Plugin settings save + read-back across all three configuration modes.
- Member invite + role-update + leave flows.
- Generation cancellation.
- Custom domain add + verify (against a mocked Vercel API).

## 13. Performance Practices

- **RSC by default** — server-rendering keeps client bundles small.
- **`next/dynamic`** for charts / heavy editors (Monaco for prompt
  overrides) — see
  [`docs/web-dashboard/components.md`](../../web-dashboard/components.md).
- **`use cache`** directive for server-side memoisation of
  expensive RSC fetches (Next.js 16 cache components).
- **Image optimisation** via `next/image` with width/height always
  declared.
- **No barrel imports** — components import from explicit paths to
  keep tree-shaking honest.

## 14. Constitution Reconciliation

| Principle                   | How the dashboard respects it                                                       |
| --------------------------- | ----------------------------------------------------------------------------------- |
| I — Plugin-first            | Plugin forms render from each plugin's schema — no hardcoded UI per plugin.         |
| II — Capability-driven      | Provider pickers query "plugins with capability X" via the API.                     |
| III — Source-of-truth repos | The dashboard never reads / writes user repos directly — always via the API.        |
| IV — Trigger.dev            | Long-running operations are dispatched via the API; the dashboard polls or streams. |
| V — Forward-only migrations | N/A (no DB).                                                                        |
| VI — Tests                  | Playwright e2e covers the user-visible surface.                                     |
| VII — Secret hygiene        | Secret values never enter the dashboard's RSC tree; password widgets handle them.   |
| VIII — Plugin counts        | The plugin grid renders from the live registry, not a hardcoded list.               |
| IX — Behaviour-first        | This spec describes observable dashboard behaviour.                                 |
| X — Backwards-compat        | New plugin schemas render via the same renderer; new server actions are additive.   |

## 15. References

- Source:
    - `apps/web/src/app/`
    - `apps/web/src/components/`
    - `apps/web/src/lib/api/`
    - `apps/web/src/i18n/`
- User docs:
    - [`docs/web-dashboard/dashboard-layout.md`](../../web-dashboard/dashboard-layout.md)
    - [`docs/web-dashboard/server-actions.md`](../../web-dashboard/server-actions.md)
    - [`docs/web-dashboard/ui-component-library.md`](../../web-dashboard/ui-component-library.md)
- Related specs:
    - [`auth`](./auth.md)
    - [`plugin-sdk`](./plugin-sdk.md)
    - [`settings-system`](./settings-system.md)
    - [`pipeline-executor`](./pipeline-executor.md)
