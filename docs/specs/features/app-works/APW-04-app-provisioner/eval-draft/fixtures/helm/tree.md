# Fixture — `helm` (detection step 4)

> DRAFT — the tree APW-13 creates as a fixture repository (plan §11.4). Expectation: `expectations.json#/cases/helm`.

```
helm/
├── chart/
│   ├── Chart.yaml         # name: ledger, version: 0.3.1
│   ├── values.yaml        # image.repository/tag, containerPort, probes, postgres host/password
│   └── templates/
│       ├── deployment.yaml
│       ├── service.yaml
│       └── secret.yaml
└── src/
    └── main.go
```

`chart/values.yaml` (the part that decides the case):

```yaml
image:
    repository: ghcr.io/example/ledger
    tag: '2.4.0'
containerPort: 8080
probes:
    readiness: /healthz
    liveness: /healthz/live
postgres:
    host: ledger-db
    password: '' # supplied at install time
```

## What matters here

- Detection stops at step 4 with `detectionSource: helm`; image, port and probe paths come **from the chart**, each
  citing `chart/values.yaml` (or the template that overrides it).
- The chart names a Postgres host, so the dependency set includes **postgres**, citing `chart/values.yaml`.
- `POSTGRES_PASSWORD` is a secret with **no default in the chart** → `from` (the platform's own postgres output);
  `POSTGRES_HOST` is not a secret; `TZ` is a non-secret default.
- The chart's own image tag is a **hint about the repository**, not the deployment's image: the platform builds the pull
  request branch and deploys the digest it produced.
