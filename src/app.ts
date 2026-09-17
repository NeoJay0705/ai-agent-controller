import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

interface HealthResponse {
  status: 'ok';
}

export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  app.get<{ Reply: HealthResponse }>(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: {
              status: { type: 'string', const: 'ok' },
            },
          },
        },
      },
    },
    () => ({ status: 'ok' }),
  );

  return app;
}
