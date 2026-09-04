// EW-266 — `src/components/homepage-features/` and `src/components/HomepageFeatures/`
// were byte-identical copies of the same Docusaurus scaffold component, so the
// Docusaurus marketing copy and the broken `undraw_docusaurus_*.svg` requires had to
// be fixed twice and could silently drift apart again. `HomepageFeatures/` is the
// canonical implementation; this path is kept as a re-export so any existing import
// of the kebab-case path keeps working.
export { default } from '../HomepageFeatures';
