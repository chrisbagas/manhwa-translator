import { describe, expect, it } from 'vitest';
import { isStructured, translateRegions } from '../../src/engine/pipeline';
import { continuesOnNextLine, splitAcross } from '../../src/engine/text';
import { fitText, type Measure } from '../../src/content/fit';
import type { Region } from '../../src/shared/types';

const region = (lines: string[], kind: Region['kind'] = 'narration'): Region => ({
  id: 'r', order: 0, kind, bbox: [0, 0, 100, 100], angle: 0, source_text: lines.join(' '), translated_text: '', translation_note: '', confidence: 0.9,
  lines: lines.map((t, i) => ({ quad: [], text: t, confidence: 0.9, angle: 0, bbox: [0, i * 40, 200, i * 40 + 30] })),
  style: { fg: '#fff', outline: null, outline_px: 0, font_px: 20, weight: 500, align: 'left', orientation: 'horizontal', angle: 0 },
  bubble: null, patch: null, patch_box: null, render_box: [0, 0, 300, 300], render_mode: 'replace', flags: [],
});

describe('structured (line-by-line) text', () => {
  it('recognises item windows, stat sheets and keeps speech bubbles as paragraphs', () => {
    expect(isStructured(region(['그림자 아이템 : 가봇 Lv.11', '창조 등급: 영웅', '종류: 방어구(몸통)', '스탯 구현률 21%', '방어력 +120']))).toBe(true);
    expect(isStructured(region(['근력 +15', '민첩 +18', '감각 +15']))).toBe(true);
    const bubble = region(['마 사범님,', '아직 마수가', '살아 있습니다!'], 'dialogue');
    bubble.style.align = 'center';
    expect(isStructured(bubble)).toBe(false);
  });
  it('detects sentences continuing on the next line', () => {
    expect(continuesOnNextLine('1분간 화염 스킬의')).toBe(true);
    expect(continuesOnNextLine('필요 마나 300')).toBe(false);
    expect(continuesOnNextLine('창조 등급: 영웅')).toBe(false);
  });
  it('splits a translation across lines at word boundaries, balanced', () => {
    expect(splitAcross('Reduces the cast time of fire skills by 30% for 1 minute.', 2)).toEqual(['Reduces the cast time of fire', 'skills by 30% for 1 minute.']);
    expect(splitAcross('One', 2)).toEqual(['One', '']);
    expect(splitAcross('a b c', 3)).toEqual(['a', 'b', 'c']);
  });
  it('translates item lines one by one, joins continued sentences, applies system terms', async () => {
    const seen: string[] = [];
    const fake = async (xs: string[]) => { seen.push(...xs); return xs.map((x) => x.replace(/[가-힣]+/g, 'K').trim()); };
    const [r] = await translateRegions([region(['필요 마나 300', '1분간 화염 스킬의', '시전 시간이 30% 단축됩니다.'])], 'ko', {}, 'annotate', fake);
    expect(r.layout).toBe('lines');
    expect(seen).toEqual(['Mana Cost 300', '1분간 화염 Skill의 시전 시간이 30% 단축됩니다.']);
    expect(r.lines.map((l) => l.translated_text)).toHaveLength(3);
    expect(r.lines[0].translated_text).toBe('Mana Cost 300');
    expect(r.lines[1].translated_text && r.lines[2].translated_text).toBeTruthy();
  });
  it('hard line breaks are respected by the fitter', () => {
    const mono: Measure = (t, size) => t.length * size * 0.5;
    expect(fitText('Power +15\nHealth +12', 200, 100, { maxPx: 20, minPx: 8, measure: mono }).lines).toEqual(['Power +15', 'Health +12']);
  });
});
