# Deployment Instructions

## VPS Setup (One-time)

1. **SSH into your VPS**:
```bash
ssh user@62.171.136.64
```

2. **Install Docker and Docker Compose**:
```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker
```

3. **Clone the repository**:
```bash
cd /opt
sudo git clone https://github.com/3my1234/banter-mobile-app-backend.git
cd banter-mobile-app-backend
```

4. **Create .env file**:
```bash
cp env.example .env
nano .env
```

Fill in all required variables, especially:
- `PRIVY_APP_ID`
- `PRIVY_APP_SECRET`
- `DATABASE_URL=postgresql://postgres:PHYSICS1234@db:5432/banter_db`
- AWS credentials
- Other service configurations

5. **Make deploy script executable**:
```bash
chmod +x deploy.sh wait-for-db.sh
```

## Deployment Process

### First Deployment

```bash
cd /opt/banter-mobile-app-backend
./deploy.sh
```

### Subsequent Deployments

Just run the deploy script:
```bash
./deploy.sh
```

The script will:
1. Pull latest code from GitHub
2. Build Docker containers
3. Run database migrations
4. Start all services
5. Verify health

## Manual Commands

### View Logs
```bash
docker-compose logs -f app
```

### Restart Services
```bash
docker-compose restart app
```

### Stop Services
```bash
docker-compose down
```

### Run Migrations Manually
```bash
docker-compose exec app npx prisma migrate deploy
```

### Access Database
```bash
docker-compose exec db psql -U postgres -d banter_db
```

## Troubleshooting

### Container Won't Start
Check logs:
```bash
docker-compose logs app
```

### Database Connection Issues
Verify database is running:
```bash
docker-compose ps db
```

### Migration Fails
Try generating Prisma client first:
```bash
docker-compose exec app npx prisma generate
docker-compose exec app npx prisma migrate deploy
```

### Health Check Fails
Check if app is listening on port 3001:
```bash
docker-compose exec app netstat -tuln | grep 3001
```

## Environment Variables

Ensure your `.env` file contains:
- `DATABASE_URL=postgresql://postgres:PHYSICS1234@db:5432/banter_db`
- All Privy credentials
- AWS S3 credentials
- Movement and Solana RPC URLs

## Nginx Configuration (Optional)

If using Nginx as reverse proxy, configure it to point to `http://localhost:3001`.
