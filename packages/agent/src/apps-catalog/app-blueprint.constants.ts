/**
 * App Blueprint facts that other modules need without depending on the
 * resolver (and, through it, on the git facade, the licence classifier and the
 * works-config validator).
 *
 * `AppBlueprintResolverService` re-exports these, so existing imports keep
 * working; a module that only needs to RECOGNISE a Blueprint (website-template
 * discovery, for one) imports this leaf file instead.
 */

/** The topic every Blueprint repository carries (`catalog.md` §5, FR-43). */
export const APP_BLUEPRINT_TOPIC = 'ever-works-app-blueprint';
