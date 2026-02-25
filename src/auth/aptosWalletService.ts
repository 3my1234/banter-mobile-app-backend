import { Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk';
import crypto from 'crypto';
import { prisma } from '../index';
import { logger } from '../utils/logger';

const ALGORITHM = 'aes-256-gcm';

const getKey = () => {
  const raw = process.env.APTOS_WALLET_ENCRYPTION_KEY || 'default-key-please-change-in-production-32bytes';
  return crypto.scryptSync(raw, 'salt', 32);
};

const encryptPrivateKey = (privateKey: string) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
};

const decryptPrivateKey = (encrypted: string) => {
  const [ivHex, authHex, data] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

export const getServerMovementAccount = async (userId: string) => {
  const wallet = await prisma.wallet.findFirst({
    where: { userId, blockchain: 'MOVEMENT', encryptedPrivateKey: { not: null } },
  });
  if (!wallet?.encryptedPrivateKey) return null;
  const privateKeyHex = decryptPrivateKey(wallet.encryptedPrivateKey);
  const privateKey = new Ed25519PrivateKey(privateKeyHex);
  return Account.fromPrivateKey({ privateKey });
};

export const ensureServerMovementWallet = async (userId: string) => {
  const existing = await prisma.wallet.findFirst({
    where: { userId, blockchain: 'MOVEMENT', encryptedPrivateKey: { not: null } },
  });
  if (existing) return existing;

  const account = Account.generate();
  const address = account.accountAddress.toString();
  const privateKey = account.privateKey.toString();
  const encryptedPrivateKey = encryptPrivateKey(privateKey);

  logger.info('Generated server-side Movement wallet', { userId, address });

  const wallet = await prisma.wallet.create({
    data: {
      userId,
      address: address.toLowerCase(),
      blockchain: 'MOVEMENT',
      type: 'APTOS_GENERATED',
      walletClient: 'APTOS_SERVER',
      isPrimary: true,
      encryptedPrivateKey,
    },
  });

  await prisma.user.update({
    where: { id: userId },
    data: { movementAddress: wallet.address },
  });

  return wallet;
};
