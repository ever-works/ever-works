import type { LucideIcon } from 'lucide-react';

/**
 * Root translator — registry entries name full message paths. Declared
 * structurally (rather than as next-intl's generic translator) so labels with
 * ICU arguments type-check from pure modules; `registry.unit.spec.ts`
 * resolves every key against `messages/en.json` so a typo still fails CI.
 */
export interface PaletteTranslator {
    (key: string, values?: Record<string, string | number | Date>): string;
    has: (key: string) => boolean;
}

/** A navigable dashboard screen (the "Screens" group). */
export interface PaletteScreen {
    id: string;
    href: string;
    icon: LucideIcon;
    title: (t: PaletteTranslator) => string;
    /** Parent labels shown before the title, e.g. `Settings`. */
    breadcrumb?: (t: PaletteTranslator) => string[];
}

/** Everything a command may need to act. Built by the palette from live shell state. */
export interface PaletteCommandContext {
    t: PaletteTranslator;
    pathname: string;
    navigate: (href: string) => void;
    openHelp: (tab?: 'shortcuts') => void;
    toggleTheme: () => void;
    isDark: boolean;
    sidebarCollapsed?: boolean;
    setSidebarCollapsed?: (collapsed: boolean) => void;
    chatOpen?: boolean;
    setChatOpen?: (open: boolean) => void;
    copyLink: () => void;
    signOut: () => void;
    switchOrganization: (slug: string) => void;
    organizations: ReadonlyArray<{ slug: string; label: string }>;
    activeOrganizationSlug: string | null;
    /**
     * APW-11 T15 — open the App Launcher, supplied by the provider that mounts it
     * (`components/app-launcher/AppLauncherProvider.tsx`).
     *
     * Optional, and the command's `available` gate reads exactly this: an
     * installation without the launcher — or one where the provider failed to
     * load its element — must not offer a command that opens nothing. That is the
     * same convention `setSidebarCollapsed`/`setChatOpen` already use, and it is
     * why the gate is `!== undefined` rather than a truthiness check on a flag.
     */
    openAppLauncher?: () => void;
}

/** An action the palette can run. Commands are code, not data. */
export interface PaletteCommand {
    id: string;
    icon: LucideIcon;
    label: (ctx: PaletteCommandContext) => string;
    /** Comma-separated alias list (translated), so a command is findable by intent. */
    aliases: (ctx: PaletteCommandContext) => string;
    /** Shown in the empty-query "Suggested" group. */
    suggested?: boolean;
    /** Hide the command when it does not apply to the current shell state. */
    available?: (ctx: PaletteCommandContext) => boolean;
    run: (ctx: PaletteCommandContext) => void;
}
