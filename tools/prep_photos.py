#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""赏秋点照片预处理 -> spots/photos/*.webp

README 第 2 步写着「图片压成 WebP、宽 1200，丢进 spots/photos/」，
但一直没工具，全靠手动压。这个脚本把那一步做掉。

顺手做三件手动压图容易忘的事：

- **按 EXIF 方向转正**。手机竖拍的图不转正，压出来会躺倒。
- **丢掉全部 EXIF（含 GPS）**。手机原图里带着拍摄地坐标，而站点本身
  已经公开点位，再把每次拍摄的精确坐标一起发出去，没有任何意义。
- **宽度只缩不放**。源图比 1200 窄就原样保留，别把小图拉大。

注意：这是本仓库 tools/ 里**唯一**一个非标准库依赖（Pillow）。
它不进构建流水线，只在人加新点时手动跑一次：

    pip install Pillow

用法:

    python tools/prep_photos.py --prefix shuanglong 原图1.jpg 原图2.jpg
    python tools/prep_photos.py --prefix shuanglong D:\\照片\\双龙
    python tools/prep_photos.py --prefix shuanglong --force 原图.jpg    # 覆盖已有产物

输出文件名是 `<前缀>-01.webp`、`<前缀>-02.webp`…… 直接写进 spots.json 的
`photos[].file` 即可（只写文件名，不写目录）。
"""
import argparse
import os
import sys

try:
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover
    sys.stderr.write(
        "需要 Pillow（本仓库 tools/ 里唯一的第三方依赖，不进构建流水线）\n"
        "    pip install Pillow\n")
    sys.exit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "spots", "photos")


def rel(p):
    """跨盘符时 relpath 会抛 ValueError（仓库在哪个盘、临时目录在哪个盘都可能不同），
    那就老老实实给绝对路径，别为了好看把脚本弄崩。"""
    try:
        return os.path.relpath(p, ROOT)
    except ValueError:
        return p

SRC_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff")
HEIC_EXT = (".heic", ".heif")
QUALITY_LADDER = (82, 78, 74, 70, 66, 62, 58, 54, 50, 45)


def ascii_slug(s):
    """前缀只留 ASCII —— 文件名要出现在 URL 和 spots.json 里，越朴素越好。"""
    out = "".join(c for c in s.lower() if c.isalnum() or c in "-_")
    return out.strip("-_") or "photo"


def collect(paths):
    """展开目录参数；顺带把 HEIC 挑出来单独说 —— Pillow 默认读不了它。"""
    files, heic = [], []
    for p in paths:
        if os.path.isdir(p):
            for f in sorted(os.listdir(p)):
                low = f.lower()
                if low.endswith(SRC_EXT):
                    files.append(os.path.join(p, f))
                elif low.endswith(HEIC_EXT):
                    heic.append(os.path.join(p, f))
        else:
            low = p.lower()
            if low.endswith(HEIC_EXT):
                heic.append(p)
            else:
                files.append(p)
    return files, heic


def encode(im, out_path, max_kb):
    """从质量 82 往下试，直到落进 max_kb；落不进也要给出最好的那版并如实报告。"""
    q = QUALITY_LADDER[0]
    size = 0
    for q in QUALITY_LADDER:
        im.save(out_path, "WEBP", quality=q, method=6)
        size = os.path.getsize(out_path)
        if size <= max_kb * 1024:
            return q, size
    return q, size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+", help="原图文件或目录")
    ap.add_argument("--prefix", default=None, help="输出文件名前缀（默认取第一张源图的名字）")
    ap.add_argument("--out", default=DEFAULT_OUT, help="输出目录")
    ap.add_argument("--max-width", type=int, default=1200)
    ap.add_argument("--max-kb", type=int, default=400)
    ap.add_argument("--force", action="store_true", help="覆盖已存在的产物")
    args = ap.parse_args()

    files, heic = collect(args.paths)
    if heic:
        print("跳过 HEIC（Pillow 默认读不了，先在手机上导成 JPG 或装 pillow-heif）：")
        for h in heic:
            print("   %s" % h)
        print("")
    if not files:
        print("没有可处理的源图。支持的扩展名：%s" % " ".join(SRC_EXT))
        return 1

    os.makedirs(args.out, exist_ok=True)
    prefix = ascii_slug(args.prefix) if args.prefix else ascii_slug(
        os.path.splitext(os.path.basename(files[0]))[0])

    print("前缀 %s -> %s/<前缀>-NN.webp\n" % (prefix, rel(args.out)))
    print("  %-22s %-14s %-9s %s" % ("输出", "尺寸", "大小", "质量"))

    ok, failed = [], []
    for i, src in enumerate(files, 1):
        name = "%s-%02d.webp" % (prefix, i)
        dst = os.path.join(args.out, name)
        try:
            if os.path.exists(dst) and not args.force:
                failed.append((src, "已存在 %s（要覆盖就加 --force）" % name))
                continue
            im = Image.open(src)
            im = ImageOps.exif_transpose(im)          # 先转正，再谈尺寸
            im = im.convert("RGB")
            im.info.pop("exif", None)                 # 丢掉 EXIF（含 GPS）
            w0, h0 = im.size
            if w0 > args.max_width:
                h1 = round(h0 * args.max_width / w0)
                im = im.resize((args.max_width, h1), Image.LANCZOS)
            q, size = encode(im, dst, args.max_kb)
            flag = "" if size <= args.max_kb * 1024 else "  ← 仍超过 %d KB" % args.max_kb
            print("  %-22s %-14s %-9s q=%d%s" % (
                name, "%dx%d" % im.size, "%.0f KB" % (size / 1024), q, flag))
            ok.append((name, size, w0, h0, q))
        except Exception as e:  # noqa: BLE001
            failed.append((src, repr(e)))

    print("\n成功 %d 张 -> %s" % (len(ok), rel(args.out)))
    if ok:
        print("往 spots.json 里写文件名：")
        for name, _, _, _, _ in ok:
            print('   "file": "%s"' % name)
    if failed:
        print("\n没处理成 %d 张：" % len(failed))
        for src, why in failed:
            print("   %s  %s" % (src, why))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
