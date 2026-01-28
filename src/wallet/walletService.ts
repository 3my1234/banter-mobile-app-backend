import { Blockchain } from '@prisma/client';
import { logger } from '../utils/logger';
import { PrivyUser } from '../auth/privyAuth';
import { prisma } from '../index';

/**
 * Create Movement wallet for user (idempotent)
 * Checks database first, only creates if missing
 */
export async function createMovementWallet(
  userId: string,
  privyUser: PrivyUser
): Promise<{ id: string; address: string }> {
  try {
    // Check if Movement wallet already exists
    const existingWallet = await prisma.wallet.findFirst({
      where: {
        userId,
        blockchain: Blockchain.MOVEMENT,
      },
    });

    if (existingWallet) {
      logger.info(`Movement wallet already exists for user ${userId}: ${existingWallet.address}`);
      return {
        id: existingWallet.id,
        address: existingWallet.address,
      };
    }

    // Find Movement wallet in Privy user's linked accounts
    // Movement wallets are identified by chainType: 'aptos'
    const movementAccount = (privyUser as any).linkedAccounts?.find(
      (account: any) => account.type === 'wallet' && account.chainType === 'aptos'
    );

    if (!movementAccount || !movementAccount.address) {
      logger.warn(`No Movement wallet found in Privy user ${userId}. User needs to create wallet via frontend.`);
      throw new Error('Movement wallet not found in Privy account. Please create wallet via frontend first.');
    }

    // Create wallet in database
    const wallet = await prisma.wallet.create({
      data: {
        userId,
        privyWalletId: movementAccount.id,
        address: movementAccount.address.toLowerCase(),
        blockchain: Blockchain.MOVEMENT,
        type: 'PRIVY_EMBEDDED',
        walletClient: 'APTOS_EMBEDDED',
        isPrimary: true, // First wallet is primary
      },
    });

    logger.info(`Created Movement wallet for user ${userId}: ${wallet.address}`);
    return {
      id: wallet.id,
      address: wallet.address,
    };
  } catch (error) {
    logger.error(`Failed to create Movement wallet for user ${userId}`, { error });
    throw error;
  }
}

/**
 * Create Solana wallet for user (idempotent)
 * Checks database first, only creates if missing
 */
export async function createSolanaWallet(
  userId: string,
  privyUser: PrivyUser
): Promise<{ id: string; address: string }> {
  try {
    // Check if Solana wallet already exists
    const existingWallet = await prisma.wallet.findFirst({
      where: {
        userId,
        blockchain: Blockchain.SOLANA,
      },
    });

    if (existingWallet) {
      logger.info(`Solana wallet already exists for user ${userId}: ${existingWallet.address}`);
      return {
        id: existingWallet.id,
        address: existingWallet.address,
      };
    }

    // Find Solana wallet in Privy user's linked accounts
    // Solana wallets are identified by chainType: 'solana'
    const solanaAccount = (privyUser as any).linkedAccounts?.find(
      (account: any) => account.type === 'wallet' && account.chainType === 'solana'
    );

    if (!solanaAccount || !solanaAccount.address) {
      logger.warn(`No Solana wallet found in Privy user ${userId}. User needs to create wallet via frontend.`);
      throw new Error('Solana wallet not found in Privy account. Please create wallet via frontend first.');
    }

    // Create wallet in database
    const wallet = await prisma.wallet.create({
      data: {
        userId,
        privyWalletId: solanaAccount.id,
        address: solanaAccount.address,
        blockchain: Blockchain.SOLANA,
        type: 'PRIVY_EMBEDDED',
        walletClient: 'SOLANA_EMBEDDED',
        isPrimary: false, // Movement is primary
      },
    });

    logger.info(`Created Solana wallet for user ${userId}: ${wallet.address}`);
    return {
      id: wallet.id,
      address: wallet.address,
    };
  } catch (error) {
    logger.error(`Failed to create Solana wallet for user ${userId}`, { error });
    throw error;
  }
}
