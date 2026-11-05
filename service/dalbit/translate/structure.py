"""Structured text (item windows, stat sheets, menus): translate line by line.

Mirrors extension/src/engine/text.ts + pipeline.ts (isStructured, units,
SYSTEM_TERMS_KO, splitAcross) so both engines lay text out the same way.
"""

from __future__ import annotations

import re

# Common game-system window vocabulary (written for this project). Applied only
# inside structured windows, never to dialogue.
SYSTEM_TERMS_KO: dict[str, str] = {
 "스탯": "Stats",
 "스킬": "Skill",
 "액티브 스킬": "Active Skill",
 "패시브 스킬": "Passive Skill",
 "레벨": "Level",
 "근력": "Strength",
 "힘": "Strength",
 "민첩": "Agility",
 "체력": "Vitality",
 "지능": "Intelligence",
 "감각": "Perception",
 "마력": "Magic Power",
 "정신력": "Willpower",
 "행운": "Luck",
 "방어력": "Defense",
 "공격력": "Attack",
 "마법 방어력": "Magic Defense",
 "생명력": "HP",
 "마나": "Mana",
 "경험치": "EXP",
 "등급": "Grade",
 "창조 등급": "Creation Grade",
 "영웅": "Hero",
 "전설": "Legendary",
 "희귀": "Rare",
 "일반": "Common",
 "고급": "Uncommon",
 "유일": "Unique",
 "신화": "Mythic",
 "아이템": "Item",
 "종류": "Type",
 "방어구": "Armor",
 "무기": "Weapon",
 "장신구": "Accessory",
 "몸통": "Body",
 "머리": "Head",
 "다리": "Legs",
 "구현률": "Implementation Rate",
 "필요 마나": "Mana Cost",
 "소모 마나": "Mana Cost",
 "재사용 대기시간": "Cooldown",
 "쿨타임": "Cooldown",
 "지속 시간": "Duration",
 "퀘스트": "Quest",
 "보상": "Reward",
 "알림": "Notice",
 "상태창": "Status Window",
 "칭호": "Title",
 "직업": "Class",
 "그림자": "Shadow"
}

ITEM_LINE = re.compile(r"\d|[:：%+\-−\[\]()（）【】<>·•]")
CONTINUES = re.compile(r"(의|이|가|을|를|은|는|에|에서|에게|와|과|도|로|으로|고|며|면|서|지만|하여|하고|및|,)$")


def is_list_like(lines: list[str]) -> bool:
    return len(lines) > 1 and all(re.search(r"\d", l) or len(re.sub(r"\s", "", l)) <= 4 for l in lines)


def is_structured(kind: str, lines: list[str], align: str) -> bool:
    if len(lines) < 2 or kind == "sfx":
        return False
    if is_list_like(lines):
        return True
    if kind == "dialogue" and align != "left":
        return False  # speech bubbles flow as sentences, however short the lines
    items = sum(1 for t in lines if ITEM_LINE.search(t))
    return items >= (len(lines) + 1) // 2


def continues_on_next_line(line: str) -> bool:
    t = line.strip()
    if re.search(r"[.!?…:)\]'’\"”]$", t):
        return False
    return bool(CONTINUES.search(t))


def units(lines: list[str]) -> list[list[int]]:
    out: list[list[int]] = []
    for k, _ in enumerate(lines):
        if out and continues_on_next_line(lines[out[-1][-1]]):
            out[-1].append(k)
        else:
            out.append([k])
    return out


def split_across(text: str, n: int) -> list[str]:
    words = text.split()
    if n <= 1 or len(words) <= 1:
        return [" ".join(words)] + [""] * max(0, n - 1)
    ends, acc = [], 0
    for w in words:
        acc += (1 if acc else 0) + len(w)
        ends.append(acc)
    cuts, start = [], 0
    for k in range(1, n):
        goal = acc * k / n
        cand = range(start, len(words) - (n - k))
        if not cand:
            break
        best = min(cand, key=lambda j: abs(ends[j] - goal))
        cuts.append(best + 1)
        start = best + 1
    out, s = [], 0
    for c in cuts + [len(words)]:
        out.append(" ".join(words[s:c]))
        s = c
    return out + [""] * (n - len(out))


BUBBLE_CONT = re.compile(r"(니|고|서|지만|는데|은데|던데|면|며|니까|라서|어서|아서|해서|도|거나|든지|면서|려고|자|,)$")


def bubble_continues(text: str) -> bool:
    t = text.strip()
    if re.search(r"[.!?…~)\]'’\"”]$", t):
        return False
    return bool(BUBBLE_CONT.search(t))


def split_weighted(text: str, weights: list[int]) -> list[str]:
    words = text.split()
    if len(weights) <= 1:
        return [" ".join(words)]
    total = sum(weights) or 1
    length = sum(len(w) + 1 for w in words) - 1
    out, i, acc, target = [], 0, 0.0, 0.0
    for n, w in enumerate(weights):
        target += w / total * length
        part, remaining = [], len(weights) - n - 1
        while i < len(words) - remaining and (n == len(weights) - 1 or not part or acc + len(words[i]) / 2 <= target):
            acc += len(words[i]) + 1
            part.append(words[i]); i += 1
        out.append(" ".join(part))
    return out
