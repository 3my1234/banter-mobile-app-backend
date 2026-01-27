#!/bin/bash

# Banter Backend Deployment Script
# Run this script on your VPS to deploy the latest code

set -e

echo "🚀 Starting Banter Backend Deployment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -f "docker-compose.yml" ]; then
    echo -e "${RED}❌ Error: docker-compose.yml not found. Are you in the backend directory?${NC}"
    exit 1
fi

# Pull latest code
echo -e "${YELLOW}📥 Pulling latest code from GitHub...${NC}"
git pull origin main || git pull origin master

# Check if .env exists
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}⚠️  Warning: .env file not found. Make sure to create it with required variables.${NC}"
fi

# Build and restart Docker containers
echo -e "${YELLOW}🐳 Building and starting Docker containers...${NC}"
docker-compose down
docker-compose build --no-cache
docker-compose up -d

# Wait for database to be ready
echo -e "${YELLOW}⏳ Waiting for database to be ready...${NC}"
sleep 10

# Run Prisma migrations
echo -e "${YELLOW}📊 Running database migrations...${NC}"
docker-compose exec -T app npx prisma migrate deploy || {
    echo -e "${RED}❌ Migration failed. Trying to generate Prisma client first...${NC}"
    docker-compose exec -T app npx prisma generate
    docker-compose exec -T app npx prisma migrate deploy
}

# Check if migrations succeeded
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Migrations completed successfully${NC}"
else
    echo -e "${RED}❌ Migration failed. Please check the logs.${NC}"
    exit 1
fi

# Check container status
echo -e "${YELLOW}📋 Checking container status...${NC}"
docker-compose ps

# Test health endpoint
echo -e "${YELLOW}🏥 Testing health endpoint...${NC}"
sleep 5
if curl -f http://localhost:3001/health > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Backend is healthy and running!${NC}"
else
    echo -e "${YELLOW}⚠️  Health check failed. Check logs with: docker-compose logs app${NC}"
fi

echo -e "${GREEN}🎉 Deployment complete!${NC}"
echo -e "${GREEN}📝 View logs with: docker-compose logs -f app${NC}"
