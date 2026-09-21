#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
点位 -> data/spots.js / data/spots.geojson

源数据：spots/spots.json   人工维护
照片：  spots/photos/      用相对文件名引用

这个脚本**只校验，不替你选点**。坐标必须人手填，并且带来源和精度 ——
「机器只校验」是这个项目从第一天起的规矩（见 README）。校验不过就退出码 1、
不写产物，免得坏数据混进站里。

用法:
    python tools/build_spots.py                # 校验 + 生成
    python tools/build_spots.py --check-only   # 只校验，不写产物
    python tools/build_spots.py --src spots --out data
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_routes import _wgs2gcj   # noqa: E402  WGS-84 -> GCJ-02 只保留一份实现，别抄第二份

# 与 app.js 的 DIFF_COLOR / JINHUA 一样，这里是同一套事实的第二份抄写 ——
# 改一边必须改另一边，别让「点位」和「徒步路线」对市区县名字有两套说法。
REGIONS = ["婺城区", "金东区", "兰溪市", "义乌市", "东阳市",
           "永康市", "武义县", "浦江县", "磐安县"]
# 想加类目就往这里加（瀑布、事件点、稻田、荷塘……都行）。前端 app.js 的 KIND_COLOR
# 是同一张表，改一边必须改另一边 —— 对不上的话点会拿到 undefined 的颜色。
KINDS = ["水杉", "银杏", "红枫", "枫香", "乌桕", "芦花", "稻田", "油菜花", "瀑布", "事件点", "其他"]
SEGS = {"上": 0, "中": 1, "下": 2}
PHOTO_EXT = (".webp", ".jpg", ".jpeg", ".png")
# 金华市范围，跟 app.js 的 JINHUA.bounds 同源；留 0.02 度余量容忍边界上的点
BOUNDS = (119.05 - 0.02, 28.42 - 0.02, 120.98 + 0.02, 29.82 + 0.02)
PHOTO_WARN_BYTES = 400 * 1024      # 一张图超过这个就提醒压缩，不是错误
INTRO_MIN = 8                      # 简介太短基本等于没写


def seg_index(v):
    """「11-中」-> 旬序号（1 月上=0）。赏秋最佳期一律用「月份-旬」表示，
    跨年不需要：这套东西只在 9~12 月有意义。解析不了返回 None。"""
    if not v:
        return None
    m = re.fullmatch(r"(\d{1,2})\s*-\s*(上|中|下)", str(v).strip())
    if not m:
        return None
    mo = int(m.group(1))
    if not 1 <= mo <= 12:
        return None
    return (mo - 1) * 3 + SEGS[m.group(2)]


def is_date(v):
    return bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(v or "").strip()))


def validate(data, photos_dir):
    """返回 (errors, warnings)。errors 非空就不出产物。"""
    err, warn = [], []
    spots = data.get("spots")
    if not isinstance(spots, list):
        return ["spots.json 里没有 spots 数组"], warn

    seen_id, seen_pos, used_photo = {}, [], {}

    for i, s in enumerate(spots):
        tag = s.get("id") or ("第 %d 条" % (i + 1))

        def bad(msg):
            err.append("%s: %s" % (tag, msg))

        def soft(msg):
            warn.append("%s: %s" % (tag, msg))

        # --- 必填 ---
        for k in ("id", "name", "kind", "region", "lon", "lat",
                  "coord_src", "coord_acc_m", "intro"):
            if s.get(k) in (None, ""):
                bad("缺字段 %s" % k)

        sid = s.get("id")
        if sid:
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", str(sid)):
                bad("id 只能用小写字母/数字/连字符（2~41 位），当前 %r" % sid)
            if sid in seen_id:
                bad("id 与第 %d 条重复" % (seen_id[sid] + 1))
            seen_id[sid] = i

        if s.get("kind") and s["kind"] not in KINDS:
            bad("kind=%r 不在表里，可选：%s" % (s["kind"], "、".join(KINDS)))
        if s.get("region") and s["region"] not in REGIONS:
            bad("region=%r 不是金华的县市区" % s["region"])

        # --- 坐标：手标、带来源、带精度 ---
        lon, lat = s.get("lon"), s.get("lat")
        if isinstance(lon, (int, float)) and isinstance(lat, (int, float)):
            w, so, e, n = BOUNDS
            if not (w <= lon <= e and so <= lat <= n):
                bad("坐标 %.5f,%.5f 落在金华范围外（%s）" % (lon, lat, s.get("coord_src") or "来源未填"))
            for (plon, plat, pname) in seen_pos:
                if abs(plon - lon) < 0.0003 and abs(plat - lat) < 0.0003:
                    bad("与「%s」相距不到 30 m，是不是同一个点录了两遍？" % pname)
            if s.get("name"):
                seen_pos.append((lon, lat, s["name"]))
        else:
            bad("lon/lat 必须是数字（WGS-84）")
        acc = s.get("coord_acc_m")
        if acc is not None and (not isinstance(acc, int) or acc <= 0):
            bad("coord_acc_m 要是正整数（米）")
        if isinstance(acc, int) and acc > 500:
            soft("坐标精度 %d m 太粗了，地图上点不准位置" % acc)

        # --- 简介 ---
        intro = str(s.get("intro") or "")
        if intro and len(intro) < INTRO_MIN:
            soft("简介只有 %d 个字，写了跟没写一样" % len(intro))

        # --- 最佳观赏期 ---
        f, t = seg_index(s.get("best_from")), seg_index(s.get("best_to"))
        if s.get("best_from") and f is None:
            bad("best_from=%r 格式不对，应形如「11-中」" % s["best_from"])
        if s.get("best_to") and t is None:
            bad("best_to=%r 格式不对，应形如「12-上」" % s["best_to"])
        if f is not None and t is not None and f > t:
            bad("最佳期起止反了（%s -> %s）" % (s["best_from"], s["best_to"]))
        if f is None:
            soft("没填最佳观赏期 —— 有季节性的点（秋色、丰水期）最好填上，"
                 "事件点之类没有季节性的忽略这条")

        if s.get("verified_at") and not is_date(s["verified_at"]):
            bad("verified_at 要是 YYYY-MM-DD")
        if t is not None and not s.get("verified_at"):
            soft("没填 verified_at（最后一次亲眼确认的日期），时间轴的可信度没处交代")

        # --- 照片与版权 ---
        photos = s.get("photos") or []
        if not isinstance(photos, list):
            bad("photos 要是数组")
            photos = []
        if not photos:
            soft("一张图都没有 —— 点位没图，用户不知道去看什么")
        for j, p in enumerate(photos):
            if not isinstance(p, dict):
                bad("photos[%d] 不是对象" % j)
                continue
            fn = p.get("file")
            if not fn:
                bad("photos[%d] 缺 file" % j)
                continue
            if os.path.basename(fn) != fn:
                bad("photos[%d].file 只写文件名，别带路径（当前 %r）" % (j, fn))
                continue
            if not fn.lower().endswith(PHOTO_EXT):
                bad("photos[%d].file=%r 只支持 %s" % (j, fn, "/".join(PHOTO_EXT)))
            full = os.path.join(photos_dir, fn)
            if not os.path.exists(full):
                bad("照片不存在：spots/photos/%s" % fn)
            else:
                size = os.path.getsize(full)
                if size > PHOTO_WARN_BYTES:
                    soft("照片 %s 有 %.0f KB，压到 400 KB 以内再进来（WebP、宽 1200）"
                         % (fn, size / 1024.0))
            used_photo.setdefault(fn, []).append(tag)
            # 版权：不是自己拍的必须写清授权，这是硬规矩
            credit = (p.get("credit") or "").strip()
            if credit and not (p.get("license") or "").strip():
                bad("照片 %s 写了 credit（%s）却没写 license —— 别人的图必须有授权说明" % (fn, credit))
            if credit and not p.get("credit_url"):
                soft("照片 %s 是别人拍的，建议填 credit_url 链回原帖" % fn)
            if p.get("shot_at") and not is_date(p["shot_at"]):
                bad("照片 %s 的 shot_at 要是 YYYY-MM-DD" % fn)

    for fn, users in used_photo.items():
        if len(users) > 1:
            warn.append("照片 %s 被 %d 个点共用（%s）" % (fn, len(users), "、".join(users)))

    if not spots:
        warn.append("还没有任何点位 —— 管线是通的，等你打第一个点")
    return err, warn


def build(data, out_dir, photos_dir):
    spots = []
    for s in data["spots"]:
        o = dict(s)
        # 派生字段在构建期算好，前端别再写第二套口径
        # 导航用的 GCJ-02 坐标，理由同 build_routes.py：/navigation 没有 coordinate
        # 参数，它按 GCJ-02 理解坐标。转换实现直接借用，别在这里养第二份。
        gx, gy = _wgs2gcj(s["lon"], s["lat"])
        o["nav_gcj"] = {"lon": round(gx, 6), "lat": round(gy, 6)}
        o["best_i_from"] = seg_index(s.get("best_from"))
        o["best_i_to"] = seg_index(s.get("best_to"))
        o["photos"] = [dict(p, src="spots/photos/" + p["file"]) for p in (s.get("photos") or [])]
        o.setdefault("tags", [])
        spots.append(o)

    spots.sort(key=lambda x: (x.get("best_i_from") if x.get("best_i_from") is not None else 999,
                              x.get("name") or ""))
    os.makedirs(out_dir, exist_ok=True)

    payload = {"schema": 1, "count": len(spots), "updated": data.get("updated"), "spots": spots}
    with open(os.path.join(out_dir, "spots.js"), "w", encoding="utf-8") as fp:
        fp.write("window.SPOT_DATA = ")
        json.dump(payload, fp, ensure_ascii=False)
        fp.write(";\n")
    with open(os.path.join(out_dir, "spots.geojson"), "w", encoding="utf-8") as fp:
        json.dump({
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature", "id": s["id"],
                "properties": {k: v for k, v in s.items() if k != "photos"},
                "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]},
            } for s in spots],
        }, fp, ensure_ascii=False, indent=1)
    return payload


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(ROOT, "spots"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data"))
    ap.add_argument("--check-only", action="store_true")
    args = ap.parse_args()

    src_file = os.path.join(args.src, "spots.json")
    photos_dir = os.path.join(args.src, "photos")
    if not os.path.exists(src_file):
        print("找不到源数据：%s" % src_file)
        return 1
    with open(src_file, encoding="utf-8") as fp:
        data = json.load(fp)

    err, warn = validate(data, photos_dir)
    n = len(data.get("spots") or [])

    for w in warn:
        print("  提醒  %s" % w)
    for e in err:
        print("  错误  %s" % e)

    if err:
        print("\n%d 个点位，%d 处必须修掉，不生成产物。" % (n, len(err)))
        return 1

    if args.check_only:
        print("\n%d 个点位，校验通过（未写产物）。" % n)
        return 0

    payload = build(data, args.out, photos_dir)
    print("\n生成 %d 个点位 -> data/spots.js / data/spots.geojson" % payload["count"])
    by_kind = {}
    for s in payload["spots"]:
        by_kind[s["kind"]] = by_kind.get(s["kind"], 0) + 1
    if by_kind:
        print("  " + "  ".join("%s %d" % (k, v) for k, v in sorted(by_kind.items())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
