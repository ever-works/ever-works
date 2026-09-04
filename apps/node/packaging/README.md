# Running the Ever Works node unattended

`ever-works-node start` is a foreground process. Everything in this
directory exists so it does not have to be — so an enrolled machine
survives a reboot, restarts after a crash, and can be drained without
throwing away work it is half-way through.

Three shapes, one binary:

| Host            | Mechanism                                        | Where                                     |
| --------------- | ------------------------------------------------ | ----------------------------------------- |
| Linux (systemd) | template unit `ever-works-node@<user>.service`   | `systemd/`                                |
| Windows         | Windows service (NSSM) or Scheduled Task at boot | `windows/`                                |
| Container / k8s | image built from the node's Dockerfile           | `../../../.deploy/docker/node/Dockerfile` |

Enrollment is **never** part of installation. It consumes a one-time
token from the platform's Fleet settings page and is an explicit,
interactive act:

```bash
ever-works-node enroll --api-url https://api.ever.works --token <token>
```

Install the service afterwards.

The scripts below live in this directory of the source tree **and** inside
the published npm package: after `npm install -g ever-works-node` they are
under `$(npm root -g)/ever-works-node/packaging/`.

---

## Linux — systemd

```bash
sudo apps/node/packaging/systemd/install.sh alice
sudo -u alice ever-works-node enroll --api-url https://api.ever.works --token <token>
sudo systemctl enable --now ever-works-node@alice
journalctl -fu ever-works-node@alice
```

The unit is a **template** whose instance name is the user the node runs
as. A fleet node executes that user's commands, so it runs as that user
rather than as root or a shared service account.

`TimeoutStopSec=900` is load-bearing: stopping the node stops the
heartbeat and then **waits** for in-flight jobs to report their verdicts.
If systemd `SIGKILL`s the drain half-way, those claims lapse and the
platform re-runs the same work on another machine. Raise it above your
longest expected job.

`systemctl reload` is wired to `ever-works-node pause` — a drain, not a
restart.

## Windows

From an **elevated** PowerShell session:

```powershell
# from the published package …
& "$(npm root -g)\ever-works-node\packaging\windows\install-service.ps1" -Work
# … or from a source checkout
.\apps\node\packaging\windows\install-service.ps1 -Work
```

`-ClaudePath` / `-CodexPath` pin the model CLIs for the service (the service
account's `PATH` often lacks the per-user npm directory) and `-WorkspaceRoot`
sets the absolute, drive- or UNC-rooted directory the per-Task worktrees live
under; each becomes the matching `start` flag. `-CliPath` points the service
at a specific `cli.js` (default: the globally installed package; from a source
checkout use `apps\node\dist\cli.js`).

The script registers `node.exe` running that `cli.js` directly. npm's global
install also puts `ever-works-node.ps1` / `.cmd` shims on `PATH`, but a service
manager cannot launch the `.ps1`, and the `.cmd` puts `cmd.exe` between the
service and the node, where the console stop signal used for draining gets
swallowed. The command line is quoted once, by the script, and handed to NSSM
verbatim — Windows PowerShell 5.1 would otherwise re-quote pinned paths
containing spaces without escaping them. Re-running the script re-applies the
current flags to an existing service or task.

The script prefers a real Windows service via [NSSM](https://nssm.cc).
This matters: Node.js cannot answer Service Control Manager messages, so
`sc.exe create` pointed straight at `node.exe` yields a service Windows
reports as "did not respond in a timely fashion" (error 1053). A wrapper
is what makes it a genuine service _and_ what gives the node a graceful
stop long enough to drain.

Without NSSM the script registers a **Scheduled Task** at boot and says
so. That runs unattended and survives reboots, but it will not appear in
`services.msc`.

Remove with `uninstall-service.ps1`. That leaves the node enrolled — use
`ever-works-node unenroll` to retire it on the platform too.

## Container

```bash
docker build -f .deploy/docker/node/Dockerfile -t ever-works-node .
docker run -d --name ever-works-node \
  -v ever-works-node-config:/var/lib/ever-works-node \
  ever-works-node start --work
```

Enroll into the same volume first:

```bash
docker run --rm -it \
  -v ever-works-node-config:/var/lib/ever-works-node \
  ever-works-node enroll --api-url https://api.ever.works --token <token>
```

Build with `--build-arg WITH_BROWSER=true` to install Chromium, so the
image can honour the `browser` capability it would otherwise not
advertise. It roughly triples the image size, which is why it is opt-in.

`tini` is PID 1 on purpose: PID 1 does not get default signal handling,
and without it the node's SIGTERM drain would never run.

---

## Credential storage

The heartbeat secret goes into the OS keychain (macOS Keychain, Windows
Credential Manager, Linux Secret Service) when one is available, and the
config file holds only a pointer. Where no keychain exists — headless
servers, containers — it falls back into the config file and **says so**,
loudly, on every load. The file is then restricted to its owner: `0600`
on POSIX, and an inheritance-stripped owner-only ACL on Windows.

Two environment variables change this:

| Variable                             | Effect                                                       |
| ------------------------------------ | ------------------------------------------------------------ |
| `EVER_WORKS_NODE_DISABLE_KEYCHAIN=1` | Force the file fallback (set in the container image).        |
| `EVER_WORKS_NODE_CONFIG`             | Absolute path of the config file, overriding the OS default. |

## Draining

`pause` is a drain, not a kill:

```bash
ever-works-node pause     # stop leasing; in-flight jobs finish and report
ever-works-node resume    # take work again
```

It tells the platform (so the scheduler stops offering work) _and_
records the intent locally (so a restart comes back paused). A paused
node keeps heartbeating: a drained machine that vanishes from Fleet is
indistinguishable from a dead one.
