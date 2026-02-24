-- Add Flutterwave to PaymentChain enum
DO $$ BEGIN
  ALTER TYPE "PaymentChain" ADD VALUE IF NOT EXISTS 'FLUTTERWAVE';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
