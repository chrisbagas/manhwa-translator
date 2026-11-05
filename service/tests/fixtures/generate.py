"""Generate synthetic manhwa-style test pages with ground truth.

Every image here is generated from scratch (procedural "artwork", OFL fonts,
original Korean sentences), so the fixtures are free to redistribute.

    python tests/fixtures/generate.py [out_dir]

Writes <name>.png plus <name>.json ground truth describing each text block:
its text, kind (dialogue/narration/sfx), bubble box and expected reading order.
"""

from __future__ import annotations

import json
import math
import random
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
FONT_DIR = HERE.parent / "fonts"
NOTO_KR = FONT_DIR / "NotoSansKR.ttf"
SFX_FONT = FONT_DIR / "BlackHanSans-Regular.ttf"


@dataclass
class Block:
    text: str  # Korean text with "\n" at the drawn line breaks
    kind: str  # dialogue | narration | sfx
    order: int
    box: list[int]  # [x, y, w, h] of the bubble / box / sfx glyphs
    text_box: list[int] = field(default_factory=list)
    angle: float = 0.0


def font(size: int, weight: int = 500, path: Path = NOTO_KR) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(path), size)
    if path == NOTO_KR:
        try:
            f.set_variation_by_axes([weight])
        except Exception:
            pass
    return f


def artwork(w: int, h: int, seed: int) -> Image.Image:
    """Procedural 'panel art': gradients, soft shapes and hatching."""
    rnd = random.Random(seed)
    img = Image.new("RGB", (w, h))
    px = img.load()
    c1 = [rnd.randint(120, 230) for _ in range(3)]
    c2 = [rnd.randint(40, 160) for _ in range(3)]
    for y in range(h):
        t = (math.sin(y / 700.0 + seed) + 1) / 2
        row = tuple(int(c1[i] * t + c2[i] * (1 - t)) for i in range(3))
        for x in range(0, w):
            px[x, y] = row
    d = ImageDraw.Draw(img)
    for _ in range(max(6, h // 120)):
        cx, cy = rnd.randint(0, w), rnd.randint(0, h)
        r = rnd.randint(40, 220)
        col = tuple(rnd.randint(30, 220) for _ in range(3))
        if rnd.random() < 0.5:
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
        else:
            d.polygon([(cx + r * math.cos(a), cy + r * math.sin(a)) for a in [rnd.random() * 6.28 for _ in range(5)]], fill=col)
    for _ in range(h // 40):
        x0, y0 = rnd.randint(0, w), rnd.randint(0, h)
        d.line([x0, y0, x0 + rnd.randint(-120, 120), y0 + rnd.randint(-120, 120)], fill=(20, 20, 30), width=rnd.randint(1, 3))
    return img.filter(ImageFilter.GaussianBlur(1.2))


def text_size(d: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, spacing: int) -> tuple[int, int]:
    l, t, r, b = d.multiline_textbbox((0, 0), text, font=f, spacing=spacing, align="center")
    return r - l, b - t


def speech_bubble(img: Image.Image, cx: int, cy: int, text: str, size: int = 30, *, pad: int = 34,
                  tail: tuple[int, int] | None = None, min_w: int = 0) -> tuple[list[int], list[int]]:
    """Draw a white ellipse bubble with black outline + tail, centred text."""
    d = ImageDraw.Draw(img)
    f = font(size, 600)
    spacing = int(size * 0.35)
    tw, th = text_size(d, text, f, spacing)
    rx = max(int(tw * 0.5 * 1.42) + pad, min_w // 2)
    ry = int(th * 0.5 * 1.42) + pad
    box = [cx - rx, cy - ry, cx + rx, cy + ry]
    if tail:
        tx, ty = tail
        d.polygon([(cx - rx * 0.25, cy + ry * 0.6), (cx + rx * 0.1, cy + ry * 0.7), (tx, ty)], fill=(0, 0, 0))
    d.ellipse(box, fill=(0, 0, 0))
    d.ellipse([box[0] + 3, box[1] + 3, box[2] - 3, box[3] - 3], fill=(255, 255, 255))
    if tail:
        d.polygon([(cx - rx * 0.25 + 4, cy + ry * 0.55), (cx + rx * 0.1 - 2, cy + ry * 0.62), (tx + 0, ty - 8)], fill=(255, 255, 255))
    d.multiline_text((cx, cy), text, font=f, fill=(10, 10, 10), anchor="mm", spacing=spacing, align="center")
    return [box[0], box[1], box[2] - box[0], box[3] - box[1]], [cx - tw // 2, cy - th // 2, tw, th]


def narration_box(img: Image.Image, x: int, y: int, text: str, size: int = 26, dark: bool = True) -> tuple[list[int], list[int]]:
    d = ImageDraw.Draw(img)
    f = font(size, 400)
    spacing = int(size * 0.3)
    tw, th = text_size(d, text, f, spacing)
    w, h = tw + 60, th + 50
    bg, fg = ((25, 25, 35), (245, 245, 245)) if dark else ((250, 244, 220), (30, 30, 30))
    d.rectangle([x, y, x + w, y + h], fill=bg, outline=(0, 0, 0), width=2)
    d.multiline_text((x + w // 2, y + h // 2), text, font=f, fill=fg, anchor="mm", spacing=spacing, align="center")
    return [x, y, w, h], [x + 30, y + 25, tw, th]


def sfx(img: Image.Image, cx: int, cy: int, text: str, size: int, angle: float,
        fill=(255, 220, 40), outline=(20, 10, 0)) -> list[int]:
    f = font(size, path=SFX_FONT)
    tmp = Image.new("RGBA", (size * (len(text) + 2), size * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    d.text((tmp.width // 2, tmp.height // 2), text, font=f, fill=fill, anchor="mm",
           stroke_width=max(3, size // 12), stroke_fill=outline)
    tmp = tmp.crop(tmp.getbbox()).rotate(angle, expand=True, resample=Image.BICUBIC)
    x, y = cx - tmp.width // 2, cy - tmp.height // 2
    img.paste(tmp, (x, y), tmp)
    return [x, y, tmp.width, tmp.height]


def save(out: Path, name: str, img: Image.Image, blocks: list[Block], **meta) -> None:
    img.save(out / f"{name}.png", optimize=True)
    (out / f"{name}.json").write_text(json.dumps({
        "image": f"{name}.png", "width": img.width, "height": img.height,
        "blocks": [asdict(b) for b in sorted(blocks, key=lambda b: b.order)], **meta,
    }, ensure_ascii=False, indent=1), encoding="utf-8")


def make_all(out: Path) -> list[str]:
    out.mkdir(parents=True, exist_ok=True)
    names = []

    # 1. One bubble of ordinary dialogue.
    img = artwork(800, 1100, 1)
    b, t = speech_bubble(img, 400, 420, "도대체 여기서\n뭘 하고 있는 거야?", 34, tail=(470, 640))
    save(out, "dialogue_single", img, [Block("도대체 여기서\n뭘 하고 있는 거야?", "dialogue", 0, b, t)])
    names.append("dialogue_single")

    # 2. Several bubbles + narration; two bubbles share a row (left one first for Korean).
    img = artwork(800, 2000, 2)
    blocks = []
    bx, tx = narration_box(img, 60, 60, "그날 밤, 모든 것이 바뀌었다.", 28)
    blocks.append(Block("그날 밤, 모든 것이 바뀌었다.", "narration", 0, bx, tx))
    b, t = speech_bubble(img, 230, 560, "형, 저기 봐!", 32, tail=(260, 760))
    blocks.append(Block("형, 저기 봐!", "dialogue", 1, b, t))
    b, t = speech_bubble(img, 590, 640, "조용히 해.\n들키면 끝이야.", 30, tail=(560, 840))
    blocks.append(Block("조용히 해.\n들키면 끝이야.", "dialogue", 2, b, t))
    b, t = speech_bubble(img, 400, 1250, "괜찮아.\n내가 지켜 줄게.", 32, tail=(420, 1450))
    blocks.append(Block("괜찮아.\n내가 지켜 줄게.", "dialogue", 3, b, t))
    b, t = speech_bubble(img, 420, 1750, "약속할게.", 30)
    blocks.append(Block("약속할게.", "dialogue", 4, b, t))
    save(out, "multi_bubbles", img, blocks)
    names.append("multi_bubbles")

    # 3. A very tall strip. Bubbles are placed on and around the default tile
    #    boundaries (tile 1600 px, overlap 256 px -> stride 1344 px).
    img = artwork(720, 9000, 3)
    blocks = []
    lines = [
        ("어디로 가는 거야?", 700), ("기다려!\n나도 같이 갈래!", 1344), ("이건 함정이야.", 2050),
        ("믿을 수가 없어...", 2688), ("지금이야!\n뛰어!", 4032), ("살았다...", 5376),
        ("고마워.\n정말 고마워.", 6900), ("다음에 또 보자.", 8400),
    ]
    for i, (txt, y) in enumerate(lines):
        cx = 260 if i % 2 == 0 else 460
        b, t = speech_bubble(img, cx, y, txt, 30)
        blocks.append(Block(txt, "dialogue", i, b, t))
    save(out, "tall_strip", img, blocks, tile={"height": 1600, "overlap": 256})
    names.append("tall_strip")

    # 4. Rotated sound effect over artwork + one normal bubble.
    img = artwork(800, 1300, 4)
    blocks = []
    b, t = speech_bubble(img, 260, 260, "누구야?", 32)
    blocks.append(Block("누구야?", "dialogue", 0, b, t))
    sb = sfx(img, 470, 800, "쾅!", 170, angle=18)
    blocks.append(Block("쾅!", "sfx", 1, sb, sb, angle=18))
    save(out, "sfx_rotated", img, blocks)
    names.append("sfx_rotated")

    # 5. A small bubble whose English translation will be much longer.
    img = artwork(700, 900, 5)
    b, t = speech_bubble(img, 350, 400, "뭐라고?!\n말도 안 돼!\n어떻게 그럴 수가?", 26, pad=14)
    save(out, "long_translation", img, [Block("뭐라고?!\n말도 안 돼!\n어떻게 그럴 수가?", "dialogue", 0, b, t)])
    names.append("long_translation")

    # 6. A short chapter split into several images (for lazy-loading browser tests).
    chapter = [
        ["오늘부터 이 학교에\n다니게 됐어."], ["반가워.\n난 서진이야."], ["너, 어디서 본 것 같은데?"],
        ["기분 탓이겠지."], ["...정말 그럴까?"], ["내일 보자!"],
    ]
    for i, texts in enumerate(chapter):
        img = artwork(720, 1400, 10 + i)
        blocks = []
        for j, txt in enumerate(texts):
            b, t = speech_bubble(img, 360, 500 + j * 500, txt, 32)
            blocks.append(Block(txt, "dialogue", j, b, t))
        save(out, f"chapter_{i + 1:02d}", img, blocks)
        names.append(f"chapter_{i + 1:02d}")
    # 7. Real-site style: two jagged bubbles that touch, thin anti-aliased
    #    outlines on a white page, and a faint grey site watermark.
    img = Image.new("RGB", (720, 1300), (255, 255, 255))
    art = artwork(720, 700, 21)
    d = ImageDraw.Draw(img)
    img.paste(art, (0, 600))
    d.polygon([(0, 600), (720, 420), (720, 600)], fill=(255, 255, 255))
    blocks = []
    def jagged(poly, text, size, order):
        d.polygon(poly, fill=(255, 255, 255))
        d.line(poly + [poly[0]], fill=(25, 25, 25), width=2, joint="curve")
        xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
        cx, cy = (min(xs) + max(xs)) // 2, (min(ys) + max(ys)) // 2
        f = font(size, 500)
        d.multiline_text((cx, cy), text, font=f, fill=(15, 15, 15), anchor="mm", spacing=int(size * 0.35), align="center")
        tw, th = text_size(d, text, f, int(size * 0.35))
        blocks.append(Block(text, "dialogue", order, [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)], [cx - tw // 2, cy - th // 2, tw, th]))
    jagged([(70, 120), (300, 128), (330, 100), (420, 122), (400, 300), (380, 330), (300, 316), (95, 330), (60, 220)], "이건 최종 무기다.\n우리가 갈 필요는\n없어!", 26, 0)
    jagged([(410, 240), (690, 228), (680, 470), (480, 500), (450, 560), (440, 500), (395, 480)], "물러서!\n지금 당장!", 30, 1)
    # Watermark: small light-grey text (site name), partly over the left bubble.
    wm = Image.new("RGBA", img.size, (0, 0, 0, 0))
    wd = ImageDraw.Draw(wm)
    wf = font(15, 400)
    for (x, y) in [(260, 140), (300, 700), (420, 1050)]:
        wd.multiline_text((x, y), "가장 빠른 웹툰사이트\n웹툰왕국뉴토끼469", font=wf, fill=(150, 150, 150, 110), spacing=2)
    img = Image.alpha_composite(img.convert("RGBA"), wm).convert("RGB")
    save(out, "site_bubbles", img, blocks, ignore="watermark text must not be translated")
    names.append("site_bubbles")

    # 8. Item window (game-system box): dark textured semi-transparent box with
    #    a gold frame, partly covered by a diagonal art band; label/value lines,
    #    a separator and two columns of stats.
    rnd = random.Random(8)
    img = artwork(720, 1000, 22)
    d = ImageDraw.Draw(img)
    d.polygon([(560, 0), (720, 0), (720, 1000), (600, 1000)], fill=(255, 255, 255))
    box = Image.new("RGBA", (520, 560), (60, 58, 54, 238))
    bd = ImageDraw.Draw(box)
    for _ in range(1500):
        x, y = rnd.randint(0, 519), rnd.randint(0, 559)
        g = rnd.randint(48, 74)
        bd.point((x, y), fill=(g, g, g - 4, 238))
    for cx, cy in [(14, 14), (506, 14), (14, 546), (506, 546)]:
        bd.arc([cx - 22, cy - 22, cx + 22, cy + 22], 0, 360, fill=(212, 170, 60, 255), width=4)
    img.paste(box, (100, 220), box)
    d = ImageDraw.Draw(img)
    d.polygon([(100, 220), (330, 220), (100, 380)], fill=(80, 90, 140))  # art over the corner
    f = font(27, 400)
    white = (246, 246, 240)
    head = ["그림자 아이템 : 가봇 Lv.11", "창조 등급: 영웅", "종류: 방어구(몸통)", "스탯 구현률 21%", "방어력 +120"]
    for i, t in enumerate(head):
        d.text((150, 270 + i * 44), t, font=f, fill=white)
    d.line([(140, 520), (560, 520)], fill=white, width=2)
    d.polygon([(552, 512), (560, 504), (568, 512), (560, 520)], fill=white)
    left, right = ["근력 +15", "민첩 +18", "감각 +15"], ["체력 +12", "지능 +10"]
    for i, t in enumerate(left):
        d.text((150, 560 + i * 46), t, font=f, fill=white)
    for i, t in enumerate(right):
        d.text((370, 560 + i * 46), t, font=f, fill=white)
    blocks.clear()
    blocks.append(Block("\n".join(head + left + right), "narration", 0, [100, 220, 520, 560], [150, 270, 330, 420]))
    save(out, "system_box", img, blocks, lines=head + left + right)
    names.append("system_box")
    # 9. Double bubble: two lobes of ONE white shape, one sentence continuing
    #    from the first lobe into the second, and a faint watermark across it.
    img = artwork(720, 1000, 31)
    d = ImageDraw.Draw(img)
    for box in ([330, 280, 690, 520], [70, 430, 470, 760]):
        d.ellipse(box, fill=(0, 0, 0))
    for box in ([334, 284, 686, 516], [74, 434, 466, 756]):
        d.ellipse(box, fill=(255, 255, 255))
    f = font(30, 500)
    t1, t2 = "사신 길드는\n독립성이 강하니", "자신들끼리\n따로 움직이고 있을\n가능성이 높죠."
    d.multiline_text((510, 395), t1, font=f, fill=(15, 15, 15), anchor="mm", spacing=10, align="center")
    d.multiline_text((270, 600), t2, font=f, fill=(15, 15, 15), anchor="mm", spacing=10, align="center")
    wm = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(wm).multiline_text((300, 520), "가장 빠른 웹툰사이트\n웹툰왕국뉴토끼469", font=font(15, 400), fill=(150, 150, 150, 120), spacing=2)
    img = Image.alpha_composite(img.convert("RGBA"), wm).convert("RGB")
    save(out, "double_bubble", img, [Block(t1, "dialogue", 0, [330, 280, 360, 240]), Block(t2, "dialogue", 1, [70, 430, 400, 330])],
         meaning="The Reaper Guild is very independent, so there's a good chance they're moving on their own.")
    names.append("double_bubble")
    return names


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "generated"
    for n in make_all(target):
        print(target / f"{n}.png")
