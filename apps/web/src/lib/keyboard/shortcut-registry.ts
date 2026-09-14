/**
 * One registry for every dashboard keyboard shortcut.
 *
 * Before this existed, each surface attached its own `keydown` listener. Two
 * of them bound `Ctrl/Cmd+K`: the dashboard-wide handler on `document` and the
 * Knowledge-Base workbench palette on `window`. Both fired for the same
 * keystroke, so pressing `Ctrl+K` inside the workbench navigated the operator
 * out of it while the workbench palette was opening. `preventDefault()` on
 * either side could not help, because neither stopped the other listener.
 *
 * Here there is exactly one `window` listener. Every binding declares a
 * `scope` and a `priority`; for one keystroke the registry runs the single
 * highest-priority binding that matches, so a screen-scoped palette wins
 * inside its screen and the global palette wins everywhere else. Ties go to
 * the most recently registered binding (the screen mounted last).
 *
 * Framework-free on purpose: React code uses {@link useShortcut}; tests can
 * drive {@link dispatchShortcut} directly.
 */

/** Well-known scopes. Screens may use any other string. */
export const SHORTCUT_SCOPE = {
    /** Available on every dashboard screen. */
    global: 'global',
    /** An overlay that is open and owns the keyboard. */
    overlay: 'overlay',
} as const;

/** Default priorities; a binding may pass any number. */
export const SHORTCUT_PRIORITY = {
    global: 0,
    screen: 100,
    overlay: 1000,
} as const;

export interface ShortcutBinding {
    /** Stable identifier, e.g. `palette.open`. Used for diagnostics and tests. */
    id: string;
    /** `global`, `overlay`, or a named screen scope such as `kb-workbench`. */
    scope: string;
    /** Higher wins. Defaults to {@link SHORTCUT_PRIORITY.global}. */
    priority?: number;
    /** Does this keystroke belong to this binding? */
    match: (event: KeyboardEvent) => boolean;
    /**
     * Fire while focus is in an input, textarea, select or contenteditable.
     * Defaults to `false`; modifier chords such as `Ctrl+K` usually set it.
     */
    allowInInput?: boolean;
    /**
     * Call `preventDefault()` when this binding runs. Defaults to `true`, so a
     * consumed keystroke never also types a character or triggers the browser.
     */
    preventDefault?: boolean;
    handler: (event: KeyboardEvent) => void;
}

interface Entry {
    binding: ShortcutBinding;
    order: number;
}

let entries: Entry[] = [];
let sequence = 0;
let listening = false;

/** True when focus is in a place where plain keys type text. */
export function isEditableTarget(target: EventTarget | null): boolean {
    if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
    const element = target as HTMLElement;
    const tag = element.tagName.toLowerCase();
    return (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        element.isContentEditable === true
    );
}

/** `Ctrl+<key>` on Windows/Linux, `Cmd+<key>` on macOS (either is accepted everywhere). */
export function isModKey(event: KeyboardEvent, key: string): boolean {
    return (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === key.toLowerCase()
    );
}

function onKeyDown(event: KeyboardEvent): void {
    dispatchShortcut(event);
}

function ensureListener(): void {
    if (listening || typeof window === 'undefined') return;
    window.addEventListener('keydown', onKeyDown);
    listening = true;
}

function releaseListenerIfIdle(): void {
    if (!listening || entries.length > 0 || typeof window === 'undefined') return;
    window.removeEventListener('keydown', onKeyDown);
    listening = false;
}

/** Register a binding. Returns the function that unregisters it. */
export function registerShortcut(binding: ShortcutBinding): () => void {
    const entry: Entry = { binding, order: sequence++ };
    entries = [...entries, entry];
    ensureListener();
    return () => {
        entries = entries.filter((candidate) => candidate !== entry);
        releaseListenerIfIdle();
    };
}

export interface ResolveShortcutOptions {
    /**
     * Only consider bindings at or below this priority. An overlay uses it to
     * ask "who would own this key if I were not open?".
     */
    maxPriority?: number;
}

/**
 * The binding that would handle `event`, or `null`. Exposed for tests and for
 * surfaces that want to know who owns a key without firing it.
 */
export function resolveShortcut(
    event: KeyboardEvent,
    options: ResolveShortcutOptions = {},
): ShortcutBinding | null {
    if (event.isComposing) return null;
    const editable = isEditableTarget(event.target);
    const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
    let winner: Entry | null = null;
    for (const entry of entries) {
        const { binding } = entry;
        if (editable && !binding.allowInInput) continue;
        // Something closer to the target already consumed a plain key — respect it.
        if (event.defaultPrevented && !hasModifier) continue;
        const priority = binding.priority ?? SHORTCUT_PRIORITY.global;
        if (options.maxPriority !== undefined && priority > options.maxPriority) continue;
        if (!binding.match(event)) continue;
        const winnerPriority = winner
            ? (winner.binding.priority ?? SHORTCUT_PRIORITY.global)
            : -Infinity;
        if (
            !winner ||
            priority > winnerPriority ||
            (priority === winnerPriority && entry.order > winner.order)
        ) {
            winner = entry;
        }
    }
    return winner?.binding ?? null;
}

/** Run the single winning binding for `event`. Returns whether one ran. */
export function dispatchShortcut(event: KeyboardEvent): boolean {
    const binding = resolveShortcut(event);
    if (!binding) return false;
    if (binding.preventDefault !== false) event.preventDefault();
    binding.handler(event);
    return true;
}

/** Ids of the currently registered bindings, in registration order. */
export function listShortcuts(): Array<Pick<ShortcutBinding, 'id' | 'scope' | 'priority'>> {
    return entries.map(({ binding }) => ({
        id: binding.id,
        scope: binding.scope,
        priority: binding.priority,
    }));
}

/** Test-only: drop every binding and detach the listener. */
export function __resetShortcutRegistryForTests(): void {
    entries = [];
    sequence = 0;
    releaseListenerIfIdle();
}
