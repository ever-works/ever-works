# Negative control — deliberately broken golden files

> **These files are BROKEN ON PURPOSE. Never "fix" them.** They exist so the golden check can be shown
> to _fail_, and to fail by naming the file and the field. Repairing a corrupted value here would
> destroy the only evidence that [`../check.mjs`](../check.mjs) is not vacuous. If a run of the check
> over this directory ever passes, the check has a bug — the control is doing its job.

## What is here

Three variants. Each is a **complete copy** of [`../app-fixture-hello/`](../app-fixture-hello/) with
**exactly one field changed** — verified mechanically: 1 of the 22 files differs from the golden tree,
and it is the file named below.

| Variant                 | File changed                          | The one corruption                                                                                   | Proves                                                                    |
| ----------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `nc-01-port/`           | `your-cluster/10-deployment-web.yaml` | `containerPort: 8080` → `8081`                                                                       | a rendered port must equal `spec.components[].port`                       |
| `nc-02-latest-tag/`     | `your-cluster/10-deployment-web.yaml` | `…ever-works-app@sha256:a1b2…ff00` → `…ever-works-app:latest`                                        | no image is ever `latest`, and every Deployment pins a digest             |
| `nc-03-literal-secret/` | `your-cluster/04-secret-env.yaml`     | `FIXTURE_SESSION_SECRET: <generated:chars:32>` → `FIXTURE_SESSION_SECRET: hunter2-not-a-placeholder` | a `secret: true` / generated value may only be a reference or placeholder |

## How to run one

```bash
cd docs/specs/features/app-works/_build-artifacts/expected-outputs/golden
node check.mjs --root __negative-control__/nc-01-port --blueprint app-fixture-hello   # exits 1
node check.mjs --root __negative-control__/nc-02-latest-tag --blueprint app-fixture-hello
node check.mjs --root __negative-control__/nc-03-literal-secret --blueprint app-fixture-hello
```

The captured failing output is in [`../README.md`](../README.md) §"The negative control", together
with the clean run. Expected results: 1, 2 and 2 failing assertions respectively; each failure names
the golden file and the field, for example

```
  FAIL  2.5     1 of 1
        app-fixture-hello/your-cluster/10-deployment-web.yaml containerPort is 8081, expected 8080
```

## Provenance

`nc-*/app-fixture-hello/` is a byte copy of the golden tree at the revision recorded in that tree's own
file headers (`App spec : … sha256 afd38c6e24f3f8e4…`). It is regenerated whenever the golden tree is
regenerated, so the _only_ difference is always the corruption named above. Nothing here is a real
value: the corrupted literals are chosen to be obviously fake, and they are never valid configuration.
