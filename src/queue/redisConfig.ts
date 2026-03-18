type RedisConnectionConfig = {
  host: string;
  port: number;
  password?: string;
  username?: string;
};

function parseRedisUrl(rawUrl: string): RedisConnectionConfig {
  const parsed = new URL(rawUrl);
  return {
    host: parsed.hostname || 'localhost',
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
  };
}

export function getRedisConfig(): RedisConnectionConfig {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (redisUrl) {
    return parseRedisUrl(redisUrl);
  }

  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    username: process.env.REDIS_USERNAME || undefined,
  };
}
