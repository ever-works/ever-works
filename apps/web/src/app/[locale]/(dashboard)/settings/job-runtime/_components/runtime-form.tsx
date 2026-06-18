/**
 * EW-742 P2.1 — route-local re-export so the runtime form lives at the
 * path called out in the implementing prompt
 * (`_components/runtime-form.tsx`) while the actual component stays in
 * `components/settings/` next to its peers (ApiKeysSettings,
 * NotificationPreferencesSettings, WorkAgentSettings — they're all
 * surfaced from `components/settings/` so the sidebar nav, plugin
 * settings, and the settings layout share one component directory).
 */
export { JobRuntimeSettings as RuntimeForm } from '@/components/settings/JobRuntimeSettings';
