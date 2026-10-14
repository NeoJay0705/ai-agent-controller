import { pathToFileURL } from 'node:url';

import { buildApp } from './app.js';
import {
  parseControllerConfig,
  type Environment,
} from './controller/config.js';
import { openControllerResources } from './controller/lifecycle.js';
import {
  ControllerService,
  type ServiceOptions,
} from './controller/service.js';
import { TelegramClient, type FetchLike } from './controller/telegram.js';
import type { ControllerConfig } from './controller/types.js';

export interface ServerOptions {
  readonly env?: Environment;
  readonly cwd?: string;
  readonly fetcher?: FetchLike;
  readonly service?: ServiceOptions;
}

export interface RunningServer {
  readonly config: ControllerConfig;
  readonly app: ReturnType<typeof buildApp>;
  readonly service?: ControllerService;
  close(): Promise<void>;
}

export async function startServer(
  options: ServerOptions = {},
): Promise<RunningServer> {
  const config = parseControllerConfig(options.env ?? process.env, options.cwd);
  const app = buildApp({ logger: true });
  let resources:
    Awaited<ReturnType<typeof openControllerResources>> | undefined;
  let service: ControllerService | undefined;
  let closePromise: Promise<void> | null = null;
  let closeServer: () => Promise<void> = () => Promise.resolve();
  try {
    if (config.mode === 'bot') {
      resources = await openControllerResources(config);
      service = new ControllerService(
        config,
        resources,
        new TelegramClient(config.token, options.fetcher),
        {
          ...options.service,
          onFatal: (classification) => {
            process.exitCode = 1;
            setImmediate(() => {
              void closeServer().catch(() => {
                app.log.error('shutdown failed after controller fatal error');
              });
            });
            options.service?.onFatal?.(classification);
          },
        },
      );
    }
    await app.listen({ host: config.host, port: config.port });
    service?.start();
    const close = (): Promise<void> => {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        try {
          if (service !== undefined) {
            await service.stop();
          } else if (resources !== undefined) {
            await resources.close();
          }
        } finally {
          await app.close();
        }
      })();
      return closePromise;
    };
    closeServer = close;
    return {
      config,
      app,
      ...(service === undefined ? {} : { service }),
      close,
    };
  } catch (error) {
    if (service !== undefined) {
      await service.stop().catch(() => undefined);
    } else if (resources !== undefined) {
      await resources.close().catch(() => undefined);
    }
    await app.close().catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  let server: RunningServer;
  try {
    server = await startServer();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Server startup failed.',
    );
    process.exitCode = 1;
    return;
  }
  let shutdown: Promise<void> | null = null;
  const requestShutdown = (): Promise<void> => {
    if (shutdown !== null) return shutdown;
    shutdown = server.close().catch(() => {
      console.error('Graceful shutdown failed.');
      process.exitCode = 1;
    });
    return shutdown;
  };
  process.once('SIGINT', () => void requestShutdown());
  process.once('SIGTERM', () => void requestShutdown());
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
