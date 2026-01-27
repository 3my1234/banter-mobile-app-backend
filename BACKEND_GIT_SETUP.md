# Backend Git Repository Setup

The backend directory needs to be initialized as a git repository and connected to GitHub.

## Setup Steps

1. **Initialize Git Repository** (if not already done):
```bash
cd banter-mobile-app-backend
git init
git branch -M main
```

2. **Add Remote Repository**:
```bash
git remote add origin https://github.com/3my1234/banter-mobile-app-backend.git
```

3. **Add All Files**:
```bash
git add .
```

4. **Commit Changes**:
```bash
git commit -m "feat: Initial backend setup with Docker, Prisma, and API endpoints

- Express/TypeScript backend with Privy authentication
- PostgreSQL database with Prisma ORM
- Movement and Solana wallet support
- Stay/Drop governance engine with BullMQ
- Real-time WebSocket updates
- Balance indexer for ROL, SOL, USDC
- Docker compose with health checks
- Deploy script for VPS
- Complete API endpoints for posts, votes, wallets"
```

5. **Push to GitHub**:
```bash
git push -u origin main
```

## If Repository Already Exists on GitHub

If the repository already has commits, you may need to pull first:

```bash
git pull origin main --allow-unrelated-histories
```

Then add, commit, and push as above.

## Files to Commit

All the following files should be committed:
- `src/` - All source code
- `prisma/` - Database schema and migrations
- `docker-compose.yml` - Docker configuration
- `Dockerfile` - Container build file
- `deploy.sh` - Deployment script
- `wait-for-db.sh` - Database readiness check
- `package.json` - Dependencies
- `tsconfig.json` - TypeScript config
- `README.md` - Documentation
- `DEPLOYMENT_INSTRUCTIONS.md` - Deployment guide
- `.env.example` - Environment template

## After Pushing

Once pushed, you can deploy to VPS using:
```bash
ssh user@62.171.136.64
cd /opt/banter-mobile-app-backend
git pull origin main
./deploy.sh
```
