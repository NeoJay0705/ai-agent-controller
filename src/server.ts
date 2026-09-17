import { buildApp } from './app.js';

const host = process.env['HOST'] ?? '0.0.0.0';
const app = buildApp({ logger: true });

process.once('SIGINT', () => {
  requestShutdown('SIGINT');
});

process.once('SIGTERM', () => {
  requestShutdown('SIGTERM');
});

try {
  const port = readPort(process.env['PORT']);
  await app.listen({ host, port });
} catch (error: unknown) {
  app.log.error(error);
  process.exitCode = 1;
}

function requestShutdown(signal: NodeJS.Signals): void {
  void shutdown(signal).catch((error: unknown) => {
    app.log.error(error, 'shutdown failed');
    process.exitCode = 1;
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutdown requested');
  await app.close();
}

function readPort(value: string | undefined): number {
  if (value === undefined) {
    return 3000;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return parsed;
}
