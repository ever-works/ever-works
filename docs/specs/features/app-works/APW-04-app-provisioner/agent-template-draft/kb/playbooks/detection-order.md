# Playbook — detection order

> DRAFT — `ever-works/agents` → `templates/app-provisioner/kb/playbooks/detection-order.md`.
> Seeded through `.works/agent.yml` (`kb.seedPaths: [kb/playbooks]`).

Stop at the **first** source that applies, record it as the detection source, and name the file that proves it. Never
merge two sources into one answer, and never fall through to a later step because an earlier one looked inconvenient.

| #   | Source                          | What to look for                                                                                        | Detection source  |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------- |
| 1   | An existing Ever Works App spec | `.works/works.yml` (kind `app`) on the branch, valid per the platform validator                         | `app-spec`        |
| 2   | Compose files                   | `docker-compose.yml`, `compose.yaml`, `compose.*.yml` — the service that is the web entry point         | `compose`         |
| 3   | Container descriptor            | `Dockerfile`, `Containerfile`, `*.Dockerfile`, or a build section in compose that names one             | `dockerfile`      |
| 4   | Helm chart                      | `Chart.yaml` plus `values.yaml`; read the image, the container port, the probes and the migrations      | `helm`            |
| 5   | Descriptor hints                | `Procfile`, `devcontainer.json`, `app.json`, `render.yaml`, `fly.toml`, `nixpacks.toml`, `railway.json` | `descriptor-hint` |
| 6   | Language and framework          | Nothing above — detect the ecosystem and propose the zero-config (`auto`) build strategy                | `auto`            |

## Rules that hold at every step

- **Step 1 wins even when it is wrong-looking.** You are re-provisioning, not re-authoring: preserve the fields other
  epics own and change only what the evidence requires.
- **A descriptor hint is a hint.** It never supplies an image, a command or a port on its own; it tells you where to
  look in the code.
- **Step 6 needs permission.** Propose `auto` only when the Task brief lists it among the App Work's build strategies;
  otherwise write the overlay Dockerfile, because that is the only way the build can run.
- **Say which source won, in the report, with its file.** "Dockerfile found (`Dockerfile`)" is a fact; "looks like Node"
  is not.
- **Several deployable apps and nothing choosing one** is a question, not a guess: offer at most four candidates by
  path.
