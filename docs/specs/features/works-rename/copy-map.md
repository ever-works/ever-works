# Work → Work — UI Copy Map

> **Status:** DRAFT — for review before any code changes.
> **Scope:** User-facing copy only (UI strings, marketing text, page titles, button labels, helper text). Code identifiers, DB columns, API routes, file paths, and class/component names are tracked separately and are **not** in this document.

---

## 1. Adopted decisions

These rules drive every row in the map below. Confirm or amend before we proceed.

### 1.1 Capitalization

Following the Linear / GitHub / Notion convention:

- **Capitalize "Work" / "Works"** when used as a label, heading, navigation item, button, or column header → it reads as a branded product noun.
- **Lowercase "work" / "works"** in body sentences and helper text → reads more naturally and avoids a "shouty" feel.

| Context        | Style   | Example                                              |
| -------------- | ------- | ---------------------------------------------------- |
| Sidebar nav    | Capital | **Works**                                            |
| Page heading   | Capital | **Recent Works**                                     |
| Button         | Capital | **+ New Work**                                       |
| Column header  | Capital | **Work**                                             |
| Body sentence  | Lower   | "Manage your AI-powered works and track performance" |
| Toast / inline | Lower   | "Your work was created"                              |

### 1.2 Singular CTAs avoid "a Work"

The phrase **"Create Work"** reads as a verb ("create labor"); **"Create a Work"** is grammatical but stilted. We sidestep both:

| Avoid                       | Prefer                                                         |
| --------------------------- | -------------------------------------------------------------- |
| Create Work                 | **+ New Work**                                                 |
| Create Work            | **+ New Work** or **New Work**                                 |
| New Work               | **New Work**                                                   |
| Create Your First Work | **Create your first Work** (lowercase first/Work cap as label) |
| Create a work          | **Start a new Work**                                           |

### 1.3 Plurals carry the rebrand

"Works" reads cleanly as a noun ("Recent Works", "Total Works", "Search works…"). Use plural-first wherever possible.

### 1.4 Words we are NOT renaming

These look related but stay as-is:

- **"work"** as a filesystem path (e.g. `docs/` work) — different word, leave alone.
- **"items"** — still items inside a Work.
- **"repository / repo"** — Git concept, unchanged.
- **"GitHub Organization"** — unchanged.
- **"Awesome List", "Data Repository"** — repository format names, unchanged.
- **"Plugin", "Pipeline", "Provider"** — unchanged.

### 1.5 Brand tagline

Replace **"Work Builder"** / **"Modern Work Website Solution"** with the new positioning: **"The Workshop for AI"** (or short: **"AI Workshop"**, or longer: **"An Open Agentic Runtime that Autonomously Builds and Maintains Content-Rich Web Apps and Git Repositories"**). Pick one for the metadata `<title>` and tagline; the long form is for the landing-page hero only.

---

## 2. Open questions

Decide these before we start; everything in §3 follows from them.

| #   | Question                                                                                                                   | Recommended default                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Q1  | Use capitalized **Work / Works** as the branded noun in UI?                                                                | ✅ Yes (Linear/GitHub style)                                                                   |
| Q2  | Plural section name: **Works** or **Work**?                                                                                | **Works** (avoids verb reading)                                                                |
| Q3  | Singular CTA: **+ New Work**, **Start Work**, **Create Work**, or rephrase?                                                | **+ New Work** for buttons, **Start a Work** in onboarding/AI prompts                          |
| Q4  | "Recent" header: **Recent Works** or **Recent Work**?                                                                      | **Recent Works**                                                                               |
| Q5  | Page metadata title — replace "Work Builder" with what?                                                               | **"Workshop for AI"** (matches new tagline)                                                    |
| Q6  | i18n message **keys** (e.g. `dashboard.works.*`) — rename to `works.*` too, or keep the keys and only change values? | **Rename the keys** so future grep is consistent. (One-time mechanical refactor, separate PR.) |
| Q7  | URL slugs (`/dashboard/works`, `/api/works`) — rename now or later?                                            | **Defer** to a separate PR; copy-only first.                                                   |

---

## 3. Copy map

Each section lists every English string in `apps/web/messages/en.json` that contains "work" / "works", with the proposed new copy. Format:

- ✅ **Direct swap** — straight `Work→Work` / `Works→Works`, no rewording
- ⚙️ **Reword** — needs phrasing change to avoid awkwardness
- ⚠️ **Decide** — depends on an open question above

### 3.1 Brand & metadata

| Key                           | Current                                                 | Proposed                                                                                               | Type  |
| ----------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----- |
| `metadata.title`              | `{companyName} - Work Builder`                     | `{companyName} — Workshop for AI`                                                                      | ⚙️ Q5 |
| `metadata.description`        | `A SaaS platform for building and managing works` | `An agentic runtime that autonomously builds and maintains content-rich web apps and Git repositories` | ⚙️    |
| `metadata.pages.works`  | `Works`                                           | `Works`                                                                                                | ✅    |
| `metadata.pages.newWork` | `New Work`                                         | `New Work`                                                                                             | ✅    |
| `metadata.pages.work`    | `Work`                                             | `Work`                                                                                                 | ✅    |

### 3.2 Sidebar / navigation

| Key                                        | Current                | Proposed          | Type |
| ------------------------------------------ | ---------------------- | ----------------- | ---- |
| `dashboard.sidebar.navigation.works` | `Works`          | `Works`           | ✅   |
| `dashboard.sidebar.newWork`           | `New Work`        | `New Work`        | ✅   |
| `dashboard.sidebar.activityIndicator`      | `Work generating` | `Work generating` | ✅   |

### 3.3 Dashboard home / header

| Key                                            | Current                                                                                   | Proposed                                                                        | Type |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---- |
| `dashboard.header.subtitle`                    | `Manage your AI-powered works and track their performance`                          | `Manage your AI-powered works and track their performance`                      | ✅   |
| `dashboard.header.help.quickTips.tip1`         | `Create your first work by clicking the 'Create Work' button on the dashboard.` | `Create your first Work by clicking the '+ New Work' button on the dashboard.`  | ⚙️   |
| `dashboard.header.help.quickTips.tip2`         | `Use the AI generator to automatically populate your work with relevant items.`      | `Use the AI generator to automatically populate your Work with relevant items.` | ✅   |
| `dashboard.header.help.quickTips.tip3`         | `Connect your GitHub account to sync and deploy your works as repositories.`        | `Connect your GitHub account to sync and deploy your works as repositories.`    | ✅   |
| `dashboard.header.help.shortcuts.search`       | `Search works`                                                                      | `Search works`                                                                  | ✅   |
| `dashboard.header.help.shortcuts.newWork` | `Create new work`                                                                    | `Create new Work`                                                               | ✅   |

### 3.4 Works list page (was "Works")

| Key                                                  | Current                                                                                   | Proposed                                                                             | Type  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----- |
| `dashboard.works.title`                        | `Works`                                                                             | `Works`                                                                              | ✅    |
| `dashboard.works.subtitle`                     | `Manage and organize your AI-powered works`                                         | `Manage and organize your AI-powered works`                                          | ✅    |
| `dashboard.works.summary.totalWorks`     | `Total Works`                                                                       | `Total Works`                                                                        | ✅    |
| `dashboard.works.recent`                       | `Recent Works`                                                                      | `Recent Works`                                                                       | ⚠️ Q4 |
| `dashboard.works.search`                       | `Search works...`                                                                   | `Search works...`                                                                    | ✅    |
| `dashboard.works.create`                       | `Create Work`                                                                        | `+ New Work`                                                                         | ⚙️ Q3 |
| `dashboard.works.showing`                      | `Showing {current} of {total} works`                                                | `Showing {current} of {total} works`                                                 | ✅    |
| `dashboard.works.searchFailed`                 | `Failed to search works. Please try again.`                                         | `Failed to search works. Please try again.`                                          | ✅    |
| `dashboard.works.empty.title`                  | `No works yet`                                                                      | `No works yet`                                                                       | ✅    |
| `dashboard.works.empty.description`            | `Create your first AI-powered work to start organizing and showcasing your content.` | `Create your first AI-powered Work to start organizing and showcasing your content.` | ✅    |
| `dashboard.works.empty.action`                 | `Create Your First Work`                                                             | `Create Your First Work`                                                             | ✅    |
| `dashboard.works.empty.notFound.title`         | `No works found`                                                                    | `No works found`                                                                     | ✅    |
| `dashboard.works.empty.notFound.withoutSearch` | `Create your first AI-powered work to get started`                                   | `Create your first AI-powered Work to get started`                                   | ✅    |
| `dashboard.totalWorks`                         | `Total Works`                                                                       | `Total Works`                                                                        | ✅    |
| `dashboard.workList.title`                      | `Your Works`                                                                        | `Your Works`                                                                         | ✅    |
| `dashboard.workList.createButton`               | `Create Work`                                                                        | `+ New Work`                                                                         | ⚙️    |

### 3.5 Work card / loading states

| Key                                      | Current                                                                   | Proposed                                                             | Type |
| ---------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---- |
| `dashboard.workCard.openingTitle`   | `Opening work`                                                       | `Opening work`                                                       | ✅   |
| `dashboard.workCard.openingMessage` | `Preparing your work. Details will open shortly. Stay on this page.` | `Preparing your work. Details will open shortly. Stay on this page.` | ✅   |

### 3.6 Auth / onboarding

| Key                                             | Current                                                                                                                                                     | Proposed                                                                                                                                                      | Type                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `auth.register.subtitle`                        | `Start building amazing works today`                                                                                                                  | `Start building amazing works today`                                                                                                                          | ✅                                       |
| `onboarding.subtitle`                           | `Build and publish your first work in minutes.`                                                                                                        | `Build and publish your first Work in minutes.`                                                                                                               | ✅                                       |
| `onboarding.steps.welcome.description`          | `Ever Works is an open-source work builder. Create structured content works — tools, jobs, links, products — and publish them as live websites.` | `Ever Works is an open agentic runtime. Build content-rich web apps and Git repositories — tools, jobs, links, products — and publish them as live websites.` | ⚙️                                       |
| `onboarding.steps.welcome.detail`               | `Let's get you set up. Connect your providers below, then create your first work.`                                                                     | `Let's get you set up. Connect your providers below, then create your first Work.`                                                                            | ✅                                       |
| `onboarding.steps.welcome.feature1.description` | `Generate and enrich work items automatically using your AI provider.`                                                                                 | `Generate and enrich items automatically using your AI provider.`                                                                                             | ⚙️ (drop "work" — context is clear) |
| `onboarding.steps.welcome.feature3.description` | `Every work is a GitHub repository you own and control.`                                                                                               | `Every Work is a GitHub repository you own and control.`                                                                                                      | ✅                                       |
| `onboarding.steps.work.title`              | `Create your first work`                                                                                                                               | `Create your first Work`                                                                                                                                      | ✅                                       |
| `onboarding.steps.work.description`        | `A work is your content hub. Add items, configure the layout, and publish it in one click.`                                                            | `A Work is your content hub. Add items, configure the layout, and publish it in one click.`                                                                   | ✅                                       |
| `onboarding.steps.work.detail`             | `You're all set! Create your first work to start building and publishing content.`                                                                     | `You're all set! Create your first Work to start building and publishing content.`                                                                            | ✅                                       |
| `onboarding.steps.work.action`             | `Create a work`                                                                                                                                        | `Create a Work`                                                                                                                                               | ✅                                       |
| `onboarding.steps.publish.description`          | `Connect Vercel or GitHub to deploy your work as a public website — no hosting configuration needed.`                                                  | `Connect Vercel or GitHub to deploy your Work as a public website — no hosting configuration needed.`                                                         | ✅                                       |
| `onboarding.steps.work` (object key)       | `work`                                                                                                                                                 | `work`                                                                                                                                                        | ✅ (rename key)                          |

### 3.7 Auth split-screen feature panel

| Key                            | Current                                                                                           | Proposed                                                                                    | Type |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---- |
| `layout.auth.feature.title`    | `Build Works with AI`                                                                       | `Build Works with AI`                                                                       | ✅   |
| `layout.auth.feature.subtitle` | `Create beautiful, searchable works in minutes using natural language. No coding required.` | `Create beautiful, searchable works in minutes using natural language. No coding required.` | ✅   |

### 3.8 Activity log

| Key                                                 | Current                                        | Proposed                                 | Type |
| --------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- | ---- |
| `dashboard.activity.subtitle`                       | `Track all operations across your works` | `Track all operations across your works` | ✅   |
| `dashboard.activity.columns.work`              | `Work`                                    | `Work`                                   | ✅   |
| `dashboard.activity.filters.types.workCreated` | `Work Created`                            | `Work Created`                           | ✅   |
| `dashboard.activity.filters.types.workUpdated` | `Work Updated`                            | `Work Updated`                           | ✅   |
| `dashboard.activity.filters.types.workDeleted` | `Work Deleted`                            | `Work Deleted`                           | ✅   |

### 3.9 Work creation flow (was "workCreation")

| Key                                    | Current                                                                                                              | Proposed                                                                                                        | Type                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------- |
| `dashboard.workCreation.title`    | `Create New Work`                                                                                               | `New Work`                                                                                                      | ⚙️ Q3                |
| `dashboard.workCreation.subtitle` | `Choose how you'd like to create your work`                                                                     | `Choose how you'd like to start your Work`                                                                      | ⚙️                   |
| `…deployProvider.description`          | `Select where to deploy your work website`                                                                      | `Select where to deploy your Work's website`                                                                    | ✅                   |
| **AI subform**                         |                                                                                                                      |                                                                                                                 |                      |
| `…ai.subtitle`                         | `Describe your work idea in natural language and let AI handle the setup`                                       | `Describe your Work in natural language and let AI handle the setup`                                            | ✅                   |
| `…ai.formTitle`                        | `Create Work with AI`                                                                                           | `New Work — with AI`                                                                                            | ⚙️ Q3                |
| `…ai.formSubtitle`                     | `Describe your work idea and let AI handle the setup and initial content generation`                            | `Describe your Work and let AI handle the setup and initial content generation`                                 | ✅                   |
| `…ai.workNameLabel`               | `Work Name`                                                                                                     | `Work Name`                                                                                                     | ✅                   |
| `…ai.promptLabel`                      | `Describe Your Work`                                                                                            | `Describe Your Work`                                                                                            | ✅                   |
| `…ai.promptPlaceholder`                | `Describe what kind of work you want to create, what items it should contain, and any specific requirements...` | `Describe what kind of Work you want to create, what items it should contain, and any specific requirements...` | ✅                   |
| `…ai.examplePrompts.0.prompt`          | `Create a work of the best AI tools for developers`                                                             | `Build a Work cataloguing the best AI tools for developers`                                                     | ⚙️                   |
| `…ai.examplePrompts.2.prompt`          | `Generate a work of productivity apps for remote teams`                                                         | `Build a Work cataloguing productivity apps for remote teams`                                                   | ⚙️                   |
| `…ai.generatingButton`                 | `Generating Work...`                                                                                            | `Generating Work...`                                                                                            | ✅                   |
| `…ai.noteText`                         | `…You'll be notified when your work is ready.`                                                                  | `…You'll be notified when your Work is ready.`                                                                  | ✅                   |
| `…ai.errors.promptRequired`            | `Please describe what kind of work you want to create`                                                          | `Please describe what kind of Work you want to create`                                                          | ✅                   |
| `…ai.errors.nameRequired`              | `Work name is required`                                                                                         | `Work name is required`                                                                                         | ✅                   |
| `…ai.errors.slugRequired`              | `Work slug is required`                                                                                         | `Work slug is required`                                                                                         | ✅                   |
| `…ai.errors.descriptionRequired`       | `Work description is required`                                                                                  | `Work description is required`                                                                                  | ✅                   |
| `…ai.errors.createFailed`              | `Failed to create work`                                                                                         | `Failed to create Work`                                                                                         | ✅                   |
| `…ai.success.started`                  | `Work creation started!`                                                                                        | `Work created — generating content…`                                                                            | ⚙️                   |
| `…ai.success.created`                  | `Work created successfully!`                                                                                    | `Work created successfully!`                                                                                    | ✅                   |
| **Manual subform**                     |                                                                                                                      |                                                                                                                 |                      |
| `…manual.subtitle`                     | `Configure your work with full control over every setting and option`                                           | `Configure your Work with full control over every setting and option`                                           | ✅                   |
| `…manual.formTitle`                    | `Create Work Manually`                                                                                          | `New Work — Manual Setup`                                                                                       | ⚙️                   |
| `…manual.formSubtitle`                 | `Configure your work with full control over every setting`                                                      | `Configure your Work with full control over every setting`                                                      | ✅                   |
| `…manual.nameLabel`                    | `Work Name *`                                                                                                   | `Work Name *`                                                                                                   | ✅                   |
| `…manual.slugLabel`                    | `Work Slug *`                                                                                                   | `Work Slug *`                                                                                                   | ✅                   |
| `…manual.organizationHelp`             | `Create this work under a GitHub organization instead of your personal account`                                 | `Create this Work under a GitHub organization instead of your personal account`                                 | ✅                   |
| `…manual.createButton`                 | `Create Work`                                                                                                   | `Create Work`                                                                                                   | ⚙️ (or `+ New Work`) |
| `…manual.creatingButton`               | `Creating Work...`                                                                                              | `Creating Work...`                                                                                              | ✅                   |
| `…manual.nameRequired`                 | `Work name is required`                                                                                         | `Work name is required`                                                                                         | ✅                   |
| `…manual.slugRequired`                 | `Work slug is required`                                                                                         | `Work slug is required`                                                                                         | ✅                   |
| `…manual.descriptionRequired`          | `Work description is required`                                                                                  | `Work description is required`                                                                                  | ✅                   |
| `…manual.createFailed`                 | `Failed to create work`                                                                                         | `Failed to create Work`                                                                                         | ✅                   |
| `…manual.success.created`              | `Work created successfully!`                                                                                    | `Work created successfully!`                                                                                    | ✅                   |
| **Import subform**                     |                                                                                                                      |                                                                                                                 |                      |
| `…import.subtitle`                     | `Import a work from an existing GitHub repository`                                                              | `Import a Work from an existing GitHub repository`                                                              | ✅                   |
| `…import.formTitle`                    | `Import Work from GitHub`                                                                                       | `Import Work from GitHub`                                                                                       | ✅                   |
| `…import.formSubtitle`                 | `Import items from an existing GitHub repository to create your work`                                           | `Import items from an existing GitHub repository to create your Work`                                           | ✅                   |
| `…import.nameLabel`                    | `Work Name`                                                                                                     | `Work Name`                                                                                                     | ✅                   |
| `…import.namePlaceholder`              | `e.g., My Awesome Work`                                                                                         | `e.g., My Awesome Work`                                                                                         | ✅                   |
| `…import.attribution.text`             | `This work will reference {url} as its source`                                                                  | `This Work will reference {url} as its source`                                                                  | ✅                   |
| `…import.importButton`                 | `Import Work`                                                                                                   | `Import Work`                                                                                                   | ✅                   |
| `…import.importing.title`              | `Importing Work`                                                                                                | `Importing Work`                                                                                                | ✅                   |
| `…import.importing.subtitle`           | `Setting up your work from the source repository...`                                                            | `Setting up your Work from the source repository...`                                                            | ✅                   |
| `…import.errors.nameRequired`          | `Work name is required`                                                                                         | `Work name is required`                                                                                         | ✅                   |
| `…import.errors.importFailed`          | `Failed to import work`                                                                                         | `Failed to import Work`                                                                                         | ✅                   |
| `…import.errors.linkFailed`            | `Failed to link work`                                                                                           | `Failed to link Work`                                                                                           | ✅                   |
| `…import.success.started`              | `Import started! Redirecting to your work...`                                                                   | `Import started! Redirecting to your Work...`                                                                   | ✅                   |
| `…import.success.linked`               | `Work linked successfully`                                                                                      | `Work linked successfully`                                                                                      | ✅                   |

### 3.10 Work detail / settings / generator

| Key                                                        | Current                                                                                                                                     | Proposed                                                                                                                               | Type |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `…members.subtitle`                                        | `Manage who has access to this work and their permissions.`                                                                            | `Manage who has access to this Work and their permissions.`                                                                            | ✅   |
| `…roles.manager`                                           | `Can edit work and manage members, but cannot delete.`                                                                                 | `Can edit Work and manage members, but cannot delete.`                                                                                 | ✅   |
| `…roles.editor`                                            | `Can edit work content and run generations.`                                                                                           | `Can edit Work content and run generations.`                                                                                           | ✅   |
| `…roles.viewer`                                            | `Read-only access to view the work.`                                                                                                   | `Read-only access to view the Work.`                                                                                                   | ✅   |
| `…invite.description`                                      | `Add a new member to collaborate on this work.`                                                                                        | `Add a new member to collaborate on this Work.`                                                                                        | ✅   |
| `…remove.description`                                      | `Are you sure you want to remove {username} from this work? They will lose all access.`                                                | `Are you sure you want to remove {username} from this Work? They will lose all access.`                                                | ✅   |
| `…fallbackName`                                            | `this work`                                                                                                                            | `this Work`                                                                                                                            | ✅   |
| `…schedule.description`                                    | `Complete one successful manual run to unlock automated scheduling. Once your work has data we can keep it fresh for you.`             | `Complete one successful manual run to unlock automated scheduling. Once your Work has data we can keep it fresh for you.`             | ✅   |
| `…generator.description`                                   | `Start generating items for your work to populate it with content.`                                                                    | `Start generating items for your Work to populate it with content.`                                                                    | ✅   |
| `…generator.successDescription`                            | `Your work has been successfully populated with items.`                                                                                | `Your Work has been successfully populated with items.`                                                                                | ✅   |
| `…comparisons.subtitle`                                    | `A vs B comparison pages between work items`                                                                                           | `A vs B comparison pages between items in this Work`                                                                                   | ⚙️   |
| `…info.title`                                              | `Work Information`                                                                                                                     | `Work Information`                                                                                                                     | ✅   |
| `…created.title`                                           | `Work Created`                                                                                                                         | `Work Created`                                                                                                                         | ✅   |
| `…created.workCreated`                                | `Work was successfully created`                                                                                                        | `Work was successfully created`                                                                                                        | ✅   |
| `…items.title`                                             | `Work Items`                                                                                                                           | `Work Items`                                                                                                                           | ✅   |
| `…items.subtitle`                                          | `Manage and organize the items in your work`                                                                                           | `Manage and organize the items in your Work`                                                                                           | ✅   |
| `…items.noItemsDescription`                                | `Your work doesn't have any items yet. Generate items to populate your work with content.`                                        | `Your Work doesn't have any items yet. Generate items to populate it with content.`                                                    | ✅   |
| `…featuredHelp`                                            | `Mark this item as featured in the work`                                                                                               | `Mark this item as featured in this Work`                                                                                              | ✅   |
| `…successDescription`                                      | `The item has been added to your work`                                                                                                 | `The item has been added to your Work`                                                                                                 | ✅   |
| `…regenerationWarning`                                     | `This work has already been generated. Starting a new generation will replace existing items.`                                         | `This Work has already been generated. Starting a new generation will replace existing items.`                                         | ✅   |
| `…workName` (×3 fields)                               | `Work Name`                                                                                                                            | `Work Name`                                                                                                                            | ✅   |
| `…promptPlaceholder`                                       | `Describe what items should be generated for this work...`                                                                             | `Describe what items should be generated for this Work...`                                                                             | ✅   |
| `…recreateWork`                                       | `Recreate Work`                                                                                                                        | `Recreate Work`                                                                                                                        | ✅   |
| `…workNamePlaceholder`                                | `Enter work name`                                                                                                                      | `Enter Work name`                                                                                                                      | ✅   |
| `…recreateConfirmTitle`                                    | `Recreate work data?`                                                                                                                  | `Recreate Work data?`                                                                                                                  | ✅   |
| `…useWorkDefault`                                     | `Use Work Default`                                                                                                                     | `Use Work Default`                                                                                                                     | ✅   |
| `…cantDeleteWhileGenerating`                               | `Cannot delete the work while items are being generated.`                                                                              | `Cannot delete the Work while items are being generated.`                                                                              | ✅   |
| `…deleteWarning` / `dangerDescription`                     | `Once you delete a work, there is no going back. Please be certain.`                                                                   | `Once you delete a Work, there is no going back. Please be certain.`                                                                   | ✅   |
| `…deleteConfirmDetail`                                     | `This action cannot be undone. The work and selected repositories will be permanently deleted.`                                        | `This action cannot be undone. The Work and selected repositories will be permanently deleted.`                                        | ✅   |
| `…confirmWorkName`                                    | `Type work name to confirm`                                                                                                            | `Type Work name to confirm`                                                                                                            | ✅   |
| `…confirmWorkNameDescription`                         | `Type "{name}" to confirm deletion`                                                                                                         | _(unchanged — no "work" in source)_                                                                                               | —    |
| `…deleteNameMismatch`                                      | `Work name does not match`                                                                                                             | `Work name does not match`                                                                                                             | ✅   |
| `…deleteButton`                                            | `Delete Work`                                                                                                                          | `Delete Work`                                                                                                                          | ✅   |
| `…deleteSuccess`                                           | `Work deleted successfully`                                                                                                            | `Work deleted successfully`                                                                                                            | ✅   |
| `…deleteFailed`                                            | `Failed to delete work`                                                                                                                | `Failed to delete Work`                                                                                                                | ✅   |
| **Deploy panel**                                           |                                                                                                                                             |                                                                                                                                        |      |
| `…deploy.description` (`workCreation.deployProvider`) | `Select where to deploy your work website`                                                                                             | `Select where to deploy your Work's website`                                                                                           | ✅   |
| `…webPagesHelp`                                            | `Additional instructions for filtering web pages by relevance to your work topic.`                                                     | `Additional instructions for filtering web pages by relevance to your Work's topic.`                                                   | ✅   |
| `…websiteSettings.subtitle`                                | `Customize how your work website looks and behaves`                                                                                    | `Customize how your Work's website looks and behaves`                                                                                  | ✅   |
| `…websiteName.placeholder`                                 | `My Work`                                                                                                                              | `My Work`                                                                                                                              | ✅   |
| `…websiteUrl.helper`                                       | `The URL of your company or work website`                                                                                              | `The URL of your company or Work's website`                                                                                            | ✅   |
| `…committer.description`                                   | `Override the committer name and email for git commits in this work. Leave empty to use your user-level settings or account defaults.` | `Override the committer name and email for git commits in this Work. Leave empty to use your user-level settings or account defaults.` | ✅   |
| `…deploy.providerDescription`                              | `Select a deployment provider to deploy your work website.`                                                                            | `Select a deployment provider to deploy your Work's website.`                                                                          | ✅   |
| `…deploy.tokenDescription`                                 | `To deploy your work, you need to configure your {provider} API token in Plugin Settings.`                                             | `To deploy your Work, you need to configure your {provider} API token in Plugin Settings.`                                             | ✅   |
| `…deploy.step4`                                            | `Return here to deploy your work`                                                                                                      | `Return here to deploy your Work`                                                                                                      | ✅   |
| `…deploy.sharedDescription`                                | `The work owner has not configured deployment. Please contact the work owner to set up deployment.`                               | `The Work owner has not configured deployment. Please contact the Work owner to set up deployment.`                                    | ✅   |
| `…deploy.repoDescription`                                  | `Deploy your work website repository.`                                                                                                 | `Deploy your Work's website repository.`                                                                                               | ✅   |
| `…deploy.teamDescription`                                  | `Choose the team to deploy this work to.`                                                                                              | `Choose the team to deploy this Work to.`                                                                                              | ✅   |
| `…deploy.updateInfo`                                       | `Updates sync your work content to the website repository for the next deployment.`                                                    | `Updates sync your Work's content to the website repository for the next deployment.`                                                  | ✅   |
| `…deploy.siteNamePlaceholder`                              | `My Work`                                                                                                                              | `My Work`                                                                                                                              | ✅   |

### 3.11 Settings → Data import/export

| Key                                         | Current                                                                                                            | Proposed                                                                                                     | Type |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ---- |
| `dashboard.settings.data.exportDescription` | `Download your account data including works, plugin settings, and profile information as a JSON file.`       | `Download your account data including works, plugin settings, and profile information as a JSON file.`       | ✅   |
| `…importDescription`                        | `Import data from a previously exported JSON file. You can resolve conflicts for works with matching slugs.` | `Import data from a previously exported JSON file. You can resolve conflicts for works with matching slugs.` | ✅   |
| `…import.works`                       | `Works`                                                                                                      | `Works`                                                                                                      | ✅   |
| `…import.existingWork`                 | `Existing`                                                                                                         | _(unchanged)_                                                                                                | —    |
| `…import.worksCreated`                | `Works created`                                                                                              | `Works created`                                                                                              | ✅   |
| `…import.worksUpdated`                | `Works updated`                                                                                              | `Works updated`                                                                                              | ✅   |
| `…import.worksSkipped`                | `Works skipped`                                                                                              | `Works skipped`                                                                                              | ✅   |

### 3.12 Settings → Plugins (pipeline / global)

| Key                           | Current                                                                                                                                        | Proposed                                                                                                                                  | Type                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `…pipelinesField.description` | `Choose which pipeline is used by default when generating work items.`                                                                    | `Choose which pipeline is used by default when generating items.`                                                                         | ⚙️ (drop "work") |
| `…autoDescription`            | `Use the system-resolved pipeline for each work`                                                                                          | `Use the system-resolved pipeline for each Work`                                                                                          | ✅                    |
| `…enforceDescription`         | `Always pre-select this pipeline, even when a work has its own pipeline configured. You can still switch pipelines manually in the form.` | `Always pre-select this pipeline, even when a Work has its own pipeline configured. You can still switch pipelines manually in the form.` | ✅                    |
| `…github.connected`           | `Create and manage works with GitHub repositories`                                                                                       | `Create and manage works with GitHub repositories`                                                                                        | ✅                    |
| `…github.disconnected`        | `Connect to create works from repositories`                                                                                              | `Connect to create works from repositories`                                                                                               | ✅                    |

### 3.13 Settings → Notifications

| Key                                                             | Current                                                     | Proposed                                              | Type                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `dashboard.settings.notifications.email.workUpdates.label` | `Work Updates`                                         | `Work Updates`                                        | ✅                                                                                                                    |
| `…workUpdates.description`                                 | `Get notified about important updates to your works`  | `Get notified about important updates to your works`  | ✅                                                                                                                    |
| `…newItems.description`                                         | `Get notified when new items are added to your works` | `Get notified when new items are added to your works` | ✅                                                                                                                    |
| `…weeklyDigest.description`                                     | `Receive a weekly summary of your work activity`       | `Receive a weekly summary of your work activity`      | ⚠️ ("work activity" reads as "labor activity"; consider **"Receive a weekly summary of activity across your works"**) |
| `…app.newItems.description`                                     | `Show notifications for new work items`                | `Show notifications for new items`                    | ⚙️ (drop "work")                                                                                                 |
| `…app.comments.description`                                     | `Get notified about comments on your works`           | `Get notified about comments on your works`           | ✅                                                                                                                    |

### 3.14 Settings → Git Provider

| Key                                               | Current                                                                                                    | Proposed                                                                                             | Type |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---- |
| `dashboard.gitProvider.connection.alert.subtitle` | `Connect your {provider} account to create works`                                                    | `Connect your {provider} account to create works`                                                    | ✅   |
| `dashboard.gitProvider.settings.subtitle`         | `Connect your git provider accounts to import repositories, create works, and manage your projects.` | `Connect your git provider accounts to import repositories, create works, and manage your projects.` | ✅   |

### 3.15 Settings → Danger Zone

| Key                                           | Current                                              | Proposed                                       | Type |
| --------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------- | ---- |
| `dashboard.dangerZone.export.subtitle`        | `Download all your works, items, and settings` | `Download all your works, items, and settings` | ✅   |
| `dashboard.dangerZone.delete.confirmItems[1]` | `All your works`                               | `All your works`                               | ✅   |
| `dashboard.dangerZone.delete.confirmItems[2]` | `All work items and data`                       | `All Work items and data`                      | ✅   |

### 3.16 AI Chat

| Key                                   | Current                                                                                                                                         | Proposed                                                                                                                             | Type |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| `dashboard.aiChat.subtitle`           | `Create works with natural language`                                                                                                      | `Create works with natural language`                                                                                                 | ✅   |
| `…welcomeSubtitle`                    | `Your AI-powered assistant. Ask me anything about creating works, generating content, or organizing your data.`                           | `Your AI-powered assistant. Ask me anything about creating works, generating content, or organizing your data.`                      | ✅   |
| `…welcomeMessage`                     | `Hi! I can help you create works using natural language. Ask something like "Create a work for AI tools" or describe what you need.` | `Hi! I can help you create works using natural language. Ask something like "Create a Work for AI tools" or describe what you need.` | ✅   |
| `…capabilities.workCreation`     | `Work Creation`                                                                                                                            | `Work Creation`                                                                                                                      | ✅   |
| `…capabilities.workCreationDesc` | `Build works from natural language descriptions`                                                                                          | `Build works from natural language descriptions`                                                                                     | ✅   |
| `…gitNotConnectedDesc`                | `Connect your git provider to create and manage works.`                                                                                   | `Connect your git provider to create and manage works.`                                                                              | ✅   |
| `…deployNotConfiguredDesc`            | `Configure a deployment provider to publish your work websites.`                                                                           | `Configure a deployment provider to publish your works' websites.`                                                                   | ✅   |
| `…suggestions.s1`                     | `Show my works`                                                                                                                           | `Show my works`                                                                                                                      | ✅   |
| `…suggestions.s2`                     | `Create a work of AI tools`                                                                                                                | `Build a Work for AI tools`                                                                                                          | ⚙️   |
| `…feelingLucky`                       | `Suggest a work to create`                                                                                                                 | `Suggest a Work to build`                                                                                                            | ⚙️   |

### 3.17 Plugins (cross-Work plugin behavior)

| Key                                    | Current                                                                                                     | Proposed                                                                                         | Type |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---- |
| `dashboard.plugins.enableDescription`  | `Configure how this plugin is enabled across your works.`                                             | `Configure how this plugin is enabled across your works.`                                        | ✅   |
| `…disableWarning`                      | `Disabling this plugin will also disable it in all your works`                                        | `Disabling this plugin will also disable it in all your works`                                   | ✅   |
| `…autoEnableForWorks`            | `Also enable for all works`                                                                           | `Also enable for all works`                                                                      | ✅   |
| `…autoEnableForWorksDescription` | `This plugin will be automatically active in all your works. You can still disable it per work.` | `This plugin will be automatically active in all your works. You can still disable it per Work.` | ✅   |

### 3.18 Per-Work plugin settings

| Key                                | Current                                                                                                | Proposed                                                                                          | Type |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---- |
| `dashboard.workPlugins.title` | `Work Plugins`                                                                                    | `Work Plugins`                                                                                    | ✅   |
| `…subtitle`                        | `Configure plugins for this work`                                                                 | `Configure plugins for this Work`                                                                 | ✅   |
| `…enableForWork`              | `Enable for this work`                                                                            | `Enable for this Work`                                                                            | ✅   |
| `…disableForWork`             | `Disable for this work`                                                                           | `Disable for this Work`                                                                           | ✅   |
| `…workSettingsInfo`           | `Configure work-specific settings here`                                                           | `Configure Work-specific settings here`                                                           | ✅   |
| `…capabilityProvidersDescription`  | `Select which plugin provides each capability for this work`                                      | `Select which plugin provides each capability for this Work`                                      | ✅   |
| `…settingsModalTitle`              | `Work Settings`                                                                                   | `Work Settings`                                                                                   | ✅   |
| `…settingsModalDescription`        | `Override settings for this work. Unset fields inherit from your user settings.`                  | `Override settings for this Work. Unset fields inherit from your user settings.`                  | ✅   |
| `…resetConfirm`                    | `This will clear all work-specific overrides. Settings will fall back to your user-level values.` | `This will clear all Work-specific overrides. Settings will fall back to your user-level values.` | ✅   |

### 3.19 Onboarding (Codex / SIM / GitHub provider blocks)

| Key                   | Current                                                                                                        | Proposed                                                                                                  | Type |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---- |
| `…codex.description`  | `Choose the Codex model you want to run for end-to-end work generation.`                                  | `Choose the Codex model you want to run for end-to-end Work generation.`                                  | ✅   |
| `…sim.subtitle`       | `Add your SIM AI API key and verify the connection to start delegating work generation to SIM workflows.` | `Add your SIM AI API key and verify the connection to start delegating Work generation to SIM workflows.` | ✅   |
| `…github.description` | `GitHub is required for creating and managing work repositories. Connect your account to get started.`    | `GitHub is required for creating and managing Work repositories. Connect your account to get started.`    | ✅   |

### 3.20 Action / validation messages

| Key                                        | Current                                                   | Proposed                                   | Type |
| ------------------------------------------ | --------------------------------------------------------- | ------------------------------------------ | ---- |
| `actions.works.createSuccess`        | `Work created successfully!`                         | `Work created successfully!`               | ✅   |
| `actions.works.createFailed`         | `Failed to create work`                              | `Failed to create Work`                    | ✅   |
| `actions.works.updateSuccess`        | `Work updated successfully!`                         | `Work updated successfully!`               | ✅   |
| `actions.works.updateFailed`         | `Failed to update work`                              | `Failed to update Work`                    | ✅   |
| `actions.works.invalidGeneratedData` | `Failed to generate valid work data`                 | `Failed to generate valid Work data`       | ✅   |
| `actions.works.aiGenerationStarted`  | `Work creation started! AI is generating content...` | `Work created — AI is generating content…` | ⚙️   |
| `actions.works.invalidId`            | `Invalid work ID`                                    | `Invalid Work ID`                          | ✅   |
| `actions.works.deleteSuccess`        | `Work deleted successfully`                          | `Work deleted successfully`                | ✅   |
| `actions.works.deleteFailed`         | `Failed to delete work`                              | `Failed to delete Work`                    | ✅   |
| `actions.works.fetchFailed`          | `Failed to fetch works`                             | `Failed to fetch works`                    | ✅   |
| `actions.works.import.failed`        | `Failed to import work`                              | `Failed to import Work`                    | ✅   |

### 3.21 Outside `en.json` — docs site

| File                                               | Current                                                                                                                                                                                                                        | Proposed                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `apps/docs/docusaurus.config.ts:40` (tagline)      | `Modern Work Website Solution`                                                                                                                                                                                            | `The Workshop for AI`                                                                                                            |
| `apps/docs/docusaurus.config.ts:219` (description) | `Ever Works is an open-source modern work website solution.`                                                                                                                                                              | `Ever Works is an open agentic runtime that autonomously builds content-rich web apps and Git repositories.`                     |
| `apps/docs/docusaurus.config.ts:263` (footer)      | `Modern Work Website Solution`                                                                                                                                                                                            | `The Workshop for AI`                                                                                                            |
| `apps/docs/sidebarsPlatform.ts`                    | sidebar item IDs reference `creating-a-work`, `work-import`, `work-members`, `work-changelog`, `work-commands`, `agent-services/work-*`, `web-dashboard/work-pages`, `api/works` etc. | **Defer** — these are doc-page slugs/URLs, handled in a separate "rename docs" pass alongside renaming the doc files themselves. |

### 3.22 Outside `en.json` — apps/web hardcoded strings

A `grep` of `apps/web/src` for `[Dd]irector(y|ies)` returns **175 files**. Most are code identifiers (variables, types, hook names, component names) and are **not** in scope for this copy map. A separate pass will:

1. Identify which of those 175 files contain hardcoded user-visible strings (vs only identifiers).
2. Replace them according to the rules in §1.

I recommend doing the **i18n strings first** (single file, all 21 locales), then a follow-up pass for any leftover hardcoded UI text.

---

## 4. Out of scope for this document

These are tracked separately and require their own design:

- **Code identifiers**: variable / type / class / file / component / route names (e.g. `WorkCard`, `works.module.ts`, `getWorkById`).
- **API routes**: `/api/works/*` → `/api/works/*` (breaking change).
- **URL paths**: `/dashboard/works/*` → `/dashboard/works/*` (with redirects).
- **Database**: `works` table, FK columns (e.g. `work_id`), indexes — needs migration plan.
- **i18n key paths**: `dashboard.works.*` → `dashboard.works.*` (Q6).
- **Plugin contracts**: any field in plugin metadata or settings JSON Schema named `work*`.
- **Translations** (other 20 locales): once English is signed off, translators / LLM batch translation re-derives them.
- **Marketing site / external blog posts / SEO redirects** (if any exist outside this repo).
- **`works-config`** package and `works.yml` filename — these already use "works" naming and are unaffected by this rename.

---

## 5. Next steps

1. **Review this document** — confirm or amend §1 and §2.
2. Once approved, I'll apply the proposed strings to `apps/web/messages/en.json` and the docs config.
3. Run the i18n diff through translation (or LLM) to update the other 20 `messages/*.json` locales.
4. Open the follow-up tasks (key rename, route rename, code rename, DB migration) as separate, independently shippable PRs.
