import 'dotenv/config';

export const port = Number(process.env.PORT) || 3001;

export const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
