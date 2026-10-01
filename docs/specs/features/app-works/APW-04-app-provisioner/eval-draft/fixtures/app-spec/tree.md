# Fixture — `app-spec` (detection step 1)

> DRAFT — the tree APW-13 creates as a fixture repository (plan §11.4). Expectation: `expectations.json#/cases/app-spec`.

```
app-spec/
├── .works/
│   └── works.yml          # kind: app — a valid App spec already on the branch
├── package.json
└── src/
    └── server.js
```

## What matters here

- `.works/works.yml` is **valid** and already declares the build, the port and the probes, so detection stops at step 1
  with `detectionSource: app-spec` and the report cites that path.
- The proposal changes only what the evidence requires: a re-provision of an already-specified repository must not
  rewrite the whole file, and it must leave `source`, `blueprint`, `license`, `display.protectedPaths`, `upstreamSync`,
  `upstreamPullRequests` and `provisioning` exactly as they were.
- A run that finds nothing to change ends with `outcome: no-change` and **no** pull request.
