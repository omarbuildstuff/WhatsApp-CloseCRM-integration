import 'dotenv/config';

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT ?? 3000),
  closeApiKey: process.env.CLOSE_API_KEY ?? '',
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? '',
};
