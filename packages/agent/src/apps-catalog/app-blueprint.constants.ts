/**
 * App Blueprint facts that other modules need to RECOGNISE a Blueprint
 * repository. Dependency-free on purpose, so website-template discovery can
 * import it without pulling anything else in.
 *
 * App Blueprints (e.g. ever-works/cal-template, ever-works/umami-template) are
 * public repositories in the catalog org whose names end in "template" like the
 * website templates do, but they generate App Works, never websites.
 */

/** The topic every Blueprint repository carries. */
export const APP_BLUEPRINT_TOPIC = 'ever-works-app-blueprint';
