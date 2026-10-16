import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_FLOW_CONFIG_BYTES } from '../../src/flow/config.js';
import {
  assertFlowAuthConfiguration,
  loadFlowBundleConfig,
  FlowConfigLoadError,
} from '../../src/flow/config-file.js';
import { createFlowBundle } from '../../src/flow/definitions.js';
import type {
  FlowBundle,
  FlowLimits,
  FlowRuntime,
} from '../../src/flow/types.js';

const runtime: FlowRuntime = {
  provider: 'openai',
  model: 'gpt-6-luna',
  thinking: 'max',
  apiKeyEnv: 'OPENAI_API_KEY',
  auth: { mode: 'api-key' },
};
const limits: FlowLimits = {
  nodeTimeoutMs: 180_000,
  waitTimeoutMs: 86_400_000,
  jobTimeoutMs: 86_400_000,
  maxTransitions: 120,
  maxRetries: 0,
  maxModelTurns: 4,
  maxToolCalls: 0,
  maxOutputChars: 20_000,
};
const expectedBundle = createFlowBundle({
  runtimes: { intake: runtime, mbti: runtime, natal: runtime },
  limits: {
    intake: limits,
    mbti: limits,
    natal: { ...limits, maxToolCalls: 1 },
  },
});

const fixtureRoot = resolve(
  process.cwd(),
  '.test-artifacts/pi-flow/wiring/config-file-fixtures',
);
let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

function withoutAuthDifferences(bundle: FlowBundle): unknown {
  return bundle.flows.map((flow) => ({
    ...flow,
    runtime: {
      provider: flow.runtime.provider,
      model: flow.runtime.model,
      thinking: flow.runtime.thinking,
    },
    nodes: flow.nodes.map((node) => ({
      ...node,
      ...(node.runtime === undefined
        ? {}
        : {
            runtime: {
              provider: node.runtime.provider,
              model: node.runtime.model,
              thinking: node.runtime.thinking,
            },
          }),
    })),
  }));
}

async function fixtureDirectory(): Promise<string> {
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  temporaryDirectory = await mkdtemp(join(fixtureRoot, 'case-'));
  return temporaryDirectory;
}

describe('trusted Flow configuration file loader', () => {
  it('loads the API-key example and matches the explicit Flow factory', async () => {
    const bundle = await loadFlowBundleConfig(
      resolve(process.cwd(), 'config/pi-flow.example.json'),
    );
    expect(bundle).toEqual(expectedBundle);
    expect(bundle.flows.map((flow) => flow.runtime)).toEqual([
      runtime,
      runtime,
      runtime,
    ]);
    expect(bundle.flows.map((flow) => flow.limits.maxToolCalls)).toEqual([
      0, 0, 1,
    ]);
    expect(
      bundle.flows.flatMap((flow) =>
        flow.nodes.map((node) => [flow.id, node.id, node.tools ?? []]),
      ),
    ).toContainEqual(['natal', 'calculate', ['calculate_natal_chart']]);
    expect(
      bundle.flows
        .flatMap((flow) => flow.nodes)
        .filter((node) => node.kind === 'agent')
        .every((node) => (node.tools ?? []).length === 0),
    ).toBe(true);
  });

  it('loads both auth examples with identical Flow graphs, models, tools, and limits', async () => {
    const apiKeyBundle = await loadFlowBundleConfig(
      resolve(process.cwd(), 'config/pi-flow.example.json'),
    );
    const piLoginBundle = await loadFlowBundleConfig(
      resolve(process.cwd(), 'config/pi-flow.oauth.example.json'),
    );
    const apiKeyRuntimes = apiKeyBundle.flows.map((flow) => flow.runtime);
    const piLoginRuntimes = piLoginBundle.flows.map((flow) => flow.runtime);

    expect(apiKeyRuntimes).toHaveLength(3);
    expect(apiKeyRuntimes.every((item) => item.auth?.mode === 'api-key')).toBe(
      true,
    );
    expect(
      piLoginRuntimes.every(
        (item) => item.auth?.mode === 'pi-login' && item.apiKeyEnv === null,
      ),
    ).toBe(true);
    expect(
      apiKeyRuntimes.map(({ provider, model, thinking }) => ({
        provider,
        model,
        thinking,
      })),
    ).toEqual(
      piLoginRuntimes.map(({ provider, model, thinking }) => ({
        provider,
        model,
        thinking,
      })),
    );
    expect(withoutAuthDifferences(apiKeyBundle)).toEqual(
      withoutAuthDifferences(piLoginBundle),
    );
    expect(
      piLoginRuntimes.map(({ provider, model, thinking }) => ({
        provider,
        model,
        thinking,
      })),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        provider: 'openai',
        model: 'gpt-6-luna',
        thinking: 'max',
      })),
    );
  });

  it('requires a canonical absolute auth source only for effective pi-login Agent Nodes', async () => {
    const loginBundle = await loadFlowBundleConfig(
      resolve(process.cwd(), 'config/pi-flow.oauth.example.json'),
    );
    const message =
      'PI_FLOW_AUTH_FILE is required for pi-login authentication.';
    expect(() => {
      assertFlowAuthConfiguration(loginBundle, undefined);
    }).toThrow(message);
    expect(() => {
      assertFlowAuthConfiguration(loginBundle, 'relative/auth.json');
    }).toThrow(message);
    expect(() => {
      assertFlowAuthConfiguration(loginBundle, '/workspace/.pi/auth.json');
    }).not.toThrow();

    const partiallyOverridden = structuredClone(loginBundle) as unknown as {
      flows: Array<{
        runtime: FlowRuntime;
        nodes: Array<{ kind: string; runtime?: FlowRuntime }>;
      }>;
    };
    const firstAgent = partiallyOverridden.flows[0]?.nodes.find(
      (node) => node.kind === 'agent',
    );
    if (firstAgent === undefined) throw new Error('Expected an Agent Node.');
    firstAgent.runtime = runtime;
    expect(() => {
      assertFlowAuthConfiguration(
        partiallyOverridden as unknown as typeof loginBundle,
        undefined,
      );
    }).toThrow(message);

    const fullyOverridden = structuredClone(loginBundle) as unknown as {
      flows: Array<{
        runtime: FlowRuntime;
        nodes: Array<{ kind: string; runtime?: FlowRuntime }>;
      }>;
    };
    for (const flow of fullyOverridden.flows) {
      for (const node of flow.nodes) {
        if (node.kind === 'agent') node.runtime = runtime;
      }
    }
    expect(() => {
      assertFlowAuthConfiguration(
        fullyOverridden as unknown as typeof loginBundle,
        undefined,
      );
    }).not.toThrow();
  });

  it('loads explicit pi-login auth from a private pinned JSON bundle', async () => {
    const directory = await fixtureDirectory();
    const path = join(directory, 'pi-login.json');
    const value = structuredClone(expectedBundle) as unknown as {
      flows: Array<Record<string, unknown>>;
    };
    const intake = value.flows.find((flow) => flow['id'] === 'intake');
    if (intake === undefined) throw new Error('Test Flow is missing.');
    intake['runtime'] = {
      provider: 'openai',
      model: 'gpt-6-luna',
      thinking: 'max',
      apiKeyEnv: null,
      auth: { mode: 'pi-login' },
    };
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });

    const loaded = await loadFlowBundleConfig(path);
    expect(loaded.flows[0]?.runtime).toEqual({
      provider: 'openai',
      model: 'gpt-6-luna',
      thinking: 'max',
      apiKeyEnv: null,
      auth: { mode: 'pi-login' },
    });
  });

  it('rejects malformed JSON with a fixed safe classification', async () => {
    const directory = await fixtureDirectory();
    const path = join(directory, 'invalid.json');
    const raw = '{"private":"DO_NOT_ECHO"';
    await writeFile(path, raw, { mode: 0o600 });
    let failure: unknown;
    try {
      await loadFlowBundleConfig(path);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(FlowConfigLoadError);
    expect(failure).toMatchObject({ code: 'FLOW_CONFIG_INVALID' });
    expect((failure as Error).message).toBe('FLOW_CONFIG_INVALID');
    expect((failure as Error).message).not.toContain(raw);
    expect((failure as Error).message).not.toContain(path);
  });

  it('rejects a symbolic link without following it', async () => {
    const directory = await fixtureDirectory();
    const target = join(directory, 'target.json');
    const link = join(directory, 'link.json');
    await writeFile(target, JSON.stringify(expectedBundle), { mode: 0o600 });
    await symlink(target, link);
    await expect(loadFlowBundleConfig(link)).rejects.toMatchObject({
      code: 'FLOW_CONFIG_INVALID',
      message: 'FLOW_CONFIG_INVALID',
    });
  });

  it('rejects a FIFO without waiting for a writer', async () => {
    const directory = await fixtureDirectory();
    const path = join(directory, 'config.fifo');
    execFileSync('mkfifo', [path], { stdio: 'ignore' });
    await expect(loadFlowBundleConfig(path)).rejects.toMatchObject({
      code: 'FLOW_CONFIG_INVALID',
      message: 'FLOW_CONFIG_INVALID',
    });
  });

  it('bounds reads at the configured byte limit plus one', async () => {
    const directory = await fixtureDirectory();
    const path = join(directory, 'oversize.json');
    await writeFile(path, ' '.repeat(MAX_FLOW_CONFIG_BYTES + 1), {
      mode: 0o600,
    });
    await expect(loadFlowBundleConfig(path)).rejects.toMatchObject({
      code: 'FLOW_CONFIG_TOO_LARGE',
      message: 'FLOW_CONFIG_TOO_LARGE',
    });
  });

  it('uses a fixed missing-file classification without exposing the path', async () => {
    const directory = await fixtureDirectory();
    const path = join(directory, 'missing-sensitive-name.json');
    await expect(loadFlowBundleConfig(path)).rejects.toMatchObject({
      code: 'FLOW_CONFIG_MISSING',
      message: 'FLOW_CONFIG_MISSING',
    });
  });
});
