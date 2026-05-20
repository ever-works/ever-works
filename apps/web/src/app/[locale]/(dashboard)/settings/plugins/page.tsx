import { redirect } from 'next/navigation';

// Bare `/<locale>/settings/plugins` has no content of its own — the
// settings UI keys on a `[category]` slug. Redirect to the canonical
// landing category so navigating to `/settings/plugins` from the
// sidebar or an external link doesn't produce a "page not found".
// `ai-provider` is the natural first card (matches the sidebar order
// and the e2e settings-extra spec expectation of a non-empty render).
export default function PluginsLandingRedirect(): never {
    redirect('./plugins/ai-provider');
}
