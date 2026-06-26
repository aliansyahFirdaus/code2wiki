export type AppEnv = {
  DATABASE_URL?: string;
  REDIS_URL?: string;
  AI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_MAX_REQUESTS_PER_MINUTE?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
};

export function readEnv(): AppEnv {
  return {
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    AI_API_KEY: process.env.AI_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_MODEL: process.env.AI_MODEL,
    AI_MAX_REQUESTS_PER_MINUTE: process.env.AI_MAX_REQUESTS_PER_MINUTE,
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET
  };
}
