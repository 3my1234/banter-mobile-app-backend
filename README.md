# Banter Mobile App Backend

Backend API for Banter - a mobile social governance app built with React Native (Expo).

## Features

- **Privy Authentication**: Google + Email OTP authentication with Privy DID as primary key
- **Movement & Solana Wallets**: Idempotent wallet creation with balance indexing
- **Stay/Drop Governance**: 24-hour post expiration with BullMQ and Redis
- **Real-time Updates**: WebSocket support for live voting gauge updates
- **Image Uploads**: S3 presigned URLs for profile pictures and post images
- **Balance Tracking**: Indexed balances for $ROL, $SOL, and $USDC

## Tech Stack

- **Runtime**: Node.js 20
- **Framework**: Express.js with TypeScript
- **Database**: PostgreSQL with Prisma ORM
- **Queue**: BullMQ with Redis
- **WebSocket**: Socket.IO
- **Storage**: AWS S3

## Setup

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Redis 7+
- Docker & Docker Compose (optional)

### Local Development

1. **Install dependencies**:
```bash
npm install
```

2. **Set up environment variables**:
```bash
cp env.example .env
# Edit .env with your configuration
```

3. **Set up database**:
```bash
# Run migrations
npx prisma migrate dev

# Generate Prisma Client
npx prisma generate
```

4. **Start development server**:
```bash
npm run dev
```

### Docker Deployment

1. **Build and start services**:
```bash
docker-compose up -d
```

2. **Run database migrations**:
```bash
docker-compose exec backend npx prisma migrate deploy
```

3. **View logs**:
```bash
docker-compose logs -f backend
```

## API Endpoints

### Authentication
- `POST /api/auth/sync` - Sync user from Privy and create wallets
- `GET /api/auth/me` - Get current authenticated user

### Wallets
- `GET /api/wallet/balances` - Get all wallet balances
- `POST /api/wallet/sync/:walletId` - Manually sync wallet balance

### Posts
- `POST /api/posts` - Create a new post
- `GET /api/posts` - Get all active posts (paginated)
- `GET /api/posts/:id` - Get a specific post

### Votes
- `POST /api/votes` - Cast a Stay or Drop vote
- `GET /api/votes/post/:postId` - Get all votes for a post

### Images
- `POST /api/images/presign` - Generate presigned S3 upload URL
- `POST /api/images/save-profile-picture` - Save profile picture URL

## Database Schema

### Key Models

- **User**: Primary key is `privyDid` for cross-app compatibility with Rolley
- **Wallet**: Supports Movement and Solana blockchains
- **Post**: 24-hour expiration with Stay/Drop voting
- **Vote**: One vote per user per post
- **WalletBalance**: Indexed token balances
- **WalletTransaction**: Transaction history

## Stay/Drop Governance Engine

Posts expire after 24 hours. At expiration:
- If `dropVotes >= stayVotes`: Post is hidden
- If `stayVotes > dropVotes`: Post stays active

The system uses BullMQ to schedule expiration checks at the 24-hour mark.

## Real-time Updates

WebSocket events:
- `vote-update`: Emitted when a vote is cast
- `post-hidden`: Emitted when a post is hidden
- `post-stays`: Emitted when a post stays active

## Environment Variables

See `env.example` for all required environment variables.

## Deployment

The backend is designed to run on a Contabo VPS (Ubuntu 24.04) at `62.171.136.64`.

**Domain**: `sportbanter.online`

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed deployment instructions.

Update the `DATABASE_URL` in your `.env` file to point to your PostgreSQL instance.

## License

MIT
