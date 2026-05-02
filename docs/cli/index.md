---
id: index
title: CLI Overview
sidebar_label: Overview
sidebar_position: 1
---

# Ever Works CLI

The **Ever Works CLI** (`ever-works-cli`) is a command-line interface that allows you to interact with the Ever Works Platform directly from your terminal. It provides convenient commands for managing works, authentication, and content generation workflows.

## Installation

You can install the CLI globally using npm:

```bash
npm install -g ever-works-cli
```

Or run it directly via npx:

```bash
npx ever-works-cli <command>
```

## Basic Usage

The CLI uses the `ever-works` command. To see the available commands:

```bash
ever-works --help
```

Output:

```text
Usage: ever-works [options] [command]

Options:
  -v, --version   output the current version
  -h, --help      display help for command

Commands:
  work       Work management commands
  auth            Authentication commands
  help [command]  display help for command
```

## Configuration

By default, the CLI tries to connect to the platform API at `http://localhost:3100`. You can override this during login:

```bash
ever-works auth login --api-url https://api.your-platform.com
```

## Prerequisites

- **Node.js** v18 or higher
- A running instance of the **Ever Works Platform API** (locally or remote)
