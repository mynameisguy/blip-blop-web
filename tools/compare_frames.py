"""Compares native frame dumps (BMP) with browser dumps (raw RGBA).

usage: python3 tools/compare_frames.py <native_dir> <web_dir> [diff_dir]
Prints one line per frame and exits non-zero if any frame differs.
"""
import json
import os
import sys

from PIL import Image, ImageChops


def load_web(path_rgba):
    meta = json.load(open(path_rgba[:-5] + ".json"))
    raw = open(path_rgba, "rb").read()
    img = Image.frombuffer("RGBA", (meta["w"], meta["h"]), raw, "raw", "RGBA", meta["pitch"], 1)
    return img.convert("RGB")


def main():
    native_dir, web_dir = sys.argv[1], sys.argv[2]
    diff_dir = sys.argv[3] if len(sys.argv) > 3 else None
    if diff_dir:
        os.makedirs(diff_dir, exist_ok=True)
    names = sorted(f[:-4] for f in os.listdir(native_dir) if f.endswith(".bmp"))
    bad = 0
    for name in names:
        web_path = os.path.join(web_dir, name + ".rgba")
        if not os.path.exists(web_path):
            print(f"{name}: missing in browser dump")
            bad += 1
            continue
        a = Image.open(os.path.join(native_dir, name + ".bmp")).convert("RGB")
        b = load_web(web_path)
        diff = ImageChops.difference(a, b)
        box = diff.getbbox()
        if box is None:
            print(f"{name}: identical")
            continue
        bad += 1
        count = sum(1 for p in diff.getdata() if p != (0, 0, 0))
        print(f"{name}: {count} pixels differ in {box}")
        if diff_dir:
            side = Image.new("RGB", (a.width * 3, a.height))
            side.paste(a, (0, 0))
            side.paste(b, (a.width, 0))
            side.paste(diff.point(lambda v: 255 if v else 0), (a.width * 2, 0))
            side.save(os.path.join(diff_dir, name + ".png"))
    print(f"{len(names) - bad}/{len(names)} frames identical")
    sys.exit(1 if bad else 0)


main()
