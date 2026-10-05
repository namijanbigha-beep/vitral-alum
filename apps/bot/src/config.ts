import { z } from 'zod';

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(20),
  SERVER_URL: z.string().url().default('http://localhost:3000'),
  BOT_SERVICE_KEY: z.string().min(32),
  DAILY_REPORT_TIME: z.string().regex(/^\d{2}:\d{2}$/).default('21:00'),
  ALERT_POLL_SECONDS: z.coerce.number().int().min(5).default(30),
  LOG_LEVEL: z.enum(['debug', 'info', 'silent']).default('info'),
});
export type BotConfig = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): BotConfig => schema.parse(env);
