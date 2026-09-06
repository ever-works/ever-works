# AW-20 — First-hour onboarding and provisioning

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> This document describes **what a user sees and can do**. No class names, no file
> paths, no code — those live in [`plan.md`](./plan.md).

**Feature ID**: `aw-20-onboarding`
**Program**: [Agent Workspace](../README.md)
**Branch**: `feat/aw-20-onboarding`
**Status**: `Draft`
**Created**: 2026-09-06
**Last updated**: 2026-09-06
**Size**: M · **Blocking dependencies**: none
**Extends**: the existing onboarding wizard and its role-driven starter seeding
**Adjacent epics**: [AW-19 Home](../AW-19-home/), [AW-02 Mission board](../AW-02-mission-board/), [AW-03 My Decisions](../AW-03-decision-queue/), [AW-10 Schedules](../AW-10-schedules-calendar/), [AW-21 Capability catalogue](../AW-21-capability-catalog/), [AW-25 Help centre](../AW-25-help-center/)

> **Additive by default (program rule #1).** The existing onboarding wizard keeps
> every step it has today, in the same order, with the same server-persisted
> state, the same catalogue endpoint and the same telemetry allow-list. This epic
> inserts **one** new step, adds **one** new dashboard surface, and adds **one**
> new attribute to Agents. Nothing is renamed, removed, or re-pointed. A user who
> skips everything this epic adds ends up exactly where they end up today.
>
> **Two new concepts are introduced and justified in §5:** a per-person **setup
> checklist** (the five first-hour milestones, evaluated server-side), and a
> **lane** — a short label naming the area of work one Agent owns. A *roster* is
> not a new entity: it is the set of Agents the platform provisions for a
> workspace, each carrying a lane.

> **Dependency posture.** This epic is a *router*: it sends people into Missions,
> Approvals, Escalations and Schedules, all of which exist today. It therefore
> reads those surfaces directly and must keep working before AW-02, AW-03, AW-10
> and AW-19 land. §4.9 pins exactly what each milestone reads today and what it
> switches to as those epics ship.

---

## 0. TL;DR

```
   The first hour, as one screen the user can leave and come back to
   ┌───────────────────────────────────────────────────────────────────────────┐
   │  Get set up                                        2 of 5 · Hide          │
   │  ─────────────────────────────────────────────────────────────────────    │
   │  ●  Connect your AI provider                              Done · 2 min ago│
   │  ●  Meet your agents                                      Done · just now │
   │  ○  Ship your first mission                            [ Pick a brief ]   │
   │     Hand your agents one real piece of work.                              │
   │  ○  Answer your first decision                                  Waiting   │
   │     Your agents ask before anything leaves the workspace.                 │
   │  ○  Put something on a schedule                        [ Choose a job ]   │
   └───────────────────────────────────────────────────────────────────────────┘

   Provisioning, as it happens
   ┌───────────────────────────────────────────────────────────────────────────┐
   │  Setting up your agents…                                     binding (3/4)│
   │   ✓ Coordination      Ada            created                              │
   │   ✓ Research          Research       created                              │
   │   ✓ Content           Content        created                              │
   │   ◐ Market watch      Market watch   attaching skills…                    │
   └───────────────────────────────────────────────────────────────────────────┘
```

Ever Works can already do everything a new owner needs. It has Agents, Missions,
Tasks, Approvals, Escalations, Skills, Schedules and a run history. What it does
not have is a **first hour**: the current wizard asks which AI provider, which
git storage, which database and which deployment target — four infrastructure
questions — and then closes, leaving the user on a dashboard with **zero agents,
zero missions and no next action**. The one step that does create agents (the
"what do you do" role step) is optional, is buried between two provider steps,
creates a flat list of unrelated agents with no coordinator and no first job, and
never tells the user afterwards that it worked.

This epic makes the first hour end somewhere specific. By the time the user
closes the setup checklist they have:

1. **connected a provider** — and we proved it works with a live check, at the
   moment they entered it, instead of failing on the first agent run;
2. **met their agents** — a provisioned roster with a coordinator and named
   lanes, introduced by name, with a reporting line and delegation already wired;
3. **shipped one real mission** — from a starter brief that carries acceptance
   checks, dispatched to the lane agent that owns it;
4. **answered one decision** — which the platform reliably produces, because
   every provisioned agent ships with review-before-act guardrails;
5. **put one job on a schedule** — so something runs tomorrow without them.

Three phases, each independently shippable:

- **P1 — The roster.** A new "Your agents" wizard step, roster blueprints,
  background provisioning with visible per-lane progress, the roster
  introduction, and the `lane` attribute on Agents.
- **P2 — The checklist.** The five milestones evaluated server-side, the
  **Get set up** card on Home, the full `/get-started` page, and the guided
  paths into the first mission, the first decision and the first schedule.
- **P3 — Repair and reach.** Re-run a failed lane, switch blueprint, replay the
  checklist from Help, hand a second person on the workspace their own checklist,
  and the completion funnel.

---

## 1. Overview

A person finishes signing up and is taken through setup. After the questions
about which providers to use, they reach a new step: **Your agents**. It proposes
a small roster — four agents by default — derived from the roles they just told
us about. Each proposed agent has a **lane**: a short label naming the area of
work it owns (Coordination, Research, Content, Market watch). One of them is the
**coordinator**: the agent every other agent reports to, and the one to hand
something to when it is not obvious who owns it. The user can rename any agent,
drop a lane, add one from a short list, or skip the whole step.

Pressing **Create my agents** starts provisioning in the background and returns
immediately. A progress panel names every lane and shows what happened to it:
created, reused (an agent with that name already existed), skipped because the
plan has no seat left, or failed. Provisioning is safe to run twice: it never
duplicates an agent, and a second run only fills the gaps left by the first.

When provisioning finishes, the user gets a one-screen **introduction**: each
agent by name, its lane, one line saying what it does, and its reporting line.
Reading it and pressing **Got it** is what marks *"met your agents"* done — the
platform does not claim the user met agents it merely created.

From that point the user sees a **Get set up** card at the top of Home and a full
page at `/get-started`. It shows five milestones, how many are done, and the one
action that advances each. Two are already done. The third offers three starter
briefs — real, short pieces of work with acceptance checks written into them —
and creates a Mission plus a Task assigned to the lane agent that owns it. The
work starts immediately and is visible on the mission surfaces.

Because every provisioned agent is created in review-before-act mode, that first
run reaches a point where it needs permission — to send something, to spend
something, to pick between two directions — and stops, raising an approval or an
escalation. That is milestone four, and it arrives on its own: the card starts
saying *"1 waiting"* and links straight to it. Answering it lets the work
continue.

Milestone five offers three recurring jobs the platform already knows how to run
— a daily workspace digest, a weekly mission review, or a cadence on the
coordinator — and arms exactly one.

The checklist is a permanent, resumable object. It survives sign-out, a device
switch, a browser wipe and a failed provisioning run. A milestone can be marked
*not for me* and stops asking. The card can be hidden at any time and reopened
later from Help. Nothing in it is a gate: every surface it points at is reachable
without it, before it, and after it.

---

## 2. Why now

### 2.1 The question this answers

> *"I signed up. Now what — and how do I know any of this is actually working?"*

This is the only question a new owner has, and it is asked in the ninety seconds
after the wizard closes. If it is not answered in that window, the account goes
quiet: the substrate is all there, but nothing in the product ever asks the user
to use it.

### 2.2 What a user does today instead

| To get to… | Today they must… |
| --- | --- |
| A working AI provider | Pick a card in the wizard, then discover on the first agent run — minutes or hours later, in a failed run's error message — whether the credential was any good |
| Any agent at all | Find the optional "what do you do" step, pick roles, notice the suggestion block below the role grid, and press "create the whole kit" — or, after the wizard, go to Agents and create one by hand from a template |
| A roster that works together | Create each agent by hand, then open each one's settings and set "reports to", then open the collaborators tab on the one that should delegate and enable each of the others — five screens per agent, and nothing in the product tells them this wiring exists |
| A first mission | Guess. There is no starter brief anywhere, and a brief without acceptance checks is exactly the brief that ends in an escalation |
| A first decision | Wait for one to happen, and hope they are looking at the right surface when it does — approvals render in a block on Home, escalations do not render anywhere |
| A first schedule | Know that recurring tasks, agent heartbeats and work schedules exist, and find the one that fits |
| To resume setup tomorrow | Nothing resumes. The wizard's saved state is a step index and four provider choices; it cannot express "you have not shipped anything yet" |

### 2.3 The seven concrete gaps

1. **Setup ends at infrastructure.** The wizard's thirteen steps are: welcome,
   AI, storage, database, deployment, where-does-this-run, roles, chat
   connection, plugins, create a Work. Nine of those are about *provisioning
   plumbing*; none of them is about *delegating work*. The product's whole value
   proposition begins one screen after the wizard closes, and nothing carries the
   user across that line.

2. **Nothing verifies the provider.** A connection-status read and a live
   validate-connection call both exist in the platform and neither is on the
   wizard's default path. A mistyped credential is discovered by an agent, in a
   failed run, later — the most expensive possible place to learn it.

3. **Starter agents are a side note with no follow-through.** Role-driven seeding
   is real, exhaustive and idempotent, and it is rendered as a block underneath a
   role grid on a step the user is told is skippable. Nothing confirms afterwards
   what was created, nothing sets a reporting line, nothing enables delegation
   between the created agents, and nothing gives any of them work.

4. **There is no coordinator.** The prebuilt agent catalogue is six
   go-to-market specialists. There is no agent whose job is to receive an
   ambiguous request and route it, which means a new user must know which
   specialist to address before they can delegate at all. The reporting-line
   column and the delegation allow-list both exist and are both empty on every
   provisioned agent.

5. **No agent says what it is for.** An Agent carries a name, an optional title
   and a free-text capabilities blob. Nothing on it answers "which part of my
   work does this one own", so a roster of six is six names the user has to hold
   in their head.

6. **Completion means "the dialog closed".** The persisted onboarding state is a
   step index, four provider choices, a skipped-steps list, a plugins-reviewed
   boolean and an optional role/team-size hint. Both completion timestamps mean
   the *wizard* ended. No signal anywhere means the *user* is operating.

7. **Provisioning is invisible and unrecoverable.** Creating starter agents is a
   synchronous request that either returns a list or does not. If it half-fails —
   a seat limit hit on the fourth agent, a name collision on the second — the
   user sees a partial list with no explanation and no way to finish the job.

### 2.4 Why this is small

Most of this epic is wiring that already exists:

- role → starter-kit resolution is written, exhaustive and type-enforced;
- creating an Agent from a template is an endpoint;
- reporting lines, delegation allow-lists and skill bindings are all endpoints;
- creating a Mission, creating a Task and assigning it to an agent are endpoints,
  and assignment already pre-creates a run and pushes it through the admission
  gate;
- approvals and escalations both have list-and-decide endpoints;
- a single read aggregates every kind of schedule the platform runs.

What is missing is a **spine** that walks a person through them in order, and a
**record** of how far they got.

---

## 3. User scenarios

### 3.1 Happy path — the whole first hour

> **Given** a new user who has just answered the provider questions in setup
> **When** they reach the **Your agents** step
> **Then** they see a proposed roster of four agents, each with a lane, a name
> and one line of description, with the coordination lane first and marked as the
> coordinator, and a note saying every agent will ask before it acts
> **And when** they press **Create my agents**
> **Then** the step switches to a progress panel within 1 second, each lane shows
> its own state, and every lane reaches a terminal state within 120 seconds
> **And** the introduction appears, naming each agent and its lane
> **And when** they press **Got it**
> **Then** milestones 1 and 2 are marked done and the wizard continues to its
> remaining steps unchanged
> **And when** the wizard closes
> **Then** Home shows a **Get set up** card reading *2 of 5*.

### 3.2 Happy path — the first mission produces the first decision

> **Given** a user with a provisioned roster and the checklist at *2 of 5*
> **When** they press **Pick a brief** on *Ship your first mission*
> **Then** they see three starter briefs, each under 280 characters, each naming
> what "finished" means, and each showing which lane will pick it up
> **And when** they choose one and press **Send it**
> **Then** a Mission is created with that brief, one Task is created under it
> carrying the acceptance checks, the Task is assigned to the lane's agent, and
> the user is shown the Mission with a link back to the checklist
> **And** the milestone flips to done as soon as that Mission has one completed
> run, or when the user marks the Mission complete
> **And when** the run reaches an action its guardrails will not take unattended
> **Then** an approval or escalation is raised, the checklist card starts reading
> *1 waiting* on *Answer your first decision*, and answering it marks milestone 4
> done and lets the work continue.

### 3.3 Happy path — resuming on another device

> **Given** a user who completed milestones 1–3 on a laptop and signs in on a
> tablet an hour later
> **When** Home loads
> **Then** the **Get set up** card reads *3 of 5* with the same two milestones
> outstanding and the same next actions, because the checklist is stored against
> the account and not the browser.

### 3.4 Unhappy path — the provider credential is wrong

> **Given** a user who pasted a credential that the provider rejects
> **When** the setup step performs its live check
> **Then** within 10 seconds the provider row shows **Couldn't reach this
> provider** with the provider's own reason, a **Try again** button and a
> **Continue anyway** link
> **And** milestone 1 stays *not done*
> **And if** they continue anyway and provision a roster, provisioning still
> succeeds — agents are configuration, not inference — but the **Ship your first
> mission** milestone shows an inline warning saying work will not run until a
> provider is connected, with a link back to the provider step.

### 3.5 Unhappy path — provisioning half-fails on a plan limit

> **Given** a plan with two agent seats left and a blueprint proposing four lanes
> **When** provisioning runs
> **Then** the first two lanes report **created**, the remaining two report
> **Not enough seats**, the run finishes as **partial**, and the panel shows
> *2 of 4 agents created* with a **See plans** link and a **Finish this later**
> button
> **And** milestone 2 is offered as completable on the agents that were created —
> a partial roster is a real roster
> **And when** the user frees a seat and presses **Finish setting up**
> **Then** only the two missing lanes are attempted; the two existing agents are
> untouched.

### 3.6 Unhappy path — a name is already taken

> **Given** a user who already has an agent named *Research*
> **When** provisioning reaches the research lane
> **Then** it creates *Research 2* and reports the lane as **created** with a note
> *Named Research 2 — you already had a Research*
> **And if** *Research 2* … *Research 9* are all taken
> **Then** that lane alone reports **failed** with reason **Couldn't find a free
> name**, offers a rename field, and the rest of the roster is unaffected.

### 3.7 Unhappy path — provisioning never finishes

> **Given** a provisioning run that has not reported a terminal state
> **When** 150 seconds have passed since it was started
> **Then** the panel shows **This is taking longer than usual** with **Keep
> waiting** and **Try again**, and stops polling
> **And** pressing **Try again** starts a fresh run that reuses everything
> already created and only attempts the outstanding lanes
> **And** no duplicate agent is ever created by the retry.

### 3.8 Unhappy path — two tabs, one roster

> **Given** the same user with the setup step open in two browser tabs
> **When** they press **Create my agents** in both within a second of each other
> **Then** the second request is rejected with *Already setting up your agents*
> and both tabs converge on the same single provisioning run and the same result
> **And** exactly one set of agents exists afterwards.

### 3.9 Unhappy path — the user skips the roster step entirely

> **Given** a user who presses **Skip** on the **Your agents** step
> **When** the wizard closes
> **Then** no agents are created, and the **Get set up** card reads *1 of 5* with
> **Meet your agents** showing **Set up my agents** as its action
> **And** pressing it opens the same roster step as a standalone panel, outside
> the wizard, with the same blueprint and the same behaviour.

### 3.10 Unhappy path — a milestone that will never apply

> **Given** a user who does not want anything on a schedule
> **When** they open the *…* menu on **Put something on a schedule** and choose
> **Not for me**
> **Then** the milestone renders struck through and greyed, the counter reads
> *4 of 4 · 1 skipped*, and the card completes when the remaining four are done
> **And** the choice is reversible from the same menu.

### 3.11 Unhappy path — the checklist is opened by someone who is already set up

> **Given** an existing user who has had agents, missions, decisions and
> schedules for months, and who has never seen this feature
> **When** they first load Home after this epic ships
> **Then** the checklist is evaluated against what they already have, all
> applicable milestones read **Done**, the card renders once in a completed state
> with a **Nice — you're set up** line and a **Dismiss** button, and it never
> renders again after dismissal
> **And** no agent, mission, schedule or decision is created on their behalf.

### 3.12 Unhappy path — a permission denial

> **Given** a member of an organization whose role does not permit creating
> Agents
> **When** they open the **Your agents** step
> **Then** the roster preview renders read-only with the message **Someone with
> permission to add agents needs to do this** and a **Copy this to send to an
> admin** button
> **And** the **Create my agents** button is disabled and explains why on focus
> **And** their checklist shows **Meet your agents** as *waiting on someone else*
> rather than as an action they have failed to take.

### 3.13 Unhappy path — the decision milestone with nothing to decide

> **Given** a user whose first mission finished cleanly without raising anything
> **When** they look at **Answer your first decision**
> **Then** it reads **Nothing needs you yet** with a one-line explanation of when
> a decision appears and a **Show me an example** link into the capability
> catalogue, rather than an action button that would do nothing
> **And** the milestone flips to done the moment any approval or escalation is
> decided, whenever that happens.

### 3.14 Unhappy path — the checklist read fails

> **Given** a transient failure reading the checklist
> **When** Home renders
> **Then** the card renders in its error state — **Couldn't load your setup
> progress** with a **Retry** — and nothing else on Home is affected
> **And** the card never blocks, delays, or replaces any other block on Home.

### 3.15 Unhappy path — provisioning is asked for a lane that does not exist

> **Given** a request naming a lane key that is not in the chosen blueprint or
> the lane catalogue
> **When** provisioning is requested
> **Then** the request is rejected with a validation error naming the unknown
> lane, nothing is created, and the previous roster state is unchanged.

### 3.16 Empty state — no roles were answered

> **Given** a user who skipped the roles step
> **When** they reach **Your agents**
> **Then** the general blueprint is proposed, the panel says **We picked a
> starting point — change anything you like**, and a **Tell us what you do**
> link jumps back to the roles step and re-derives the proposal on return.

### 3.17 Over-limit — the lane cap

> **Given** a user adding lanes to the proposed roster
> **When** they have selected 8 lanes and try to add a ninth
> **Then** the add control is disabled with **8 agents is the most we'll set up
> at once — you can add more any time from Agents**.

### 3.18 Race — a milestone completes while the page is open

> **Given** the checklist open at *3 of 5* with a run in flight
> **When** an approval is raised and answered in another tab
> **Then** within 60 seconds the open page shows *4 of 5* without a manual
> refresh and without losing any in-progress input in the starter-brief picker.

---

## 4. Functional requirements

### 4.1 The setup step

- **FR-1** Setup gains exactly **one** new step, **Your agents**, positioned
  immediately after the roles step and before the chat-connection step. Step
  order, ids and skip semantics of every existing step are unchanged.
- **FR-2** The step is always shown and always skippable. Skipping records the
  skip and creates nothing.
- **FR-3** The step proposes a **roster blueprint**: an ordered list of lanes.
  The proposal is derived from the roles and team size already answered; when
  neither was answered, the **general** blueprint is proposed.
- **FR-4** Blueprint selection is **total and deterministic**: every role option
  the platform offers maps to a blueprint, the mapping is verified by a test, and
  the same answers always propose the same blueprint.
- **FR-5** Team size caps how many lanes are proposed: **solo → 3**,
  **2–10 → 5**, **11–50 → 6**, **51–200 → 8**, **200+ → 8**, unanswered → **5**.
  The coordination lane is never trimmed.
- **FR-6** A blueprint declares at most **8** lanes. A user may add lanes from
  the lane catalogue up to the same ceiling of 8, and may remove any lane except
  coordination.
- **FR-7** Every proposed agent's name is editable in place before provisioning,
  limited to **60** characters, and must be non-empty.
- **FR-8** Exactly one lane in every blueprint is the **coordinator**. It is
  always first, always present, and cannot be removed or reassigned to another
  lane.

### 4.2 Provisioning

- **FR-9** Provisioning is asynchronous. The request returns within **1 second**
  with a provisioning identifier and a state of **queued**; it never blocks on
  agent creation.
- **FR-10** Provisioning states are exactly: **queued → creating → binding →
  ready | partial | failed**. There is no other state.
- **FR-11** Each lane carries its own outcome: **created**, **reused**,
  **skipped (no seat)**, or **failed** with a reason. Lane outcomes are visible
  while the run is in flight, not only at the end.
- **FR-12** Agents are created **one at a time, in blueprint order**, because
  agent names are unique per person and parallel creation races that constraint
  into false conflicts.
- **FR-13** Each lane is attempted at most **3** times (initial attempt plus 2
  retries) with a **5 second** gap, and each attempt is abandoned after **20
  seconds**.
- **FR-14** A whole provisioning run is abandoned after **120 seconds** and
  reported as **partial** if anything was created, **failed** if nothing was.
- **FR-15** Provisioning is **idempotent per person and workspace scope**. Running
  it again never creates a second agent for a lane that already has one; it
  reports that lane as **reused** and attempts only outstanding lanes.
- **FR-16** At most **one** provisioning run per person and scope may be in
  flight. A second request while one is in flight is refused with a conflict and
  the identifier of the run already going.
- **FR-17** Provisioning may be requested at most **5 times per hour** per
  person.
- **FR-18** On a name collision, the lane's agent is created with a numeric
  suffix from **2** to **9**. If all are taken, that lane alone fails with
  **name-unavailable** and offers a rename.
- **FR-19** When agent creation is refused for want of a seat, the current lane
  and every remaining lane report **skipped (no seat)**, the run finishes as
  **partial** or **failed**, and the result carries a link to plan management. No
  other lane outcome is affected.
- **FR-20** Every provisioned agent is created with **review-before-act
  guardrails**: it proposes, and a human approves, before it acts. This is not
  configurable during provisioning.
- **FR-21** Every provisioned agent is created with **no schedule** — it acts when
  given work and never on a cadence of its own. Arming a cadence is milestone 5
  and is always an explicit act.
- **FR-22** Provisioning sets the **reporting line** of every non-coordinator
  agent to the coordinator, and adds every non-coordinator agent to the
  coordinator's **delegation allow-list**, enabled.
- **FR-23** Provisioning attaches each lane's suggested Skills. A Skill that
  cannot be attached is reported on that lane as a warning and never fails the
  lane: an agent without one skill is still an agent.
- **FR-24** Provisioning never touches an Agent it did not create in this run,
  except to add it to the coordinator's allow-list when it occupies a blueprint
  lane and was reused.
- **FR-25** Every provisioned agent is left **active**.

### 4.3 Lanes

- **FR-26** An Agent may carry a **lane**: a stable key of at most **32**
  characters and a display label of at most **32** characters. It is optional;
  every existing Agent has none and is unaffected.
- **FR-27** A lane is a label, not a permission. It grants nothing, restricts
  nothing, and is never consulted by any authorization decision.
- **FR-28** Two Agents belonging to the same person may not hold the same lane
  key. Provisioning enforces this by reusing rather than duplicating.
- **FR-29** The lane is shown on the agent card, on the agent's own page, and in
  every roster surface. It is editable wherever an agent's title is editable.
- **FR-30** The lane catalogue offered during provisioning holds at most **12**
  entries and each maps to exactly one prebuilt agent template.

### 4.4 The introduction

- **FR-31** After a provisioning run reaches **ready** or **partial**, an
  introduction is shown listing every roster agent with its name, lane, one-line
  description and reporting line.
- **FR-32** **Meet your agents** is marked done only when the user acknowledges
  the introduction. Provisioning alone never marks it done.
- **FR-33** The introduction is reachable again at any time from the checklist
  and from Help, and acknowledging it twice is harmless.

### 4.5 The checklist

- **FR-34** The checklist holds exactly **five** milestones, in this order:
  1. Connect your AI provider
  2. Meet your agents
  3. Ship your first mission
  4. Answer your first decision
  5. Put something on a schedule
- **FR-35** Each milestone is **pending**, **done**, or **skipped**. A done
  milestone records when it completed and what completed it.
- **FR-36** A milestone is never marked done on the client's word. Every
  completion is decided server-side from a fact that already exists in the
  platform.
- **FR-37** The completion facts are exactly:
  | # | Milestone | Done when |
  | --- | --- | --- |
  | 1 | Connect your AI provider | A provider with AI capability reports a successful live check no older than **24 hours** |
  | 2 | Meet your agents | A provisioning run reached **ready** or **partial** *and* the introduction was acknowledged |
  | 3 | Ship your first mission | A Mission owned by this person has at least one **completed** run, or has been marked complete |
  | 4 | Answer your first decision | An approval owned by this person has been approved or rejected, or an escalation has been resolved |
  | 5 | Put something on a schedule | At least one **enabled** entry exists in the person's schedule read-model |
- **FR-38** The checklist is evaluated on read and cached for **60 seconds** per
  person. Any action taken through the checklist re-evaluates immediately.
- **FR-39** An open checklist refreshes itself at most every **60 seconds** and
  never while a form inside it has focus or unsaved input.
- **FR-40** A milestone may be marked **not for me**, which removes it from the
  denominator (*4 of 4 · 1 skipped*) and is reversible.
- **FR-41** The checklist may be hidden. Hiding never deletes it; it is reopened
  from Help and from a direct link.
- **FR-42** Once every applicable milestone is done, the card renders one final
  completed state and stops rendering after it is dismissed or after **7 days**,
  whichever comes first.
- **FR-43** The checklist is created lazily on first read. An account that never
  loads Home never gets a row.
- **FR-44** For a person who already satisfies milestones before ever seeing the
  checklist, the first evaluation marks them done from existing facts. The
  checklist never creates anything to make itself true.

### 4.6 The first mission

- **FR-45** *Ship your first mission* offers exactly **3** starter briefs. Each
  brief is at most **280** characters, states what finished looks like, and names
  the lane that will pick it up.
- **FR-46** A starter brief is offered only when a roster agent exists for its
  lane. When no roster exists, the milestone's action is **Set up my agents** and
  points at milestone 2.
- **FR-47** Choosing a brief creates one Mission and one Task under it, records
  the brief's acceptance checks on the Task, and assigns the Task to the lane's
  agent — the same assignment path any hand-created task uses, including the
  admission gate.
- **FR-48** The brief is editable before sending and may be replaced entirely
  with the user's own text, up to the Mission description limit of **10 000**
  characters.
- **FR-49** If no AI provider is connected, sending is still allowed but the
  confirmation states plainly that the work will not run until one is connected,
  and links to milestone 1.
- **FR-50** Starter briefs may be sent at most **10 times per hour** per person.

### 4.7 The first decision

- **FR-51** *Answer your first decision* shows a live count of open approvals
  plus open escalations for this person. When the count is zero it shows an
  explanation, not a dead action button.
- **FR-52** Its action opens the existing decision surface; it never renders a
  second, private copy of a decision.
- **FR-53** The milestone completes on the **first decision of any kind**,
  including one decided from somewhere else entirely.

### 4.8 The first schedule

- **FR-54** *Put something on a schedule* offers exactly **3** options: a daily
  workspace digest, a weekly mission review, and a cadence on the coordinator.
- **FR-55** Each option states its cadence in the person's own timezone before it
  is armed. The default for the daily option is **08:00 local**.
- **FR-56** Arming an option uses the platform's existing scheduling mechanism
  for that kind of work. No new scheduling mechanism is introduced.
- **FR-57** Only one option needs to be armed to complete the milestone, and
  arming a schedule anywhere else in the product completes it equally.

### 4.9 Degradation and dependencies

- **FR-58** Every milestone action must resolve to a surface that exists today:
  Missions, the approvals block, escalations, Agents, and Schedules. Where a
  program epic later owns a richer surface, the action's destination changes and
  nothing else does.
- **FR-59** A failure reading any single milestone's completion fact degrades
  that milestone to **pending** with a quiet *couldn't check* marker. It never
  fails the whole checklist and never marks anything done by accident.
- **FR-60** Nothing in this epic is a gate. Every destination is reachable
  without the checklist, and hiding, skipping or never opening it changes no
  behaviour anywhere else in the product.

### 4.10 Privacy, permissions and cost

- **FR-61** Everything in this epic is scoped to the person and the active
  workspace scope. No checklist, roster or provisioning state is ever readable
  across accounts.
- **FR-62** The provider check never returns, logs or displays the credential —
  only reachable/not reachable and the provider's own reason string.
- **FR-63** A person without permission to create Agents sees the roster preview
  read-only, with an explanation, and their milestone 2 reads *waiting on someone
  else*.
- **FR-64** Provisioning spends nothing. Creating agents, attaching skills and
  wiring reporting lines are configuration writes. The first thing in this epic
  that can spend is the starter mission, and its confirmation says so.
- **FR-65** Telemetry records milestone keys, blueprint slugs, lane keys,
  outcomes and durations. It never records brief text, agent names, mission
  titles or any provider reason string.

---

## 5. Key entities

### 5.1 Already in Ever Works — used unchanged

| Entity | Role here | States it moves through |
| --- | --- | --- |
| **Agent** | The roster is Agents. Provisioning creates them from prebuilt templates and leaves them active. | `draft → active`, then the normal lifecycle |
| **Agent run** | What "shipped a mission" is measured by. | `queued → running → completed \| failed \| cancelled` |
| **Mission** | Created by the starter brief. | unchanged |
| **Task** | Created under the starter Mission, carries the acceptance checks, is assigned to the lane agent. | unchanged |
| **Approval** | Raised by a roster agent's review-before-act guardrails; one of the two things milestone 4 counts. | `pending → approved \| rejected` |
| **Escalation** | Raised when an agent gives up or refuses; the other thing milestone 4 counts. | `open → resolved` |
| **Skill** | Attached to roster agents during the binding stage. | unchanged |
| **Schedule** | What milestone 5 arms; read through the existing unified schedule read-model. | unchanged |
| **Plugin / Connection** | What milestone 1 checks. | not-connected → connected → lapsed |
| **Organization / Workspace scope** | Scopes the checklist and the roster. | unchanged |
| **Onboarding wizard state** | Keeps its existing shape and its existing completion timestamps; gains nothing. | unchanged |

### 5.2 New — and why

#### 5.2.1 Setup checklist *(new, one row per person per workspace scope)*

**What it is.** The record of how far a person got through the first hour: five
milestones, each `pending | done | skipped`, each done one carrying when it
completed and which object completed it; plus whether the card is hidden and
whether the roster introduction has been acknowledged.

**Why it cannot be the existing wizard state.** The wizard's persisted state is a
step index plus provider choices. Its two timestamps mean *the dialog closed* and
*the dialog was dismissed*. Four of the five milestones here are satisfied by
facts in four other subsystems — a completed run, a decided approval, a resolved
escalation, an enabled schedule — none of which the wizard's shape can express,
and none of which should be written into a blob whose whole contract is "the
wizard's own progress". Folding them in would also mean every wizard write and
every milestone write contend on the same row.

**Why it is not derived on the fly with no row at all.** Three pieces of state
have no source anywhere else: *skipped*, *hidden*, and *the introduction was
acknowledged*. All three are decisions the person made and must survive a device
switch. Everything else on the row is a cache with a 60-second life.

**States.** Per milestone: `pending → done` (irreversible — a shipped mission
stays shipped) and `pending ⇄ skipped`. Per row: `active → hidden`, reversible;
`active → completed → dismissed`.

#### 5.2.2 Lane *(new — an attribute of Agent, not an entity)*

**What it is.** A short, stable label naming the area of work one Agent owns:
`coordination`, `research`, `content`, `outreach`, `visibility`, `social`,
`market-watch`.

**Why it is needed.** A roster is only legible if each member's job is stated. An
Agent today has a name, a free-text title and a free-text capabilities blob;
none of them is a stable key, so nothing can ask "who owns research here?" — not
the coordinator when it routes, not the starter-brief picker when it chooses an
assignee, not provisioning when it decides whether a lane is already filled.

**Why it is an attribute and not a new entity.** It holds no state of its own, has
no lifecycle, and is one-to-one with the Agent. Making it a table would create a
second noun for a thing that is already an Agent — exactly what program rule #2
forbids.

**States.** None. It is set at provisioning, editable afterwards, and may be
cleared.

#### 5.2.3 Roster blueprint *(new — content that ships with the build, not data)*

**What it is.** A named, ordered list of lanes with a default agent name and a
prebuilt template per lane. Five blueprints ship: **general**, **growth**,
**revenue**, **insight**, **solo starter**.

**Why it is not a table.** It changes when we ship, not when a user acts; it has
no per-person state; and it must be identical in every environment on a given
build. Persisting it would buy nothing and would immediately drift between
environments. This mirrors how the prebuilt agent templates and the role starter
kits are already carried.

**States.** None.

#### 5.2.4 Provisioning run *(new — a record inside the checklist row, not a table)*

**What it is.** The state of the current or last roster provisioning attempt:
blueprint, overall state, and one row per lane with its outcome, the agent it
produced, and any reason.

**Why it is not its own table.** It is one small, bounded object per person, read
only in the moments around provisioning, and written only by provisioning. It is
one-to-one with the checklist row, which already exists for every person who gets
this far. A separate table would add a join and a second lifecycle for no read
pattern anyone has.

**States.** `idle → queued → creating → binding → ready | partial | failed`, and
back to `queued` on a retry.

### 5.3 Nothing is renamed

No existing entity, endpoint, route, message key or state value changes meaning.
The word *roster* is descriptive prose for "the Agents provisioned for a
workspace" and is never a stored thing.

---

## 6. UX

Six surfaces. Every state of every one of them is drawn.

### 6.1 Setup — the "Your agents" step

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Set up Ever Works                                          Step 8 of 11  ✕  │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Your agents                                                                 │
│  Based on what you told us, here's a team to start with. Rename anything,     │
│  drop what you don't need, add what's missing.                               │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ ⬡  Coordination · coordinator                                          │  │
│  │    [ Ada                                    ]                          │  │
│  │    Takes whatever you hand over, works out who should do it, and asks   │  │
│  │    you when it isn't obvious.                                          │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │ ⬡  Research                                               [ Remove ]   │  │
│  │    [ Research                               ]                          │  │
│  │    Digs into questions and writes up what it found.                    │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │ ⬡  Content                                                [ Remove ]   │  │
│  │    [ Content                                ]                          │  │
│  │    Drafts copy and long-form pieces. Always a draft, never published.  │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │ ⬡  Market watch                                           [ Remove ]   │  │
│  │    [ Market watch                           ]                          │  │
│  │    Keeps an eye on the field and flags what changed.                   │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                        [ + Add a lane ▾ ]    │
│                                                                              │
│  ⓘ  Every one of these asks you before it sends, spends, or publishes        │
│     anything. You can loosen that later, per agent.                          │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  Back                                     Skip for now   [ Create my agents ]│
└──────────────────────────────────────────────────────────────────────────────┘
```

**Copy — exact.**

- Title: `Your agents`
- Subtitle: `Based on what you told us, here's a team to start with. Rename anything, drop what you don't need, add what's missing.`
- Coordinator chip: `coordinator`
- Add control: `+ Add a lane`
- Notice: `Every one of these asks you before it sends, spends, or publishes anything. You can loosen that later, per agent.`
- Primary: `Create my agents` · Secondary: `Skip for now` · Tertiary: `Back`
- Name field validation: `Give this one a name` (empty) · `Names can be up to 60 characters` (too long)
- Add-control disabled tooltip: `8 agents is the most we'll set up at once — you can add more any time from Agents.`

**Keyboard.** `Tab` walks lane cards in order; within a card `Tab` reaches the
name field then **Remove**. `Enter` in a name field commits and moves to the next
card. `Alt+A` opens the add menu; arrow keys move within it; `Esc` closes it.
`Ctrl/Cmd+Enter` anywhere in the step is **Create my agents**. `Esc` is
**Skip for now** and asks for confirmation only when a name was edited.

### 6.2 Setup — provisioning in progress

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Your agents                                                                 │
│                                                                              │
│  Setting up your agents…                                                     │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░  3 of 4                       │
│                                                                              │
│   ✓  Coordination     Ada             Created                                │
│   ✓  Research         Research        Created                                │
│   ✓  Content          Content         Created                                │
│   ◐  Market watch     Market watch    Attaching skills…                      │
│                                                                              │
│  This takes about a minute. You can keep going — we'll finish in the          │
│  background.                                                                 │
│                                                        [ Continue setup ]    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Partial result.**

```
│  Set up 2 of 4 agents                                                        │
│   ✓  Coordination     Ada             Created                                │
│   ✓  Research         Research        Created                                │
│   ⚠  Content          —               Not enough seats on your plan          │
│   ⚠  Market watch     —               Not enough seats on your plan          │
│                                                                              │
│  Your plan has room for 2 more agents. The two we made are ready to work.    │
│                        [ See plans ]  [ Finish this later ]  [ Continue ]    │
```

**Failed result.**

```
│  We couldn't set up your agents                                              │
│   ✕  Coordination     —               Something went wrong on our side       │
│   —  Research         —               Not attempted                          │
│                                                                              │
│  Nothing was created, so nothing is half-made. Try again, or carry on and     │
│  set them up later from Agents.                                              │
│                                    [ Try again ]  [ Skip for now ]           │
```

**Stalled.**

```
│  This is taking longer than usual                                            │
│  We've set up 2 of 4 so far. Nothing is lost — trying again picks up where   │
│  this left off.                                                              │
│                                    [ Keep waiting ]  [ Try again ]           │
```

**Copy — exact.** `Setting up your agents…` · `{done} of {total}` ·
`Created` · `Reused — you already had this one` · `Not enough seats on your plan`
· `Couldn't find a free name` · `Something went wrong on our side` ·
`Not attempted` · `Attaching skills…` ·
`This takes about a minute. You can keep going — we'll finish in the background.`
· `Nothing was created, so nothing is half-made. Try again, or carry on and set them up later from Agents.`
· `This is taking longer than usual` ·
`We've set up {done} of {total} so far. Nothing is lost — trying again picks up where this left off.`

**Keyboard.** The panel takes focus when it appears and announces its state
politely. `Ctrl/Cmd+Enter` is the primary button in every result state. Nothing
traps focus: **Continue setup** is always reachable with one `Tab`.

### 6.3 The introduction — "Meet your agents"

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Meet your agents                                                        ✕   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ⬡  Ada — Coordination                                                      │
│      Hand anything to Ada. She works out who should do it, and asks you       │
│      when it isn't obvious.                                                  │
│      Everyone below reports to Ada.                                          │
│                                                                              │
│   ⬡  Research — Research                             reports to Ada          │
│      Digs into questions and writes up what it found.                        │
│      Skills: research, signal detection                                      │
│                                                                              │
│   ⬡  Content — Content                               reports to Ada          │
│      Drafts copy and long-form pieces. Always a draft, never published.       │
│      Skills: newsletter drafting, digest                                     │
│                                                                              │
│   ⬡  Market watch — Market watch                     reports to Ada          │
│      Keeps an eye on the field and flags what changed.                        │
│      Skills: competitor watch                                                │
│                                                                              │
│  ⓘ  None of them acts on its own. They propose; you approve.                 │
│                                                                              │
│                                   [ Open Agents ]        [ Got it ]          │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Copy — exact.** Title `Meet your agents` · `reports to {name}` ·
`Everyone below reports to {name}.` · `Skills: {list}` ·
`None of them acts on its own. They propose; you approve.` ·
Primary `Got it` · Secondary `Open Agents`.

**Keyboard.** `Esc` closes without acknowledging (the milestone stays pending and
the panel is offered again). `Enter` on the focused primary is **Got it**. Each
agent row is a link to that agent, reachable by `Tab`.

### 6.4 The "Get set up" card on Home

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Get set up                                             2 of 5      ⋯   ✕    │
│  ──────────────────────────────────────────────────────────────────────────  │
│   ●  Connect your AI provider                                    Done         │
│   ●  Meet your agents                                            Done         │
│   ○  Ship your first mission                              [ Pick a brief ]    │
│      Hand your agents one real piece of work.                                 │
│   ○  Answer your first decision                                   Waiting     │
│      Your agents ask before anything leaves the workspace.                    │
│   ○  Put something on a schedule                          [ Choose a job ]    │
│                                                          See all details →    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Loading.** Three grey rows at the row height, no spinner, no layout shift.

**Error.**

```
│  Get set up                                                              ✕   │
│  Couldn't load your setup progress.                        [ Retry ]         │
```

**One skipped.**

```
│  Get set up                                     3 of 4 · 1 skipped   ⋯   ✕   │
│   ○  ~~Put something on a schedule~~                     Not for me   [ Undo ]│
```

**Completed.**

```
│  Get set up                                                   All done  ✕    │
│  Nice — you're set up. Your agents are working; check Home each morning.      │
│                                                        [ Dismiss ]           │
```

**Blocked on someone else.**

```
│   ○  Meet your agents                          Waiting on an admin            │
│      Someone with permission to add agents needs to do this.  [ Copy note ]  │
```

**Copy — exact.** Title `Get set up` · counter `{done} of {total}` ·
`{done} of {total} · {n} skipped` · `All done` · `Done` · `Waiting` ·
`Not for me` · `Undo` · `See all details` · `Couldn't load your setup progress.`
· `Retry` · `Nice — you're set up. Your agents are working; check Home each morning.`
· `Dismiss` · `Waiting on an admin` ·
`Someone with permission to add agents needs to do this.` · `Copy note` ·
`Hide this` · `Reset progress`.

Milestone rows, exact:

| Row | Title | Sub-line | Action |
| --- | --- | --- | --- |
| 1 | `Connect your AI provider` | `Your agents run on your own provider account.` | `Connect a provider` |
| 2 | `Meet your agents` | `A small team, each with one area to own.` | `Set up my agents` |
| 3 | `Ship your first mission` | `Hand your agents one real piece of work.` | `Pick a brief` |
| 4 | `Answer your first decision` | `Your agents ask before anything leaves the workspace.` | `Open decisions` / `Waiting` |
| 5 | `Put something on a schedule` | `Something that runs tomorrow without you.` | `Choose a job` |

**Keyboard.** The card is one landmark. `Tab` reaches each milestone row's action
in order; a done row's action is not focusable. `⋯` opens the row menu
(**Not for me** / **Undo**) with arrow keys, `Esc` closes. `✕` is **Hide this**
and is the last stop in the card.

### 6.5 The `/get-started` page

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Get set up                                                                  │
│  Five things, about an hour. You can stop and come back.        2 of 5       │
├──────────────────────────────────────────────────────────────────────────────┤
│  ●  1 · Connect your AI provider                                     Done    │
│        Connected 4 minutes ago. Last checked just now.       [ Recheck ]     │
├──────────────────────────────────────────────────────────────────────────────┤
│  ●  2 · Meet your agents                                             Done    │
│        4 agents · Ada, Research, Content, Market watch                        │
│                                    [ See the introduction ]  [ Open Agents ] │
├──────────────────────────────────────────────────────────────────────────────┤
│  ○  3 · Ship your first mission                                              │
│        Pick something real. A brief that says what "finished" means is the    │
│        difference between work that lands and work that comes back to ask.    │
│                                                                              │
│        ( ) Map the field                                     → Market watch  │
│            Compare the three closest alternatives to us on price and what     │
│            each one gates. Finished = one page I can read in three minutes,   │
│            recommendation at the top.                                        │
│                                                                              │
│        ( ) Write one thing                                        → Content  │
│            Draft a 700-word post for people who've outgrown spreadsheets.     │
│            Finished = a draft I can edit. Don't publish anything.             │
│                                                                              │
│        ( ) Answer one question                                   → Research  │
│            Find out what changed in our space in the last 30 days and why it  │
│            matters to us. Finished = five bullets with sources.               │
│                                                                              │
│        [ Write my own instead ]                            [ Send it ]       │
├──────────────────────────────────────────────────────────────────────────────┤
│  ○  4 · Answer your first decision                            Nothing yet    │
│        When an agent reaches something you should decide — spending, sending, │
│        or a fork in the road — it stops and asks. Nothing is waiting yet.     │
│                                                     [ Show me an example ]   │
├──────────────────────────────────────────────────────────────────────────────┤
│  ○  5 · Put something on a schedule                                          │
│        ( ) A daily summary of the workspace          every day at 08:00 CET   │
│        ( ) A weekly look at your missions            Mondays at 09:00 CET     │
│        ( ) Give Ada a cadence                        every hour               │
│                                                          [ Turn it on ]      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Over-limit inside the brief picker.**

```
│        Your own brief                                          10 000 max    │
│        [ …3 of 10 000 characters ]                                           │
│        ⚠ That's longer than a mission brief can be. Trim it by 214           │
│          characters.                                                         │
```

**No roster yet.**

```
│  ○  3 · Ship your first mission                                              │
│        You need an agent before you can hand out work.                        │
│                                                    [ Set up my agents ]      │
```

**No provider.**

```
│        ⚠ Nothing will run until you connect a provider. You can send this     │
│          now and it'll start as soon as one is connected.                     │
│                                        [ Connect a provider ]  [ Send it ]   │
```

**Copy — exact.** Page title `Get set up` · subtitle
`Five things, about an hour. You can stop and come back.` ·
`Connected {relative}. Last checked {relative}.` · `Recheck` ·
`See the introduction` · `Open Agents` ·
`Pick something real. A brief that says what "finished" means is the difference between work that lands and work that comes back to ask.`
· `Write my own instead` · `Send it` · `Nothing yet` ·
`When an agent reaches something you should decide — spending, sending, or a fork in the road — it stops and asks. Nothing is waiting yet.`
· `Show me an example` · `Turn it on` ·
`You need an agent before you can hand out work.` ·
`Nothing will run until you connect a provider. You can send this now and it'll start as soon as one is connected.`
· `That's longer than a mission brief can be. Trim it by {n} characters.`

**Keyboard.** Each milestone is a section with a heading. Radio groups are single
tab stops with arrow-key selection. `Ctrl/Cmd+Enter` inside a section triggers
that section's primary action. `g` then `s` from anywhere in the dashboard opens
this page once the command palette lands; until then it is a Help entry and a
link from the card.

### 6.6 The standalone roster panel

Opened by **Set up my agents** when the wizard was skipped or the step was
skipped. It is §6.1 and §6.2, rendered in a dialog on the current page instead of
inside the wizard, with `Skip for now` replaced by `Cancel` and `Continue setup`
replaced by `Close`. Nothing else differs.

### 6.7 Accessibility

- Every lane row, milestone row and result row has an accessible name that
  includes its state, so a screen reader hears *"Research, created"* rather than
  *"Research, check mark"*.
- The provisioning panel is a polite live region; each lane transition announces
  once. The progress bar carries the same `{done} of {total}` text.
- Colour never carries state alone: done is a filled dot **and** the word `Done`;
  skipped is struck through **and** labelled `Not for me`; a failure is an icon
  **and** its reason in words.
- Disabled controls explain themselves on focus, never only on hover.
- Nothing auto-focuses on Home. The card is announced when it first appears and
  never steals focus afterwards.

---

## 7. Out of scope

This epic deliberately does **not**:

1. **Change any existing setup step.** No step is reordered, retitled, merged or
   removed; the provider, storage, database, deployment and where-it-runs
   questions are untouched.
2. **Replace the wizard with a conversation.** Setting up a roster by talking to
   an agent is an appealing idea and belongs to the chat epic, not here. This
   epic ships a form because a form can be resumed, tested and translated.
3. **Build a decision surface.** Milestone 4 links to what exists and to whatever
   AW-03 ships. It renders no decision of its own.
4. **Build a mission board.** Milestone 3 creates a Mission and links to it.
   Columns, cards and steering are AW-02.
5. **Build a schedules page.** Milestone 5 arms one of three known jobs. The
   calendar, heartbeats and never-runs detection are AW-10.
6. **Add or change any AI provider.** Milestone 1 checks the connections the
   platform already resolves. New providers are plugins and are AW-16.
7. **Introduce agent levels or autonomy tiers.** How much rope an agent has
   earned is AW-23 and AW-24. Every agent this epic creates is created in
   review-before-act mode and stays there until a human changes it.
8. **Do anything about the machine-to-machine registration flow** that shares the
   word "onboarding". It is a different feature with a different entry point and
   is not touched.
9. **Localise the roster blueprints' agent descriptions into agent instructions.**
   Instruction text stays exactly what the prebuilt templates already carry.
10. **Send anything.** No email, no notification, no digest is triggered by this
    epic. A stalled first hour produces silence, not a nudge; re-engagement is
    AW-13's problem.
11. **Backfill existing accounts.** Nothing is created for anyone. Existing
    accounts get an evaluated checklist and, in almost every case, a completed
    card they dismiss once.

---

## 8. Acceptance criteria

A reviewer can run this list top to bottom against a build.

### Setup step

- [ ] The setup flow has exactly one new step, titled **Your agents**, after the
      roles step and before the chat-connection step.
- [ ] Skipping it creates nothing and records the skip.
- [ ] With no roles answered, the general blueprint is proposed with the notice
      about having picked a starting point.
- [ ] Answering marketing-shaped roles proposes a different blueprint than
      answering research-shaped roles, and the same answers always propose the
      same one.
- [ ] Team size `solo` caps the proposal at 3 lanes; `51–200` allows 8.
- [ ] The coordination lane is first, is labelled `coordinator`, and has no
      **Remove** control.
- [ ] Adding lanes stops at 8 with the documented message.
- [ ] An empty agent name blocks the primary button and shows `Give this one a name`.

### Provisioning

- [ ] Pressing **Create my agents** returns to a progress panel in under a second.
- [ ] Every lane reaches a terminal outcome, and each outcome is visible before
      the run as a whole finishes.
- [ ] Agents are created in blueprint order, one at a time.
- [ ] Running provisioning twice produces the same agents; the second run reports
      every existing lane as **Reused** and creates nothing.
- [ ] A second provisioning request while one is in flight is refused with
      **Already setting up your agents**.
- [ ] With an existing agent named *Research*, the research lane produces
      *Research 2* and says so.
- [ ] With a seat limit reached mid-run, the remaining lanes report
      **Not enough seats on your plan**, the run is **partial**, and a plans link
      is shown.
- [ ] After a partial run, **Finish this later** → **Finish setting up** attempts
      only the missing lanes.
- [ ] Every created agent is active, has review-before-act guardrails, has no
      cadence, carries its lane, and reports to the coordinator.
- [ ] The coordinator's delegation allow-list contains every other roster agent,
      enabled.
- [ ] A skill that fails to attach shows a warning on that lane and does not fail
      it.
- [ ] Nothing is created when the request names an unknown lane.

### Introduction

- [ ] The introduction lists every roster agent with name, lane, description and
      reporting line.
- [ ] Closing with `Esc` leaves **Meet your agents** pending.
- [ ] Pressing **Got it** marks it done, and pressing it again is harmless.

### Checklist

- [ ] Home shows **Get set up** with the correct count for a new account.
- [ ] Every milestone completes only from a real platform fact, verified by
      completing each one from outside the checklist and watching it flip.
- [ ] A milestone marked **Not for me** leaves the denominator and can be undone.
- [ ] Hiding the card removes it from Home and it can be reopened from Help.
- [ ] The checklist survives sign-out and a different browser.
- [ ] An existing, fully set-up account sees a completed card once and never
      again after dismissing it, and has nothing created for it.
- [ ] A failed read renders the error state and affects nothing else on Home.
- [ ] With the page open, completing a milestone elsewhere updates the count
      within 60 seconds without clobbering unsaved input.

### First mission, decision and schedule

- [ ] Three starter briefs are offered, each under 280 characters, each naming
      its lane.
- [ ] Sending one creates a Mission and a Task, assigns the Task to the lane's
      agent, and links to the Mission.
- [ ] With no roster, milestone 3 offers **Set up my agents** instead.
- [ ] With no provider connected, sending is allowed and warns explicitly.
- [ ] A brief over 10 000 characters is blocked with the trim message.
- [ ] Milestone 4 shows a live count of open approvals plus escalations and links
      to the existing surface.
- [ ] Deciding anything anywhere completes milestone 4.
- [ ] Milestone 5 offers exactly three options with cadences shown in local time,
      and arming any one completes it.
- [ ] Arming a schedule elsewhere in the product also completes it.

### Cross-cutting

- [ ] No user-visible string in any new surface is hard-coded; all resolve
      through message keys.
- [ ] The whole feature is reachable, operable and understandable with a keyboard
      and with a screen reader.
- [ ] No credential value, brief text, agent name or mission title appears in any
      telemetry event.
- [ ] Provisioning spends nothing; the only spend warning in the epic is on the
      starter mission.
- [ ] Removing the checklist entirely would change no behaviour on any other
      surface.

---

## 9. Open questions

- **[NEEDS CLARIFICATION: coordinator naming]** The proposal ships a default
  name for the coordinator lane. Should it be a neutral role word
  (*Coordinator*), a short given name (*Ada*), or an empty field the user must
  fill? A name makes the roster feel like a team and makes routing instructions
  read naturally; a role word is unambiguous and avoids implying a persona we do
  not otherwise support until AW-23. The wireframes above assume a short given
  name with the lane shown beside it.
- **[NEEDS CLARIFICATION: scope of the checklist row]** The checklist is
  specified per person per workspace scope, so someone in two organizations gets
  two first hours. The alternative — one per person — is simpler but means the
  second organization someone joins never offers to set up its roster. Which
  does the organization model want?
- **[NEEDS CLARIFICATION: the provider check cadence]** Milestone 1 accepts a
  successful live check no older than 24 hours. Should opening the checklist
  re-check silently (costs a provider call per open) or only show the age and
  offer **Recheck**? The wireframes assume the latter.
- **[NEEDS CLARIFICATION: what "shipped" means]** Milestone 3 completes on the
  first completed run under the mission, which can be true while the mission is
  still open. The stricter reading is "the mission reached a completed state",
  which is more honest but can take days. Is the looser reading acceptable for a
  first-hour signal?
- **[NEEDS CLARIFICATION: starter brief content ownership]** The three briefs are
  written into the build. Should they instead be derived from the user's answered
  roles, so a support-shaped account is not offered a market-comparison brief?
  That is a larger content surface and may belong with AW-21.
- **[NEEDS CLARIFICATION: the seven-day auto-dismiss]** FR-42 removes the
  completed card after seven days. Is seven right, or should a completed card
  persist until explicitly dismissed so the user gets to feel the completion?
- **[NEEDS CLARIFICATION: blueprint editing]** P3 proposes switching blueprint
  after the fact. Should switching ever archive an agent it no longer proposes,
  or only ever add? The spec currently assumes add-only, because archiving an
  agent someone may already have given work to is not a decision provisioning
  should make.

---

## 10. References

- Program: [`../README.md`](../README.md) — the operating loop (§2), vocabulary (§1), rules (§5)
- Substrate: [`../EXISTING-SUBSTRATE.md`](../EXISTING-SUBSTRATE.md) — S2 (escalation queue), S12 (task workflow templates), S14 (schedule aggregation)
- Constitution: [`../../../../../.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- House-style worked example: [`../../schedules/spec.md`](../../schedules/spec.md)
</content>
</invoke>
