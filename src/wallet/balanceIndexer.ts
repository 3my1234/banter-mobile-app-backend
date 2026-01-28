import { prisma } from '../index';
import { logger } from '../utils/logger';
import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';

// Movement Network Configuration
const MOVEMENT_TESTNET_RPC = process.env.MOVEMENT_TESTNET_RPC || 'https://testnet.movementnetwork.xyz/v1';
const MOVEMENT_USDC_ADDRESS = process.env.MOVEMENT_USDC_ADDRESS || '0xb89077cfd2a82a0c1450534d49cfd5f2707643155273069bc23a912bcfefdee7';
const MOVEMENT_ROL_ADDRESS = process.env.MOVEMENT_ROL_ADDRESS || '';

// Solana Configuration
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const SOLANA_USDC_MINT = process.env.SOLANA_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Get Movement wallet balance from blockchain
 */
async function getMovementBalance(
  walletAddress: string,
  tokenAddress?: string
): Promise<{
  balance: string;
  tokenAddress: string;
  tokenSymbol: string;
  decimals: number;
}> {
  const tokenAddr = tokenAddress || MOVEMENT_USDC_ADDRESS;
  const isFungibleAsset = !tokenAddr.includes('::');

  try {
    if (isFungibleAsset) {
      // Fungible Asset (USDC.e)
      const response = await axios.post(
        `${MOVEMENT_TESTNET_RPC}/view`,
        {
          function: '0x1::primary_fungible_store::balance',
          type_arguments: ['0x1::fungible_asset::Metadata'],
          arguments: [walletAddress, tokenAddr],
        },
        { timeout: 10000 }
      );

      const balance = response.data[0] || '0';
      const isUSDC = tokenAddr.toLowerCase() === MOVEMENT_USDC_ADDRESS.toLowerCase();

      return {
        balance: balance.toString(),
        tokenAddress: tokenAddr,
        tokenSymbol: isUSDC ? 'USDC.e' : 'FA',
        decimals: isUSDC ? 6 : 8,
      };
    } else {
      // Native MOVE token
      const response = await axios.get(
        `${MOVEMENT_TESTNET_RPC}/accounts/${walletAddress}/resources`,
        { timeout: 10000 }
      );

      const resources = response.data || [];
      const coinStore = resources.find(
        (r: { type?: string }) =>
          r.type?.includes('coin::CoinStore') &&
          (tokenAddr === '0x1::aptos_coin::AptosCoin' || r.type?.includes(tokenAddr))
      );

      if (!coinStore) {
        return {
          balance: '0',
          tokenAddress: tokenAddr,
          tokenSymbol: 'MOVE',
          decimals: 8,
        };
      }

      const balanceValue = coinStore.data?.coin?.value || '0';
      return {
        balance: balanceValue.toString(),
        tokenAddress: tokenAddr,
        tokenSymbol: 'MOVE',
        decimals: 8,
      };
    }
  } catch (error) {
    logger.error(`Failed to get Movement balance for ${walletAddress}`, { error });
    throw error;
  }
}

/**
 * Get Solana wallet balance
 */
async function getSolanaBalance(
  walletAddress: string,
  tokenMint?: string
): Promise<{
  balance: string;
  tokenAddress: string;
  tokenSymbol: string;
  decimals: number;
}> {
  try {
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
    const publicKey = new PublicKey(walletAddress);

    if (!tokenMint || tokenMint === 'SOL') {
      // Native SOL balance
      const balance = await connection.getBalance(publicKey);
      return {
        balance: balance.toString(),
        tokenAddress: 'SOL',
        tokenSymbol: 'SOL',
        decimals: 9,
      };
    } else {
      // SPL Token balance (USDC)
      const mintPublicKey = new PublicKey(tokenMint);
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
        mint: mintPublicKey,
      });

      if (tokenAccounts.value.length === 0) {
        return {
          balance: '0',
          tokenAddress: tokenMint,
          tokenSymbol: 'USDC',
          decimals: 6,
        };
      }

      const tokenAccount = tokenAccounts.value[0];
      const balance = tokenAccount.account.data.parsed.info.tokenAmount.amount;
      return {
        balance: balance.toString(),
        tokenAddress: tokenMint,
        tokenSymbol: 'USDC',
        decimals: 6,
      };
    }
  } catch (error) {
    logger.error(`Failed to get Solana balance for ${walletAddress}`, { error });
    throw error;
  }
}

/**
 * Sync Movement wallet balance to database
 */
export async function syncMovementBalance(
  walletId: string,
  walletAddress: string
): Promise<void> {
  try {
    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet || wallet.blockchain !== 'MOVEMENT') {
      throw new Error('Invalid Movement wallet');
    }

    // Sync native MOVE token
    const moveBalance = await getMovementBalance(walletAddress, '0x1::aptos_coin::AptosCoin');
    await prisma.walletBalance.upsert({
      where: {
        walletId_tokenAddress: {
          walletId,
          tokenAddress: moveBalance.tokenAddress,
        },
      },
      create: {
        walletId,
        tokenAddress: moveBalance.tokenAddress,
        tokenSymbol: 'MOVE',
        tokenName: 'Movement Network Token',
        decimals: moveBalance.decimals,
        balance: moveBalance.balance,
        lastUpdated: new Date(),
      },
      update: {
        balance: moveBalance.balance,
        lastUpdated: new Date(),
      },
    });

    // Sync USDC.e
    const usdcBalance = await getMovementBalance(walletAddress, MOVEMENT_USDC_ADDRESS);
    await prisma.walletBalance.upsert({
      where: {
        walletId_tokenAddress: {
          walletId,
          tokenAddress: usdcBalance.tokenAddress,
        },
      },
      create: {
        walletId,
        tokenAddress: usdcBalance.tokenAddress,
        tokenSymbol: 'USDC.e',
        tokenName: 'USDC.e (Fungible Asset)',
        decimals: usdcBalance.decimals,
        balance: usdcBalance.balance,
        lastUpdated: new Date(),
      },
      update: {
        balance: usdcBalance.balance,
        lastUpdated: new Date(),
      },
    });

    // Sync ROL token if address is configured
    if (MOVEMENT_ROL_ADDRESS) {
      try {
        const rolBalance = await getMovementBalance(walletAddress, MOVEMENT_ROL_ADDRESS);
        await prisma.walletBalance.upsert({
          where: {
            walletId_tokenAddress: {
              walletId,
              tokenAddress: rolBalance.tokenAddress,
            },
          },
          create: {
            walletId,
            tokenAddress: rolBalance.tokenAddress,
            tokenSymbol: 'ROL',
            tokenName: 'Rolley Token',
            decimals: rolBalance.decimals,
            balance: rolBalance.balance,
            lastUpdated: new Date(),
          },
          update: {
            balance: rolBalance.balance,
            lastUpdated: new Date(),
          },
        });
      } catch (error) {
        logger.warn(`Failed to sync ROL balance for wallet ${walletId}`, { error });
      }
    }

    logger.info(`Synced Movement balances for wallet ${walletAddress}`);
  } catch (error) {
    logger.error(`Failed to sync Movement balance for wallet ${walletId}`, { error });
    throw error;
  }
}

/**
 * Sync Solana wallet balance to database
 */
export async function syncSolanaBalance(
  walletId: string,
  walletAddress: string
): Promise<void> {
  try {
    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
    });

    if (!wallet || wallet.blockchain !== 'SOLANA') {
      throw new Error('Invalid Solana wallet');
    }

    // Sync native SOL
    const solBalance = await getSolanaBalance(walletAddress, 'SOL');
    await prisma.walletBalance.upsert({
      where: {
        walletId_tokenAddress: {
          walletId,
          tokenAddress: 'SOL',
        },
      },
      create: {
        walletId,
        tokenAddress: 'SOL',
        tokenSymbol: 'SOL',
        tokenName: 'Solana',
        decimals: solBalance.decimals,
        balance: solBalance.balance,
        lastUpdated: new Date(),
      },
      update: {
        balance: solBalance.balance,
        lastUpdated: new Date(),
      },
    });

    // Sync USDC
    const usdcBalance = await getSolanaBalance(walletAddress, SOLANA_USDC_MINT);
    await prisma.walletBalance.upsert({
      where: {
        walletId_tokenAddress: {
          walletId,
          tokenAddress: SOLANA_USDC_MINT,
        },
      },
      create: {
        walletId,
        tokenAddress: SOLANA_USDC_MINT,
        tokenSymbol: 'USDC',
        tokenName: 'USD Coin',
        decimals: usdcBalance.decimals,
        balance: usdcBalance.balance,
        lastUpdated: new Date(),
      },
      update: {
        balance: usdcBalance.balance,
        lastUpdated: new Date(),
      },
    });

    logger.info(`Synced Solana balances for wallet ${walletAddress}`);
  } catch (error) {
    logger.error(`Failed to sync Solana balance for wallet ${walletId}`, { error });
    throw error;
  }
}
