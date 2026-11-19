#!/usr/bin/env python3
"""Import native DevNet SA4 sets A and B from archived source exports.

Run with both source files in public/reviewers (or pass explicit paths).
--check compares generated assessment JSON and extracted exhibits to disk.
"""
import argparse
import base64
import json
import re
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_HTML = ROOT / "public/reviewers/devnet-sa4-reviewer.html"
DEFAULT_JSON = ROOT / "public/reviewers/devasc-m7-m8-question-bank.json"
EXHIBIT_MAP = {"m7-exam-12": "s1q12", "m8-exam-06": "s2q6", "m8-quiz-08": "s4q8"}


def image_size(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return struct.unpack(">II", data[16:24])
    if data.startswith(b"\xff\xd8"):
        i = 2
        while i < len(data):
            if data[i] != 0xff:
                i += 1
                continue
            marker = data[i + 1]
            length = int.from_bytes(data[i + 2:i + 4], "big")
            if 0xc0 <= marker <= 0xcf and marker not in (0xc4, 0xc8, 0xcc):
                return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
            i += 2 + length
    raise ValueError("Unsupported exhibit image")


def build(html_path, json_path):
    html = html_path.read_text(encoding="utf-8-sig")
    match = re.search(r'<script id="quiz-data"[^>]*>(.*?)</script>', html, re.S)
    if not match:
        raise ValueError("quiz-data script not found")
    sections = json.loads(match.group(1))
    sa4 = [b for b in sections if b.get("section") == "summative"]
    source_a = [q for b in sa4 for q in b["questions"]]
    if len(source_a) != 79:
        raise ValueError(f"Expected 79 SA4 questions, found {len(source_a)}")
    out_a = []
    for q in source_a:
        choices = [{"id": f"{q['id']}-{i + 1}", "text": c["text"], "correct": c["correct"]} for i, c in enumerate(q["options"])]
        item = {"id": q["id"], "type": "single", "prompt": q["stem"], "instruction": "Select every correct choice and no incorrect choices; no partial credit." if sum(c["correct"] for c in choices) > 1 else "Select one answer.", "choices": choices, "explanation": q.get("explanation", "")}
        if sum(c["correct"] for c in choices) > 1:
            item["type"] = "multi"
            item["choose"] = sum(c["correct"] for c in choices)
        if q.get("unscored"):
            item["unscored"] = True
        if q.get("references"):
            refs = "\n".join(f"{r['label']}: {r['url']}" for r in q["references"])
            item["explanation"] = f"{item['explanation']}\n\nReferences:\n{refs}" if item["explanation"] else f"References:\n{refs}"
        out_a.append(item)

    html_by_id = {q["id"]: q for b in sections for q in b["questions"]}
    raw_b = json_path.read_text(encoding="utf-8-sig")
    source_b = [q for q in json.loads(raw_b)["items"] if q["type"] == "mcq"]
    out_b = []
    exhibits = {}
    for q in source_b:
        qid = q["id"]
        item = {"id": qid, "type": "single", "prompt": q["question"], "instruction": "Select one answer.", "choices": [{"id": f"{qid}-{i + 1}", "text": text, "correct": text in q["correct_answers"]} for i, text in enumerate(q["choices"])], "explanation": q["explanation"]}
        if len(q["correct_answers"]) > 1:
            item.update(type="multi", choose=len(q["correct_answers"]), instruction=f"Select all that apply · choose {len(q['correct_answers'])}.")
        if q.get("sources"):
            item["explanation"] += "\n\nReferences:\n" + "\n".join(q["sources"])
        source_id = EXHIBIT_MAP.get(qid)
        if source_id:
            image = html_by_id[source_id].get("image")
            if not image:
                raise ValueError(f"Missing source exhibit {source_id}")
            mime, encoded = image.split(";base64,", 1)
            data = base64.b64decode(encoded)
            ext = "png" if "png" in mime else "jpg"
            name = f"devnet-{qid}.{'jpg' if ext == 'jpg' else 'png'}"
            exhibits[name] = data
            w, h = image_size(data)
            item["exhibits"] = [{"src": f"/exhibits/{name}", "alt": f"Exhibit for {q['question']}", "width": w, "height": h}]
        out_b.append(item)
    if len(out_b) != 52:
        raise ValueError(f"Expected 52 MCQs, found {len(out_b)}")
    return {"devnet-sa4-mock-exam-set-a": {"id": "devnet-sa4-mock-exam-set-a", "questions": out_a}, "devnet-sa4-mock-exam-set-b": {"id": "devnet-sa4-mock-exam-set-b", "questions": out_b}}, exhibits


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--html", type=Path, default=DEFAULT_HTML)
    parser.add_argument("--json", type=Path, default=DEFAULT_JSON)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    banks, exhibits = build(args.html, args.json)
    for bank_id, bank in banks.items():
        path = ROOT / "data/assessments" / f"{bank_id}.json"
        rendered = json.dumps(bank, ensure_ascii=False, indent=2) + "\n"
        if args.check:
            if json.loads(path.read_text(encoding="utf-8")) != bank:
                raise SystemExit(f"{path} differs from source")
        else:
            path.write_text(rendered, encoding="utf-8")
    for name, data in exhibits.items():
        path = ROOT / "public/exhibits" / name
        if args.check:
            if path.read_bytes() != data:
                raise SystemExit(f"{path} differs from source exhibit")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    print("Verified" if args.check else "Imported", "79 Set A and 52 Set B questions; 3 exhibits.")


if __name__ == "__main__":
    main()
