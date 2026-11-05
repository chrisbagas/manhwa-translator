import { describe, expect, it } from 'vitest';
import { contrast, readableColor } from '../../src/content/overlay';

describe('readable text colour', () => {
  it('keeps a good estimate', () => {
    expect(readableColor('#111111', '#ffffff')).toBe('#111111');
    expect(readableColor('#fffffc', '#4a4844')).toBe('#fffffc');
  });
  it('replaces low-contrast colours (grey on dark grey) with black or white', () => {
    expect(contrast('#7f7e7a', '#4a4844')).toBeLessThan(3);
    expect(readableColor('#7f7e7a', '#4a4844')).toBe('#ffffff');
    expect(readableColor('#dddddd', '#f4f4f4')).toBe('#111111');
  });
});
