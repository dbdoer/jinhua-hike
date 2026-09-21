"""从仓库里的 SVG 生成三份图标产物。

一次性脚本，不进流水线（跑它需要无头 Chrome）。留着是为了「以后想改颜色/构图」时
不用重新摸索一遍。用法：

    cd E:/code/jinhua-hike && node tools/render_icons.js && python tools/build_icons.py

两个前提（都踩过）：
  1. 渲染前必须把 SVG 的固有 width/height 换成 100%，否则 Chrome 按 64px 画，
     视口小于 64 时截到的是左上角那一块。
  2. 截图要 omitBackground，否则圆角外面糊上白底。

Pillow 只用来拼 ICO 和回读校验（跟 prep_photos.py 一个依赖）。
"""
import io
import os
import struct

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'jh-icons')

SIZES = [(16, 'icon-16.png'), (32, 'icon-32.png'), (48, 'icon-48.png')]


def build_ico(out_path):
    """PNG 载荷直接塞进 ICO 容器（Vista 以后都认），三档尺寸各是各的图。"""
    blobs = []
    for size, name in SIZES:
        im = Image.open(os.path.join(TMP, name)).convert('RGBA')
        assert im.size == (size, size), f'{name} 尺寸不对：{im.size}'
        buf = io.BytesIO()
        im.save(buf, format='PNG')
        blobs.append(buf.getvalue())

    out = bytearray(struct.pack('<HHH', 0, 1, len(blobs)))
    offset = 6 + 16 * len(blobs)
    for (size, _), data in zip(SIZES, blobs):
        out += struct.pack('<BBBBHHII', size if size < 256 else 0,
                           size if size < 256 else 0, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for data in blobs:
        out += data
    with open(out_path, 'wb') as f:
        f.write(bytes(out))

    ico = Image.open(out_path)
    print(f'{out_path}  {len(out)} 字节  内含 {sorted(ico.ico.sizes())}')
    for size, _ in SIZES:
        ico.size = (size, size)
        ico.load()
        ico.convert('RGBA')
    print('  三档逐张打开正常')


if __name__ == '__main__':
    build_ico(os.path.join(ROOT, 'favicon.ico'))
    for f in ('apple-touch-icon.png',):
        p = os.path.join(TMP, f)
        im = Image.open(p).convert('RGBA')
        im.save(os.path.join(ROOT, f))
        print(f'{f}  {im.size}  {os.path.getsize(os.path.join(ROOT, f))} 字节')
