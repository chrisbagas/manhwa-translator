// Text helpers shared by both engines (ports of service/dalbit/translate/*.py).

// Korean onomatopoeia -> short English glosses (hand-written for this project).
export const LEXICON_KO: Record<string, string> = {"쾅": "BOOM", "쿵": "THUD", "쿠궁": "RUMBLE", "콰광": "KA-BOOM", "콰앙": "KA-BOOM", "펑": "POW", "퍽": "WHAM", "팍": "WHACK", "빡": "SMACK", "짝": "SLAP", "철썩": "SPLASH", "첨벙": "SPLASH", "탁": "TAP", "톡": "TAP", "똑": "KNOCK", "똑똑": "KNOCK KNOCK", "딸깍": "CLICK", "찰칵": "CLICK", "쨍그랑": "CRASH", "와장창": "CRASH", "우당탕": "CLATTER", "쿵쾅": "STOMP", "쾅쾅": "BANG BANG", "휙": "WHOOSH", "쉭": "SWISH", "슉": "SHOOP", "훅": "WHOOSH", "휘익": "WHOOSH", "샥": "SWISH", "두근": "BA-DUM", "두근두근": "BA-DUM BA-DUM", "콩닥": "THUMP-THUMP", "쿵쾅쿵쾅": "THUMP THUMP", "번쩍": "FLASH", "반짝": "SPARKLE", "빤짝": "SPARKLE", "스윽": "SHFF", "슥": "SHF", "부들": "TREMBLE", "덜덜": "SHIVER", "후들": "WOBBLE", "움찔": "FLINCH", "흠칫": "STARTLE", "털썩": "FLOP", "풀썩": "FLOP", "벌떡": "JOLT UP", "꿀꺽": "GULP", "꿀떡": "GULP", "냠": "NOM", "냠냠": "NOM NOM", "쩝": "SMACK", "후": "PHEW", "휴": "PHEW", "하아": "HAAH", "헉": "GASP", "흑": "SOB", "훌쩍": "SNIFF", "킥": "SNICKER", "킥킥": "HEHE", "크크": "HEH HEH", "ㅋㅋ": "LOL", "ㅋㅋㅋ": "LOL", "하하": "HAHA", "히히": "HEHE", "흐흐": "HEH HEH", "깔깔": "CACKLE", "으악": "AAARGH", "꺅": "EEK", "꺄악": "KYAAH", "아악": "AAAH", "윽": "UGH", "읏": "NGH", "쿨럭": "COUGH", "콜록": "COUGH", "에취": "ACHOO", "쯧": "TSK", "칫": "TCH", "흥": "HMPH", "부릉": "VROOM", "끼익": "SCREECH", "빵빵": "HONK HONK", "띵동": "DING-DONG", "따르릉": "RING RING", "지잉": "BZZT", "위잉": "WHIRR", "삐": "BEEP", "삐빅": "BEEP-BEEP", "째깍": "TICK", "똑딱": "TICK-TOCK", "주르륵": "TRICKLE", "뚝뚝": "DRIP DRIP", "뚝": "DRIP", "보글": "BUBBLE", "치익": "SIZZLE", "활활": "BLAZE", "화르륵": "WHOOSH", "우르릉": "RUMBLE", "쏴아": "SHHHH", "솨아": "SHHHH", "꽉": "SQUEEZE", "꾹": "PRESS", "덥석": "GRAB", "툭": "POKE", "쿡": "JAB", "찌릿": "ZAP", "빠직": "SNAP", "뚜둑": "CRACK", "우두둑": "CRUNCH", "바스락": "RUSTLE", "부스럭": "RUSTLE", "저벅": "STEP", "터벅": "TRUDGE", "뚜벅": "STEP", "타닥": "PATTER", "후다닥": "DASH", "쌩": "ZOOM", "슝": "ZOOM", "번뜩": "GLINT", "히죽": "SMIRK", "씨익": "GRIN", "방긋": "SMILE", "멍": "BLANK", "글썽": "TEARY", "끄덕": "NOD", "도리도리": "HEAD SHAKE", "빼꼼": "PEEK", "힐끔": "GLANCE", "쓱": "SHF", "꿈틀": "TWITCH", "부르르": "SHUDDER", "벌컥": "BURST OPEN", "철컥": "CLACK"};

const PUNCT = /[\s!?.,~…\-ー·:;'"“”‘’()[\]]+/g;
export const normalizeSfx = (t: string) => t.replace(PUNCT, '');

function collapseRepeats(s: string): [string, number] {
  for (let size = 1; size <= Math.floor(s.length / 2); size++) {
    const unit = s.slice(0, size);
    if (s.length % size === 0 && unit.repeat(s.length / size) === s) return [unit, s.length / size];
  }
  return [s, 1];
}

export function sfxLookup(text: string, lang = 'ko'): string | null {
  if (lang !== 'ko') return null;
  const s = normalizeSfx(text);
  if (!s) return null;
  const [unit, reps] = collapseRepeats(s);
  const cands = [s];
  if (reps > 1) cands.push(unit);
  const stripped = s.replace(/[아앙으응우웅이잉어엉]+$/, '');
  if (stripped && stripped !== s) cands.push(stripped);
  for (const c of cands) {
    let gloss = LEXICON_KO[c];
    if (!gloss) continue;
    if (c === unit && reps > 1 && c !== s) gloss = Array(Math.min(reps, 3)).fill(gloss).join(' ');
    return gloss + (text.includes('!') ? '!' : '');
  }
  return null;
}

export function looksLikeSfx(text: string, lang = 'ko'): boolean {
  const s = normalizeSfx(text);
  if (!s || [...s].length > 6) return false;
  if (sfxLookup(text, lang)) return true;
  const [unit, reps] = collapseRepeats(s);
  return reps > 1 && unit.length <= 2;
}

const INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const VOWELS = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const FINALS = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
const JAMO: Record<string, string> = { ㄱ: 'g', ㄲ: 'kk', ㄴ: 'n', ㄷ: 'd', ㄹ: 'r', ㅁ: 'm', ㅂ: 'b', ㅅ: 's', ㅆ: 'ss', ㅇ: '', ㅈ: 'j', ㅊ: 'ch', ㅋ: 'k', ㅌ: 't', ㅍ: 'p', ㅎ: 'h', ㅏ: 'a', ㅓ: 'eo', ㅗ: 'o', ㅜ: 'u', ㅡ: 'eu', ㅣ: 'i' };

/** Hangul -> Revised Romanization, syllable by syllable. */
export function romanize(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)! - 0xac00;
    if (code >= 0 && code < 11172) {
      out += INITIALS[Math.floor(code / 588)] + VOWELS[Math.floor((code % 588) / 28)] + FINALS[code % 28];
    } else out += JAMO[ch] ?? ch;
  }
  return out;
}

/** Glossary pre-substitution (longest term first). */
export function applyGlossary(text: string, glossary: Record<string, string>): { text: string; used: string[] } {
  const used: string[] = [];
  for (const src of Object.keys(glossary).sort((a, b) => b.length - a.length)) {
    if (text.includes(src)) {
      text = text.split(src).join(glossary[src]);
      used.push(src);
    }
  }
  return { text, used };
}

export function glossaryKey(g: Record<string, string>): string {
  const entries = Object.entries(g).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length ? JSON.stringify(entries) : 'none';
}

const SENT_END = /[.!?…~♡♥]+["'”’」』)]*(?=\s)/g;
export function splitSentences(text: string): string[] {
  text = text.trim();
  const parts: string[] = [];
  let start = 0;
  for (const m of text.matchAll(SENT_END)) {
    parts.push(text.slice(start, m.index! + m[0].length).trim());
    start = m.index! + m[0].length;
  }
  parts.push(text.slice(start).trim());
  const out = parts.filter(Boolean);
  return out.length ? out : [text];
}

export const HANGUL = /[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]/;
export function scriptOk(text: string, lang: string): boolean {
  if (lang === 'ko') return HANGUL.test(text);
  if (lang === 'ja') return /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
  if (lang === 'zh') return /[\u4e00-\u9fff]/.test(text);
  return !!text.trim();
}

/** Common game-system window vocabulary (written for this project). Applied
 *  only inside structured item/stat windows, never to dialogue. */
export const SYSTEM_TERMS_KO: Record<string, string> = {
  '스탯': 'Stats', '스킬': 'Skill', '액티브 스킬': 'Active Skill', '패시브 스킬': 'Passive Skill', '레벨': 'Level',
  '근력': 'Strength', '힘': 'Strength', '민첩': 'Agility', '체력': 'Vitality', '지능': 'Intelligence', '감각': 'Perception',
  '마력': 'Magic Power', '정신력': 'Willpower', '행운': 'Luck', '방어력': 'Defense', '공격력': 'Attack', '마법 방어력': 'Magic Defense',
  '생명력': 'HP', '마나': 'Mana', '경험치': 'EXP', '등급': 'Grade', '창조 등급': 'Creation Grade', '영웅': 'Hero', '전설': 'Legendary',
  '희귀': 'Rare', '일반': 'Common', '고급': 'Uncommon', '유일': 'Unique', '신화': 'Mythic', '아이템': 'Item', '종류': 'Type',
  '방어구': 'Armor', '무기': 'Weapon', '장신구': 'Accessory', '몸통': 'Body', '머리': 'Head', '다리': 'Legs', '구현률': 'Implementation Rate',
  '필요 마나': 'Mana Cost', '소모 마나': 'Mana Cost', '재사용 대기시간': 'Cooldown', '쿨타임': 'Cooldown', '지속 시간': 'Duration',
  '퀘스트': 'Quest', '보상': 'Reward', '알림': 'Notice', '상태창': 'Status Window', '칭호': 'Title', '직업': 'Class', '그림자': 'Shadow',
};

/** Korean line-final particles / connectives: the sentence continues on the next line. */
export function continuesOnNextLine(line: string): boolean {
  const t = line.trim();
  if (/[.!?…:)\]'’"”]$/.test(t)) return false;
  return /(의|이|가|을|를|은|는|에|에서|에게|와|과|도|로|으로|고|며|면|서|지만|하여|하고|및|,)$/.test(t);
}

/** Split a translation across n lines with balanced character counts, cutting
 *  at the word boundary nearest to each 1/n of the total length. */
export function splitAcross(text: string, n: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (n <= 1 || words.length <= 1) return [words.join(' '), ...Array(Math.max(0, n - 1)).fill('')];
  const ends: number[] = []; // cumulative length after each word
  let acc = 0;
  for (const w of words) { acc += (acc ? 1 : 0) + w.length; ends.push(acc); }
  const cuts: number[] = [];
  let from = 0;
  for (let k = 1; k < n; k++) {
    const goal = (acc * k) / n;
    let best = -1, bestD = Infinity;
    // Leave at least one word for each remaining line.
    for (let j = from; j < words.length - (n - k); j++) {
      const d = Math.abs(ends[j] - goal);
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best < 0) break;
    cuts.push(best + 1);
    from = best + 1;
  }
  const out: string[] = [];
  let start = 0;
  for (const c of [...cuts, words.length]) { out.push(words.slice(start, c).join(' ')); start = c; }
  while (out.length < n) out.push('');
  return out;
}
