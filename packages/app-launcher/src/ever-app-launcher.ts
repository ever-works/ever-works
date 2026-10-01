import { LitElement, html, nothing, type TemplateResult } from 'lit';

import { isControlOpenKey, isTypeaheadKey, nextGridIndex, typeaheadIndex } from './grid-navigation.js';
import { safeLauncherUrl } from './safe-url.js';
import { DEFAULT_LAUNCHER_STRINGS } from './strings.js';
import { styles } from './styles.js';
import type {
	AppLauncherEmptyAction,
	AppLauncherEnvironment,
	AppLauncherItem,
	AppLauncherListResponse,
	LauncherEmptyActionDetail,
	LauncherErrorSection,
	LauncherItemActivateDetail,
	LauncherManageDetail,
	LauncherRetrySection,
	LauncherStrings,
	LauncherTheme
} from './types.js';

/**
 * `<ever-app-launcher>` — the App Launcher panel of plan §6.2–§6.3, in
 * **host-fed mode** (Ever Works P1): the host sets `data` from
 * `GET /api/me/apps` and translates it through `strings`; the element renders,
 * drives the keyboard and reports what the person did.
 *
 * **The element never navigates on its own.** There is no route and no session
 * in here: `:manage`, `:retry` and `:empty-action` are reports for the host to
 * act on (FR-64, ACC-11-48), and the only thing the element ever opens is a
 * tile's own stored address, in a new tab, with no opener and no referrer
 * (FR-30) — and only after the cancellable `:item-activate` was not cancelled
 * (ACC-11-40).
 *
 * Host-facing surface (plan §6.2):
 *
 * | Kind      | Name                                      | Notes                                             |
 * | --------- | ----------------------------------------- | ------------------------------------------------- |
 * | attribute | `current`                                 | catalog id of the platform to mark **You're here** |
 * | attribute | `theme`                                   | `light` \\| `dark` \\| `auto` (default `auto`)      |
 * | attribute | `environment`, `catalog-url`, `apps-url`  | P2 self-fetch only; carried, not yet read          |
 * | attribute | `sign-in-available`, `allow-localhost`    | S6 button; FR-32's local-development allowance     |
 * | property  | `data`                                    | `{ items, meta } \\| null` — host-fed mode          |
 * | property  | `strings`                                 | `Partial<LauncherStrings>`                        |
 * | property  | `appWorksAvailable`                       | overrides `meta.appWorksAvailable` (FR-64)         |
 * | property  | `loading`, `error`                        | `'catalog'` \\| `'apps'` \\| `null`                   |
 * | method    | `show()`, `hide()`                        | the palette command uses `show()`                  |
 */

/** The custom element's tag name. */
export const EVER_APP_LAUNCHER_TAG = 'ever-app-launcher';

/** `id` of the panel the control points at with `aria-controls` (FR-38). */
export const EVER_APP_LAUNCHER_PANEL_ID = 'ever-app-launcher-panel';

/** `id` of the panel's visible title, which names the `role="menu"` (FR-38). */
export const EVER_APP_LAUNCHER_PANEL_TITLE_ID = 'ever-app-launcher-panel-title';

/** FR-3: 3 columns at a panel width of at least {@link PANEL_TILE_COLUMNS_MIN_WIDTH}. */
export const PANEL_TILE_COLUMNS_MAX = 3;

/** FR-3: 2 columns below that width. */
export const PANEL_TILE_COLUMNS_MIN = 2;

/** FR-3: the 360 px breakpoint between {@link PANEL_TILE_COLUMNS_MAX} and `MIN`. */
export const PANEL_TILE_COLUMNS_MIN_WIDTH = 360;

/** FR-5 / spec §6.2: a cold open renders six skeleton tiles. */
export const SKELETON_TILE_COUNT = 6;

/** The control's icon — a 2×2 grid, i.e. "the apps panel". Decorative only. */
const TRIGGER_ICON = html`
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false">
		<rect x="3" y="3" width="7" height="7" rx="1.5"></rect>
		<rect x="14" y="3" width="7" height="7" rx="1.5"></rect>
		<rect x="3" y="14" width="7" height="7" rx="1.5"></rect>
		<rect x="14" y="14" width="7" height="7" rx="1.5"></rect>
	</svg>
`;

/** The initials tile FR-14 falls back to when a platform has no icon. */
function initialsOf(name: string): string {
	return name
		.split(/\s+/)
		.filter((part) => part.length > 0)
		.slice(0, 2)
		.map((part) => part.charAt(0).toUpperCase())
		.join('');
}

export class EverAppLauncher extends LitElement {
	static styles = styles;

	static properties = {
		current: { type: String },
		theme: { type: String },
		environment: { type: String },
		catalogUrl: { type: String, attribute: 'catalog-url' },
		appsUrl: { type: String, attribute: 'apps-url' },
		signInAvailable: { type: Boolean, attribute: 'sign-in-available' },
		allowLocalhost: { type: Boolean, attribute: 'allow-localhost' },
		data: { attribute: false },
		strings: { attribute: false },
		appWorksAvailable: { attribute: false },
		loading: { type: Boolean },
		error: { attribute: false },
		_open: { state: true },
		_columns: { state: true },
		_activeIndex: { state: true }
	};

	/** Catalog id of the platform the launcher is running inside (FR-13). */
	current = '';

	/** `light`, `dark`, or `auto` (plan §6.2). */
	theme: LauncherTheme = 'auto';

	/** P2 self-fetch only (FR-10); carried here so a host can set it today. */
	environment: AppLauncherEnvironment = 'production';

	/** P2 self-fetch only. */
	catalogUrl = '';

	/** P2 self-fetch only. */
	appsUrl = '';

	/** Shows the S6 **Sign in** control (spec §6.5, P2). */
	signInAvailable = false;

	/**
	 * FR-32's local-development allowance: accept `http://localhost` and
	 * `http://127.0.0.1` as well as `https`. Off by default — a production
	 * installation must never open a plain-`http` address.
	 */
	allowLocalhost = false;

	/** `GET /api/me/apps` — the host-fed payload (FR-33). */
	data: AppLauncherListResponse | null = null;

	/** Translated strings; anything the host omits stays English (FR-42). */
	strings: Partial<LauncherStrings> = {};

	/**
	 * FR-64's override for S8. `undefined` means "ask the registry"
	 * (`meta.appWorksAvailable`); an explicit `true`/`false` always wins.
	 */
	appWorksAvailable?: boolean = undefined;

	/** True while the host is fetching/list refreshing (FR-5). */
	loading = false;

	/** Which half of the panel failed, if any (plan §6.2 / spec §6.2). */
	error: LauncherErrorSection | null = null;

	_open = false;
	_columns = PANEL_TILE_COLUMNS_MAX;
	_activeIndex = 0;

	private _observer: ResizeObserver | null = null;

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener('pointerdown', this._onDocumentPointerDown, true);
	}

	disconnectedCallback(): void {
		document.removeEventListener('pointerdown', this._onDocumentPointerDown, true);
		this._observer?.disconnect();
		this._observer = null;
		super.disconnectedCallback();
	}

	// -----------------------------------------------------------------------
	// Public API (plan §6.2)
	// -----------------------------------------------------------------------

	/** Open the panel; the command palette calls this (FR-7). */
	show(): void {
		void this._openPanel();
	}

	/** Close the panel without moving focus (a host-driven close). */
	hide(): void {
		void this._closePanel(false);
	}

	// -----------------------------------------------------------------------
	// Rendering
	// -----------------------------------------------------------------------

	render(): TemplateResult {
		const strings = this._strings;
		return html`
			<button
				class="trigger"
				part="trigger"
				type="button"
				aria-haspopup="menu"
				aria-expanded=${this._open ? 'true' : 'false'}
				aria-controls=${EVER_APP_LAUNCHER_PANEL_ID}
				aria-label=${strings.controlLabel}
				title=${strings.controlTooltip}
				@click=${this._onTriggerClick}
				@keydown=${this._onTriggerKeydown}
			>
				<span class="trigger-icon">${TRIGGER_ICON}</span>
			</button>
			<div
				class="panel"
				part="panel"
				id=${EVER_APP_LAUNCHER_PANEL_ID}
				role="menu"
				tabindex="-1"
				aria-labelledby=${EVER_APP_LAUNCHER_PANEL_TITLE_ID}
				?hidden=${!this._open}
				@keydown=${this._onPanelKeydown}
			>
				${this._renderPanelBody()}
			</div>
		`;
	}

	private _renderPanelBody(): TemplateResult {
		const strings = this._strings;
		return html`
			<p class="panel-title" part="title" id=${EVER_APP_LAUNCHER_PANEL_TITLE_ID} role="presentation">
				${strings.panelTitle}
			</p>
			<div
				class="grid"
				part="grid"
				data-columns=${String(this._columns)}
				aria-busy=${this.loading ? 'true' : 'false'}
				style=${`grid-template-columns: repeat(${this._columns}, minmax(0, 1fr));`}
			>
				${this._isColdLoading() ? this._renderSkeletons() : this._renderSections()}
			</div>
			<div class="footer" part="footer" role="presentation">
				<p class="helper" role="presentation">${strings.footerHelper}</p>
				${this.signInAvailable
					? html`<button
							class="sign-in"
							part="sign-in"
							type="button"
							role="menuitem"
							@click=${this._onSignIn}
						>
							${strings.signIn}
						</button>`
					: nothing}
				<button class="manage" part="manage" type="button" role="menuitem" @click=${this._onManage}>
					${strings.manageLink}
				</button>
			</div>
		`;
	}

	private _renderSkeletons(): TemplateResult {
		return html`${Array.from(
			{ length: SKELETON_TILE_COUNT },
			() => html`<div class="tile skeleton" part="skeleton" aria-hidden="true"></div>`
		)}`;
	}

	/**
	 * The three sections in FR-2's order — **Pinned** only when something is
	 * pinned, then **Ever apps**, then **Your apps** — and nothing else: the
	 * footer is outside the grid (ACC-11-02).
	 */
	private _renderSections(): TemplateResult {
		const flat = this._tileItems();
		const pinned = this._itemsIn('pinned');
		const platforms = this._itemsIn('platforms');
		const works = this._itemsIn('works');
		return html`${pinned.length > 0
			? this._renderSection('pinned', this._strings.sectionPinned, pinned, flat, nothing)
			: nothing}${this._renderSection(
			'platforms',
			this._strings.sectionPlatforms,
			platforms,
			flat,
			this.error === 'catalog' ? this._renderError('catalog', 'platforms', this._strings.catalogError) : nothing
		)}${this._renderSection(
			'works',
			this._strings.sectionWorks,
			works,
			flat,
			this._renderWorksExtra(works.length)
		)}`;
	}

	private _renderSection(
		section: 'pinned' | 'platforms' | 'works',
		label: string,
		items: AppLauncherItem[],
		flat: AppLauncherItem[],
		extra: TemplateResult | typeof nothing
	): TemplateResult {
		const headingId = `ever-app-launcher-${section}-heading`;
		return html`
			<section
				class="section"
				part=${`section-${section}`}
				data-section=${section}
				role="group"
				aria-labelledby=${headingId}
			>
				<h3 class="section-heading" id=${headingId}>${label}</h3>
				<div class="tiles">${items.map((item) => this._renderTile(item, flat.indexOf(item), section))}</div>
				${extra}
			</section>
		`;
	}

	private _renderTile(item: AppLauncherItem, position: number, section: string): TemplateResult {
		const strings = this._strings;
		const chip = this._chipFor(item);
		const isCurrent = this._isCurrent(item);
		const inert = !isCurrent && safeLauncherUrl(item.url, { allowLocalhost: this.allowLocalhost }) === null;
		// Roving tabindex (FR-40): exactly one tile is in the tab order.
		const tabindex = inert ? -1 : position === this._activeIndex ? 0 : -1;
		const icon = item.iconDataUri
			? html`<span class="tile-icon" part="tile-icon" aria-hidden="true"
					><img src=${item.iconDataUri} alt=""
				/></span>`
			: html`<span class="tile-icon" part="tile-icon" aria-hidden="true">${initialsOf(item.name)}</span>`;
		const body = html`
			<span class="tile-body">
				<span class="tile-name">${item.name}</span>
				${chip
					? html`<span class="chip" part="chip" data-chip=${item.chip ?? (isCurrent ? 'current' : 'beta')}
							>${chip}</span
						>`
					: item.host
						? html`<span class="tile-host">${item.host}</span>`
						: nothing}
			</span>
		`;

		// **You're here** is not a link (FR-13); activating it closes the panel.
		if (isCurrent) {
			return html`<button
				class="tile"
				part="tile"
				type="button"
				role="menuitem"
				data-key=${item.key}
				data-section=${section}
				aria-current="true"
				tabindex=${String(tabindex)}
				@click=${this._onCurrentTileClick}
			>
				${icon}${body}
			</button>`;
		}

		// An address FR-32 refuses is visible but inert — no link, no tab.
		if (inert) {
			return html`<div
				class="tile"
				part="tile"
				role="menuitem"
				data-key=${item.key}
				data-section=${section}
				aria-disabled="true"
				tabindex="-1"
			>
				${icon}${body}
			</div>`;
		}

		return html`<a
			class="tile"
			part="tile"
			role="menuitem"
			data-key=${item.key}
			data-section=${section}
			href=${item.url as string}
			target="_blank"
			rel="noopener noreferrer"
			referrerpolicy="no-referrer"
			tabindex=${String(tabindex)}
			@click=${(event: MouseEvent) => this._onTileClick(item, event)}
		>
			${icon}${body}
		</a>`;
	}

	private _renderError(
		retrySection: LauncherRetrySection,
		panelSection: 'platforms' | 'works',
		message: string
	): TemplateResult {
		return html`
			<p class="error" role="presentation" data-section=${panelSection}>${message}</p>
			<button
				class="retry"
				part="retry"
				type="button"
				role="menuitem"
				data-section=${retrySection}
				@click=${() => this._emitRetry(retrySection)}
			>
				${this._strings.retry}
			</button>
		`;
	}

	/**
	 * What happens under **Your apps** (spec §6.2): the failure message and a
	 * retry, or S8's empty state, or nothing.
	 *
	 * The "All hidden" row of spec §6.2 is deliberately **not** rendered: the
	 * host-fed payload of FR-33 carries only the listed items, so from inside
	 * the element "the person hid everything" and "the person has no apps" look
	 * identical. Guessing would show the wrong copy on one of the two; the host
	 * owns that distinction.
	 */
	private _renderWorksExtra(workTileCount: number): TemplateResult | typeof nothing {
		if (this.error === 'apps') return this._renderError('works', 'works', this._strings.worksError);
		if (this._isColdLoading()) return nothing;
		if (workTileCount > 0) return this._renderOverflow(workTileCount);

		const action: AppLauncherEmptyAction = this._appWorksAvailable() ? 'createAppWork' : 'goToWorks';
		return html`
			<p class="empty" role="presentation">${this._strings.emptyWorks}</p>
			<button
				class="empty-action"
				part="empty-action"
				type="button"
				role="menuitem"
				data-action=${action}
				@click=${() => this._emitEmptyAction(action)}
			>
				${action === 'createAppWork' ? this._strings.emptyWorksCreateApp : this._strings.emptyWorksGoToWorks}
			</button>
		`;
	}

	/**
	 * FR-4's overflow row: **View all {count}**, where `{count}` is
	 * `meta.worksTotal` — the number of Works the scope holds, not the number the
	 * panel shows (spec FR-4:193, ACC-11-14: 140 exposed Works render 24 tiles
	 * **and** `View all 140`).
	 *
	 * **It opens Manage apps**, which is what spec FR-4:137 says the row does, so
	 * it reports through the SAME `:manage` event the footer link uses — with
	 * `section: 'works'`, because that is the list the person wants to see more of.
	 * No new event was invented for it: the element still never navigates, and the
	 * host has one handler for "the person asked for the full list".
	 *
	 * Rendered only when the scope really holds more than the panel received, so a
	 * complete list gets no row that would lead to a page showing the same thing.
	 */
	private _renderOverflow(workTileCount: number): TemplateResult | typeof nothing {
		const total = this.data?.meta.worksTotal ?? 0;
		if (total <= workTileCount) return nothing;
		const label = this._strings.viewAll.replace('{count}', String(total));
		return html`
			<button
				class="view-all"
				part="view-all"
				type="button"
				role="menuitem"
				data-count=${total}
				@click=${this._onViewAll}
			>
				${label}
			</button>
		`;
	}

	/** See {@link _renderOverflow} — one report, the host's existing handler. */
	private _onViewAll = (): void => {
		this.dispatchEvent(
			new CustomEvent<LauncherManageDetail>('ever-app-launcher:manage', {
				detail: { section: 'works' },
				bubbles: true,
				composed: true
			})
		);
	};

	// -----------------------------------------------------------------------
	// Derived state
	// -----------------------------------------------------------------------

	private get _strings(): LauncherStrings {
		return { ...DEFAULT_LAUNCHER_STRINGS, ...this.strings };
	}

	private _isColdLoading(): boolean {
		return this.loading && !this.data;
	}

	private _itemsIn(section: 'pinned' | 'platforms' | 'works'): AppLauncherItem[] {
		return (this.data?.items ?? []).filter((item) => item.visible !== false && item.section === section);
	}

	/** Every visible tile, in DOM order — the grid the keyboard model moves in. */
	private _tileItems(): AppLauncherItem[] {
		return [...this._itemsIn('pinned'), ...this._itemsIn('platforms'), ...this._itemsIn('works')];
	}

	/** FR-64: the host's property wins; otherwise the registry's answer. */
	private _appWorksAvailable(): boolean {
		return this.appWorksAvailable ?? this.data?.meta.appWorksAvailable ?? false;
	}

	private _isCurrent(item: AppLauncherItem): boolean {
		if (item.current === true) return true;
		return item.kind === 'platform' && this.current !== '' && item.key === `platform:${this.current}`;
	}

	private _isPinned(item: AppLauncherItem): boolean {
		return item.pinned === true || item.section === 'pinned';
	}

	/** FR-41: a chip is a string, never a colour. */
	private _chipFor(item: AppLauncherItem): string | null {
		if (this._isCurrent(item)) return this._strings.chipCurrent;
		if (item.chip === 'deploying') return this._strings.chipDeploying;
		if (item.chip === 'lastDeployFailed') return this._strings.chipLastDeployFailed;
		if (item.status === 'beta') return this._strings.chipBeta;
		return null;
	}

	// -----------------------------------------------------------------------
	// Element handles
	// -----------------------------------------------------------------------

	private _panel(): HTMLElement | null {
		return this.renderRoot.querySelector<HTMLElement>('.panel');
	}

	private _tileElements(): HTMLElement[] {
		return Array.from(this.renderRoot.querySelectorAll<HTMLElement>('.tile'));
	}

	/** Everything inside the panel that `Tab` can reach, in DOM order (FR-40). */
	private _focusables(): HTMLElement[] {
		const panel = this._panel();
		if (!panel) return [];
		return Array.from(panel.querySelectorAll<HTMLElement>('a[href], button, [tabindex]')).filter(
			(element) => !element.hasAttribute('disabled') && element.tabIndex >= 0
		);
	}

	private _activeInPanel(): Element | null {
		const root = this.renderRoot as ShadowRoot;
		return (root.activeElement as Element | null) ?? null;
	}

	// -----------------------------------------------------------------------
	// Opening and closing
	// -----------------------------------------------------------------------

	private async _openPanel(): Promise<void> {
		if (this._open) return;
		this._open = true;
		this._activeIndex = 0;
		await this.updateComplete;
		this._observePanel();
		this._focusInitial();
		this.dispatchEvent(new CustomEvent('ever-app-launcher:open', { bubbles: true, composed: true }));
	}

	private async _closePanel(restoreFocus: boolean): Promise<void> {
		if (!this._open) return;
		this._open = false;
		this._observer?.disconnect();
		this._observer = null;
		await this.updateComplete;
		if (restoreFocus) this.renderRoot.querySelector<HTMLElement>('.trigger')?.focus();
		this.dispatchEvent(new CustomEvent('ever-app-launcher:close', { bubbles: true, composed: true }));
	}

	/** FR-3: the column count comes from the panel's own width, not the window's. */
	private _observePanel(): void {
		if (typeof ResizeObserver === 'undefined' || this._observer) return;
		const panel = this._panel();
		if (!panel) return;

		this._observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const width = entry.contentRect?.width ?? 0;
				// A zero-width report is a not-yet-laid-out panel, not a narrow one.
				if (width <= 0) continue;
				this._columns = width >= PANEL_TILE_COLUMNS_MIN_WIDTH ? PANEL_TILE_COLUMNS_MAX : PANEL_TILE_COLUMNS_MIN;
			}
		});
		this._observer.observe(panel);
	}

	/** FR-39: opening from the keyboard focuses the first tile. */
	private _focusInitial(): void {
		const tiles = this._tileElements();
		if (tiles.length > 0) {
			this._focusTile(0, tiles);
			return;
		}
		const focusables = this._focusables();
		if (focusables.length > 0) {
			focusables[0].focus();
			return;
		}
		this._panel()?.focus();
	}

	private _focusTile(index: number, tiles: HTMLElement[] = this._tileElements()): void {
		if (tiles.length === 0) return;
		const target = Math.min(Math.max(index, 0), tiles.length - 1);
		// The roving tabindex is moved here as well as in the template: a key
		// press must leave the DOM consistent before the next render runs.
		const previous = tiles[this._activeIndex];
		if (previous && previous !== tiles[target] && previous.getAttribute('aria-disabled') !== 'true') {
			previous.tabIndex = -1;
		}
		this._activeIndex = target;
		const next = tiles[target];
		// An inert tile (an address FR-32 refuses) never enters the tab order.
		if (next.getAttribute('aria-disabled') !== 'true') next.tabIndex = 0;
		next.focus();
	}

	// -----------------------------------------------------------------------
	// Events
	// -----------------------------------------------------------------------

	private _onTriggerClick = (): void => {
		if (this._open) this.hide();
		else this.show();
	};

	/**
	 * `Enter` and `Space` open the panel through the button's own `click`, so
	 * only `ArrowDown` — the third key of §6.6's Control row — is handled here.
	 * Handling `Enter` here as well would open and immediately re-toggle it.
	 */
	private _onTriggerKeydown = (event: KeyboardEvent): void => {
		if (event.key !== 'ArrowDown' || this._open) return;
		event.preventDefault();
		this.show();
	};

	private _onPanelKeydown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') {
			event.preventDefault();
			void this._closePanel(true);
			return;
		}
		if (event.key === 'Tab') {
			this._trapTab(event);
			return;
		}

		const tiles = this._tileElements();
		if (tiles.length === 0) return;
		const active = tiles.indexOf(this._activeInPanel() as HTMLElement);

		if (isTypeaheadKey(event.key)) {
			const next = typeaheadIndex(
				this._tileItems().map((item) => item.name),
				active,
				event.key
			);
			if (next !== null) {
				event.preventDefault();
				this._focusTile(next, tiles);
			}
			return;
		}

		const next = nextGridIndex({ key: event.key, index: active, columns: this._columns, count: tiles.length });
		if (next !== null) {
			event.preventDefault();
			this._focusTile(next, tiles);
		}
	};

	/** FR-40: `Tab` cycles between the grid and **Manage apps**; focus stays in. */
	private _trapTab(event: KeyboardEvent): void {
		const focusables = this._focusables();
		if (focusables.length === 0) {
			event.preventDefault();
			return;
		}
		const current = this._activeInPanel() as HTMLElement | null;
		const index = current ? focusables.indexOf(current) : -1;
		const step = event.shiftKey ? -1 : 1;
		const next =
			index === -1
				? event.shiftKey
					? focusables.length - 1
					: 0
				: (index + step + focusables.length) % focusables.length;
		event.preventDefault();
		focusables[next].focus();
	}

	private _onCurrentTileClick = (): void => {
		// Spec §6.6: `Enter` on **You're here** closes the panel.
		this.hide();
	};

	/**
	 * FR-30/ACC-11-40. The tile is an anchor so middle-click and
	 * "open in a new tab" keep working; the primary click is handled here so
	 * the cancellable `:item-activate` — and nothing else — decides whether a
	 * tab opens, and so the address never gains a parameter (FR-31).
	 */
	private _onTileClick(item: AppLauncherItem, event: MouseEvent): void {
		const detail: LauncherItemActivateDetail = {
			key: item.key,
			kind: item.kind,
			url: item.url ?? '',
			position: this._tileItems().indexOf(item),
			pinned: this._isPinned(item)
		};
		const proceed = this.dispatchEvent(
			new CustomEvent<LauncherItemActivateDetail>('ever-app-launcher:item-activate', {
				detail,
				bubbles: true,
				composed: true,
				cancelable: true
			})
		);
		// Always: the anchor's own navigation must not race the host's answer.
		event.preventDefault();
		if (!proceed) return;

		const url = safeLauncherUrl(item.url, { allowLocalhost: this.allowLocalhost });
		if (url === null) return;
		window.open(url, '_blank', 'noopener,noreferrer');
	}

	private _onManage = (): void => {
		this.dispatchEvent(new CustomEvent('ever-app-launcher:manage', { detail: {}, bubbles: true, composed: true }));
	};

	private _onSignIn = (): void => {
		this.dispatchEvent(new CustomEvent('ever-app-launcher:sign-in', { detail: {}, bubbles: true, composed: true }));
	};

	/**
	 * FR-64: the element reports which action it offered and the person chose;
	 * the **host** navigates. No `location`, no `window.open`, no route.
	 */
	private _emitEmptyAction(action: AppLauncherEmptyAction): void {
		const detail: LauncherEmptyActionDetail = { action };
		this.dispatchEvent(
			new CustomEvent<LauncherEmptyActionDetail>('ever-app-launcher:empty-action', {
				detail,
				bubbles: true,
				composed: true
			})
		);
	}

	private _emitRetry(section: LauncherRetrySection): void {
		this.dispatchEvent(
			new CustomEvent('ever-app-launcher:retry', { detail: { section }, bubbles: true, composed: true })
		);
	}

	private _onDocumentPointerDown = (event: Event): void => {
		if (!this._open) return;
		if (event.composedPath().includes(this)) return;
		// FR-40: a click outside closes it.
		this.hide();
	};
}

// Guarded define (plan §6.1): importing the module twice — a React effect plus a
// `<script type="module">` fixture page — must not throw.
if (typeof customElements !== 'undefined' && !customElements.get(EVER_APP_LAUNCHER_TAG)) {
	customElements.define(EVER_APP_LAUNCHER_TAG, EverAppLauncher);
}
