type PerformanceConfig = {
  dbConnectionLimit: number;
  dbPoolTimeoutSeconds: number;
  dbUsePgBouncer: boolean;
  apiRateLimitWindowMs: number;
  apiRateLimitMax: number;
  authRateLimitWindowMs: number;
  authRateLimitMax: number;
};

const parseIntEnv = (value: string | undefined, fallback: number, min: number) => {
  const parsed = Number.parseInt((value || '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
};

const parseBoolEnv = (value: string | undefined, fallback: boolean) => {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return fallback;
};

const toPerformanceConfig = (): PerformanceConfig => ({
  dbConnectionLimit: parseIntEnv(process.env.DB_CONNECTION_LIMIT, 20, 2),
  dbPoolTimeoutSeconds: parseIntEnv(process.env.DB_POOL_TIMEOUT_SEC, 20, 2),
  dbUsePgBouncer: parseBoolEnv(process.env.DB_USE_PGBOUNCER, false),
  apiRateLimitWindowMs: parseIntEnv(process.env.API_RATE_LIMIT_WINDOW_MS, 60_000, 1_000),
  apiRateLimitMax: parseIntEnv(process.env.API_RATE_LIMIT_MAX, 500, 50),
  authRateLimitWindowMs: parseIntEnv(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 60_000, 1_000),
  authRateLimitMax: parseIntEnv(process.env.AUTH_RATE_LIMIT_MAX, 60, 5),
});

let cachedPerformanceConfig: PerformanceConfig | null = null;

export const getPerformanceConfig = () => {
  if (!cachedPerformanceConfig) {
    cachedPerformanceConfig = toPerformanceConfig();
  }
  return cachedPerformanceConfig;
};

export const buildPrismaDatasourceUrl = () => {
  const source = (process.env.DATABASE_URL || '').trim();
  if (!source) return source;

  try {
    const parsed = new URL(source);
    const config = getPerformanceConfig();

    if (!parsed.searchParams.has('connection_limit')) {
      parsed.searchParams.set('connection_limit', String(config.dbConnectionLimit));
    }
    if (!parsed.searchParams.has('pool_timeout')) {
      parsed.searchParams.set('pool_timeout', String(config.dbPoolTimeoutSeconds));
    }
    if (config.dbUsePgBouncer && !parsed.searchParams.has('pgbouncer')) {
      parsed.searchParams.set('pgbouncer', 'true');
    }

    return parsed.toString();
  } catch {
    return source;
  }
};
