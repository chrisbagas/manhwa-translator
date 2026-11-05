// Job scheduler for chapter images: prioritises images near the reader,
// bounded concurrency, pause / resume / cancel / retry.

import type { ErrorCode, PageResult, Progress, TranslateResponse } from '../shared/types';

export type JobState = 'waiting' | 'queued' | 'processing' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  key: string; // dedupe key (resolved URL)
  el: HTMLImageElement;
  url: string | null;
  state: JobState;
  attempts: number;
  error?: string;
  code?: ErrorCode;
  result?: PageResult;
}

export interface SchedulerDeps {
  translate(job: Job): Promise<TranslateResponse>;
  cancelRemote(ids: string[]): void;
  /** Smaller = sooner. Typically distance (px) from the viewport. */
  priority(job: Job): number;
  onDone(job: Job): void;
  onChange(): void;
  concurrency(): number;
}

let seq = 0;
export const newJobId = () => `j${Date.now().toString(36)}${(seq++).toString(36)}`;

export class Scheduler {
  jobs: Job[] = [];
  paused = false;
  running = false;
  private active = 0;
  private generation = 0;

  constructor(private deps: SchedulerDeps) {}

  byElement(el: HTMLImageElement) {
    return this.jobs.find((j) => j.el === el);
  }

  /** Add or update an image. Returns the job. Same element + same URL is a no-op. */
  upsert(el: HTMLImageElement, url: string | null): Job {
    const existing = this.byElement(el);
    if (existing) {
      if (url && existing.url !== url) {
        // Source changed (lazy loader swapped it in, or the page reused the node).
        if (existing.state === 'processing') this.deps.cancelRemote([existing.id]);
        Object.assign(existing, { id: newJobId(), url, key: url, state: 'queued', attempts: 0, error: undefined, result: undefined });
      } else if (url && existing.state === 'waiting') {
        existing.url = url;
        existing.key = url;
        existing.state = 'queued';
      }
      this.pump();
      return existing;
    }
    const job: Job = { id: newJobId(), key: url ?? `pending:${seq}`, el, url, state: url ? 'queued' : 'waiting', attempts: 0 };
    this.jobs.push(job);
    this.pump();
    return job;
  }

  start() {
    this.running = true;
    this.paused = false;
    this.pump();
  }

  pause() {
    this.paused = true;
    this.deps.onChange();
  }

  resume() {
    this.paused = false;
    this.pump();
  }

  /** Stop everything: abort in-flight work and drop the queue (results kept). */
  cancel() {
    this.generation++;
    const inflight = this.jobs.filter((j) => j.state === 'processing').map((j) => j.id);
    for (const j of this.jobs) if (j.state === 'processing' || j.state === 'queued') j.state = 'cancelled';
    this.active = 0;
    this.running = false;
    if (inflight.length) this.deps.cancelRemote(inflight);
    this.deps.onChange();
  }

  retryFailed() {
    for (const j of this.jobs) {
      if (j.state === 'failed' || j.state === 'cancelled') {
        j.state = j.url ? 'queued' : 'waiting';
        j.error = undefined;
        j.id = newJobId();
      }
    }
    this.running = true;
    this.paused = false;
    this.pump();
  }

  /** Re-run finished images (e.g. after settings changed). OCR is cached service-side. */
  requeueDone() {
    for (const j of this.jobs) if (j.state === 'done') {
      j.state = 'queued';
      j.id = newJobId();
    }
    this.pump();
  }

  progress(notes: string[] = [], showingOriginal = false): Progress {
    const c = (s: JobState) => this.jobs.filter((j) => j.state === s).length;
    return {
      discovered: this.jobs.length,
      waiting: c('waiting'),
      queued: c('queued'),
      processing: c('processing'),
      done: c('done'),
      failed: c('failed') + c('cancelled'),
      paused: this.paused,
      running: this.running,
      showingOriginal,
      notes,
    };
  }

  pump() {
    this.deps.onChange();
    if (!this.running || this.paused) return;
    while (this.active < Math.max(1, this.deps.concurrency())) {
      const next = this.jobs
        .filter((j) => j.state === 'queued')
        .sort((a, b) => this.deps.priority(a) - this.deps.priority(b))[0];
      if (!next) break;
      this.run(next);
    }
    if (this.active === 0 && !this.jobs.some((j) => j.state === 'queued')) this.deps.onChange();
  }

  private async run(job: Job) {
    const gen = this.generation;
    const id = job.id;
    job.state = 'processing';
    job.attempts++;
    this.active++;
    this.deps.onChange();
    let res: TranslateResponse;
    try {
      res = await this.deps.translate(job);
    } catch (e) {
      res = { ok: false, code: 'service-error', error: String(e) };
    }
    if (gen !== this.generation || job.id !== id) return; // cancelled or superseded
    this.active--;
    if (res.ok) {
      job.state = 'done';
      job.result = res.result;
      this.deps.onDone(job);
    } else if (res.code === 'cancelled') {
      job.state = 'cancelled';
    } else {
      job.state = 'failed';
      job.code = res.code;
      job.error = res.error;
      if (res.code === 'service-unreachable' || res.code === 'unauthorized') {
        // No point hammering a missing service: pause and let the user fix it.
        this.paused = true;
      }
    }
    this.pump();
  }
}
