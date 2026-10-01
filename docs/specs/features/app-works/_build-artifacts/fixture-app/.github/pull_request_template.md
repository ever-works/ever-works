<!--
	The Ever Works App Work assistant follows this template. The line marked `ever-works:required-check`
	is the one an acceptance lane reads back (ACC-E2E-08): keep the marker, tick the box only when it is
	true, and do not delete the line.
-->

## What this changes

<!-- One paragraph. If a reader cannot tell what changed and why, the description is not finished. -->

## How it was checked

<!--
	ever-works:required-check
-->

- [ ] `npm test` passes locally (and `npm run format:check`)

## Review checklist

- [ ] No file under `public/brand/**` and no change to `LICENSE` (protected paths)
- [ ] No new runtime dependency
- [ ] No secret, token, credential or real address added
- [ ] The change is under 200 lines
- [ ] What changed is observable through `/marker`, `/state`, `/readyz`, `/healthz` or the home page

## Notes for the reviewer

<!-- Anything a reviewer should know: tradeoffs, follow-ups, what you deliberately did not do. -->
