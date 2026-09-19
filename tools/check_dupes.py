#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""导入前体检：找出重复/疑似重复的 GPX，避免同一批数据在站点上变成好几条。

用法:
    python tools/check_dupes.py

明细写到 data/_scan.json（自测产物，已在 .gitignore 里忽略）。
"""
import hashlib
import json
import math
import os
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from tools.build_routes import parse_gpx  # noqa: E402

GPX = os.path.join(ROOT, "gpx")
SCAN = os.path.join(ROOT, "data", "_scan.json")


def hav(a, b):
    R = 6371.0088
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp = math.radians(b[1] - a[1])
    dl = math.radians(b[0] - a[0])
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))


def sample(coords, n=40):
    """沿路径等距取 n 个点，作为形状指纹"""
    if len(coords) < 2:
        return coords
    out = []
    for i in range(n):
        k = int(i * (len(coords) - 1) / (n - 1))
        out.append(coords[k])
    return out


def shape_match(a, b, tol_km=0.05):
    """a 里有多大比例的点能在 b 附近 50m 内找到点（双向）"""

    def one_way(p, q):
        c = 0
        for x in p:
            if any(hav((x[0], x[1]), (y[0], y[1])) <= tol_km for y in q):
                c += 1
        return c / len(p)

    return one_way(a, b), one_way(b, a)


def load_rows():
    """读 gpx/ 下全部 GPX，解析成体检用的行。返回 (rows, bad)。"""
    rows, bad = [], []
    for f in sorted(os.listdir(GPX)):
        if not f.lower().endswith(".gpx"):
            continue
        p = os.path.join(GPX, f)
        try:
            r = parse_gpx(p)
        except Exception as e:  # noqa: BLE001
            bad.append((f, repr(e)))
            continue
        with open(p, "rb") as fp:
            h = hashlib.sha1(fp.read()).hexdigest()[:12]
        rows.append({
            "file": f, "hash": h,
            "track_id": r["source"]["track_id"],
            "name": r["name"], "desc": (r["description"] or "")[:40],
            "km": r["distance_km"], "asc": r["ascent_m"],
            "start": (round(r["start"]["lat"], 4), round(r["start"]["lon"], 4)),
            "end": (round(r["end"]["lat"], 4), round(r["end"]["lon"], 4)),
            "pts": len(r["geometry"]["coordinates"]),
            "raw_pts": r["track_points"],
            "shape": sample(r["geometry"]["coordinates"]),
        })
    return rows, bad


def find_exact_dupes(rows):
    """1) 文件内容完全相同（同一份文件存了两次）"""
    by_hash = defaultdict(list)
    for r in rows:
        by_hash[r["hash"]].append(r["file"])
    return {k: v for k, v in by_hash.items() if len(v) > 1}


def find_trackid_dupes(rows):
    """2) TrackId 相同（两步路认为是同一条轨迹）"""
    grouped = defaultdict(list)
    for r in rows:
        grouped[r["track_id"]].append(r)
    return {k: v for k, v in grouped.items() if k and len(v) > 1}


def find_name_dupes(rows):
    """3) 路线名相同"""
    grouped = defaultdict(list)
    for r in rows:
        grouped[r["name"]].append(r)
    return {k: v for k, v in grouped.items() if len(v) > 1}


def find_shape_dupes(rows):
    """4) 几何形状高度重合（不同 TrackId 也可能是同一条路）"""
    pairs = []
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            a, b = rows[i], rows[j]
            if abs(a["km"] - b["km"]) > max(1.0, a["km"] * 0.15):
                continue
            d_start = hav(a["start"], b["start"]) * 1000
            if min(d_start, hav(a["start"], b["end"]) * 1000,
                   hav(a["end"], b["start"]) * 1000) > 800:
                continue
            f1, f2 = shape_match(a["shape"], b["shape"])
            if min(f1, f2) >= 0.80:
                pairs.append((min(f1, f2), a, b, d_start))
    pairs.sort(reverse=True, key=lambda t: t[0])
    return pairs


def find_live_overlap(rows, live_routes):
    """5) 与 data/routes.json 里已上线的路线逐个比对"""
    out = []
    for route in live_routes:
        live_shape = sample(route["geometry"]["coordinates"])
        for r in rows:
            f1, f2 = shape_match(live_shape, r["shape"])
            score = min(f1, f2)
            if score >= 0.75:
                out.append((route, r, score))
    out.sort(key=lambda t: -t[2])
    return out


def main():
    rows, bad = load_rows()
    print("解析成功 %d 个，失败 %d 个" % (len(rows), len(bad)))
    for f, e in bad:
        print("  ✗ %s  %s" % (f, e))
    print()

    print("=== 1) 文件内容完全相同（同一份文件存了两次）===")
    dup_hash = find_exact_dupes(rows)
    if not dup_hash:
        print("  无")
    for k, v in dup_hash.items():
        print("  ", k, "->", v)

    print("\n=== 2) TrackId 相同（两步路认为是同一条轨迹）===")
    dup_track = find_trackid_dupes(rows)
    if not dup_track:
        print("  无")
    for k, v in dup_track.items():
        print("  TrackId=%s" % k)
        for x in v:
            print("     %-46s %s  %.2fkm" % (x["file"], x["name"], x["km"]))

    print("\n=== 3) 路线名相同 ===")
    dup_name = find_name_dupes(rows)
    if not dup_name:
        print("  无")
    for k, v in dup_name.items():
        print("  名称 %s" % k)
        for x in v:
            print("     %-46s TrackId=%s  %.2fkm" % (x["file"], x["track_id"], x["km"]))

    print("\n=== 4) 几何形状高度重合（不同 TrackId 也可能是同一条路）===")
    shape_pairs = find_shape_dupes(rows)
    if not shape_pairs:
        print("  无")
    for score, a, b, ds in shape_pairs:
        print("  重合 %.0f%%  起点相距 %.0fm" % (score * 100, ds))
        print("     A %-46s %-22s %.2fkm  TrackId=%s"
              % (a["file"], a["name"], a["km"], a["track_id"]))
        print("     B %-46s %-22s %.2fkm  TrackId=%s"
              % (b["file"], b["name"], b["km"], b["track_id"]))

    with open(os.path.join(ROOT, "data", "routes.json"), encoding="utf-8") as fp:
        live_routes = json.load(fp)["routes"]
    print("\n=== 5) 与 data/routes.json 里已上线的 %d 条对比 ===" % len(live_routes))
    overlaps = find_live_overlap(rows, live_routes)
    if not overlaps:
        print("  无")
    for route, r, score in overlaps:
        print("  已上线「%s」(%s)  ≈  %s  重合 %.0f%%"
              % (route["name"], route["source"]["file"], r["file"], score * 100))

    os.makedirs(os.path.dirname(SCAN), exist_ok=True)
    with open(SCAN, "w", encoding="utf-8") as fp:
        json.dump([{k: v for k, v in r.items() if k != "shape"} for r in rows],
                  fp, ensure_ascii=False, indent=1)
    print("\n明细已存 %s" % os.path.relpath(SCAN, ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
