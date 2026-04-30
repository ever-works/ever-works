---
id: commands
title: CLI Commands
sidebar_label: Commands
sidebar_position: 2
---

# CLI Command Reference

This page lists all available commands in the Ever Works CLI.

## Authentication (`auth`)

Manage your session with the Ever Works Platform.

### Login

Log in to the platform. Supports both OAuth (browser-based) and manual token entry.

```bash
ever-works auth login [options]
```

**Options:**

- `--api-url <url>`: The API URL to connect to (default: `http://localhost:3100`)
- `--manual`: Skip the browser-based OAuth flow and manually enter an API token.

**Example:**

```bash
# Standard login (opens browser)
ever-works auth login

# Login to a remote production server
ever-works auth login --api-url https://api.ever.works

# Manual token entry (useful for CI/CD or headless environments)
ever-works auth login --manual
```

### Logout

Log out of the current session and remove stored credentials.

```bash
ever-works auth logout
```

### Status

Check the current authentication status and see who is logged in.

```bash
ever-works auth status
```

## Directory Management (`directory`)

Create, manage, and generate content for your directories.

### Create

Create a new directory project. This command is interactive and will prompt you for details like name, slug, description, and repository settings.

```bash
ever-works directory create
```

**What it does:**

1. Checks for GitHub connection.
2. Prompts for directory details.
3. Creates the directory entry in the platform database.
4. Initializes the configuration for future generation.

### List

List all directories you have access to.

```bash
ever-works directory list
```

### Generate

Start the AI content generation pipeline for a directory. This is the core command to populate your directory with data.

```bash
ever-works directory generate
```

**Interactive Flow:**

1. Select a directory from the list.
2. Confirm or edit the prompt/topic.
3. (Optional) Configure advanced settings like company info, domain type, or custom configuration.
4. Triggers the generation pipeline on the server.

Use `directory status` to track progress.

### Status

Check the status of a directory, including the current state of any running generation pipeline.

```bash
ever-works directory status
```

### Update

Update a directory's configuration and synchronize changes with its GitHub repository.

```bash
ever-works directory update
```

### Update Website

Update specifically the website repository for a directory (e.g., to apply template updates).

```bash
ever-works directory update-website
```

### Deploy

Trigger a deployment of the directory's website to Vercel.

```bash
ever-works directory deploy
```

### Submit Item

Manually submit a single item to a directory.

```bash
ever-works directory submit-item
```

### Remove Item

Remove an item from a directory.

```bash
ever-works directory remove-item
```

### Regenerate Markdown

Regenerate the `README.md` file for a directory based on the latest data.

```bash
ever-works directory regenerate-markdown
```

### Delete

Delete a directory and its associated data.

```bash
ever-works directory delete
```
