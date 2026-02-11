# Ever Works Platform - Claude AI Instructions

You are an AI assistant helping with the **Ever Works Platform**, an open-source directory builder platform built with a modern TypeScript monorepo architecture.

## Project Overview

**Ever Works** is a full-stack platform for building and managing AI-powered directories with automated content generation, deployment, and integrations.

- **Repository**: https://github.com/ever-works/ever-works
- **Documentation**: https://github.com/ever-works/ever-works-docs/tree/develop/website/docs
- **Website**: https://ever.works

### Tech Stack

- **Monorepo**: Turborepo + pnpm workspaces
- **Backend**: NestJS 11 with TypeScript, SQLite/PostgreSQL/MySQL
- **Frontend**: Next.js 16 (App Router) with React 19, Tailwind CSS 4
- **AI**: LangChain with multi-provider support (OpenAI, Anthropic, Google, Mistral, Groq, DeepSeek, Ollama)
- **Build Tools**: SWC (NestJS), Turbopack (Next.js), esbuild (CLI)
- **Package Manager**: pnpm 10.21.0 (required ≥9.9.0)
- **Node.js**: ≥20

## Architecture

### Monorepo Structure

```
ever-works/
├── apps/
│   ├── api/              # NestJS REST API (port 3100)
│   ├── web/              # Next.js web app (port 3000)
│   ├── cli/              # Standalone CLI tool (esbuild)
│   ├── internal-cli/     # Internal CLI (nest-commander)
│   └── admin/            # Admin dashboard (future)
├── packages/
│   ├── agent/            # AI agents, LangChain, Trigger.dev
│   ├── monitoring/       # Sentry + PostHog integration
│   └── cli-shared/       # Shared CLI utilities
└── docs/                 # Documentation
```

### Key Modules

- **Auth**: JWT + OAuth (GitHub, Google), iron-session, email verification
- **Directories**: Core directory management with AI generation
- **AI Conversation**: Chat interface with streaming support
- **Deploy**: Vercel deployment integration
- **Mail**: Multi-provider email (Resend, SendGrid, Mailgun, Faker)
- **Trigger**: Background jobs with Trigger.dev
- **Twenty CRM**: CRM integration

## Code Style & Conventions

### TypeScript

- **Strict mode**: Varies by package (web: strict, api: relaxed)
- **Decorators**: Enabled (NestJS dependency injection)
- **Path aliases**: `@/*` (web), `@src/*` (api/cli), `@packages/*` (shared)
- **Target**: ES2021 (backend), ES2017 (frontend)

### Formatting (Prettier)

- **Print width**: 100 characters
- **Indentation**: 4 spaces (not tabs)
- **Quotes**: Single quotes
- **Semicolons**: Always
- **Trailing commas**: All
- **Arrow parens**: Always
- **Line endings**: LF

### Naming Conventions

- **Files**: kebab-case (e.g., `auth.service.ts`, `user-profile.tsx`)
- **Classes**: PascalCase (e.g., `AuthService`, `UserProfile`)
- **Interfaces/Types**: PascalCase with descriptive names
- **Constants**: UPPER_SNAKE_CASE for true constants
- **Functions/Variables**: camelCase

### NestJS Patterns

- **Modules**: Feature-based organization (auth/, directories/, etc.)
- **Services**: Business logic, injectable with `@Injectable()`
- **Controllers**: Route handlers, use DTOs for validation
- **DTOs**: class-validator decorators for validation
- **Guards**: JWT auth, throttling (global APP_GUARD)
- **Interceptors**: Logging, Sentry, PostHog (global APP_INTERCEPTOR)
- **Decorators**: Custom decorators for common patterns (`@Public()`, `@CurrentUser()`)

### Next.js Patterns

- **App Router**: Use server components by default
- **Client components**: Mark with `'use client'` only when needed
- **Server actions**: In `app/actions/` directory
- **API routes**: Proxy to backend API (see `src/proxy.ts`)
- **Internationalization**: next-intl with locale routing
- **Styling**: Tailwind CSS with utility-first approach
- **Components**: Organized by feature in `src/components/`

## Development Workflow

### Commands

```bash
# Development
pnpm dev              # Start all apps in watch mode
pnpm dev:api          # Start only API
pnpm dev:web          # Start only web app
pnpm dev:trigger      # Start Trigger.dev dev server

# Building
pnpm build            # Build all packages (respects dependencies)
pnpm build --filter=ever-works-api  # Build specific package

# Quality
pnpm lint             # ESLint all packages
pnpm type-check       # TypeScript check all packages
pnpm format           # Prettier format all files
pnpm test             # Run tests (per package)

# Deployment
pnpm deploy:trigger   # Deploy Trigger.dev jobs
```

### Build Order

Turbo automatically handles build dependencies:

1. Shared packages (`@packages/*`) build first
2. Apps build after their dependencies
3. Use `^build` in turbo.json for dependency ordering

### Environment Setup

- Copy `.env.example` to `.env` in each app
- Required for API: `JWT_SECRET`, database config
- Required for Web: `AUTH_SECRET`, `API_URL`
- Optional: AI provider keys, OAuth credentials, email provider

## Testing

### Backend (Jest)

- Unit tests: `*.spec.ts` files next to source
- Run: `pnpm test` in package directory
- Coverage: `pnpm test:cov`
- Watch mode: `pnpm test:watch`

### Frontend

- Testing setup: TBD (recommend Vitest + Testing Library)

## Database

### Supported Databases

- **SQLite**: Development (in-memory or file)
- **PostgreSQL**: Production recommended
- **MySQL**: Production alternative

### TypeORM

- Entities in feature modules
- Migrations: Manual or auto-sync (dev only)
- Configuration in `@ever-works/agent/database`

## AI Integration

### Providers

- Primary: OpenAI (GPT-4, GPT-3.5)
- Alternatives: Anthropic, Google Gemini, Mistral, Groq, DeepSeek
- Local: Ollama (fallback for development)

### LangChain

- Agents in `@ever-works/agent`
- Streaming support for chat
- Context management with LangGraph

## Important Rules

### DO

- ✅ Use pnpm for package management (never npm/yarn)
- ✅ Run `pnpm format` before committing
- ✅ Follow conventional commits (enforced by commitlint)
- ✅ Use dependency injection in NestJS
- ✅ Validate inputs with DTOs and class-validator
- ✅ Handle errors with proper HTTP status codes
- ✅ Use server components in Next.js unless interactivity needed
- ✅ Keep components small and focused
- ✅ Use TypeScript types, avoid `any`
- ✅ Add JSDoc comments for public APIs

### DON'T

- ❌ Don't commit `.env` files (use `.env.example`)
- ❌ Don't use `npm install` or `yarn` (use pnpm)
- ❌ Don't bypass authentication guards without `@Public()`
- ❌ Don't put business logic in controllers
- ❌ Don't use `'use client'` unnecessarily in Next.js
- ❌ Don't hardcode URLs or secrets
- ❌ Don't skip error handling
- ❌ Don't ignore TypeScript errors

## Git Workflow

### Commit Messages

Follow conventional commits:

- `feat: add user profile page`
- `fix: resolve authentication bug`
- `docs: update API documentation`
- `refactor: simplify auth service`
- `test: add unit tests for directories`
- `chore: update dependencies`

### Husky Hooks

- **commit-msg**: Validates commit message format
- Configured in `.husky/commit-msg`

## Deployment

### Vercel (Web App)

- Automatic deployments from GitHub
- Environment variables in Vercel dashboard
- Build command: `pnpm build --filter=ever-works-web`

### API Deployment

- Docker support via `compose.yaml`
- Environment variables required
- Database migrations before deployment

### Trigger.dev

- Background jobs for AI generation
- Deploy: `pnpm deploy:trigger`
- Configure in Trigger.dev dashboard

## Common Tasks

### Adding a New Feature

1. Create feature module in appropriate app
2. Add routes/controllers (API) or pages/components (Web)
3. Create DTOs for validation
4. Add services for business logic
5. Update types and interfaces
6. Add tests
7. Update documentation

### Adding a Dependency

```bash
# Add to specific package
cd apps/api
pnpm add <package>

# Add to workspace root (dev tools only)
pnpm add -D -w <package>
```

### Creating a New Package

1. Create directory in `packages/`
2. Add `package.json` with proper exports
3. Configure TypeScript (`tsconfig.json`)
4. Add to `pnpm-workspace.yaml` (auto-detected)
5. Reference in consuming packages

## Resources

- **Repository**: https://github.com/ever-works/ever-works
- **Documentation**: https://github.com/ever-works/ever-works-docs/tree/develop/website/docs
- **Website**: https://ever.works
- **NestJS Docs**: https://docs.nestjs.com
- **Next.js Docs**: https://nextjs.org/docs
- **Turborepo Docs**: https://turbo.build/repo/docs

## When Helping

1. **Understand context**: Ask about the specific feature/module
2. **Follow patterns**: Match existing code style and architecture
3. **Be explicit**: Provide complete code, not just snippets
4. **Consider dependencies**: Check if changes affect other packages
5. **Suggest tests**: Recommend test cases for new features
6. **Security first**: Always validate inputs and handle auth properly
