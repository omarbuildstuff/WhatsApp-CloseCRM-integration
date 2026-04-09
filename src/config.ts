import 'dotenv/config';

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

const rawPort = process.env.PORT ?? '3000';
const parsedPort = parseInt(rawPort, 10);
if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  throw new Error(`Invalid PORT env var: "${rawPort}"`);
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  port: parsedPort,
  closeApiKey: required('CLOSE_API_KEY'),
  dashboardPassword: required('DASHBOARD_PASSWORD'),
  closeWebhookSecret: required('CLOSE_WEBHOOK_SECRET'),
};
