---
id: fleet-session-status
title: Session status — what needs you, and answering it from anywhere
sidebar_label: Session status & board
description: Every session on your computers says whether it is working, needs you, is done or has gone idle — from the agent CLI's own hooks first — and a question or permission it asks can be answered from the card, the Inbox or My Decisions without opening a terminal.
---

# Session status, attention and the Sessions board

[Sessions on computers](./fleet-sessions.md) keep running when nobody is watching. This page is about the question you have when you are **not** looking: _is anything waiting for me?_

:::info Status: shipped behind a flag

Session status, attention and the board ship with `FLEET_SESSIONS_ENABLED=true` (default off), like sessions themselves. The status pipeline spends **no model tokens**: it only reads what the CLI and the computer already say.

:::

## Four states and an outcome

| State         | What it means                                                                                                   | On the card                       |
| ------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Working**   | The agent is doing something; nothing is required of you.                                                       | spinner ring                      |
| **Needs you** | It stopped to ask — permission to run a tool, an answer to a question — or it is blocked.                      | question bubble, warm tint        |
| **Done**      | It finished a turn and waits for your next instruction, with an outcome: success, failed, stopped, no result.  | green check (success), green tint |
| **Idle**      | Nothing happened for 30 minutes and nobody said it is finished. Silence never makes a session "done".          | grey dot                          |

A fifth word, **ended**, says the process is gone, with its reason. A plain shell is only ever working, idle or ended — it has no agent status.

The card shows the last thing you asked ("You: …") and the agent's last line, or — when it needs you — what it asks in an amber box with its options. Its title is **bold** while there is something you have not seen yet; opening the session clears that (but not the question itself).

## Where the status comes from

1. **The CLI's own hooks.** For Claude Code and Codex the node adds a per-session overlay — a settings file passed with `--settings` for Claude Code, a `notify` override on the command line for Codex — that tells the node the moment a prompt is submitted, a tool wants permission, a question is asked, or the turn ends. **Your own configuration is never written**: not `~/.claude/settings.json`, not `~/.codex/config.toml`. The hooks post to a loopback endpoint on the computer (`127.0.0.1`, a token minted at every node start); when the node is restarting they write to a small spool that is applied, in order, when it is back.
2. **The screen.** For prompts no hook reports — a Codex approval, an older Claude Code — the node reads the terminal's own screen against a rules file that ships with the node (each rule says why it exists). The card then says _from the screen_.
3. **The process.** Output, Ctrl-C and the exit code. A session that exits non-zero while working is _failed_; one lost when the computer restarted is _no result_, never "finished".

The session page says which of these applies: _Status from Claude Code's hooks_, _Status from the screen for permission prompts — update Claude Code on build-01 for exact status_, _Status from the screen — Codex reports only when a turn ends_. For a Codex session of yours, the per-session `notify` replaces your own notify command **for that session only**, and the page says so.

## Needs you: one prompt, every door

When a session needs you, one **attention key** identifies that moment everywhere:

- the **card** (in the Sessions board, on the computer's Sessions tab, on the Agent's page) — answer with the buttons, or focus the card and press **1–9**, **A** (allow) or **D** (deny);
- the **session page** — the approval or question card replaces the message box (**Esc** denies an approval; on a question it keeps the prompt);
- the **[Inbox](./inbox.md)** and **My Decisions** — a question or a permission request is a Decision marked _From a session_; a blocked or failed session is a notice;
- the hub's **Needs a look** list — _Nina (Agent) waiting for you on build-01 · "Allow Bash(pnpm db:migrate)?"_ with **Answer**;
- a **notification** — _Nina needs you on build-01 — Allow Bash(pnpm db:migrate)?_

Answer in any of them and it clears in all of them. The computer types your answer exactly as the CLI expects it. If someone already answered in the terminal, the card says _Already answered in the terminal_ and nothing is typed twice; if the computer is unreachable, the prompt stays and you can retry; under the fleet stop the buttons are disabled.

Permission prompts are answered **by people only**. An Agent can read what another session asks (`fleet_sessions_question`) and answer a **question** (`fleet_sessions_answer`) only when its owner allowed it to answer other sessions. A Decision for a session that ends is withdrawn; it is never answered for you.

## Notifications

Three events, under Settings → Notifications: **a session needs you** (urgent), **a session finished**, **a session failed**. One notification per prompt; a finish at the very start or resume of a session is not news, and a session you stopped yourself (Ctrl-C) or ended never notifies. Shells never notify.

## The Sessions board

**Activity → Sessions** (key **n**) shows every session on the computers you may see sessions on:

- **Board** — Needs you · Working · Done · Idle, most recently moved first, with counts. A finished session stays on the board for 24 hours, then lives in the list.
- **List** — every session, grouped by day or week and by who (an Agent, you), ended ones with their reason.

Filters — Agent, computer, kind, state — live in the address bar, so a link reproduces the view.

**Fleet → Sessions** shows the same live sessions grouped by computer, with each computer's online state and consents. The command palette opens with the sessions waiting on you, first.

## From the terminal

```bash
ever-works fleet session question <id>            # what it waits for, and the key
ever-works fleet session answer <id> 1            # answer with option 1
ever-works fleet session answer <id> --text "eu-west"
```
