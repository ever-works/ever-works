# Directory → Work — UI Copy Map

> **Status:** DRAFT — for review before any code changes.
> **Scope:** User-facing copy only (UI strings, marketing text, page titles, button labels, helper text). Code identifiers, DB columns, API routes, file paths, and class/component names are tracked separately and are **not** in this document.

---

## 1. Adopted decisions

These rules drive every row in the map below. Confirm or amend before we proceed.

### 1.1 Capitalization

Following the Linear / GitHub / Notion convention:

- **Capitalize "Work" / "Works"** when used as a label, heading, navigation item, button, or column header → it reads as a branded product noun.
- **Lowercase "work" / "works"** in body sentences and helper text → reads more naturally and avoids a "shouty" feel.

| Context | Style | Example |
|---|---|---|
| Sidebar nav | Capital | **Works** |
| Page heading | Capital | **Recent Works** |
| Button | Capital | **+ New Work** |
| Column header | Capital | **Work** |
| Body sentence | Lower | "Manage your AI-powered works and track performance" |
| Toast / inline | Lower | "Your work was created" |

### 1.2 Singular CTAs avoid "a Work"

The phrase **"Create Work"** reads as a verb ("create labor"); **"Create a Work"** is grammatical but stilted. We sidestep both:

| Avoid | Prefer |
|---|---|
| Create Work | **+ New Work** |
| Create Directory | **+ New Work** or **New Work** |
| New Directory | **New Work** |
| Create Your First Directory | **Create your first Work** (lowercase first/Work cap as label) |
| Create a directory | **Start a new Work** |

### 1.3 Plurals carry the rebrand

"Works" reads cleanly as a noun ("Recent Works", "Total Works", "Search works…"). Use plural-first wherever possible.

### 1.4 Words we are NOT renaming

These look related but stay as-is:

- **"directory"** as a filesystem path (e.g. `docs/` directory) — different word, leave alone.
- **"items"** — still items inside a Work.
- **"repository / repo"** — Git concept, unchanged.
- **"GitHub Organization"** — unchanged.
- **"Awesome List", "Data Repository"** — repository format names, unchanged.
- **"Plugin", "Pipeline", "Provider"** — unchanged.

### 1.5 Brand tagline

Replace **"Directory Builder"** / **"Modern Directory Website Solution"** with the new positioning: **"The Workshop for AI"** (or short: **"AI Workshop"**, or longer: **"An Open Agentic Runtime that Autonomously Builds and Maintains Content-Rich Web Apps and Git Repositories"**). Pick one for the metadata `<title>` and tagline; the long form is for the landing-page hero only.

---

## 2. Open questions

Decide these before we start; everything in §3 follows from them.

| # | Question | Recommended default |
|---|---|---|
| Q1 | Use capitalized **Work / Works** as the branded noun in UI? | ✅ Yes (Linear/GitHub style) |
| Q2 | Plural section name: **Works** or **Work**? | **Works** (avoids verb reading) |
| Q3 | Singular CTA: **+ New Work**, **Start Work**, **Create Work**, or rephrase? | **+ New Work** for buttons, **Start a Work** in onboarding/AI prompts |
| Q4 | "Recent" header: **Recent Works** or **Recent Work**? | **Recent Works** |
| Q5 | Page metadata title — replace "Directory Builder" with what? | **"Workshop for AI"** (matches new tagline) |
| Q6 | i18n message **keys** (e.g. `dashboard.directories.*`) — rename to `works.*` too, or keep the keys and only change values? | **Rename the keys** so future grep is consistent. (One-time mechanical refactor, separate PR.) |
| Q7 | URL slugs (`/dashboard/directories`, `/api/directories`) — rename now or later? | **Defer** to a separate PR; copy-only first. |

---

## 3. Copy map

Each section lists every English string in `apps/web/messages/en.json` that contains "directory" / "directories", with the proposed new copy. Format:

- ✅ **Direct swap** — straight `Directory→Work` / `Directories→Works`, no rewording
- ⚙️ **Reword** — needs phrasing change to avoid awkwardness
- ⚠️ **Decide** — depends on an open question above

### 3.1 Brand & metadata

| Key | Current | Proposed | Type |
|---|---|---|---|
| `metadata.title` | `{companyName} - Directory Builder` | `{companyName} — Workshop for AI` | ⚙️ Q5 |
| `metadata.description` | `A SaaS platform for building and managing directories` | `An agentic runtime that autonomously builds and maintains content-rich web apps and Git repositories` | ⚙️ |
| `metadata.pages.directories` | `Directories` | `Works` | ✅ |
| `metadata.pages.newDirectory` | `New Directory` | `New Work` | ✅ |
| `metadata.pages.directory` | `Directory` | `Work` | ✅ |

### 3.2 Sidebar / navigation

| Key | Current | Proposed | Type |
|---|---|---|---|
| `dashboard.sidebar.navigation.directories` | `Directories` | `Works` | ✅ |
| `dashboard.sidebar.newDirectory` | `New Directory` | `New Work` | ✅ |
| `dashboard.sidebar.activityIndicator` | `Directory generating` | `Work generating` | ✅ |

### 3.3 Dashboard home / header

| Key | Current | Proposed | Type |
|---|---|---|---|
| `dashboard.header.subtitle` | `Manage your AI-powered directories and track their performance` | `Manage your AI-powered works and track their performance` | ✅ |
| `dashboard.header.help.quickTips.tip1` | `Create your first directory by clicking the 'Create Directory' button on the dashboard.` | `Create your first Work by clicking the '+ New Work' button on the dashboard.` | ⚙️ |
| `dashboard.header.help.quickTips.tip2` | `Use the AI generator to automatically populate your directory with relevant items.` | `Use the AI generator to automatically populate your Work with relevant items.` | ✅ |
| `dashboard.header.help.quickTips.tip3` | `Connect your GitHub account to sync and deploy your directories as repositories.` | `Connect your GitHub account to sync and deploy your works as repositories.` | ✅ |
| `dashboard.header.help.shortcuts.search` | `Search directories` | `Search works` | ✅ |
| `dashboard.header.help.shortcuts.newDirectory` | `Create new directory` | `Create new Work` | ✅ |

### 3.4 Works list page (was "Directories")

| Key | Current | Proposed | Type |
|---|---|---|---|
| `dashboard.directories.title` | `Directories` | `Works` | ✅ |
| `dashboard.directories.subtitle` | `Manage and organize your AI-powered directories` | `Manage and organize your AI-powered works` | ✅ |
| `dashboard.directories.summary.totalDirectories` | `Total Directories` | `Total Works` | ✅ |
| `dashboard.directories.recent` | `Recent Directories` | `Recent Works` | ⚠️ Q4 |
| `dashboard.directories.search` | `Search directories...` | `Search works...` | ✅ |
| `dashboard.directories.create` | `Create Directory` | `+ New Work` | ⚙️ Q3 |
| `dashboard.directories.showing` | `Showing {current} of {total} directories` | `Showing {current} of {total} works` | ✅ |
| `dashboard.directories.searchFailed` | `Failed to search directories. Please try again.` | `Failed to search works. Please try again.` | ✅ |
| `dashboard.directories.empty.title` | `No directories yet` | `No works yet` | ✅ |
| `dashboard.directories.empty.description` | `Create your first AI-powered directory to start organizing and showcasing your content.` | `Create your first AI-powered Work to start organizing and showcasing your content.` | ✅ |
| `dashboard.directories.empty.action` | `Create Your First Directory` | `Create Your First Work` | ✅ |
| `dashboard.directories.empty.notFound.title` | `No directories found` | `No works found` | ✅ |
| `dashboard.directories.empty.notFound.withoutSearch` | `Create your first AI-powered directory to get started` | `Create your first AI-powered Work to get started` | ✅ |
| `dashboard.totalDirectories` | `Total Directories` | `Total Works` | ✅ |
| `dashboard.directoryList.title` | `Your Directories` | `Your Works` | ✅ |
| `dashboard.directoryList.createButton` | `Create Directory` | `+ New Work` | ⚙️ |

### 3.5 Work card / loading states

| Key | Current | Proposed | Type |
|---|---|---|---|
| `dashboard.directoryCard.openingTitle` | `Opening directory` | `Opening work` | ✅ |
| `dashboard.directoryCard.openingMessage` | `Preparing your directory. Details will open shortly. Stay on this page.` | `Preparing your work. Details will open shortly. Stay on this page.` | ✅ |

### 3.6 Auth / onboarding

| Key | Current | Proposed | Type |
|---|---|---|---|
| `auth.register.subtitle` | `Start building amazing directories today` | `Start building amazing works today` | ✅ |
| `onboarding.subtitle` | `Build and publish your first directory in minutes.` | `Build and publish your first Work in minutes.` | ✅ |
| `onboarding.steps.welcome.description` | `Ever Works is an open-source directory builder. Create structured content directories — tools, jobs, links, products — and publish them as live websites.` | `Ever Works is an open agentic runtime. Build content-rich web apps and Git repositories — tools, jobs, links, products — and publish them as live websites.` | ⚙️ |
| `onboarding.steps.welcome.detail` | `Let's get you set up. Connect your providers below, then create your first directory.` | `Let's get you set up. Connect your providers below, then create your first Work.` | ✅ |
| `onboarding.steps.welcome.feature1.description` | `Generate and enrich directory items automatically using your AI provider.` | `Generate and enrich items automatically using your AI provider.` | ⚙️ (drop "directory" — context is clear) |
| `onboarding.steps.welcome.feature3.description` | `Every directory is a GitHub repository you own and control.` | `Every Work is a GitHub repository you own and control.` | ✅ |
| `onboarding.steps.directory.title` | `Create your first directory` | `Create your first Work` | ✅ |
| `onboarding.steps.directory.description` | `A directory is your content hub. Add items, configure the layout, and publish it in one click.` | `A Work is your content hub. Add items, configure the layout, and publish it in one click.` | ✅ |
| `onboarding.steps.directory.detail` | `You're all set! Create your first directory to start building and publishing content.` | `You're all set! Create your first Work to start building and publishing content.` | ✅ |
| `onboarding.steps.directory.action` | `Create a directory` | `Create a Work` | ✅ |
| `onboarding.steps.publish.description` | `Connect Vercel or GitHub to deploy your directory as a public website — no hosting configuration needed.` | `Connect Vercel or GitHub to deploy your Work as a public website — no hosting configuration needed.` | ✅ |
| `onboarding.steps.directory` (object key) | `directory` | `work` | ✅ (rename key) |

### 3.7 Auth split-screen feature panel

| Key | Current | Proposed | Type |
|---|---|---|---|
| `layout.auth.feature.title` | `Build Directories with AI` | `Build Works with AI` | ✅ |
| `layout.auth.feature.subtitle` | `Create beautiful, searchable directories in minutes using natural language. No coding required.` | `Create beautiful, searchable works in minutes using natural language. No coding required.` | ✅ |

### 3.8 Activity log

| Key | Current | Proposed | Type |
|---|---|---|---|
| `dashboard.activity.subtitle` | `Track all operations across your directories` | `Track all operations across your works` | ✅ |
| `dashboard.activity.columns.directory` | `Directory` | `Work` | ✅ |
| `dashboard.activity.filters.types.directoryCreated` | `Directory Created` | `Work Created` | ✅ |
| `dashboard.activity.filters.types.directoryUpdated` | `Directory Updated` | `Work Updated` | ✅ |
| `dashboard.activity.filters.types.directoryDeleted` | `Directory Deleted` | `Work Deleted` | ✅ |

### 3.9 Work creation flow (was "directoryCreation")

| Key | Current | Proposed | Type |
|---|---|---|---|
| `dashboard.directoryCreation.title` | `Create New Directory` | `New Work` | ⚙️ Q3 |
| `dashboard.directoryCreation.subtitle` | `Choose how you'd like to create your directory` | `Choose how you'd like to start your Work` | ⚙️ |
| `…deployProvider.description` | `Select where to deploy your directory website` | `Select where to deploy your Work's website` | ✅ |
| **AI subform** | | | |
| `…ai.subtitle` | `Describe your directory idea in natural language and let AI handle the setup` | `Describe your Work in natural language and let AI handle the setup` | ✅ |
| `…ai.formTitle` | `Create Directory with AI` | `New Work — with AI` | ⚙️ Q3 |
| `…ai.formSubtitle` | `Describe your directory idea and let AI handle the setup and initial content generation` | `Describe your Work and let AI handle the setup and initial content generation` | ✅ |
| `…ai.directoryNameLabel` | `Directory Name` | `Work Name` | ✅ |
| `…ai.promptLabel` | `Describe Your Directory` | `Describe Your Work` | ✅ |
| `…ai.promptPlaceholder` | `Describe what kind of directory you want to create, what items it should contain, and any specific requirements...` | `Describe what kind of Work you want to create, what items it should contain, and any specific requirements...` | ✅ |
| `…ai.examplePrompts.0.prompt` | `Create a directory of the best AI tools for developers` | `Build a Work cataloguing the best AI tools for developers` | ⚙️ |
| `…ai.examplePrompts.2.prompt` | `Generate a directory of productivity apps for remote teams` | `Build a Work cataloguing productivity apps for remote teams` | ⚙️ |
| `…ai.generatingButton` | `Generating Directory...` | `Generating Work...` | ✅ |
| `…ai.noteText` | `…You'll be notified when your directory is ready.` | `…You'll be notified when your Work is ready.` | ✅ |
| `…ai.errors.promptRequired` | `Please describe what kind of directory you want to create` | `Please describe what kind of Work you want to create` | ✅ |
| `…ai.errors.nameRequired` | `Directory name is required` | `Work name is required` | ✅ |
| `…ai.errors.slugRequired` | `Directory slug is required` | `Work slug is required` | ✅ |
| `…ai.errors.descriptionRequired` | `Directory description is required` | `Work description is required` | ✅ |
| `…ai.errors.createFailed` | `Failed to create directory` | `Failed to create Work` | ✅ |
| `…ai.success.started` | `Directory creation started!` | `Work created — generating content…` | ⚙️ |
| `…ai.success.created` | `Directory created successfully!` | `Work created successfully!` | ✅ |
| **Manual subform** | | | |
| `…manual.subtitle` | `Configure your directory with full control over every setting and option` | `Configure your Work with full control over every setting and option` | ✅ |
| `…manual.formTitle` | `Create Directory Manually` | `New Work — Manual Setup` | ⚙️ |
| `…manual.formSubtitle` | `Configure your directory with full control over every setting` | `Configure your Work with full control over every setting` | ✅ |
| `…manual.nameLabel` | `Directory Name *` | `Work Name *` | ✅ |
| `…manual.slugLabel` | `Directory Slug *` | `Work Slug *` | ✅ |
| `…manual.organizationHelp` | `Create this directory under a GitHub organization instead of your personal account` | `Create this Work under a GitHub organization instead of your personal account` | ✅ |
| `…manual.createButton` | `Create Directory` | `Create Work` | ⚙️ (or `+ New Work`) |
| `…manual.creatingButton` | `Creating Directory...` | `Creating Work...` | ✅ |
| `…manual.nameRequired` | `Directory name is required` | `Work name is required` | ✅ |
| `…manual.slugRequired` | `Directory slug is required` | `Work slug is required` | ✅ |
| `…manual.descriptionRequired` | `Directory description is required` | `Work description is required` | ✅ |
| `…manual.createFailed` | `Failed to create directory` | `Failed to create Work` | ✅ |
| `…manual.success.created` | `Directory created successfully!` | `Work created successfully!` | ✅ |
| **Import subform** | | | |
| `…import.subtitle` | `Import a directory from an existing GitHub repository` | `Import a Work from an existing GitHub repository` | ✅ |
| `…import.formTitle` | `Import Directory from GitHub` | `Import Work from GitHub` | ✅ |
| `…import.formSubtitle` | `Import items from an existing GitHub repository to create your directory` | `Import items from an existing GitHub repository to create your Work` | ✅ |
| `…import.nameLabel` | `Directory Name` | `Work Name` | ✅ |
| `…import.namePlaceholder` | `e.g., My Awesome Directory` | `e.g., My Awesome Work` | ✅ |
| `…import.attribution.text` | `This directory will reference {url} as its source` | `This Work will reference {url} as its source` | ✅ |
| `…import.importButton` | `Import Directory` | `Import Work` | ✅ |
| `…import.importing.title` | `Importing Directory` | `Importing Work` | ✅ |
| `…import.importing.subtitle` | `Setting up your directory from the source repository...` | `Setting up your Work from the source repository...` | ✅ |
| `…import.errors.nameRequired` | `Directory name is required` | `Work name is required` | ✅ |
| `…import.errors.importFailed` | `Failed to import directory` | `Failed to import Work` | ✅ |
| `…import.errors.linkFailed` | `Failed to link directory` | `Failed to link Work` | ✅ |
| `…import.success.started` | `Import started! Redirecting to your directory...` | `Import started! Redirecting to your Work...` | ✅ |
| `…import.success.linked` | `Directory linked successfully` | `Work linked successfully` | ✅ |

### 3.10 Work detail / settings / generator

| Key | Current | Proposed | Type |
|---|---|---|---|
| `…members.subtitle` | `Manage who has access to this directory and their permissions.` | `Manage who has access to this Work and their permissions.` | ✅ |
| `…roles.manager` | `Can edit directory and manage members, but cannot delete.` | `Can edit Work and manage members, but cannot delete.` | ✅ |
| `…roles.editor` | `Can edit directory content and run generations.` | `Can edit Work content and run generations.` | ✅ |
| `…roles.viewer` | `Read-only access to view the directory.` | `Read-only access to view the Work.` | ✅ |
| `…invite.description` | `Add a new member to collaborate on this directory.` | `Add a new member to collaborate on this Work.` | ✅ |
| `…remove.description` | `Are you sure you want to remove {username} from this directory? They will lose all access.` | `Are you sure you want to remove {username} from this Work? They will lose all access.` | ✅ |
| `…fallbackName` | `this directory` | `this Work` | ✅ |
| `…schedule.description` | `Complete one successful manual run to unlock automated scheduling. Once your directory has data we can keep it fresh for you.` | `Complete one successful manual run to unlock automated scheduling. Once your Work has data we can keep it fresh for you.` | ✅ |
| `…generator.description` | `Start generating items for your directory to populate it with content.` | `Start generating items for your Work to populate it with content.` | ✅ |
| `…generator.successDescription` | `Your directory has been successfully populated with items.` | `Your Work has been successfully populated with items.` | ✅ |
| `…comparisons.subtitle` | `A vs B comparison pages between directory items` | `A vs B comparison pages between items in this Work` | ⚙️ |
| `…info.title` | `Directory Information` | `Work Information` | ✅ |
| `…created.title` | `Directory Created` | `Work Created` | ✅ |
| `…created.directoryCreated` | `Directory was successfully created` | `Work was successfully created` | ✅ |
| `…items.title` | `Directory Items` | `Work Items` | ✅ |
| `…items.subtitle` | `Manage and organize the items in your directory` | `Manage and organize the items in your Work` | ✅ |
| `…items.noItemsDescription` | `Your directory doesn't have any items yet. Generate items to populate your directory with content.` | `Your Work doesn't have any items yet. Generate items to populate it with content.` | ✅ |
| `…featuredHelp` | `Mark this item as featured in the directory` | `Mark this item as featured in this Work` | ✅ |
| `…successDescription` | `The item has been added to your directory` | `The item has been added to your Work` | ✅ |
| `…regenerationWarning` | `This directory has already been generated. Starting a new generation will replace existing items.` | `This Work has already been generated. Starting a new generation will replace existing items.` | ✅ |
| `…directoryName` (×3 fields) | `Directory Name` | `Work Name` | ✅ |
| `…promptPlaceholder` | `Describe what items should be generated for this directory...` | `Describe what items should be generated for this Work...` | ✅ |
| `…recreateDirectory` | `Recreate Directory` | `Recreate Work` | ✅ |
| `…directoryNamePlaceholder` | `Enter directory name` | `Enter Work name` | ✅ |
| `…recreateConfirmTitle` | `Recreate directory data?` | `Recreate Work data?` | ✅ |
| `…useDirectoryDefault` | `Use Directory Default` | `Use Work Default` | ✅ |
| `…cantDeleteWhileGenerating` | `Cannot delete the directory while items are being generated.` | `Cannot delete the Work while items are being generated.` | ✅ |
| `…deleteWarning` / `dangerDescription` | `Once you delete a directory, there is no going back. Please be certain.` | `Once you delete a Work, there is no going back. Please be certain.` | ✅ |
| `…deleteConfirmDetail` | `This action cannot be undone. The directory and selected repositories will be permanently deleted.` | `This action cannot be undone. The Work and selected repositories will be permanently deleted.` | ✅ |
| `…confirmDirectoryName` | `Type directory name to confirm` | `Type Work name to confirm` | ✅ |
| `…confirmDirectoryNameDescription` | `Type "{name}" to confirm deletion` | _(unchanged — no "directory" in source)_ | — |
| `…deleteNameMismatch` | `Directory name does not match` | `Work name does not match` | ✅ |
| `…deleteButton` | `Delete Directory` | `Delete Work` | ✅ |
| `…deleteSuccess` | `Directory deleted successfully` | `Work deleted successfully` | ✅ |
| `…deleteFailed` | `Failed to delete directory` | `Failed to delete Work` | ✅ |
| **Deploy panel** | | | |
| `…deploy.description` (`directoryCreation.deployProvider`) | `Select where to deploy your directory website` | `Select where to deploy your Work's website` | ✅ |
| `…webPagesHelp` | `Additional instructions for filtering web pages by relevance to your directory topic.` | `Additional instructions for filtering web pages by relevance to your Work's topic.` | ✅ |
| `…websiteSettings.subtitle` | `Customize how your directory website looks and behaves` | `Customize how your Work's website looks and behaves` | ✅ |
| `…websiteName.placeholder` | `My Directory` | `My Work` | ✅ |
| `…websiteUrl.helper` | `The URL of your company or directory website` | `The URL of your company or Work's website` | ✅ |
| `…committer.description` | `Override the committer name and email for git commits in this directory. Leave empty to use your user-level settings or account defaults.` | `Override the committer name and email for git commits in this Work. Leave empty to use your user-level settings or account defaults.` | ✅ |
| `…deploy.providerDescription` | `Select a deployment provider to deploy your directory website.` | `Select a deployment provider to deploy your Work's website.` | ✅ |
| `…deploy.tokenDescription` | `To deploy your directory, you need to configure your {provider} API token in Plugin Settings.` | `To deploy your Work, you need to configure your {provider} API token in Plugin Settings.` | ✅ |
| `…deploy.step4` | `Return here to deploy your directory` | `Return here to deploy your Work` | ✅ |
| `…deploy.sharedDescription` | `The directory owner has not configured deployment. Please contact the directory owner to set up deployment.` | `The Work owner has not configured deployment. Please contact the Work owner to set up deployment.` | ✅ |
| `…deploy.repoDescription` | `Deploy your directory website repository.` | `Deploy your Work's website repository.` | ✅ |
| `…deploy.teamDescription` | `Choose the team to deploy this directory to.` | `Choose the team to deploy this Work to.` | ✅ |
| `…deploy.updateInfo` | `Updates sync your directory content to the website repository for the next deployment.` | `Updates sync your Work's content to the website repository for the next deployment.` | ✅ |
| `…deploy.siteNamePlaceholder` | `My Directory` | `My Work` | ✅ |

### 3.11 Settings → Data import/export

| Key | Current | Proposed | Type |
|---|---|---|---|
| `dashboard.settings.data.exportDescription` | `Download your account data including directories, plugin settings, and profile information as a JSON file.` | `Download your account data including works, plugin settings, and profile information as a JSON file.` | ✅ |
| `…importDescription` | `Import data from a previously exported JSON file. You can resolve conflicts for directories with matching slugs.` | `Import data from a previously exported JSON file. You can resolve conflicts for works with matching slugs.` | ✅ |
| `…import.directories` | `Directories` | `Works` | ✅ |
| `…import.existingDirectory` | `Existing` | _(unchanged)_ | — |
| `…import.directoriesCreated` | `Directories created` | `Works created` | ✅ |
| `…import.directoriesUpdated` | `Directories updated` | `Works updated` | ✅ |
| `…import.directoriesSkipped` | `Directories skipped` | `Works skipped` | ✅ |

### 3.12 Settings → Plugins (pipeline / global)

| Key | Current | Proposed | Type |
|---|---|---|---|
| `…pipelinesField.description` | `Choose which pipeline is used by default when generating directory items.` | `Choose which pipeline is used by default when generating items.` | ⚙️ (drop "directory") |
| `…autoDescription` | `Use the system-resolved pipeline for each directory` | `Use the system-resolved pipeline for each Work` | ✅ |
| `…enforceDescription` | `Always pre-select this pipeline, even when a directory has its own pipeline configured. You can still switch pipelines manually in the form.` | `Always pre-select this pipeline, even when a Work has its own pipeline configured. You can still switch pipelines manually in the form.` | ✅ |
| `…github.connected` | `Create and manage directories with GitHub repositories` | `Create and manage works with GitHub repositories` | ✅ |
| `…github.disconnected` | `Connect to create directories from repositories` | `Connect to create works from repositories` | ✅ |

### 3.13 Settings → Notifications

| Key | Current | Proposed | Type |
|---|---|---|---|
| `dashboard.settings.notifications.email.directoryUpdates.label` | `Directory Updates` | `Work Updates` | ✅ |
| `…directoryUpdates.description` | `Get notified about important updates to your directories` | `Get notified about important updates to your works` | ✅ |
| `…newItems.description` | `Get notified when new items are added to your directories` | `Get notified when new items are added to your works` | ✅ |
| `…weeklyDigest.description` | `Receive a weekly summary of your directory activity` | `Receive a weekly summary of your work activity` | ⚠️ ("work activity" reads as "labor activity"; consider **"Receive a weekly summary of activity across your works"**) |
| `…app.newItems.description` | `Show notifications for new directory items` | `Show notifications for new items` | ⚙️ (drop "directory") |
| `…app.comments.description` | `Get notified about comments on your directories` | `Get notified about comments on your works` | ✅ |

### 3.14 Settings → Git Provider

| Key | Current | Proposed | Type |
|---|---|---|---|
| `dashboard.gitProvider.connection.alert.subtitle` | `Connect your {provider} account to create directories` | `Connect your {provider} account to create works` | ✅ |
| `dashboard.gitProvider.settings.subtitle` | `Connect your git provider accounts to import repositories, create directories, and manage your projects.` | `Connect your git provider accounts to import repositories, create works, and manage your projects.` | ✅ |

### 3.15 Settings → Danger Zone

| Key | Current | Proposed | Type |
|---|---|---|---|
| `dashboard.dangerZone.export.subtitle` | `Download all your directories, items, and settings` | `Download all your works, items, and settings` | ✅ |
| `dashboard.dangerZone.delete.confirmItems[1]` | `All your directories` | `All your works` | ✅ |
| `dashboard.dangerZone.delete.confirmItems[2]` | `All directory items and data` | `All Work items and data` | ✅ |

### 3.16 AI Chat

| Key | Current | Proposed | Type |
|---|---|---|---|
| `dashboard.aiChat.subtitle` | `Create directories with natural language` | `Create works with natural language` | ✅ |
| `…welcomeSubtitle` | `Your AI-powered assistant. Ask me anything about creating directories, generating content, or organizing your data.` | `Your AI-powered assistant. Ask me anything about creating works, generating content, or organizing your data.` | ✅ |
| `…welcomeMessage` | `Hi! I can help you create directories using natural language. Ask something like "Create a directory for AI tools" or describe what you need.` | `Hi! I can help you create works using natural language. Ask something like "Create a Work for AI tools" or describe what you need.` | ✅ |
| `…capabilities.directoryCreation` | `Directory Creation` | `Work Creation` | ✅ |
| `…capabilities.directoryCreationDesc` | `Build directories from natural language descriptions` | `Build works from natural language descriptions` | ✅ |
| `…gitNotConnectedDesc` | `Connect your git provider to create and manage directories.` | `Connect your git provider to create and manage works.` | ✅ |
| `…deployNotConfiguredDesc` | `Configure a deployment provider to publish your directory websites.` | `Configure a deployment provider to publish your works' websites.` | ✅ |
| `…suggestions.s1` | `Show my directories` | `Show my works` | ✅ |
| `…suggestions.s2` | `Create a directory of AI tools` | `Build a Work for AI tools` | ⚙️ |
| `…feelingLucky` | `Suggest a directory to create` | `Suggest a Work to build` | ⚙️ |

### 3.17 Plugins (cross-Work plugin behavior)

| Key | Current | Proposed | Type |
|---|---|---|---|
| `dashboard.plugins.enableDescription` | `Configure how this plugin is enabled across your directories.` | `Configure how this plugin is enabled across your works.` | ✅ |
| `…disableWarning` | `Disabling this plugin will also disable it in all your directories` | `Disabling this plugin will also disable it in all your works` | ✅ |
| `…autoEnableForDirectories` | `Also enable for all directories` | `Also enable for all works` | ✅ |
| `…autoEnableForDirectoriesDescription` | `This plugin will be automatically active in all your directories. You can still disable it per directory.` | `This plugin will be automatically active in all your works. You can still disable it per Work.` | ✅ |

### 3.18 Per-Work plugin settings

| Key | Current | Proposed | Type |
|---|---|---|---|
| `dashboard.directoryPlugins.title` | `Directory Plugins` | `Work Plugins` | ✅ |
| `…subtitle` | `Configure plugins for this directory` | `Configure plugins for this Work` | ✅ |
| `…enableForDirectory` | `Enable for this directory` | `Enable for this Work` | ✅ |
| `…disableForDirectory` | `Disable for this directory` | `Disable for this Work` | ✅ |
| `…directorySettingsInfo` | `Configure directory-specific settings here` | `Configure Work-specific settings here` | ✅ |
| `…capabilityProvidersDescription` | `Select which plugin provides each capability for this directory` | `Select which plugin provides each capability for this Work` | ✅ |
| `…settingsModalTitle` | `Directory Settings` | `Work Settings` | ✅ |
| `…settingsModalDescription` | `Override settings for this directory. Unset fields inherit from your user settings.` | `Override settings for this Work. Unset fields inherit from your user settings.` | ✅ |
| `…resetConfirm` | `This will clear all directory-specific overrides. Settings will fall back to your user-level values.` | `This will clear all Work-specific overrides. Settings will fall back to your user-level values.` | ✅ |

### 3.19 Onboarding (Codex / SIM / GitHub provider blocks)

| Key | Current | Proposed | Type |
|---|---|---|---|
| `…codex.description` | `Choose the Codex model you want to run for end-to-end directory generation.` | `Choose the Codex model you want to run for end-to-end Work generation.` | ✅ |
| `…sim.subtitle` | `Add your SIM AI API key and verify the connection to start delegating directory generation to SIM workflows.` | `Add your SIM AI API key and verify the connection to start delegating Work generation to SIM workflows.` | ✅ |
| `…github.description` | `GitHub is required for creating and managing directory repositories. Connect your account to get started.` | `GitHub is required for creating and managing Work repositories. Connect your account to get started.` | ✅ |

### 3.20 Action / validation messages

| Key | Current | Proposed | Type |
|---|---|---|---|
| `actions.directories.createSuccess` | `Directory created successfully!` | `Work created successfully!` | ✅ |
| `actions.directories.createFailed` | `Failed to create directory` | `Failed to create Work` | ✅ |
| `actions.directories.updateSuccess` | `Directory updated successfully!` | `Work updated successfully!` | ✅ |
| `actions.directories.updateFailed` | `Failed to update directory` | `Failed to update Work` | ✅ |
| `actions.directories.invalidGeneratedData` | `Failed to generate valid directory data` | `Failed to generate valid Work data` | ✅ |
| `actions.directories.aiGenerationStarted` | `Directory creation started! AI is generating content...` | `Work created — AI is generating content…` | ⚙️ |
| `actions.directories.invalidId` | `Invalid directory ID` | `Invalid Work ID` | ✅ |
| `actions.directories.deleteSuccess` | `Directory deleted successfully` | `Work deleted successfully` | ✅ |
| `actions.directories.deleteFailed` | `Failed to delete directory` | `Failed to delete Work` | ✅ |
| `actions.directories.fetchFailed` | `Failed to fetch directories` | `Failed to fetch works` | ✅ |
| `actions.directories.import.failed` | `Failed to import directory` | `Failed to import Work` | ✅ |

### 3.21 Outside `en.json` — docs site

| File | Current | Proposed |
|---|---|---|
| `apps/docs/docusaurus.config.ts:40` (tagline) | `Modern Directory Website Solution` | `The Workshop for AI` |
| `apps/docs/docusaurus.config.ts:219` (description) | `Ever Works is an open-source modern directory website solution.` | `Ever Works is an open agentic runtime that autonomously builds content-rich web apps and Git repositories.` |
| `apps/docs/docusaurus.config.ts:263` (footer) | `Modern Directory Website Solution` | `The Workshop for AI` |
| `apps/docs/sidebarsPlatform.ts` | sidebar item IDs reference `creating-a-directory`, `directory-import`, `directory-members`, `directory-changelog`, `directory-commands`, `agent-services/directory-*`, `web-dashboard/directory-pages`, `api/directories` etc. | **Defer** — these are doc-page slugs/URLs, handled in a separate "rename docs" pass alongside renaming the doc files themselves. |

### 3.22 Outside `en.json` — apps/web hardcoded strings

A `grep` of `apps/web/src` for `[Dd]irector(y|ies)` returns **175 files**. Most are code identifiers (variables, types, hook names, component names) and are **not** in scope for this copy map. A separate pass will:

1. Identify which of those 175 files contain hardcoded user-visible strings (vs only identifiers).
2. Replace them according to the rules in §1.

I recommend doing the **i18n strings first** (single file, all 21 locales), then a follow-up pass for any leftover hardcoded UI text.

---

## 4. Out of scope for this document

These are tracked separately and require their own design:

- **Code identifiers**: variable / type / class / file / component / route names (e.g. `DirectoryCard`, `directories.module.ts`, `getDirectoryById`).
- **API routes**: `/api/directories/*` → `/api/works/*` (breaking change).
- **URL paths**: `/dashboard/directories/*` → `/dashboard/works/*` (with redirects).
- **Database**: `directories` table, FK columns (e.g. `directory_id`), indexes — needs migration plan.
- **i18n key paths**: `dashboard.directories.*` → `dashboard.works.*` (Q6).
- **Plugin contracts**: any field in plugin metadata or settings JSON Schema named `directory*`.
- **Translations** (other 20 locales): once English is signed off, translators / LLM batch translation re-derives them.
- **Marketing site / external blog posts / SEO redirects** (if any exist outside this repo).
- **`works-config`** package and `works.yml` filename — these already use "works" naming and are unaffected by this rename.

---

## 5. Next steps

1. **Review this document** — confirm or amend §1 and §2.
2. Once approved, I'll apply the proposed strings to `apps/web/messages/en.json` and the docs config.
3. Run the i18n diff through translation (or LLM) to update the other 20 `messages/*.json` locales.
4. Open the follow-up tasks (key rename, route rename, code rename, DB migration) as separate, independently shippable PRs.
