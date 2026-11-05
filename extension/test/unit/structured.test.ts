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
    expect(seen).toEqual(['Mana Cost 300', '1분간 화염 스킬의 시전 시간이 30% 단축됩니다.']); // system terms only on item lines, never inside sentences
    expect(r.lines.map((l) => l.translated_text)).toHaveLength(3);
    expect(r.lines[0].translated_text).toBe('Mana Cost 300');
    expect(r.lines[1].translated_text && r.lines[2].translated_text).toBeTruthy();
  });
  it('hard line breaks are respected by the fitter', () => {
    const mono: Measure = (t, size) => t.length * size * 0.5;
    expect(fitText('Power +15\nHealth +12', 200, 100, { maxPx: 20, minPx: 8, measure: mono }).lines).toEqual(['Power +15', 'Health +12']);
  });
});

import { bubbleContinues, splitWeighted } from '../../src/engine/pipeline';
import { combineReadings, diff, makeLM } from '../../src/engine/lm';

describe('sentences across bubbles', () => {
  it('detects clause endings that continue into the next bubble', () => {
    expect(bubbleContinues('사신 길드는 독립성이 강하니')).toBe(true);
    expect(bubbleContinues('지금 당장!')).toBe(false);
    expect(bubbleContinues('살아 있습니다')).toBe(false);
  });
  it('splits one translation between bubbles by source length', () => {
    expect(splitWeighted('The guild has strong independence, so it is likely that they are moving on their own.', [12, 22]))
      .toEqual(['The guild has strong independence,', 'so it is likely that they are moving on their own.']);
  });
  it('translates a continued sentence once and splits it across the bubbles', async () => {
    const r1 = region(['사신 길드는', '독립성이 강하니'], 'dialogue'); r1.style.align = 'center'; r1.order = 0; r1.id = 'a';
    const r2 = region(['자신들끼리', '따로 움직이고 있을', '가능성이 높죠.'], 'dialogue'); r2.style.align = 'center'; r2.order = 1; r2.id = 'b';
    const seen: string[] = [];
    const out = await translateRegions([r1, r2], 'ko', {}, 'annotate', async (xs) => { seen.push(...xs); return xs.map(() => 'The guild is independent, so they probably move on their own.'); });
    expect(seen.join(' ')).toContain('강하니 자신들끼리');
    expect(out[0].layout).toBe('paragraph');
    expect(out[0].translated_text && out[1].translated_text).toBeTruthy();
    expect(`${out[0].translated_text} ${out[1].translated_text}`).toBe('The guild is independent, so they probably move on their own.');
  });
});

describe('combining two OCR readings', () => {
  // Toy LM: known Korean words score high, unknown characters low.
  const lm = makeLM(new Map([['▁사신', -2], ['▁길드는', -2], ['▁높죠', -2], ['.', -1], ['▁', -1], ['사', -8], ['신', -8], ['킬', -9], ['드', -8], ['는', -6], ['높', -8], ['조', -8], ['죠', -8], ['L', -6], ['v', -6], ['1', -6], ['I', -6]]));
  it('prefers the more plausible Korean and keeps the primary reader on Latin/digits', () => {
    expect(combineReadings(lm, '사신 킬드는', '사신 길드는')).toBe('사신 길드는');
    expect(combineReadings(lm, 'Lv.1', '[1ㅠ.1')).toBe('Lv.1');
  });
  it('character diff', () => {
    expect(diff('abcd', 'abxd')).toEqual([['equal', 'ab', 'ab'], ['change', 'c', 'x'], ['equal', 'd', 'd']]);
  });
});
