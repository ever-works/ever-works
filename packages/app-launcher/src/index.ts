/**
 * `@ever-works/app-launcher` — the App Launcher web component (APW-11, T10–T12).
 *
 * One self-contained ESM file at build time (plan §6.1, APW11-G15): importing
 * this module registers `<ever-app-launcher>` (once — the define is guarded) and
 * exports everything a host or a fixture page needs.
 *
 * ```html
 * <script type="module" src="./dist/index.js"></script>
 * <ever-app-launcher current="ever-works" theme="auto"></ever-app-launcher>
 * ```
 *
 * ```ts
 * const launcher = document.querySelector('ever-app-launcher');
 * launcher.data = await (await fetch('/api/me/apps')).json();
 * launcher.strings = translations; // dashboard.appLauncher.*
 * launcher.addEventListener('ever-app-launcher:manage', () => router.push('/settings/app-launcher'));
 * launcher.addEventListener('ever-app-launcher:empty-action', (event) => {
 * 	event.detail.action === 'createAppWork' ? router.push('/works/new?kind=app') : router.push('/works');
 * });
 * ```
 */

export {
	EVER_APP_LAUNCHER_PANEL_ID,
	EVER_APP_LAUNCHER_PANEL_TITLE_ID,
	EVER_APP_LAUNCHER_TAG,
	EverAppLauncher,
	PANEL_TILE_COLUMNS_MAX,
	PANEL_TILE_COLUMNS_MIN,
	PANEL_TILE_COLUMNS_MIN_WIDTH,
	SKELETON_TILE_COUNT
} from './ever-app-launcher.js';

export {
	CONTROL_OPEN_KEYS,
	GRID_NAVIGATION_KEYS,
	isControlOpenKey,
	isGridNavigationKey,
	isTypeaheadKey,
	nextGridIndex,
	typeaheadIndex
} from './grid-navigation.js';

export { isSafeLauncherUrl, safeLauncherUrl } from './safe-url.js';

export { DEFAULT_LAUNCHER_STRINGS } from './strings.js';

export { EVER_APP_LAUNCHER_STYLES, styles as everAppLauncherStyles } from './styles.js';

export type {
	AppLauncherEmptyAction,
	AppLauncherEnvironment,
	AppLauncherItem,
	AppLauncherItemKind,
	AppLauncherListResponse,
	AppLauncherSection,
	AppLauncherWorkChip,
	LauncherEmptyActionDetail,
	LauncherErrorSection,
	LauncherItemActivateDetail,
	LauncherManageDetail,
	LauncherRetryDetail,
	LauncherRetrySection,
	LauncherSignInDetail,
	LauncherStrings,
	LauncherTheme
} from './types.js';
