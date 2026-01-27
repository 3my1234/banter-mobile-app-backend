# Banter Backend Deployment Guide

## Domain Configuration

**Domain**: `sportbanter.online`  
**VPS IP**: `62.171.136.64`  
**DNS Records**: 
- A Record: `@` → `62.171.136.64`
- A Record: `www` → `62.171.136.64`

## VPS Setup (Contabo Ubuntu 24.04)

### 1. Initial Server Setup

```bash
# SSH into your VPS
ssh user@62.171.136.64

# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker and Docker Compose
sudo apt install -y docker.io docker-compose-plugin

# Add user to docker group (if needed)
sudo usermod -aG docker $USER
newgrp docker

# Install Node.js 20 (if running without Docker)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Clone Repository

```bash
cd /opt
sudo git clone <your-repo-url> banter-backend
cd banter-backend/banter-mobile-app-backend
```

### 3. Configure Environment

```bash
# Copy environment file
cp env.example .env

# Edit .env with production values
nano .env
```

**Required Production Variables:**
```env
NODE_ENV=production
PORT=3001
DOMAIN=sportbanter.online
API_URL=https://sportbanter.online
FRONTEND_URL=https://your-mobile-app-domain.com

# Database (use remote PostgreSQL or Docker)
DATABASE_URL=postgresql://banter_user:secure_password@localhost:5432/banter_db

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Privy
PRIVY_APP_ID=your_production_privy_app_id
PRIVY_APP_SECRET=your_production_privy_app_secret

# AWS S3
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_aws_key
AWS_SECRET_ACCESS_KEY=your_aws_secret
S3_BUCKET_NAME=banter-uploads

# Movement & Solana
MOVEMENT_TESTNET_RPC=https://testnet.movementnetwork.xyz/v1
MOVEMENT_ROL_ADDRESS=your_rol_token_address
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

### 4. Database Setup

#### Option A: Docker PostgreSQL (Recommended)

The `docker-compose.yml` includes PostgreSQL. Just start it:

```bash
docker-compose up -d postgres redis
```

#### Option B: Remote PostgreSQL

If using a separate PostgreSQL instance:

```bash
# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Create database
sudo -u postgres psql
CREATE DATABASE banter_db;
CREATE USER banter_user WITH PASSWORD 'secure_password';
GRANT ALL PRIVILEGES ON DATABASE banter_db TO banter_user;
\q
```

### 5. Run Migrations

```bash
# Generate Prisma Client
npx prisma generate

# Run migrations
npx prisma migrate deploy
```

### 6. Deploy with Docker

```bash
# Build and start all services
docker-compose up -d --build

# View logs
docker-compose logs -f backend

# Check status
docker-compose ps
```

### 7. Nginx Reverse Proxy Setup

Install and configure Nginx for SSL/TLS:

```bash
# Install Nginx
sudo apt install -y nginx certbot python3-certbot-nginx

# Create Nginx config
sudo nano /etc/nginx/sites-available/sportbanter.online
```

**Nginx Configuration:**
```nginx
server {
    listen 80;
    server_name sportbanter.online www.sportbanter.online;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/sportbanter.online /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx

# Get SSL certificate
sudo certbot --nginx -d sportbanter.online -d www.sportbanter.online
```

### 8. Firewall Configuration

```bash
# Allow SSH, HTTP, HTTPS
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Enable firewall
sudo ufw enable

# Check status
sudo ufw status
```

### 9. Systemd Service (Optional - if not using Docker)

Create a systemd service for the backend:

```bash
sudo nano /etc/systemd/system/banter-backend.service
```

```ini
[Unit]
Description=Banter Backend API
After=network.target postgresql.service redis.service

[Service]
Type=simple
User=your_user
WorkingDirectory=/opt/banter-backend/banter-mobile-app-backend
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start service
sudo systemctl enable banter-backend
sudo systemctl start banter-backend
sudo systemctl status banter-backend
```

## Monitoring

### View Logs

```bash
# Docker logs
docker-compose logs -f backend

# Systemd logs
sudo journalctl -u banter-backend -f
```

### Health Check

```bash
# Check API health
curl https://sportbanter.online/health

# Expected response:
# {"status":"ok","timestamp":"2026-01-27T..."}
```

### Database Backup

```bash
# Backup database
docker-compose exec postgres pg_dump -U banter_user banter_db > backup_$(date +%Y%m%d).sql

# Or if using remote PostgreSQL
pg_dump -h localhost -U banter_user banter_db > backup_$(date +%Y%m%d).sql
```

## Troubleshooting

### Port Already in Use

```bash
# Check what's using port 3001
sudo lsof -i :3001

# Kill process if needed
sudo kill -9 <PID>
```

### Database Connection Issues

```bash
# Test PostgreSQL connection
psql -h localhost -U banter_user -d banter_db

# Check PostgreSQL status
sudo systemctl status postgresql
```

### Redis Connection Issues

```bash
# Test Redis connection
redis-cli ping

# Check Redis status
sudo systemctl status redis
```

### SSL Certificate Renewal

Certbot certificates auto-renew, but you can manually renew:

```bash
sudo certbot renew
```

## Updates and Maintenance

### Update Backend Code

```bash
cd /opt/banter-backend/banter-mobile-app-backend
git pull
docker-compose up -d --build
```

### Run New Migrations

```bash
docker-compose exec backend npx prisma migrate deploy
```

### Restart Services

```bash
# Restart all services
docker-compose restart

# Restart specific service
docker-compose restart backend
```

## Security Checklist

- [ ] Use strong passwords for database and Redis
- [ ] Enable firewall (UFW)
- [ ] Configure SSL/TLS with Let's Encrypt
- [ ] Set proper CORS origins (not `*` in production)
- [ ] Use environment variables for secrets (never commit `.env`)
- [ ] Regularly update system packages
- [ ] Monitor logs for suspicious activity
- [ ] Set up automated backups
- [ ] Use production Privy app credentials
- [ ] Configure rate limiting (consider adding express-rate-limit)

## API Endpoints

Once deployed, your API will be available at:

- **Base URL**: `https://sportbanter.online`
- **Health Check**: `https://sportbanter.online/health`
- **API Routes**: `https://sportbanter.online/api/*`

Update your mobile app's API base URL to `https://sportbanter.online`.
