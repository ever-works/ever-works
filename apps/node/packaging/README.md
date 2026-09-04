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

Enroll first, **as the account the node will run as**, then install from an
**elevated** PowerShell session:

```powershell
# 1. as the fleet user (NOT elevated) - this consumes a one-time token
ever-works-node enroll --api-url https://api.ever.works --token <token>

# 2. as an administrator: rehearse, then install
$password = Read-Host -AsSecureString 'Password for the node account'
.\apps\node\packaging\windows\install-service.ps1 -Work -ServicePassword $password -DryRun
.\apps\node\packaging\windows\install-service.ps1 -Work -ServicePassword $password
```

### Who the node runs as

This is the load-bearing decision, and it is why `-ServicePassword` is not
optional. A fleet node executes the enrolling user's work with that user's
credentials:

- its config and heartbeat credential live in that user's
  `%APPDATA%\ever-works-node`, written with inheritance stripped and exactly
  one ACE for that user;
- its git credentials live in that user's Windows Credential Manager vault,
  which the credential helper reads per-user;
- the Claude Code and Codex logins live in that user's profile.

`nssm install` calls `CreateService` with a NULL `lpServiceStartName`, which
the Win32 API defines as **LocalSystem** — an account that shares none of
those. A node installed that way starts, finds no config, reports "not
enrolled", and is restarted every 10 seconds forever.

So `-ServiceAccount` defaults to the account running the installer and is
applied on **every** run, including a re-run to change a pin. It accepts
`DOMAIN\User`, `MACHINE\User`, `.\User`, a bare local name, a UPN, and a gMSA
(`DOMAIN\name$`, which takes no password). The built-in service accounts are
refused, with the reason.

A gMSA is accepted but is an odd fit, and the preflight will say so: it is
provisioned rather than signed in to, so it has no profile, no `%APPDATA%`,
and nowhere for `ever-works-node enroll` to have put a credential. A fleet
node's whole job is to run the **enrolling user's** work with that user's git
and model-CLI logins.

### How the password is handled

`-ServicePassword` is a **SecureString**, so the plaintext never reaches your
shell history or `powershell.exe`'s own command line — passing a literal is a
parameter-binding error, not a history entry. It is never echoed, never
written to a log file, and never rendered into a progress line or an
exception.

On the **service** path it never reaches a command line either. The obvious
implementation, `nssm set <name> ObjectName <account> <password>`, puts it on
a child process's command line, and that is written to persistent telemetry:
Security event 4688 wherever command-line auditing is enabled (the Microsoft
and CIS baselines enable it), and any EDR agent that captures
`ProcessCommandLine` — Defender for Endpoint uploads that to its cloud and
keeps it queryable. So the installer unwraps the SecureString into unmanaged
memory and hands `ChangeServiceConfigW` a pointer, zeroing the buffer
afterwards. No child process, no cmdlet parameter, and no managed `String`
(which is immutable and could not be zeroed).

That means the installer also has to do the half of the job NSSM was quietly
doing for us: `ChangeServiceConfig` does **not** grant the "Log on as a
service" right, and without it a correctly configured service fails to start
with error 1069. The installer grants it with `LsaAddAccountRights`.

On the **scheduled-task** path there is no such route: `Register-ScheduledTask`
takes the password as an ordinary cmdlet parameter and the Task Scheduler API
takes a `BSTR`, so a managed copy exists for the duration of the call and
PowerShell module logging (event 4103) would record the bound value where that
policy is enabled. One more reason the service is the recommended mechanism.

### Preflight

The installer refuses, before registering anything, when the chosen account
could not actually run a node: no such account, no profile, no config at that
account's `%APPDATA%` path, a config whose ACL does not grant it, a
`-ClaudePath`/`-CodexPath` pin that does not resolve or is not launchable, or
a workspace root it cannot write (or that would land inside the system
profile). It warns — but proceeds — for the survivable cases, including a
pinned CLI with no login: the node would advertise `claude-code` and then fail
every job it was sent, which is worse than not advertising it at all.

It also warns when the account cannot write `%ProgramData%\ever-works-node` or
a log file already there, and then **fixes** it: files created in that folder
by a privileged identity inherit only `BUILTIN\Users: ReadAndExecute`, so a
`node.log` written by a LocalSystem-era install is read-only to the account
the fixed installer picks. Left alone, the service could not open its
`AppStdout` and the scheduled task would die inside `cmd.exe` before the node
ran — with nothing in either log. The installer grants the account `Modify` on
the directory and on any log left behind.

### If a real run fails part-way

A fresh install that fails after `nssm install` — most likely at the identity
step, which is where a wrong account or password surfaces — is **undone**. The
service is removed rather than left registered under the LocalSystem default
this whole mechanism exists to avoid. A re-run over a service that already
existed is not removed; the message says so, and names `uninstall-service.ps1`.

### Dry run

`-DryRun` (or the standard `-WhatIf`) runs the whole preflight and prints
every command that would run, changing nothing. It does not require elevation,
so it is the way to check five remote machines before touching any of them.

### Other flags

`-ClaudePath` / `-CodexPath` pin the model CLIs for the service (a service
inherits the **machine** `PATH`, which normally lacks the per-user npm
directory) and `-WorkspaceRoot` sets the absolute, drive- or UNC-rooted
directory the per-Task worktrees live under; each becomes the matching `start`
flag. `-CliPath` points the service at a specific `cli.js` (default: the
globally installed package; from a source checkout use `apps\node\dist\cli.js`).

### Mechanism

The script registers `node.exe` running that `cli.js` directly. npm's global
install also puts `ever-works-node.ps1` / `.cmd` shims on `PATH`, but a service
manager cannot launch the `.ps1`, and the `.cmd` puts `cmd.exe` between the
service and the node, where the console stop signal used for draining gets
swallowed. The command line is quoted once, by the script, and handed to NSSM
verbatim — Windows PowerShell 5.1 would otherwise re-quote pinned paths
containing spaces without escaping them.

The script prefers a real Windows service via [NSSM](https://nssm.cc).
This matters: Node.js cannot answer Service Control Manager messages, so
`sc.exe create` pointed straight at `node.exe` yields a service Windows
reports as "did not respond in a timely fashion" (error 1053). A wrapper
is what makes it a genuine service _and_ what gives the node a graceful
stop long enough to drain.

Without NSSM the script registers a **Scheduled Task** at boot and says so.
That runs unattended and survives reboots, but it will not appear in
`services.msc`. Both branches write `%ProgramData%\ever-works-node\node.log`
and `node.err.log`; the task branch reaches them through `cmd.exe`, which is
acceptable there only because `Stop-ScheduledTask` terminates the task
outright and delivers no console event for `cmd.exe` to swallow — that branch
never drained.

Without `-ServicePassword` the task falls back to an **S4U** logon, which is
minted without the account's password and therefore never unlocks its DPAPI
master key: Windows Credential Manager reads fail there exactly as they do
under LocalSystem. The preflight says so. (A gMSA is not S4U either — its
password is held by the domain controller, so it registers as a `Password`
logon with no value.)

Remove with `uninstall-service.ps1`. That leaves the node enrolled — use
`ever-works-node unenroll` to retire it on the platform too.

### Tests

`test-install-service-logic.ps1` covers the decision logic (account
normalisation, the service configuration plan, the scheduled-task plan, the
ACL plan, the access-verdict and pin rules, the preflight verdicts) without
registering anything. It also exercises the `ChangeServiceConfigW` and
`LsaAddAccountRights` signatures against a deliberately invalid handle, which
proves the marshalling without touching a service or the local security
policy. `.github/workflows/node-packaging-windows.yml` runs it on a
`windows-2022` runner under Windows PowerShell 5.1 — the shell the fleet
workstations actually have — and exercises the installer's `-DryRun` and
`-WhatIf` paths. `apps/node/src/core/packaging/windows-service-contract.internal.spec.ts`
pins the same invariants from the Linux CI, so they hold even if that
workflow's path filter is edited.

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
