import { css, unsafeCSS } from 'lit';

/**
 * The element's shadow-root CSS — plan §6.3 and FR-46.
 *
 * Two rules of the host contract live here:
 *
 *  - **No global style is emitted.** Everything is scoped to the shadow root and
 *    the host's page is themed through custom properties (FR-46, asserted by
 *    `ever-app-launcher.spec.ts`'s "adds no style to the host document").
 *  - **No layout shift.** The skeleton tiles carry the same `.tile` class as the
 *    real ones, so the 88 px height (FR-5) is one declaration, not two.
 *
 * Documented host-facing custom properties:
 *
 * | Property                             | Default        | What it colours                    |
 * | ------------------------------------ | -------------- | ---------------------------------- |
 * | `--ever-app-launcher-bg`             | `#ffffff`      | panel and tile background          |
 * | `--ever-app-launcher-fg`             | `#16181d`      | text                               |
 * | `--ever-app-launcher-muted`          | `#5b6472`      | hosts, chips, helper copy          |
 * | `--ever-app-launcher-accent`         | `#2563eb`      | focus ring and hover accent        |
 * | `--ever-app-launcher-border`         | `#e3e6eb`      | tile and panel borders             |
 * | `--ever-app-launcher-hover`          | `#f1f3f7`      | hover and skeleton fill            |
 * | `--ever-app-launcher-radius`         | `10px`         | panel and tile corners             |
 * | `--ever-app-launcher-font`           | system UI      | typeface                           |
 * | `--ever-app-launcher-tile-height`    | `88px`         | tile height (FR-5: never shifts)   |
 *
 * Expressed as one plain string so the size/coverage checks and this module's
 * spec can read the stylesheet a host actually loads, and converted to a
 * `CSSResult` for Lit with `unsafeCSS` (the value is a frozen constant in this
 * file — there is no interpolation, which is the only thing `unsafeCSS` warns
 * about).
 */
export const EVER_APP_LAUNCHER_STYLES = `
:host {
	--ever-app-launcher-bg: #ffffff;
	--ever-app-launcher-fg: #16181d;
	--ever-app-launcher-muted: #5b6472;
	--ever-app-launcher-accent: #2563eb;
	--ever-app-launcher-border: #e3e6eb;
	--ever-app-launcher-hover: #f1f3f7;
	--ever-app-launcher-radius: 10px;
	--ever-app-launcher-font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
	--ever-app-launcher-tile-height: 88px;
	display: inline-block;
	position: relative;
	font-family: var(--ever-app-launcher-font);
	color: var(--ever-app-launcher-fg);
}

:host([theme='dark']) {
	--ever-app-launcher-bg: #16181d;
	--ever-app-launcher-fg: #f5f7fa;
	--ever-app-launcher-muted: #9aa4b2;
	--ever-app-launcher-accent: #7aa2ff;
	--ever-app-launcher-border: #2c313a;
	--ever-app-launcher-hover: #232830;
}

@media (prefers-color-scheme: dark) {
	:host([theme='auto']) {
		--ever-app-launcher-bg: #16181d;
		--ever-app-launcher-fg: #f5f7fa;
		--ever-app-launcher-muted: #9aa4b2;
		--ever-app-launcher-accent: #7aa2ff;
		--ever-app-launcher-border: #2c313a;
		--ever-app-launcher-hover: #232830;
	}
}

.trigger {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 36px;
	height: 36px;
	padding: 0;
	border: 1px solid transparent;
	border-radius: var(--ever-app-launcher-radius);
	background: transparent;
	color: inherit;
	cursor: pointer;
}

.trigger:hover,
.trigger[aria-expanded='true'] {
	background: var(--ever-app-launcher-hover);
}

.trigger:focus-visible {
	outline: 2px solid var(--ever-app-launcher-accent);
	outline-offset: 2px;
}

.trigger-icon,
.trigger-icon svg {
	display: block;
	width: 20px;
	height: 20px;
}

.panel {
	position: absolute;
	z-index: 60;
	top: calc(100% + 8px);
	right: 0;
	display: flex;
	flex-direction: column;
	gap: 8px;
	box-sizing: border-box;
	width: 360px;
	max-width: min(92vw, 420px);
	max-height: min(70vh, 560px);
	overflow-y: auto;
	padding: 12px;
	border: 1px solid var(--ever-app-launcher-border);
	border-radius: var(--ever-app-launcher-radius);
	background: var(--ever-app-launcher-bg);
	box-shadow: 0 12px 32px rgb(0 0 0 / 18%);
}

.panel[hidden] {
	display: none;
}

.panel-title {
	margin: 0;
	font-size: 13px;
	font-weight: 700;
	letter-spacing: 0.02em;
}

.grid {
	display: grid;
	gap: 8px;
	grid-template-columns: repeat(2, minmax(0, 1fr));
}

.section {
	display: contents;
}

.section-heading {
	margin: 4px 0 0;
	font-size: 11px;
	font-weight: 700;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: var(--ever-app-launcher-muted);
}

.tiles {
	display: contents;
}

.tile {
	box-sizing: border-box;
	display: flex;
	align-items: center;
	gap: 8px;
	height: var(--ever-app-launcher-tile-height);
	min-height: var(--ever-app-launcher-tile-height);
	padding: 8px;
	overflow: hidden;
	border: 1px solid var(--ever-app-launcher-border);
	border-radius: var(--ever-app-launcher-radius);
	background: var(--ever-app-launcher-bg);
	color: inherit;
	font: inherit;
	text-align: left;
	text-decoration: none;
	cursor: pointer;
}

.tile:hover {
	background: var(--ever-app-launcher-hover);
}

.tile:focus-visible {
	outline: 2px solid var(--ever-app-launcher-accent);
	outline-offset: 2px;
}

.tile[aria-disabled='true'] {
	cursor: not-allowed;
	opacity: 0.6;
}

.tile-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	flex: 0 0 32px;
	width: 32px;
	height: 32px;
	overflow: hidden;
	border-radius: 8px;
	background: var(--ever-app-launcher-hover);
	font-size: 13px;
	font-weight: 700;
}

.tile-icon img {
	width: 100%;
	height: 100%;
	object-fit: contain;
}

.tile-body {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.tile-name {
	overflow: hidden;
	font-size: 13px;
	font-weight: 600;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.tile-host {
	overflow: hidden;
	font-size: 11px;
	color: var(--ever-app-launcher-muted);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.chip {
	align-self: flex-start;
	padding: 1px 6px;
	border-radius: 999px;
	background: var(--ever-app-launcher-hover);
	color: var(--ever-app-launcher-muted);
	font-size: 11px;
	font-weight: 600;
	white-space: nowrap;
}

.skeleton {
	border-color: transparent;
	background: var(--ever-app-launcher-hover);
	animation: ever-app-launcher-pulse 1.4s ease-in-out infinite;
}

@keyframes ever-app-launcher-pulse {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.55;
	}
}

@media (prefers-reduced-motion: reduce) {
	.skeleton {
		animation: none;
	}
}

.error,
.empty {
	margin: 4px 0 0;
	font-size: 12px;
	color: var(--ever-app-launcher-muted);
}

.retry,
.empty-action,
.manage,
.sign-in,
/* FR-4's overflow row — same shape as the footer's Manage apps link, because it
   does the same thing: it opens the full list. */
.view-all {
	align-self: flex-start;
	padding: 6px 10px;
	border: 1px solid var(--ever-app-launcher-border);
	border-radius: var(--ever-app-launcher-radius);
	background: var(--ever-app-launcher-bg);
	color: var(--ever-app-launcher-accent);
	font: inherit;
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
}

.retry:focus-visible,
.empty-action:focus-visible,
.manage:focus-visible,
.sign-in:focus-visible,
.view-all:focus-visible {
	outline: 2px solid var(--ever-app-launcher-accent);
	outline-offset: 2px;
}

.footer {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	margin-top: 4px;
	padding-top: 8px;
	border-top: 1px solid var(--ever-app-launcher-border);
}

.helper {
	flex: 1 1 160px;
	margin: 0;
	font-size: 11px;
	color: var(--ever-app-launcher-muted);
}

/* FR-3: under a 640 px host viewport the panel is a full-width bottom sheet. */
@media (max-width: 639.98px) {
	.panel {
		position: fixed;
		top: auto;
		right: 0;
		bottom: 0;
		left: 0;
		width: auto;
		max-width: none;
		max-height: 80vh;
		border-radius: var(--ever-app-launcher-radius) var(--ever-app-launcher-radius) 0 0;
	}
}
`;

/** {@link EVER_APP_LAUNCHER_STYLES} as the value `LitElement.styles` wants. */
export const styles = unsafeCSS(EVER_APP_LAUNCHER_STYLES);
