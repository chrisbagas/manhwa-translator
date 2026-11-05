import { describe, expect, it, vi } from 'vitest';
import { Scheduler, type Job } from '../../src/content/scheduler';
import type { PageResult, TranslateResponse } from '../../src/shared/types';

const result = { imageSha256: 'x', width: 1, height: 1, regions: [] } as unknown as PageResult;

function setup(opts: { fail?: Set<string>; prio?: Record<string, number>; conc?: number } = {}) {
  const pending: { job: Job; resolve: (r: TranslateResponse) => void }[] = [];
  const cancelled: string[][] = [];
  const done: string[] = [];
  const s = new Scheduler({
    translate: (job) => new Promise((resolve) => pending.push({ job, resolve })),
    cancelRemote: (ids) => cancelled.push(ids),
    priority: (job) => opts.prio?.[job.url ?? ''] ?? 0,
    onDone: (job) => done.push(job.url!),
    onChange: () => {},
    concurrency: () => opts.conc ?? 1,
  });
  const img = () => document.createElement('img');
  const finish = async (i = 0, ok = true) => {
    const p = pending.splice(i, 1)[0];
    p.resolve(ok ? { ok: true, result } : { ok: false, code: 'fetch-failed', error: 'HTTP 500' });
    await Promise.resolve(); await Promise.resolve();
  };
  return { s, pending, cancelled, done, img, finish };
}

describe('Scheduler', () => {
  it('processes nearest images first with bounded concurrency', async () => {
    const t = setup({ prio: { a: 3000, b: 0, c: 500 }, conc: 1 });
    t.s.upsert(t.img(), 'a'); t.s.upsert(t.img(), 'b'); t.s.upsert(t.img(), 'c');
    t.s.start();
    expect(t.pending.map((p) => p.job.url)).toEqual(['b']);
    await t.finish();
    expect(t.pending.map((p) => p.job.url)).toEqual(['c']);
    await t.finish();
    await t.finish();
    expect(t.done).toEqual(['b', 'c', 'a']);
    expect(t.s.progress().done).toBe(3);
  });

  it('pause stops dispatch, resume continues', async () => {
    const t = setup();
    t.s.upsert(t.img(), 'a'); t.s.upsert(t.img(), 'b');
    t.s.start();
    t.s.pause();
    await t.finish();
    expect(t.pending).toHaveLength(0);
    expect(t.s.progress()).toMatchObject({ done: 1, queued: 1, paused: true });
    t.s.resume();
    expect(t.pending.map((p) => p.job.url)).toEqual(['b']);
  });

  it('cancel aborts in-flight work remotely and ignores late results', async () => {
    const t = setup({ conc: 2 });
    t.s.upsert(t.img(), 'a'); t.s.upsert(t.img(), 'b'); t.s.upsert(t.img(), 'c');
    t.s.start();
    const ids = t.pending.map((p) => p.job.id);
    t.s.cancel();
    expect(t.cancelled).toEqual([ids]);
    await t.finish(); // late success must not mark done
    expect(t.done).toEqual([]);
    expect(t.s.progress()).toMatchObject({ failed: 3, done: 0, queued: 0 });
  });

  it('retries failed images', async () => {
    const t = setup();
    t.s.upsert(t.img(), 'a');
    t.s.start();
    await t.finish(0, false);
    expect(t.s.jobs[0]).toMatchObject({ state: 'failed', error: 'HTTP 500' });
    t.s.retryFailed();
    expect(t.pending).toHaveLength(1);
    await t.finish();
    expect(t.s.jobs[0].state).toBe('done');
    expect(t.s.jobs[0].attempts).toBe(2);
  });

  it('dedupes the same element and re-queues when its source changes', async () => {
    const t = setup();
    const el = t.img();
    t.s.upsert(el, null);
    expect(t.s.progress().waiting).toBe(1);
    t.s.upsert(el, 'lazy.jpg');
    t.s.upsert(el, 'lazy.jpg');
    expect(t.s.jobs).toHaveLength(1);
    t.s.start();
    await t.finish();
    t.s.upsert(el, 'lazy.jpg');
    expect(t.pending).toHaveLength(0); // unchanged: not translated again
    t.s.upsert(el, 'other.jpg');
    expect(t.pending.map((p) => p.job.url)).toEqual(['other.jpg']);
  });

  it('pauses itself when the service is unavailable', async () => {
    const t = setup();
    t.s.upsert(t.img(), 'a'); t.s.upsert(t.img(), 'b');
    t.s.start();
    t.pending.shift()!.resolve({ ok: false, code: 'service-unreachable', error: 'down' });
    await Promise.resolve(); await Promise.resolve();
    expect(t.s.paused).toBe(true);
    expect(t.pending).toHaveLength(0);
  });
});
