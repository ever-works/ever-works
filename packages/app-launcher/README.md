# `@ever-works/app-launcher`

The **App Launcher** web component — the cross-platform panel that lists **Ever apps** and the
person's own apps (**APW-11**, T10–T12; `docs/specs/features/app-works/APW-11-app-launcher/`).

One framework-neutral custom element, one self-contained ESM file: Angular, React, Solid and plain
HTML pages load the same artifact (FR-45), and Ever Works mounts it in its header from P1.

```bash
pnpm --filter @ever-works/app-launcher build   # tsc --noEmit && tsup  -> dist/index.js
pnpm --filter @ever-works/app-launcher test    # vitest run && node scripts/check-size.mjs
```

## Using it

```html
<script type="module" src="./dist/index.js"></script>
<ever-app-launcher current="ever-works" theme="auto"></ever-app-launcher>
```

```ts
const launcher = document.querySelector('ever-app-launcher');

launcher.data = await (await fetch('/api/me/apps')).json(); // AppLauncherListResponse
launcher.strings = translations; // dashboard.appLauncher.* from apps/web/messages/*.json

launcher.addEventListener('ever-app-launcher:manage', () => router.push('/settings/app-launcher'));
launcher.addEventListener('ever-app-launcher:empty-action', (event) => {
	router.push(event.detail.action === 'createAppWork' ? '/works/new?kind=app' : '/works');
});
```

**The element never navigates on its own in host-fed mode.** `:manage`, `:retry` and
`:empty-action` are reports for the host to act on (FR-64); `:item-activate` is cancellable, and if
the host cancels it no tab opens (ACC-11-40). The only thing the element opens is a tile's own
stored address — exactly as stored, in a new tab, with `noopener noreferrer` and no referrer
(FR-30, FR-31, ACC-11-23).

The registry shapes are **not** redeclared here: `AppLauncherItem`, `AppLauncherListResponse` and the
section/chip/kind/status unions are re-exported from `@ever-works/contracts`
(`src/apps/app-launcher.ts`) as **types only**, so the built bundle still has no runtime dependency.
Set `data` from `GET /api/me/apps` and the element renders it; the limits (`APP_LAUNCHER_PIN_LIMIT`,
`APP_LAUNCHER_PANEL_*`) stay the contracts'.

## Two package-shape rules that are load-bearing

- **`noExternal: ['lit']` in `tsup.config.ts`.** tsup externalises `dependencies` by default, so
  without this line `dist/index.js` would keep a bare `import … from 'lit'`, the 30 KB measurement
  would be of an artifact that does not contain Lit, and a static fixture page with no import map
  could not resolve it (APW11-G15). `scripts/check-size.mjs` fails the test run if any bare import
  survives, and `ever-app-launcher.spec.ts` is not what catches it — the build is.
- **`useDefineForClassFields: false` in `tsconfig.json`.** The element uses Lit's
  `static properties` API, which installs prototype accessors; class fields defined with
  `Object.defineProperty` would shadow them and silently break reactivity. Both `tsc` and `tsup`
  read this from `tsconfig.json`.

## Licence note for the two dependencies this package adds

| Package     | Licence          | Why it is here                                                                                                                                                                                                      | Where             |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `lit`       | **BSD-3-Clause** | The component base class. It escapes interpolated values by default (FR-14: no catalog field is ever markup) and its production build is ~15 KB gzipped with this package's own code — inside FR-46's 30 KB budget. | `dependencies`    |
| `happy-dom` | **MIT**          | The DOM the Vitest suite registers, renders and focuses in (`vitest.config.ts` → `environment: 'happy-dom'`). Test-only, so it is a dev dependency and never reaches a consumer's install.                          | `devDependencies` |

Both are permissive and compatible with this package's AGPL-3.0 licence (`package.json`). This
package is `"private": true` in P1; the Wave 3 extraction and its publish credential are T28's.

> The repository's dependency inventory is `LICENSES.md`, whose "Credits" section points at a
> `CREDITS.md` **that does not exist in this tree** (`LICENSES.md:56`). Rather than invent that file
> from another owner's task, the note lives here, next to the package it describes — recorded as a
> finding for the coordinator.
