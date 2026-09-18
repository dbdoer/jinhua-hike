#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
两步路 GPX 轨迹 -> 网页 demo 用的 routes.json / routes.geojson

用法:
    python tools/build_routes.py            # 读 gpx/*.gpx，输出 data/
    python tools/build_routes.py --src gpx  # 指定来源目录

所有派生字段的来源都在 README 里写明，不确定的字段一律给 null，
不猜、不编。新增轨迹只需把两步路导出的 GPX 丢进 gpx/ 再跑一次。
"""
import argparse
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 金华各县市区近似中心点，只用于「按区域筛选」的兜底归类（PosStartName 缺失时才用）
COUNTY_CENTERS = {
    "婺城区": (29.085, 119.571),
    "金东区": (29.199, 119.692),
    "兰溪市": (29.209, 119.460),
    "义乌市": (29.306, 120.075),
    "东阳市": (29.290, 120.242),
    "永康市": (28.888, 120.047),
    "武义县": (28.893, 119.816),
    "浦江县": (29.452, 119.892),
    "磐安县": (29.054, 120.450),
}

# 关键词识别：只在轨迹描述/标注点名称里找，找不到就是 null（未知），不推断
WATER_KEYS = ("瀑布", "溪", "涧", "水潭", "深潭", "水源", "涉水")
FAMILY_KEYS = ("亲子", "家庭", "儿童", "遛娃")


def strip_ns(tag):
    return tag.split("}", 1)[1] if "}" in tag else tag


def kids(el, name):
    return [c for c in el if strip_ns(c.tag) == name]


def child_text(el, name):
    for c in el:
        if strip_ns(c.tag) == name:
            return (c.text or "").strip()
    return None


def all_text(el, name):
    return [kids(el, name)[0].text.strip() if kids(el, name) else None for _ in ()] or None


def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ---------------- 行政区归属：拿真实边界判定，不用「离县城中心最近」 ----------------
# 边界来自阿里云 DataV.GeoAtlas（金华市 330700 的 9 个县市区完整多边形）。
# **它是 GCJ-02 火星坐标**，而 GPX 是 WGS-84，本地实测两者差约 560 m。
# 不转换的话边界附近的点会判到隔壁县：实测 25 条有上传者自报县名的路线，
# 直接判对 24/25，先转 GCJ 再判 25/25。所以这里必须先转。
_A = 6378245.0
_EE = 0.00669342162296594323
_BOUND = {}


def _wgs2gcj(lon, lat):
    def tlat(x, y):
        r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
        r += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
        r += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
        r += (160.0 * math.sin(y / 12.0 * math.pi) + 320.0 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
        return r

    def tlon(x, y):
        r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
        r += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
        r += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
        r += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
        return r

    dlat = tlat(lon - 105.0, lat - 35.0)
    dlon = tlon(lon - 105.0, lat - 35.0)
    rad = lat / 180.0 * math.pi
    m = 1 - _EE * math.sin(rad) ** 2
    sm = math.sqrt(m)
    return (lon + dlon * 180.0 / (_A / sm * math.cos(rad) * math.pi),
            lat + dlat * 180.0 / ((_A * (1 - _EE)) / (m * sm) * math.pi))


def _load_boundaries():
    if "v" not in _BOUND:
        try:
            with open(os.path.join(ROOT, "tools", "data", "jinhua_counties.json"),
                      encoding="utf-8") as fp:
                _BOUND["v"] = json.load(fp)["counties"]
        except Exception:  # noqa: BLE001
            _BOUND["v"] = []
    return _BOUND["v"]


def _in_ring(x, y, ring):
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def county_of(lon, lat):
    """这个点在哪个县市区里（必须传 WGS-84）；在金华市界外返回 None"""
    glon, glat = _wgs2gcj(lon, lat)
    for c in _load_boundaries():
        g = c["geometry"]
        for poly in (g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]):
            if _in_ring(glon, glat, poly[0]) and not any(_in_ring(glon, glat, h) for h in poly[1:]):
                return c["name"]
    return None


def locate_track(trkpts):
    """先看起点落在哪个县；起点在界外（GPS 抖动或跨市）再沿轨迹多试几个点取多数"""
    c = county_of(trkpts[0]["lon"], trkpts[0]["lat"])
    if c:
        return c
    n = len(trkpts)
    votes = {}
    for i in (n // 4, n // 2, (3 * n) // 4, n - 1):
        c = county_of(trkpts[i]["lon"], trkpts[i]["lat"])
        if c:
            votes[c] = votes.get(c, 0) + 1
    return max(votes, key=votes.get) if votes else None


def rdp(points, eps, must_keep=()):
    """Douglas-Peucker 抽稀，points = [[lon,lat,ele?], ...]

    must_keep: 必须保留的点下标。用来强行保住最高/最低点——
    前端是从几何坐标现算海拔剖面的，少了这两个点，图上的峰值
    就会低于 ele_max，两处数字对不上。
    """
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    for i in must_keep:
        if 0 <= i < len(points):
            keep[i] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1:
            continue
        (x0, y0), (x1, y1) = points[i0][:2], points[i1][:2]
        dx, dy = x1 - x0, y1 - y0
        seg = math.hypot(dx, dy) or 1e-12
        best, best_i = -1.0, -1
        for i in range(i0 + 1, i1):
            px, py = points[i][:2]
            d = abs(dy * px - dx * py + x1 * y0 - y1 * x0) / seg
            if d > best:
                best, best_i = d, i
        if best > eps:
            keep[best_i] = True
            stack.append((i0, best_i))
            stack.append((best_i, i1))
    return [p for p, k in zip(points, keep) if k]


def parse_gpx(path):
    tree = ET.parse(path)
    root = tree.getroot()

    gpx_ext = None
    for c in root:
        if strip_ns(c.tag) == "extensions":
            gpx_ext = {strip_ns(x.tag): (x.text or "").strip() for x in c}
            break
    gpx_ext = gpx_ext or {}

    trkpts, rtepts, wpts = [], [], []
    for el in root.iter():
        t = strip_ns(el.tag)
        if t == "trkpt" and el.get("lat"):
            trkpts.append({
                "lat": float(el.get("lat")),
                "lon": float(el.get("lon")),
                "ele": float(child_text(el, "ele")) if child_text(el, "ele") else None,
                "time": child_text(el, "time"),
            })
        elif t == "rtept" and el.get("lat"):
            rtepts.append({
                "lat": float(el.get("lat")),
                "lon": float(el.get("lon")),
                "ele": float(child_text(el, "ele")) if child_text(el, "ele") else None,
                "time": child_text(el, "time"),
            })
        elif t == "wpt" and el.get("lat"):
            wpts.append({
                "lat": float(el.get("lat")),
                "lon": float(el.get("lon")),
                "name": child_text(el, "name") or "",
                "desc": child_text(el, "desc") or "",
                "cmt": child_text(el, "cmt") or "",
                "ele": float(child_text(el, "ele")) if child_text(el, "ele") else None,
                "time": child_text(el, "time"),
            })

    # 两步路有时导出的是「路线」不是「轨迹」：几何点在 <rte>/<rtept> 下，没有录制时间。
    # 例如在 App 里把多段轨迹合并/拆分后导出，就会走这条路径。
    # 没有 trkpt 时退回用 rtept，其余口径（距离/爬升/难度/剖面）完全一致。
    geometry_from = "trk"
    if not trkpts:
        if not rtepts:
            raise ValueError("既没有 trkpt 也没有 rtept")
        trkpts = rtepts
        geometry_from = "rte"

    if not trkpts:
        raise ValueError("没有 trkpt")

    # 距离
    dist = 0.0
    for a, b in zip(trkpts, trkpts[1:]):
        dist += haversine(a["lat"], a["lon"], b["lat"], b["lon"])

    # 累计爬升/下降：3m 阈值滞回，滤掉 GPS 高程抖动
    ascent = descent = 0.0
    TH = 3.0
    ref = None
    for p in trkpts:
        if p["ele"] is None:
            continue
        if ref is None:
            ref = p["ele"]
            continue
        d = p["ele"] - ref
        if d >= TH:
            ascent += d
            ref = p["ele"]
        elif d <= -TH:
            descent += -d
            ref = p["ele"]

    eles = [p["ele"] for p in trkpts if p["ele"] is not None]
    lats = [p["lat"] for p in trkpts]
    lons = [p["lon"] for p in trkpts]

    # 用时：优先用 trkpt 时间戳，其次用两步路扩展里的 TimeUsed
    dur_s = None
    ts = [p["time"] for p in trkpts if p["time"]]
    if len(ts) >= 2:
        fmt = "%Y-%m-%dT%H:%M:%SZ"
        try:
            t0 = datetime.strptime(ts[0], fmt).replace(tzinfo=timezone.utc)
            t1 = datetime.strptime(ts[-1], fmt).replace(tzinfo=timezone.utc)
            dur_s = (t1 - t0).total_seconds()
        except ValueError:
            dur_s = None
    if dur_s is None and gpx_ext.get("TimeUsed"):
        _used = float(gpx_ext["TimeUsed"]) / 1000.0
        # 「路线」类文件里 TimeUsed/PauseTime 是 0，不能当成功耗时，否则用时显示成 0 h
        dur_s = _used if _used > 0 else None
    pause_s = float(gpx_ext["PauseTime"]) / 1000.0 if gpx_ext.get("PauseTime") else None

    # 抽稀（约 4m 容差）。最高/最低点强制保留：前端从几何现算剖面，
    # 这两个点不在几何里，剖面峰值就会低于 ele_max。
    raw = [[p["lon"], p["lat"]] + ([p["ele"]] if p["ele"] is not None else []) for p in trkpts]
    forced = []
    ele_idx = [(i, p["ele"]) for i, p in enumerate(trkpts) if p["ele"] is not None]
    if ele_idx:
        forced.append(max(ele_idx, key=lambda t: t[1])[0])
        forced.append(min(ele_idx, key=lambda t: t[1])[0])
    simp = rdp(raw, 0.00004, forced)

    name = gpx_ext.get("name") or os.path.splitext(os.path.basename(path))[0]
    desc = gpx_ext.get("description") or ""
    tags = [t for t in re.split(r"[,，、\s]+", gpx_ext.get("TrackTags", "")) if t]
    # 区域归属，三步走，越靠前越可信：
    # ① PosStartName 里明确含且仅含一个县名 —— 那是上传者自己写的，最可信
    #    （注意它是自由文本：「金华市义乌市上溪镇五星社村岩下村1号」这种也要能认出来，
    #      所以用「包含」而不是整串相等）
    # ② 拿轨迹起点做行政边界内判定（真实多边形，WGS→GCJ 后再判）
    # ③ 都失败才退回「离县城中心最近」，并明确标注是近似
    region, region_source = None, None
    ps = gpx_ext.get("PosStartName") or ""
    hits = [c for c in COUNTY_CENTERS if c in ps]
    if len(hits) == 1:
        region, region_source = hits[0], "两步路 PosStartName"
    if region is None:
        by_bound = locate_track(trkpts)
        if by_bound:
            region, region_source = by_bound, "按行政边界判定"
    if region is None:
        region = min(COUNTY_CENTERS, key=lambda k: haversine(
            trkpts[0]["lat"], trkpts[0]["lon"], *COUNTY_CENTERS[k]))
        region_source = "按起点坐标就近归类（近似，起点在金华市界外）"

    dist_km = round(dist, 2)
    asc_m = round(ascent)
    hours = round(dur_s / 3600, 2) if dur_s else None

    # 难度：距离 + 累计爬升的透明规则，UI 里会写明依据
    if dist_km <= 8 and asc_m <= 400:
        difficulty, diff_reason = "休闲", "≤8km 且爬升≤400m"
    elif dist_km <= 15 and asc_m <= 900:
        difficulty, diff_reason = "中等", "≤15km 且爬升≤900m"
    else:
        difficulty, diff_reason = "困难", "距离>15km 或爬升>900m"

    family_hi = (dist_km <= 8 and asc_m <= 400 and (hours is None or hours <= 5))
    family = True if family_hi else (None if (dist_km > 12 or asc_m > 700) else None)

    blob = desc + " " + " ".join(w["name"] + w["desc"] for w in wpts) + " " + " ".join(tags)
    has_water = True if any(k in blob for k in WATER_KEYS) else None
    family_tag = True if any(k in blob for k in FAMILY_KEYS) else None
    if family_tag:
        family = True

    annotations = [{
        "lon": w["lon"], "lat": w["lat"], "name": w["name"],
        "desc": w["desc"], "ele": w["ele"], "time": w["time"],
    } for w in wpts if w["name"] or w["desc"]]

    # 高程剖面不再单独存：geometry 的坐标就是 [lon,lat,ele]，前端从它现算。
    # 曾单独存一份 240 点的抽稀剖面（单条 1.6 KB gzip），等于把高程存了两遍。

    return {
        "id": "tb_" + (gpx_ext.get("TrackId") or re.sub(r"\W+", "_", name)),
        "name": name,
        "region": region,
        "region_source": region_source,
        "difficulty": difficulty,
        "difficulty_reason": diff_reason,
        "family": family,
        "family_reason": ("距离≤8km、爬升≤400m、用时≤5h（系统判定）" if family_hi else None),
        "family_tag": family_tag,
        "has_water": has_water,
        "water_reason": ("轨迹描述或标注点提到：" + "、".join(
            k for k in WATER_KEYS if k in blob) if has_water else None),
        "distance_km": dist_km,
        "ascent_m": asc_m,
        "descent_m": round(descent),
        "ele_min": round(min(eles)) if eles else None,
        "ele_max": round(max(eles)) if eles else None,
        "hours": hours,
        "pause_hours": round(pause_s / 3600, 2) if pause_s else None,
        "track_points": len(trkpts),
        "waypoints": len(wpts),
        # 几何来自 <trkpt>（真实记录的轨迹）还是 <rtept>（两步路的「路线」，无录制时间）
        "geometry_from": geometry_from,
        "start": {"lon": trkpts[0]["lon"], "lat": trkpts[0]["lat"]},
        "end": {"lon": trkpts[-1]["lon"], "lat": trkpts[-1]["lat"]},
        "tags": tags,
        "description": desc,
        "annotations": annotations,
        # 来源与版权：原作者信息必须一路带到界面上
        "source": {
            "provider": "两步路(2bulu)",
            "track_id": gpx_ext.get("TrackId"),
            "creator": gpx_ext.get("CreaterName"),
            "creator_id": gpx_ext.get("CreaterId"),
            "app_version": gpx_ext.get("ProductVersion"),
            "begin_time": gpx_ext.get("BeginTime"),
            "file": os.path.basename(path),
        },
        "geometry": {"type": "LineString", "coordinates": simp},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(ROOT, "gpx"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data"))
    args = ap.parse_args()

    files = sorted(f for f in os.listdir(args.src) if f.lower().endswith(".gpx"))
    if not files:
        print("gpx 目录里没有 .gpx 文件：", args.src)
        return 1

    routes, feats, bad = [], [], []
    for f in files:
        try:
            r = parse_gpx(os.path.join(args.src, f))
        except Exception as e:  # noqa: BLE001
            bad.append((f, repr(e)))
            continue
        feats.append({
            "type": "Feature",
            "properties": {k: v for k, v in r.items()
                           if k not in ("geometry", "annotations")},
            "geometry": r["geometry"],
        })
        routes.append(r)
        print("%-28s %6.2f km  爬升%5dm  用时%-6s %s / %s" % (
            r["name"], r["distance_km"], r["ascent_m"],
            r["hours"] if r["hours"] else "-", r["region"], r["difficulty"]))

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "routes.json"), "w", encoding="utf-8") as fp:
        json.dump({
            "generated_from": "两步路 GPX 导出",
            "count": len(routes),
            "routes": routes,
        }, fp, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, "routes.geojson"), "w", encoding="utf-8") as fp:
        json.dump({"type": "FeatureCollection", "features": feats}, fp, ensure_ascii=False)
    # 同时产出一份 JS，页面用 <script> 直接吃，避免 file:// 下 fetch 被拦
    with open(os.path.join(args.out, "routes.js"), "w", encoding="utf-8") as fp:
        fp.write("window.HIKE_DATA = ")
        json.dump({
            "generated_from": "两步路 GPX 导出",
            "count": len(routes),
            "routes": routes,
        }, fp, ensure_ascii=False)
        fp.write(";\n")

    print("\n生成 %d 条 -> data/routes.json + data/routes.geojson" % len(routes))
    for f, e in bad:
        print("跳过(解析失败): %s %s" % (f, e))
    return 0


if __name__ == "__main__":
    sys.exit(main())
