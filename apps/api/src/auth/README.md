# Authentication Module

This module provides secure authentication for the Ever Works API with support for:
- Local authentication (email/password)
- OAuth2 authentication (GitHub, Google)
- JWT-based session management
- Refresh tokens
- Rate limiting
- Security headers (Helmet)

## Endpoints

### Authentication
- `POST /auth/register` - Register new user
- `POST /auth/login` - Login with email/password
- `POST /auth/refresh` - Refresh access token
- `POST /auth/logout` - Logout and invalidate refresh token
- `GET /auth/profile` - Get current user profile (requires auth)
- `POST /auth/update-password` - Update password (requires auth)

### OAuth
- `GET /auth/github` - Initiate GitHub OAuth flow
- `GET /auth/github/callback` - GitHub OAuth callback
- `GET /auth/google` - Initiate Google OAuth flow  
- `GET /auth/google/callback` - Google OAuth callback

## Security Features

1. **Password Requirements**
   - Minimum 8 characters
   - At least 1 uppercase letter
   - At least 1 lowercase letter
   - At least 1 number or special character

2. **JWT Tokens**
   - Access tokens expire in 15 minutes
   - Refresh tokens expire in 7 days
   - Tokens are signed with JWT_SECRET

3. **Rate Limiting**
   - Short: 3 requests per second
   - Medium: 20 requests per 10 seconds
   - Long: 100 requests per minute

4. **Security Headers**
   - Helmet.js for security headers
   - CORS configured for allowed origins

## Environment Variables

```bash
# JWT
JWT_SECRET=your-secret-key

# OAuth - GitHub
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
GITHUB_CALLBACK_URL=http://localhost:3100/auth/github/callback

# OAuth - Google  
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3100/auth/google/callback

# CORS
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001

# API
PORT=3100
```

## Usage Examples

### Register
```bash
curl -X POST http://localhost:3100/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "email": "test@example.com",
    "password": "Test123!"
  }'
```

### Login
```bash
curl -X POST http://localhost:3100/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Test123!"
  }'
```

### Protected Routes
```bash
curl -X GET http://localhost:3100/auth/profile \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

## Guards

- `@UseGuards(JwtAuthGuard)` - Protect routes requiring authentication
- `@Public()` - Mark routes as public (no auth required)
- `@UseGuards(LocalAuthGuard)` - For login endpoint validation