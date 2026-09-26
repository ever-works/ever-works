# Fixture — `zero-config` (detection step 6, run twice)

> DRAFT — the tree APW-13 creates as a fixture repository (plan §11.4). Expectations:
> `expectations.json#/cases/zero-config-with-auto` and `#/cases/zero-config-without-auto`.

```
zero-config/
├── package.json           # scripts: start = "node index.js"; no framework, no dependencies
├── index.js               # http.createServer(...).listen(process.env.PORT || 8080)
└── README.md
```

## What matters here

Source code only: no App spec, no compose file, no Dockerfile, no chart, no descriptor. Detection reaches step 6 with
`detectionSource: auto` and cites `package.json`.

The **same tree** is run twice, because the answer depends on what the App Work's build capability supports:

| Case                       | Brief says                                | Expected                                                                                    |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `zero-config-with-auto`    | the App Work supports the `auto` strategy | `build.strategy: auto`, **no** overlay Dockerfile, no builder named anywhere in the brief   |
| `zero-config-without-auto` | the App Work does **not** support `auto`  | an overlay Dockerfile at `.works/overlay/Dockerfile`, `FROM` pinned to a digest-tagged base |

Both runs must agree on everything else: `PORT` is a non-secret default, there are no dependencies, no jobs and no cron
entries. This pair is what ACC-04-38 checks.
