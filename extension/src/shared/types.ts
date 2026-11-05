// Types shared by background, content script and popup.
// Region fields mirror the local service's JSON (snake_case on purpose).

export type Kind = 'dialogue' | 'narration' | 'sfx' | 'uncertain';
export type RenderMode = 'replace' | 'overlay' | 'annotate' | 'marker' | 'hidden';
export type SfxMode = 'annotate' | 'original' | 'replace';

export interface Style {
  fg: string;
  outline: string | null;
  outline_px: number;
  font_px: number;
  weight: number;
  align: 'left' | 'center' | 'right';
  orientation: 'horizontal' | 'vertical';
  angle: number;
}

export interface Bubble {
  bbox: number[];
  interior: number[];
  fill: string;
  flat: boolean;
  shape: string;
}

export interface Line {
  quad: number[][];
  text: string;
  confidence: number;
  angle: number;
  bbox: number[];
}

export interface Region {
  id: string;
  order: number;
  kind: Kind;
  bbox: [number, number, number, number];
  angle: number;
  lines: Line[];
  source_text: string;
  translated_text: string;
  translation_note: string;
  confidence: number;
  style: Style;
  bubble: Bubble | null;
  patch: string | null;
  patch_box: [number, number, number, number] | null;
  render_box: [number, number, number, number];
  render_mode: RenderMode;
  flags: string[];
}

export interface PageResult {
  imageSha256: string;
  width: number;
  height: number;
  sourceLang: string;
  targetLang: string;
  sfxMode: SfxMode;
  regions: Region[];
  timingsMs: Record<string, number>;
  cache: { analysis: boolean; result: boolean };
  warnings: string[];
  models: Record<string, string>;
}

export type EngineKind = 'builtin' | 'service';

export interface Settings {
  engine: EngineKind; // builtin = everything inside the browser; service = local Python service
  serviceUrl: string;
  token: string;
  sourceLang: string;
  targetLang: string;
  textScale: number; // 0.7 .. 1.5
  minFontPx: number; // smallest CSS px we will shrink text to
  sfxMode: SfxMode;
  glossary: Record<string, string>;
  concurrency: number; // in-flight images (service still processes one at a time)
}

export const DEFAULT_SETTINGS: Settings = {
  engine: 'builtin',
  serviceUrl: 'http://127.0.0.1:47615',
  token: '',
  sourceLang: 'ko',
  targetLang: 'en',
  textScale: 1,
  minFontPx: 11,
  sfxMode: 'annotate',
  glossary: {},
  concurrency: 2,
};

export type ErrorCode =
  | 'service-unreachable'
  | 'unauthorized'
  | 'fetch-failed'
  | 'cross-origin'
  | 'image-rejected'
  | 'translation-unavailable'
  | 'cancelled'
  | 'service-error'
  | 'no-source';

export type TranslateResponse =
  | { ok: true; result: PageResult }
  | { ok: false; code: ErrorCode; error: string; status?: number };

export interface HealthInfo {
  state: 'ok' | 'unauthorized' | 'unreachable' | 'error';
  engine?: EngineKind;
  detail?: Record<string, unknown>;
  message: string;
  version?: string;
  targets?: string[];
  models?: Record<string, string>;
}

// content <-> background
export type BgMessage =
  | { type: 'translate-image'; id: string; url?: string; dataBase64?: string; mime?: string; pageUrl: string; attempt?: number }
  | { type: 'cancel'; ids: string[] }
  | { type: 'health'; load?: boolean }
  | { type: 'translate-text'; texts: string[] };

// popup/background -> content
export type ContentCommand =
  | { type: 'start' }
  | { type: 'toggle' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' }
  | { type: 'retry-failed' }
  | { type: 'scan' }
  | { type: 'status' };

export interface Progress {
  discovered: number;
  waiting: number; // found but source not resolvable yet (lazy, no URL)
  queued: number;
  processing: number;
  done: number;
  failed: number;
  paused: boolean;
  running: boolean;
  showingOriginal: boolean;
  notes: string[];
}
