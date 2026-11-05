import { ext, formatGlossary, loadSettings, parseGlossary, saveSettings } from '../shared/browser';
import type { ContentCommand, EngineKind, HealthInfo, SfxMode } from '../shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const LANG_NAMES: Record<string, string> = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', id: 'Indonesian', vi: 'Vietnamese', ru: 'Russian', pl: 'Polish', nl: 'Dutch', tr: 'Turkish' };

// ?tab=<id> lets tests drive a specific tab; normally the active tab is used.
async function targetTab(): Promise<number | undefined> {
  const forced = new URLSearchParams(location.search).get('tab');
  if (forced) return Number(forced);
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function showMsg(text: string | null) {
  const m = $('msg');
  m.hidden = !text;
  m.textContent = text ?? '';
}

async function command(cmd: ContentCommand) {
  const tabId = await targetTab();
  if (tabId === undefined) return showMsg('No active tab.');
  const r = (await ext.runtime.sendMessage({ type: 'command-tab', tabId, cmd })) as { ok: boolean; error?: string };
  if (!r?.ok) showMsg(`Could not run on this page: ${r?.error ?? 'unknown error'} (browser pages and the extension store cannot be translated).`);
  else showMsg(null);
}

async function refreshHealth() {
  const h = (await ext.runtime.sendMessage({ type: 'health' })) as HealthInfo;
  const st = $('status');
  const builtin = h.engine === 'builtin';
  st.textContent = h.state === 'ok' ? (builtin ? 'built-in ready' : 'service ok') : h.state === 'unauthorized' ? 'needs token' : h.state === 'unreachable' ? 'service offline' : 'error';
  st.className = `status ${h.state === 'ok' ? 'ok' : h.state === 'unauthorized' ? 'warn' : 'bad'}`;
  st.title = h.message;
  if (h.state !== 'ok') showMsg(h.message);
  if (h.targets?.length) {
    const sel = $<HTMLSelectElement>('targetLang');
    const cur = sel.value;
    sel.textContent = '';
    for (const t of h.targets) sel.append(new Option(LANG_NAMES[t] ?? t, t));
    sel.value = h.targets.includes(cur) ? cur : h.targets[0];
  }
}

async function init() {
  const s = await loadSettings();
  $<HTMLSelectElement>('targetLang').value = s.targetLang;
  $<HTMLInputElement>('textScale').value = String(s.textScale);
  $('textScaleVal').textContent = `${Math.round(s.textScale * 100)}%`;
  $<HTMLSelectElement>('sfxMode').value = s.sfxMode;
  $<HTMLTextAreaElement>('glossary').value = formatGlossary(s.glossary);
  $<HTMLInputElement>('token').value = s.token;
  $<HTMLInputElement>('serviceUrl').value = s.serviceUrl;
  $<HTMLSelectElement>('engine').value = s.engine;
  const showService = () => ($('serviceFields').hidden = $<HTMLSelectElement>('engine').value !== 'service');
  showService();
  $('engine').addEventListener('change', showService);
  if (s.engine === 'service' && !s.token) $<HTMLDetailsElement>('settings').open = true;

  $<HTMLInputElement>('textScale').addEventListener('input', async (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    $('textScaleVal').textContent = `${Math.round(v * 100)}%`;
    await saveSettings({ textScale: v });
  });
  $('save').addEventListener('click', async () => {
    const url = $<HTMLInputElement>('serviceUrl').value.trim().replace(/\/+$/, '');
    if ($<HTMLSelectElement>('engine').value === 'service') try {
      const u = new URL(url);
      if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error();
    } catch {
      return showMsg('Service URL must be http://127.0.0.1:<port> or http://localhost:<port>.');
    }
    await saveSettings({
      engine: $<HTMLSelectElement>('engine').value as EngineKind,
      targetLang: $<HTMLSelectElement>('targetLang').value,
      sfxMode: $<HTMLSelectElement>('sfxMode').value as SfxMode,
      glossary: parseGlossary($<HTMLTextAreaElement>('glossary').value),
      token: $<HTMLInputElement>('token').value.trim(),
      serviceUrl: url,
    });
    showMsg(null);
    await refreshHealth();
  });
  $('translate').addEventListener('click', async () => {
    await ensureHostAccess();
    await command({ type: 'start' });
  });
  $('toggle').addEventListener('click', () => command({ type: 'toggle' }));
  $('scan').addEventListener('click', () => command({ type: 'scan' }));
  $('grant').addEventListener('click', () => ensureHostAccess());
  const has = await ext.permissions.contains({ origins: ['<all_urls>'] });
  $('grant').hidden = has;
  await refreshHealth();
}

/** Firefox MV3 treats host permissions as opt-in; ask from a user gesture. */
async function ensureHostAccess() {
  // Call request() directly (no await before it) so Firefox keeps the user gesture.
  try {
    await ext.permissions.request({ origins: ['<all_urls>'] });
  } catch {
    /* Chrome grants at install; request may be unsupported in tests */
  }
}

void init();
