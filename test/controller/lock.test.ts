import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  link,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openControllerResources } from '../../src/controller/lifecycle.js';
import { artifactsPath, testConfig } from './helpers.js';

async function fixture(label: string): Promise<string> {
  const root = artifactsPath(`kernel-lock-${label}`).replace(/\.sqlite$/, '');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  return root;
}

type ChildClose = { code: number | null; signal: NodeJS.Signals | null };
type SyntheticOwner = {
  child: ReturnType<typeof spawn>;
  ready: Promise<void>;
  close: Promise<ChildClose>;
};

async function startSyntheticOwner(
  dataDir: string,
  failClose = false,
): Promise<SyntheticOwner> {
  const script = join(dataDir, 'synthetic-owner.mts');
  const helper = join(process.cwd(), 'test/controller/helpers.ts');
  const lifecycle = join(process.cwd(), 'src/controller/lifecycle.ts');
  await writeFile(
    script,
    `import { openControllerResources } from ${JSON.stringify(lifecycle)};\nimport { testConfig } from ${JSON.stringify(helper)};\nlet resources = await openControllerResources(testConfig({ CONTROLLER_DATA_DIR: process.argv[2] }));\n${failClose ? "resources.store.close = () => { throw new Error('synthetic close failure'); };\ntry { await resources.close(); } catch {}\nresources = null;\nfor (let i = 0; i < 5; i++) { global.gc?.(); await new Promise((resolve) => setTimeout(resolve, 20)); }\n" : ''}process.stdout.write('READY ' + process.pid + '\\n');\nsetInterval(() => void resources, 1000);\n`,
    { mode: 0o600, flag: 'wx' },
  );
  const child = spawn(
    process.execPath,
    [
      ...(failClose ? ['--expose-gc'] : []),
      '--import',
      join(process.cwd(), 'node_modules/tsx/dist/loader.mjs'),
      script,
      dataDir,
    ],
    { cwd: process.cwd(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stderr.resume();
  const close = new Promise<ChildClose>((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('synthetic child timeout'));
    }, 5000);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 256) {
        clearTimeout(timeout);
        reject(new Error('synthetic child output limit exceeded'));
      } else if (output.includes(`READY ${String(child.pid)}\n`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('synthetic child failed to start'));
    });
    void close.then(() => {
      clearTimeout(timeout);
      reject(new Error('synthetic child exited before ready'));
    });
  });
  return { child, ready, close };
}

async function stopSyntheticChild(owner: SyntheticOwner): Promise<void> {
  if (owner.child.exitCode === null && owner.child.signalCode === null)
    owner.child.kill('SIGTERM');
  const joined = await Promise.race([
    owner.close.then(() => true),
    new Promise<false>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, 1000);
    }),
  ]);
  if (!joined) {
    owner.child.kill('SIGKILL');
    await Promise.race([
      owner.close,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error('synthetic child join timed out'));
        }, 3000),
      ),
    ]);
  }
}

describe('Linux controller kernel lock', () => {
  it('holds the kernel lock across helper exit and reacquires after release', async () => {
    const dataDir = await fixture('same-process');
    const config = testConfig({ CONTROLLER_DATA_DIR: dataDir });
    const owner = await openControllerResources(config);
    const markerPath = join(dataDir, 'controller.lock');
    const firstBytes = await readFile(markerPath);
    await expect(openControllerResources(config)).rejects.toThrow(
      'Controller lock already exists.',
    );
    expect(await readFile(markerPath)).toEqual(firstBytes);
    await Promise.all([owner.close(), owner.close()]);
    await expect(readFile(markerPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await stat(join(dataDir, 'controller.kernel.lock'))).isFile()).toBe(
      true,
    );
    const next = await openControllerResources(config);
    await next.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('allows only one winner in concurrent resource starts', async () => {
    const dataDir = await fixture('concurrent-starts');
    const starts = await Promise.allSettled([
      openControllerResources(testConfig({ CONTROLLER_DATA_DIR: dataDir })),
      openControllerResources(testConfig({ CONTROLLER_DATA_DIR: dataDir })),
    ]);
    const owners = starts.filter((item) => item.status === 'fulfilled');
    const rejected = starts.filter((item) => item.status === 'rejected');
    expect(owners).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (owners[0]?.status === 'fulfilled') await owners[0].value.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('kills the verified synthetic owner and recovers its complete marker', async () => {
    const dataDir = await fixture('synthetic-sigkill');
    const owner = await startSyntheticOwner(dataDir);
    try {
      await owner.ready;
      const prior = JSON.parse(
        await readFile(join(dataDir, 'controller.lock'), 'utf8'),
      ) as {
        pid: number;
        token: string;
      };
      expect(prior.pid).toBe(owner.child.pid);
      owner.child.kill('SIGKILL');
      const closed = await Promise.race([
        owner.close,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('synthetic join timeout'));
          }, 5000);
        }),
      ]);
      expect(closed).toEqual({ code: null, signal: 'SIGKILL' });
      const recovered = await openControllerResources(
        testConfig({ CONTROLLER_DATA_DIR: dataDir }),
      );
      const next = JSON.parse(
        await readFile(join(dataDir, 'controller.lock'), 'utf8'),
      ) as {
        pid: number;
        token: string;
      };
      expect(next.pid).toBe(process.pid);
      expect(next.token).not.toBe(prior.token);
      await recovered.close();
    } finally {
      await stopSyntheticChild(owner);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps the lock held after DB close failure and forced GC in another process', async () => {
    const dataDir = await fixture('close-failure-gc');
    const owner = await startSyntheticOwner(dataDir, true);
    try {
      await owner.ready;
      const marker = JSON.parse(
        await readFile(join(dataDir, 'controller.lock'), 'utf8'),
      ) as {
        pid: number;
      };
      expect(marker.pid).toBe(owner.child.pid);
      await expect(
        openControllerResources(testConfig({ CONTROLLER_DATA_DIR: dataDir })),
      ).rejects.toThrow('Controller lock already exists.');
      owner.child.kill('SIGTERM');
      const closed = await Promise.race([
        owner.close,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('synthetic join timeout'));
          }, 5000);
        }),
      ]);
      expect(closed.signal).toBe('SIGTERM');
      const recovered = await openControllerResources(
        testConfig({ CONTROLLER_DATA_DIR: dataDir }),
      );
      await recovered.close();
    } finally {
      await stopSyntheticChild(owner);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('recovers a complete stale marker even when its recorded PID is alive', async () => {
    const dataDir = await fixture('live-pid-stale-marker');
    const config = testConfig({ CONTROLLER_DATA_DIR: dataDir });
    const owner = await openControllerResources(config);
    const prior = JSON.parse(
      await readFile(join(dataDir, 'controller.lock'), 'utf8'),
    ) as { anchorDev: string; anchorIno: string; token: string };
    await owner.close();
    const stale = {
      version: 1,
      kind: 'controller-kernel-lock',
      pid: process.pid,
      token: prior.token,
      anchorDev: prior.anchorDev,
      anchorIno: prior.anchorIno,
    };
    await writeFile(
      join(dataDir, 'controller.lock'),
      `${JSON.stringify(stale)}\n`,
      {
        mode: 0o600,
        flag: 'wx',
      },
    );
    const recovered = await openControllerResources(config);
    const current = JSON.parse(
      await readFile(join(dataDir, 'controller.lock'), 'utf8'),
    ) as { pid: number; token: string };
    expect(current.pid).toBe(process.pid);
    expect(current.token).not.toBe(prior.token);
    await recovered.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it.each([
    Buffer.from('123456\n'),
    Buffer.from('123456\r\n'),
    Buffer.from('123456\n\n'),
    Buffer.from([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x80, 0x0a]),
    Buffer.alloc(2049, 0x61),
    Buffer.alloc(0),
    Buffer.from('{bad'),
    Buffer.from('{"version":2}'),
  ])('preserves unknown, legacy and oversized marker bytes', async (marker) => {
    const dataDir = await fixture(
      `bad-marker-${String(marker.length)}-${marker.toString('hex').slice(0, 8)}`,
    );
    const markerPath = join(dataDir, 'controller.lock');
    await writeFile(markerPath, marker, { mode: 0o600, flag: 'wx' });
    const before = await readFile(markerPath);
    await expect(
      openControllerResources(testConfig({ CONTROLLER_DATA_DIR: dataDir })),
    ).rejects.toThrow();
    expect(await readFile(markerPath)).toEqual(before);
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects a marker that refers to a different anchor without changing it', async () => {
    const dataDir = await fixture('wrong-anchor-marker');
    const owner = await openControllerResources(
      testConfig({ CONTROLLER_DATA_DIR: dataDir }),
    );
    const markerPath = join(dataDir, 'controller.lock');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await owner.close();
    marker.anchorIno = String(BigInt(String(marker.anchorIno)) + 1n);
    const bytes = Buffer.from(`${JSON.stringify(marker)}\n`);
    await writeFile(markerPath, bytes, { mode: 0o600, flag: 'wx' });
    await expect(
      openControllerResources(testConfig({ CONTROLLER_DATA_DIR: dataDir })),
    ).rejects.toThrow('Controller lock marker refers to another anchor.');
    expect(await readFile(markerPath)).toEqual(bytes);
    await rm(dataDir, { recursive: true, force: true });
  });

  it('recovers a valid marker with an extra hardlink left by atomic publication', async () => {
    const dataDir = await fixture('marker-nlink-two');
    const owner = await openControllerResources(
      testConfig({ CONTROLLER_DATA_DIR: dataDir }),
    );
    const markerPath = join(dataDir, 'controller.lock');
    const bytes = await readFile(markerPath);
    await owner.close();
    await writeFile(markerPath, bytes, { mode: 0o600, flag: 'wx' });
    const secondLink = join(dataDir, '.controller.lock.synthetic.tmp');
    await link(markerPath, secondLink);
    expect((await stat(markerPath)).nlink).toBe(2);
    const recovered = await openControllerResources(
      testConfig({ CONTROLLER_DATA_DIR: dataDir }),
    );
    await recovered.close();
    expect(await readFile(secondLink)).toEqual(bytes);
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects marker symlinks and FIFOs without following or blocking on them', async () => {
    const symlinkDir = await fixture('marker-symlink');
    const target = join(symlinkDir, 'marker-target');
    const marker = join(symlinkDir, 'controller.lock');
    await writeFile(target, 'synthetic-marker-target', {
      mode: 0o600,
      flag: 'wx',
    });
    await symlink(target, marker);
    const targetBytes = await readFile(target);
    await expect(
      openControllerResources(testConfig({ CONTROLLER_DATA_DIR: symlinkDir })),
    ).rejects.toThrow();
    expect(await readFile(target)).toEqual(targetBytes);
    await rm(symlinkDir, { recursive: true, force: true });

    const fifoDir = await fixture('marker-fifo');
    const fifoPath = join(fifoDir, 'controller.lock');
    const fifo = spawnSync('/usr/bin/mkfifo', [fifoPath], {
      shell: false,
      encoding: 'utf8',
    });
    expect(fifo.status).toBe(0);
    await expect(
      openControllerResources(testConfig({ CONTROLLER_DATA_DIR: fifoDir })),
    ).rejects.toThrow();
    await rm(fifoDir, { recursive: true, force: true });
  });

  it('does not remove a replacement marker during lease release', async () => {
    const dataDir = await fixture('marker-replacement');
    const owner = await openControllerResources(
      testConfig({ CONTROLLER_DATA_DIR: dataDir }),
    );
    const markerPath = join(dataDir, 'controller.lock');
    const replacement = join(dataDir, 'replacement');
    await writeFile(replacement, 'replacement-marker', {
      mode: 0o600,
      flag: 'wx',
    });
    await rm(markerPath);
    await link(replacement, markerPath);
    await expect(owner.close()).rejects.toThrow(
      'Controller lock ownership changed.',
    );
    expect(await readFile(markerPath, 'utf8')).toBe('replacement-marker');
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects an anchor with unsafe permissions without changing its mode', async () => {
    const dataDir = await fixture('anchor-wrong-mode');
    const anchor = join(dataDir, 'controller.kernel.lock');
    await writeFile(anchor, '', { mode: 0o600, flag: 'wx' });
    await chmod(anchor, 0o644);
    await expect(
      openControllerResources(testConfig({ CONTROLLER_DATA_DIR: dataDir })),
    ).rejects.toThrow();
    expect((await stat(anchor)).mode & 0o777).toBe(0o644);
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects unsafe anchor symlinks and hardlinks', async () => {
    const symlinkDir = await fixture('anchor-symlink');
    const target = join(symlinkDir, 'synthetic-target');
    const anchor = join(symlinkDir, 'controller.kernel.lock');
    await writeFile(target, 'synthetic-anchor', { mode: 0o600, flag: 'wx' });
    await symlink(target, anchor);
    await expect(
      openControllerResources(testConfig({ CONTROLLER_DATA_DIR: symlinkDir })),
    ).rejects.toThrow();
    await rm(symlinkDir, { recursive: true, force: true });

    const hardlinkDir = await fixture('anchor-hardlink');
    const linkedAnchor = join(hardlinkDir, 'controller.kernel.lock');
    const extra = join(hardlinkDir, 'anchor-alias');
    await writeFile(linkedAnchor, '', { mode: 0o600, flag: 'wx' });
    await link(linkedAnchor, extra);
    await expect(
      openControllerResources(testConfig({ CONTROLLER_DATA_DIR: hardlinkDir })),
    ).rejects.toThrow();
    expect((await readFile(extra)).length).toBe(0);
    await rm(hardlinkDir, { recursive: true, force: true });
  });
});
