# GitHub Copilot Instructions - Ever Works Platform

## Project Context

### Canonical Rules

For the full, always up-to-date project guide, see [`CLAUDE.md`](../CLAUDE.md). This Copilot file only provides lightweight hints and examples.

You're working on **Ever Works**, an open-source directory builder platform with AI-powered content generation.

- **Repository**: https://github.com/ever-works/ever-works
- **Documentation**: https://github.com/ever-works/ever-works-docs/tree/develop/website/docs

### Quick Facts

- **Monorepo**: Turborepo + pnpm workspaces
- **Backend**: NestJS 11 + TypeScript
- **Frontend**: Next.js 16 (App Router) + React 19
- **AI**: LangChain with multi-provider support
- **Package Manager**: pnpm (never npm/yarn)
- **Node.js**: ≥20 required

## Code Style

### Formatting

- **Indentation**: 4 spaces
- **Quotes**: Single quotes
- **Semicolons**: Always
- **Line length**: 100 characters max
- **Trailing commas**: Always

### Naming

- **Files**: kebab-case (`auth.service.ts`, `user-profile.tsx`)
- **Classes**: PascalCase (`AuthService`, `UserProfile`)
- **Functions/Variables**: camelCase
- **Constants**: UPPER_SNAKE_CASE
- **Interfaces/Types**: PascalCase

## NestJS Patterns

### Controllers

```typescript
@Controller('api/feature')
export class FeatureController {
	constructor(private readonly service: FeatureService) {}

	@Get()
	@Public() // Skip auth if needed
	async findAll(): Promise<FeatureDto[]> {
		return this.service.findAll();
	}

	@Post()
	async create(@Body() dto: CreateFeatureDto): Promise<FeatureDto> {
		return this.service.create(dto);
	}
}
```

### Services

```typescript
@Injectable()
export class FeatureService {
	constructor(
		@InjectRepository(Entity) private repo: Repository<Entity>,
		private readonly dependency: DependencyService
	) {}

	async findAll(): Promise<Entity[]> {
		return this.repo.find();
	}
}
```

### DTOs

```typescript
import { IsString, IsEmail, IsOptional, MinLength } from 'class-validator';

export class CreateUserDto {
	@IsEmail()
	email: string;

	@IsString()
	@MinLength(8)
	password: string;

	@IsString()
	@IsOptional()
	name?: string;
}
```

### Modules

```typescript
@Module({
	imports: [TypeOrmModule.forFeature([Entity]), DependencyModule],
	controllers: [FeatureController],
	providers: [FeatureService],
	exports: [FeatureService]
})
export class FeatureModule {}
```

## Next.js Patterns

### Server Components (Default)

```typescript
// app/[locale]/feature/page.tsx
import { getFeatures } from '@/lib/api/features';

export default async function FeaturePage() {
    const features = await getFeatures();

    return (
        <div>
            {features.map((feature) => (
                <FeatureCard key={feature.id} feature={feature} />
            ))}
        </div>
    );
}
```

### Client Components

```typescript
'use client';

import { useState } from 'react';

export function InteractiveComponent() {
    const [state, setState] = useState('');

    return <input value={state} onChange={(e) => setState(e.target.value)} />;
}
```

### Server Actions

```typescript
'use server';

import { revalidatePath } from 'next/cache';

export async function createFeature(formData: FormData) {
	const name = formData.get('name') as string;

	// Call API
	await fetch(`${process.env.API_URL}/api/features`, {
		method: 'POST',
		body: JSON.stringify({ name })
	});

	revalidatePath('/features');
}
```

## TypeScript Patterns

### Interfaces

```typescript
interface User {
	id: string;
	email: string;
	name?: string;
	createdAt: Date;
}
```

### Types

```typescript
type Status = 'active' | 'inactive' | 'pending';
type Result<T> = { success: true; data: T } | { success: false; error: string };
```

### Generics

```typescript
async function fetchData<T>(url: string): Promise<T> {
	const response = await fetch(url);
	return response.json();
}
```

## Database (TypeORM)

### Entities

```typescript
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('users')
export class User {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ unique: true })
	email: string;

	@Column()
	name: string;

	@CreateDateColumn()
	createdAt: Date;
}
```

### Repositories

```typescript
// In service
const users = await this.userRepo.find({ where: { active: true } });
const user = await this.userRepo.findOne({ where: { id } });
await this.userRepo.save(user);
await this.userRepo.delete(id);
```

## Common Patterns

### Error Handling (NestJS)

```typescript
import { BadRequestException, NotFoundException } from '@nestjs/common';

if (!user) {
	throw new NotFoundException('User not found');
}

if (!isValid) {
	throw new BadRequestException('Invalid input');
}
```

### Async/Await

```typescript
// Always use async/await
async function getData() {
	const result = await service.fetch();
	return result;
}

// Not .then()
```

### Environment Variables

```typescript
// NestJS
process.env.DATABASE_URL;

// Next.js (client-side)
process.env.NEXT_PUBLIC_API_URL;
```

## Project Structure

### Backend (apps/api)

```
src/
├── auth/              # Authentication
├── directories/       # Core feature
├── ai-conversation/   # AI chat
├── mail/              # Email service
└── integrations/      # External APIs
```

### Frontend (apps/web)

```
src/
├── app/               # Pages & layouts
├── components/        # React components
├── lib/               # Utilities & API
└── i18n/              # Translations
```

### Packages

```
packages/
├── agent/             # AI & background jobs
├── monitoring/        # Sentry + PostHog
└── cli-shared/        # CLI utilities
```

## Commands

```bash
# Development
pnpm dev              # All apps
pnpm dev:api          # API only
pnpm dev:web          # Web only

# Build
pnpm build

# Quality
pnpm lint
pnpm format
pnpm type-check
```

## Best Practices

### DO ✅

- Use pnpm for package management
- Validate inputs with DTOs
- Use dependency injection
- Prefer server components
- Handle errors properly
- Use TypeScript types
- Format before committing

### DON'T ❌

- Don't use npm/yarn
- Don't commit .env files
- Don't bypass auth guards
- Don't use 'any' type
- Don't put logic in controllers
- Don't hardcode secrets
- Don't ignore TS errors

## Path Aliases

- **Web**: `@/*` → `src/*`
- **API**: `@src/*` → `src/*`
- **Packages**: `@packages/*` → `../packages/*/src`

## Testing

```typescript
describe('FeatureService', () => {
	let service: FeatureService;

	beforeEach(async () => {
		const module = await Test.createTestingModule({
			providers: [FeatureService]
		}).compile();

		service = module.get<FeatureService>(FeatureService);
	});

	it('should be defined', () => {
		expect(service).toBeDefined();
	});
});
```

## Commit Messages

Follow conventional commits:

- `feat: add user profile page`
- `fix: resolve auth bug`
- `docs: update README`
- `refactor: simplify service`
- `test: add unit tests`
- `chore: update deps`
