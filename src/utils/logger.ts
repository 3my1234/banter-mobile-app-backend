import winston from 'winston';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { service: 'banter-backend' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

// Always emit logs to stdout/stderr so container platforms (Coolify/Docker) can capture them.
logger.add(
  new winston.transports.Console({
    format:
      process.env.NODE_ENV === 'production'
        ? logFormat
        : winston.format.combine(winston.format.colorize(), winston.format.simple()),
  })
);
