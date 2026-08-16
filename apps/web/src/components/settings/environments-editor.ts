import type { Environment, EnvironmentNetworkingMode } from '@/lib/api/environments';

/**
 * Environments editor serialization — the pure row ⇄ form-state
 * functions behind `EnvironmentsSettings`. Kept out of the component so
 * they can be unit-tested without dragging the server-action imports
 * into the test runtime.
 */

export interface EditorState {
    /** null = creating a new Environment. */
    id: string | null;
    name: string;
    description: string;
    availableInAllProjects: boolean;
    pipPackages: string;
    npmPackages: string;
    networkingMode: EnvironmentNetworkingMode;
    allowedHosts: string;
    allowPackageManagers: boolean;
}

export const EMPTY_EDITOR: EditorState = {
    id: null,
    name: '',
    description: '',
    availableInAllProjects: true,
    pipPackages: '',
    npmPackages: '',
    networkingMode: 'unrestricted',
    allowedHosts: '',
    allowPackageManagers: true,
};

export function toEditorState(environment: Environment): EditorState {
    return {
        id: environment.id,
        name: environment.name,
        description: environment.description ?? '',
        availableInAllProjects: environment.availableInAllProjects,
        // One package per line — NEVER comma-joined: a comma is legal
        // INSIDE a single pip specifier (`pandas>=2.0,<3.0`), so a
        // comma-separated round-trip would split one valid spec into two
        // invalid ones on every edit.
        pipPackages: environment.pipPackages.join('\n'),
        npmPackages: environment.npmPackages.join('\n'),
        networkingMode: environment.networkingMode,
        allowedHosts: (environment.allowedHosts ?? []).join('\n'),
        allowPackageManagers: environment.allowPackageManagers,
    };
}

/** Separated text input → trimmed, non-empty entries. */
function splitList(raw: string, separator: RegExp): string[] {
    return raw
        .split(separator)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

export function buildPayload(state: EditorState) {
    return {
        name: state.name.trim(),
        // Explicit `null`, not `undefined`: an omitted key leaves the
        // stored description alone, so emptying the field would silently
        // fail to clear it.
        description: state.description.trim() || null,
        // Newline is the ONLY package separator (see `toEditorState`).
        pipPackages: splitList(state.pipPackages, /\n/),
        npmPackages: splitList(state.npmPackages, /\n/),
        networkingMode: state.networkingMode,
        // Hosts never contain a comma, so both separators stay accepted.
        allowedHosts:
            state.networkingMode === 'limited' ? splitList(state.allowedHosts, /[,\n]/) : undefined,
        allowPackageManagers: state.allowPackageManagers,
        availableInAllProjects: state.availableInAllProjects,
    };
}
