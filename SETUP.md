# Banter Backend Setup Guide

## Initial Setup

### 1. Install Dependencies

```bash
cd banter-mobile-app-backend
npm install
```

### 2. Configure Environment Variables

Copy `env.example` to `.env` and fill in your values:

```bash
cp env.example .env
```

**Required Variables:**
- `PRIVY_APP_ID` - Your Privy App ID
- `PRIVY_APP_SECRET` - Your Privy App Secret
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_HOST` - Redis host (default: localhost)
- `REDIS_PORT` - Redis port (default: 6379)
- `AWS_ACCESS_KEY_ID` - AWS access key for S3
- `AWS_SECRET_ACCESS_KEY` - AWS secret key
- `S3_BUCKET_NAME` - S3 bucket name for uploads

### 3. Database Setup

#### Option A: Local PostgreSQL

1. Create database:
```sql
CREATE DATABASE banter_db;
```

2. Update `DATABASE_URL` in `.env`:
```
DATABASE_URL=postgresql://user:password@localhost:5432/banter_db
```

3. Run migrations:
```bash
npx prisma migrate dev --name init
```

#### Option B: Remote PostgreSQL (VPS)

1. Connect to your VPS (62.171.136.64):
```bash
ssh user@62.171.136.64
```

2. Create database:
```sql
sudo -u postgres psql
CREATE DATABASE banter_db;
CREATE USER banter_user WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE banter_db TO banter_user;
\q
```

3. Update `DATABASE_URL` in `.env`:
```
DATABASE_URL=postgresql://banter_user:your_secure_password@62.171.136.64:5432/banter_db
```

4. Run migrations:
```bash
npx prisma migrate deploy
```

### 4. Redis Setup

#### Option A: Local Redis

```bash
# Install Redis (Ubuntu/Debian)
sudo apt-get install redis-server

# Start Redis
sudo systemctl start redis-server
```

#### Option B: Docker Redis

```bash
docker run -d -p 6379:6379 redis:7-alpine
```

### 5. Generate Prisma Client

```bash
npx prisma generate
```

### 6. Start Development Server

```bash
npm run dev
```

The server will start on `http://localhost:3001`

## Docker Deployment

### 1. Build and Start Services

```bash
docker-compose up -d
```

### 2. Run Migrations

```bash
docker-compose exec backend npx prisma migrate deploy
```

### 3. View Logs

```bash
docker-compose logs -f backend
```

## Testing the API

### Health Check

```bash
curl http://localhost:3001/health
```

### Test Authentication (after setting up Privy)

```bash
# Sync user (requires Privy token from mobile app)
curl -X POST http://localhost:3001/api/auth/sync \
  -H "Authorization: Bearer YOUR_PRIVY_TOKEN" \
  -H "Content-Type: application/json"
```

## Privy Configuration

1. Go to [Privy Dashboard](https://dashboard.privy.io/)
2. Create or select your app
3. Enable Embedded Wallets
4. Configure login methods (Google + Email OTP)
5. Copy App ID and App Secret to `.env`

## Movement Wallet Setup

The backend expects Movement wallets to be created via Privy on the frontend first. When a user logs in:

1. Frontend creates Movement wallet using `createWallet({ chainType: 'aptos' })`
2. Backend syncs the wallet address from Privy user data
3. Backend indexes balances for $ROL, $SOL, and $USDC

## Solana Wallet Setup

Similar to Movement:
1. Frontend creates Solana wallet using `createWallet({ chainType: 'solana' })`
2. Backend syncs the wallet address from Privy user data
3. Backend indexes SOL and USDC balances

## Troubleshooting

### Database Connection Issues

- Verify PostgreSQL is running: `sudo systemctl status postgresql`
- Check connection string format
- Ensure firewall allows connections on port 5432

### Redis Connection Issues

- Verify Redis is running: `redis-cli ping`
- Check Redis host/port in `.env`
- Ensure firewall allows connections on port 6379

### Privy Authentication Errors

- Verify `PRIVY_APP_ID` and `PRIVY_APP_SECRET` are correct
- Check that embedded wallets are enabled in Privy dashboard
- Ensure the token is from the correct Privy app environment

### Balance Indexing Issues

- Check RPC endpoints are accessible
- Verify token addresses are correct
- Check logs for specific error messages

## Production Deployment

1. Set `NODE_ENV=production` in `.env`
2. Use strong passwords for database and Redis
3. Configure proper CORS origins
4. Set up SSL/TLS (use nginx or similar)
5. Configure log rotation
6. Set up monitoring and alerts
7. Use environment-specific Privy app credentials
