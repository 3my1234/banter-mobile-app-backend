# Web3Auth Migration Summary

## Overview
The backend has been successfully updated to support the new Web3Auth authentication flow implemented in `banter-v3`. The migration removes Privy dependencies and implements a standard JWT-based authentication system.

## Changes Made

### 1. Database Schema Updates (`prisma/schema.prisma`)
- **Removed fields:**
  - `privyDid` (String, unique)
  - `privyUserId` (String, unique)
  - `name` (String)

- **Added fields:**
  - `displayName` (String, optional)
  - `username` (String, optional, unique)
  - `solanaAddress` (String, optional, unique)
  - `movementAddress` (String, optional, unique)

- **Updated indexes:**
  - Removed `@@index([privyDid])`
  - Added `@@index([username])`

### 2. Migration Files
- Created migration: `prisma/migrations/init-web3auth-users/migration.sql`
- This migration will be applied on the VPS using `npx prisma migrate deploy`

### 3. New Authentication Endpoints

#### POST `/api/auth/check`
- **Purpose:** Check if a user exists by email
- **Request Body:**
  ```json
  {
    "email": "user@example.com"
  }
  ```
- **Response (User exists):**
  ```json
  {
    "exists": true,
    "token": "jwt_token_here"
  }
  ```
- **Response (User does not exist):**
  ```json
  {
    "exists": false
  }
  ```

#### POST `/api/auth/login`
- **Purpose:** Login an existing user
- **Request Body:**
  ```json
  {
    "email": "user@example.com"
  }
  ```
- **Response:**
  ```json
  {
    "token": "jwt_token_here"
  }
  ```

#### POST `/api/auth/register`
- **Purpose:** Register a new user
- **Request Body:**
  ```json
  {
    "email": "user@example.com",
    "displayName": "John Doe",
    "username": "johndoe",
    "solanaAddress": "SolanaWalletAddressHere",
    "movementAddress": "MovementWalletAddressHere"
  }
  ```
- **Response:**
  ```json
  {
    "token": "jwt_token_here"
  }
  ```
- **Validation:**
  - Email is required
  - Solana address is required
  - Movement address is required
  - Username must be unique (if provided)
  - Addresses must be unique

### 4. JWT Authentication System

#### New Files Created:
- `src/auth/jwt.ts` - JWT token generation and verification utilities
- `src/auth/jwtMiddleware.ts` - Express middleware for JWT authentication

#### JWT Configuration:
- Secret: `JWT_SECRET` from environment variables (defaults to `banter-dev-secret-123`)
- Token expiration: 7 days
- Token payload: `{ userId: string, email: string }`

### 5. Updated Endpoints

#### GET `/api/auth/me`
- **Updated to use JWT middleware** instead of Privy
- **Response now includes:**
  - `displayName` instead of `name`
  - `username`
  - `solanaAddress`
  - `movementAddress`
  - Removed `privyDid`

### 6. Protected Routes Updated
All protected routes now use `jwtAuthMiddleware` instead of `privyAuthMiddleware`:
- `/api/wallet/*`
- `/api/posts/*`
- `/api/votes/*`
- `/api/images/*`

### 7. Dependencies Added
- `jsonwebtoken` - For JWT token generation and verification
- `@types/jsonwebtoken` - TypeScript types for jsonwebtoken

## Deployment Steps

### On VPS:
1. Pull the latest changes from GitHub:
   ```bash
   cd /root/banter-mobile-app-backend
   git pull origin main
   ```

2. Apply database migrations:
   ```bash
   npx prisma migrate deploy
   ```

3. Restart the backend service:
   ```bash
   # If using PM2:
   pm2 restart banter-backend
   
   # Or if using Docker:
   docker-compose restart backend
   ```

## Frontend Integration

The frontend (`banter-v3`) should update the `API_BASE_URL` to point to the Contabo VPS backend:
- **Current placeholder:** `https://your-contabo-vps-backend.com`
- **Should be:** `https://sportbanter.online` or `http://62.171.136.64:3001` (depending on your setup)

## Backward Compatibility

- Old Privy endpoints (`/api/auth/sync`) are still available but deprecated
- Old Privy middleware (`privyAuthMiddleware`) is still in the codebase but not used by default
- These can be removed in a future cleanup if not needed

## Testing Checklist

- [ ] Test `/api/auth/check` with existing user email
- [ ] Test `/api/auth/check` with new user email
- [ ] Test `/api/auth/login` with valid email
- [ ] Test `/api/auth/register` with all required fields
- [ ] Test `/api/auth/register` with duplicate email/username/addresses
- [ ] Test `/api/auth/me` with valid JWT token
- [ ] Test protected routes with JWT token
- [ ] Verify database migration applied successfully

## Notes

- All functions use explicit TypeScript typing (no `any` types) as per user preference
- Error handling follows the existing `AppError` pattern
- Logging uses the existing `logger` utility
- The JWT secret should be changed in production (currently using default)
