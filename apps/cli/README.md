# Ever Works CLI

The command-line interface for Ever Works - Open Directory Builder Platform.

This CLI provides an API-based interface to interact with Ever Works services, allowing you to manage directories, generate content, and deploy websites from the command line.

## Installation

```bash
pnpm install
pnpm run build
```

## Configuration

1. Copy the environment configuration:
```bash
cp .env.example .env
```

2. Edit `.env` to set your API URL:
```bash
API_URL=http://localhost:3000
```

## Authentication

Before using the CLI, you need to authenticate:

```bash
# Login to Ever Works API
node dist/cli.js auth login

# Logout
node dist/cli.js auth logout
```

The CLI will prompt you for:
- API URL (defaults to environment variable)
- API Token

Credentials are stored securely in `$HOME/.ever-works/.credentials.json`.

## Usage

### Directory Management

```bash
# Create a new directory
node dist/cli.js directory create

# List all directories (when API endpoint is available)
node dist/cli.js directory list

# Generate content for a directory
node dist/cli.js directory generate

# Update a directory
node dist/cli.js directory update

# Submit an item to a directory
node dist/cli.js directory submit-item

# Remove an item from a directory
node dist/cli.js directory remove-item

# Regenerate markdown files
node dist/cli.js directory regenerate-markdown

# Update website repository
node dist/cli.js directory update-website

# Deploy website
node dist/cli.js directory deploy

# Delete a directory
node dist/cli.js directory delete
```

### Getting Help

```bash
# General help
node dist/cli.js --help

# Command-specific help
node dist/cli.js auth --help
node dist/cli.js directory --help
node dist/cli.js directory create --help
```

## API Integration

This CLI integrates with the Ever Works API endpoints:

- `POST /directories` - Create directory
- `POST /generate` - Generate content
- `POST /update/:slug` - Update directory
- `POST /submit-item/:slug` - Submit item
- `POST /remove-item/:slug` - Remove item
- `POST /regenerate-markdown/:slug` - Regenerate markdown
- `POST /update-website/:slug` - Update website
- `POST /deploy/:slug/vercel` - Deploy to Vercel
- `POST /delete/:slug` - Delete directory

## Features

- **Authentication Management**: Secure token-based authentication
- **Interactive Prompts**: User-friendly prompts for all operations
- **Error Handling**: Comprehensive error handling with helpful messages
- **Progress Indicators**: Visual feedback for long-running operations
- **Environment Configuration**: Flexible configuration via environment variables
- **API Integration**: Direct integration with Ever Works API endpoints

## Development

```bash
# Install dependencies
pnpm install

# Build the CLI
pnpm run build

# Test the CLI
node dist/cli.js --help
```

## Architecture

The CLI is built using:
- **Commander.js**: Command-line interface framework
- **Axios**: HTTP client for API calls
- **Inquirer**: Interactive command-line prompts
- **Chalk**: Terminal styling
- **Ora**: Progress spinners
- **fs-extra**: Enhanced file system operations
- **dotenv**: Environment variable loading

## Notes

- This CLI calls API endpoints instead of using local services
- Authentication tokens are stored locally for convenience
- Some features (like directory listing) may require additional API endpoints
- The CLI mirrors the functionality of the internal CLI but uses HTTP calls

For more information, visit: https://ever.works
