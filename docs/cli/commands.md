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

## Work Management (`work`)

Create, manage, and generate content for your works.

### Create

Create a new work project. This command is interactive and will prompt you for details like name, slug, description, and repository settings.

```bash
ever-works work create
```

**What it does:**

1. Checks for GitHub connection.
2. Prompts for work details.
3. Creates the work entry in the platform database.
4. Initializes the configuration for future generation.

### List

List all works you have access to.

```bash
ever-works work list
```

### Generate

Start the AI content generation pipeline for a work. This is the core command to populate your work with data.

```bash
ever-works work generate
```

**Interactive Flow:**

1. Select a work from the list.
2. Confirm or edit the prompt/topic.
3. (Optional) Configure advanced settings like company info, domain type, or custom configuration.
4. Triggers the generation pipeline on the server.

Use `work status` to track progress.

### Status

Check the status of a work, including the current state of any running generation pipeline.

```bash
ever-works work status
```

### Update

Update a work's configuration and synchronize changes with its GitHub repository.

```bash
ever-works work update
```

### Update Website

Update specifically the website repository for a work (e.g., to apply template updates).

```bash
ever-works work update-website
```

### Deploy

Trigger a deployment of the work's website to Vercel.

```bash
ever-works work deploy
```

### Submit Item

Manually submit a single item to a work.

```bash
ever-works work submit-item
```

### Remove Item

Remove an item from a work.

```bash
ever-works work remove-item
```

### Regenerate Markdown

Regenerate the `README.md` file for a work based on the latest data.

```bash
ever-works work regenerate-markdown
```

### Delete

Delete a work and its associated data.

```bash
ever-works work delete
```
