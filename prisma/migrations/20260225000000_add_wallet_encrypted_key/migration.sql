-- Add encrypted private key for server-side Movement wallets
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "encryptedPrivateKey" text;
