/**
 * The catalog tab's shapes — `GET /api/apps-catalog/blueprints`
 * (`apps/api/src/works/apps-catalog-blueprints.service.ts`). Shared by the
 * client component and the server-only client: no directive.
 */

export interface AppsCatalogBlueprintItem {
    /** `umami-template` ⇒ `umami`. */
    id: string;
    name: string;
    summary: string;
    /** `ever-works/umami-template`. */
    repo: string;
    /** What the form pastes and inspects. */
    url: string;
    stars: number | null;
    spdx: string | null;
    topics: string[];
}

export interface AppsCatalogBlueprintList {
    items: AppsCatalogBlueprintItem[];
    total: number;
    /** `false` when GitHub could not be read; `items` is then empty. */
    available: boolean;
    source: 'github-topic';
}
