/**
 * Version reported to the platform as the node's `version` field and sent in
 * the `User-Agent`.
 *
 * Kept as a constant rather than importing `package.json`: the manifest lives
 * outside `rootDir`, and importing it would drag the whole file into `dist/`.
 * Keep this in sync with `package.json`'s `version`.
 */
export const NODE_APP_VERSION = '0.2.0';
