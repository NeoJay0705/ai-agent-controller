import { describe, expect, it } from 'vitest';
import { runTelegramServiceMockAcceptance } from './telegram-service-mock-harness.js';

describe('real bot-mode service with mock Telegram HTTP', () => {
  it('runs all acceptance scenarios through real HTTP polling and outbox delivery', async () => {
    const report = await runTelegramServiceMockAcceptance();
    expect(report.status).toBe('passed');
    expect(report.controller.healthStatus).toBe(200);
    expect(report.controller.healthBody).toEqual({ status: 'ok' });
    expect(report.pid).toBe(process.pid);
    expect(report.controller.port).toBeGreaterThan(0);
    expect(report.mockTelegram.port).toBeGreaterThan(0);
    expect(report.scenarios.length).toBeGreaterThanOrEqual(7);
    for (const scenario of report.scenarios) {
      expect(scenario.status, scenario.name).toBe('passed');
      expect(scenario.checks.length, scenario.name).toBeGreaterThan(0);
      for (const check of scenario.checks)
        expect(check.status, `${scenario.name}: ${check.name}`).toBe('passed');
    }
    expect(report.cleanup).toMatchObject({
      controllerClosed: true,
      mockStopped: true,
      controllerDisconnected: true,
      mockDisconnected: true,
      pendingRuntimeGates: 0,
      runtimeAllSettled: true,
    });
    expect(report.boundaries.join(' ')).toContain('Fake AgentRuntime only');
  }, 60_000);
});
