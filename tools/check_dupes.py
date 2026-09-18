#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""导入前体检：找出重复/疑似重复的 GPX，避免同一批数据在站点上变成好几条。"""
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

print("解析成功 %d 个，失败 %d 个" % (len(rows), len(bad)))
for f, e in bad:
    print("  ✗ %s  %s" % (f, e))
print()

# ---- 1. 内容完全相同的文件 ----
print("=== 1) 文件内容完全相同（同一份文件存了两次）===")
byh = defaultdict(list)
for r in rows:
    byh[r["hash"]].append(r["file"])
dupH = {k: v for k, v in byh.items() if len(v) > 1}
print("  " + ("无" if not dupH else ""))
for k, v in dupH.items():
    print("  ", k, "->", v)

# ---- 2. TrackId 相同 ----
print("\n=== 2) TrackId 相同（两步路认为是同一条轨迹）===")
byt = defaultdict(list)
for r in rows:
    byt[r["track_id"]].append(r)
dupT = {k: v for k, v in byt.items() if k and len(v) > 1}
if not dupT:
    print("  无")
for k, v in dupT.items():
    print("  TrackId=%s" % k)
    for x in v:
        print("     %-46s %s  %.2fkm" % (x["file"], x["name"], x["km"]))

# ---- 3. 名称相同 ----
print("\n=== 3) 路线名相同 ===")
byn = defaultdict(list)
for r in rows:
    byn[r["name"]].append(r)
dupN = {k: v for k, v in byn.items() if len(v) > 1}
if not dupN:
    print("  无")
for k, v in dupN.items():
    print("  名称 %s" % k)
    for x in v:
        print("     %-46s TrackId=%s  %.2fkm" % (x["file"], x["track_id"], x["km"]))

# ---- 4. 形状高度重合 ----
print("\n=== 4) 几何形状高度重合（不同 TrackId 也可能是同一条路）===")
pairs = []
for i in range(len(rows)):
    for j in range(i + 1, len(rows)):
        a, b = rows[i], rows[j]
        if abs(a["km"] - b["km"]) > max(1.0, a["km"] * 0.15):
            continue
        d_start = hav(a["start"], b["start"]) * 1000
        d_end = hav(a["end"], b["end"]) * 1000
        if min(d_start, hav(a["start"], b["end"]) * 1000,
               hav(a["end"], b["start"]) * 1000) > 800:
            continue
        f1, f2 = shape_match(a["shape"], b["shape"])
        if min(f1, f2) >= 0.80:
            pairs.append((min(f1, f2), a, b, d_start))
pairs.sort(reverse=True, key=lambda t: t[0])
if not pairs:
    print("  无")
for score, a, b, ds in pairs:
    print("  重合 %.0f%%  起点相距 %.0fm" % (score * 100, ds))
    print("     A %-46s %-22s %.2fkm  TrackId=%s" % (a["file"], a["name"], a["km"], a["track_id"]))
    print("     B %-46s %-22s %.2fkm  TrackId=%s" % (b["file"], b["name"], b["km"], b["track_id"]))

# ---- 5. 和已在站点上的两条对比 ----
print("\n=== 5) 与当前已上线的 2 条对比 ===")
live = json.load(open(os.path.join(ROOT, "data", "routes.json"), encoding="utf-8"))
for L in live["routes"]:
    ls = sample(L["geometry"]["coordinates"])
    for r in rows:
        f1, f2 = shape_match(ls, r["shape"])
        if min(f1, f2) >= 0.75:
            print("  已上线「%s」(%s)  ≈  %s  重合 %.0f%%" % (
                L["name"], L["source"]["file"], r["file"], min(f1, f2) * 100))
json.dump([{k: v for k, v in r.items() if k != "shape"} for r in rows],
          open(os.path.join(ROOT, "data", "_scan.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print("\n明细已存 _scan.json")
