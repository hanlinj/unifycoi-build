// Phase 7 closing loop — instrumentation smoke test.
//
// Proves the Next.js instrumentation hook (register) starts the background workers on boot.
// startAllWorkers + seedTemplates are mocked so the test asserts the wiring without spinning
// up real timers.

import { jest } from '@jest/globals';

const startAllWorkers = jest.fn();
const seedTemplates = jest.fn();

jest.mock('@/lib/workers/bootstrap', () => ({ startAllWorkers }));
jest.mock('@/lib/requirements/templates', () => ({ seedTemplates }));

describe('instrumentation register()', () => {
  const prevRuntime = process.env['NEXT_RUNTIME'];
  beforeEach(() => {
    startAllWorkers.mockClear();
    seedTemplates.mockClear();
  });
  afterAll(() => { process.env['NEXT_RUNTIME'] = prevRuntime; });

  test('starts the workers on boot under the nodejs runtime', async () => {
    process.env['NEXT_RUNTIME'] = 'nodejs';
    const { register } = await import('@/instrumentation');
    await register();
    expect(seedTemplates).toHaveBeenCalledTimes(1);
    expect(startAllWorkers).toHaveBeenCalledTimes(1);
  });

  test('does nothing under a non-nodejs (edge) runtime', async () => {
    process.env['NEXT_RUNTIME'] = 'edge';
    const { register } = await import('@/instrumentation');
    await register();
    expect(startAllWorkers).not.toHaveBeenCalled();
  });
});
