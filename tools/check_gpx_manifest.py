#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""gpx/ 原始文件的字节指纹：生成与校验。

为什么需要它：站点上详情页有个「下载原始 GPX」的链接，而本机 core.autocrlf=true
曾把 GPX 的 CRLF 压成 LF —— 线上的文件比原始少了 5164 字节，链接「能打开」但不是原来那个。
光靠「能打开」验不出来，必须比字节。

用法:
    python tools/check_gpx_manifest.py           # 校验，不一致则退出码 1
    python tools/check_gpx_manifest.py --write   # 按当前 gpx/ 重写清单
    python tools/check_gpx_manifest.py --quiet   # 只报问题，供 build_routes.py 调用

清单刻意不放时间戳：只有内容真的变了，diff 才动。
"""
import argparse
import hashlib
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GPX = os.path.join(ROOT, "gpx")
MANIFEST = os.path.join(GPX, "MANIFEST.json")

NOTE = ("gpx/ 里原始 GPX 文件的字节指纹。任何一项对不上，都意味着「下载原始 GPX」"
        "给出去的已经不是上传者导出的那串字节。.gitattributes 里 *.gpx 标了 -text，"
        "禁止 git 做行尾转换 —— 别去掉它。用 python tools/check_gpx_manifest.py 校验。")


def strip_ns(tag):
    return tag.split("}", 1)[1] if "}" in tag else tag


def gpx_meta(path):
    """从文件里取 TrackId 和 name，便于把清单跟站点上的路线对上号"""
    try:
        root = ET.parse(path).getroot()
    except Exception:  # noqa: BLE001
        return None, None
    tid = name = None
    for c in root:
        if strip_ns(c.tag) == "extensions":
            for x in c:
                t = strip_ns(x.tag)
                if t == "TrackId":
                    tid = (x.text or "").strip() or None
                elif t == "name":
                    name = (x.text or "").strip() or None
            break
    if name is None:
        for c in root:
            if strip_ns(c.tag) in ("trk", "rte", "metadata"):
                for x in c:
                    if strip_ns(x.tag) == "name":
                        name = (x.text or "").strip()
                        break
                if name:
                    break
    return tid, name


def scan():
    rows = []
    for f in sorted(os.listdir(GPX)):
        if not f.lower().endswith(".gpx"):
            continue
        p = os.path.join(GPX, f)
        with open(p, "rb") as fp:
            raw = fp.read()
        tid, name = gpx_meta(p)
        rows.append({
            "file": f,
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "track_id": tid,
            "name": name,
        })
    return rows


def load():
    if not os.path.isfile(MANIFEST):
        return None
    with open(MANIFEST, encoding="utf-8") as fp:
        return json.load(fp)


def write(rows):
    data = {
        "note": NOTE,
        "algorithm": "sha256",
        "count": len(rows),
        "files": rows,
    }
    with open(MANIFEST, "w", encoding="utf-8", newline="\n") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=1)
        fp.write("\n")
    print("已写入 %s（%d 个文件）" % (os.path.relpath(MANIFEST, ROOT), len(rows)))


def compare(rows, man, quiet=False):
    old = {r["file"]: r for r in (man or {}).get("files", [])}
    new = {r["file"]: r for r in rows}
    added = [f for f in new if f not in old]
    gone = [f for f in old if f not in new]
    changed = [f for f in new if f in old
               and (new[f]["sha256"] != old[f]["sha256"] or new[f]["bytes"] != old[f]["bytes"])]
    same = len(new) - len(added) - len(changed)

    if man is None:
        print("  ✗ 清单不存在：%s" % os.path.relpath(MANIFEST, ROOT))
        print("    跑 python tools/check_gpx_manifest.py --write 生成")
        return False

    if not quiet:
        print("清单：%s（记 %d 个）" % (os.path.relpath(MANIFEST, ROOT), len(old)))
        print("磁盘：%d 个 GPX" % len(new))
        print("  字节一致  %d" % same)
        print("  新增      %d" % len(added))
        print("  丢失      %d" % len(gone))
        print("  内容变了  %d" % len(changed))

    for f in added:
        print("  + 新增（清单里没有）：%s  %d 字节" % (f, new[f]["bytes"]))
    for f in gone:
        print("  - 清单里有、磁盘上没有：%s" % f)
    for f in changed:
        print("  ! 内容变了：%s  %d -> %d 字节" % (f, old[f]["bytes"], new[f]["bytes"]))
        print("      旧 %s" % old[f]["sha256"][:16])
        print("      新 %s" % new[f]["sha256"][:16])

    if added or gone or changed:
        if not quiet:
            print("\n原始字节有出入。确认是有意改动之后，跑 --write 更新清单。")
        return False
    if not quiet:
        print("\n✓ 全部一致：%d 个 GPX 的字节与清单完全吻合" % len(new))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="按当前 gpx/ 重写清单")
    ap.add_argument("--quiet", action="store_true", help="只报问题（给 build_routes.py 用）")
    a = ap.parse_args()
    rows = scan()
    if not rows:
        print("gpx/ 里没有 .gpx 文件")
        return 1
    if a.write:
        write(rows)
        return 0
    return 0 if compare(rows, load(), a.quiet) else 1


if __name__ == "__main__":
    sys.exit(main())
