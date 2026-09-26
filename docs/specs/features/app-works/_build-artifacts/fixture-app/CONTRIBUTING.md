# Contributing to `app-fixture-hello`

Thanks for helping. This repository is small on purpose: it is the fixture the Ever Works App Works
acceptance lanes run against, and every file in it exists to make one platform behaviour observable.

## Before you open a pull request

```bash
npm ci          # no dependencies today; the lockfile is still authoritative
npm test        # Node's built-in test runner, about a second
npm run format:check
```

## The pull request template

`.github/pull_request_template.md` is not decoration. A pull request body must keep the template's
**required checklist line** — the line marked with the HTML comment `ever-works:required-check` —
and it must be ticked only when it is true. Agents working through Ever Works are asked to follow this
template, and the acceptance lanes read the line back (ACC-E2E-08).

## What a good change looks like here

- **One observable difference.** If the change cannot be seen through `/marker`, `/state`, `/readyz`,
  `/healthz` or the home page, say in the description how a reviewer is supposed to see it.
- **No new dependency.** The image must build from a cold cache in under three minutes on a hosted
  runner. Adding a runtime dependency needs a very good reason and a note in this file.
- **No new secret, address or credential.** Ever.
- **Protected paths stay untouched.** `public/brand/**` and `LICENSE` are read-only to agents
  (`display.protectedPaths` in the Blueprint's App spec). A person may commit there; an agent may not.
- **Tests come with the change.** `test/*.test.mjs` covers the route table, the migration ordering, the
  bootstrap decision and the dependency-free protocols — add a case beside the behaviour you change.

## The variant branches

`VARIANTS.md` lists the `variant/*` branches and what each one is for. They are **not** merged into
`main`: each is one small commit on top of it, reproducing one documented failure. If you change a file
a variant patches, regenerate the patch (`tools/apply-variants.mjs` prints how) and re-run the variant
workflow, or the lanes will start asserting yesterday's failure.

## Reporting a problem with a variant

If a variant stops reproducing its documented outcome, that is a bug in this repository and it blocks
acceptance for the whole program. Open an issue naming the branch, the table row of `VARIANTS.md` and
the observed outcome.
