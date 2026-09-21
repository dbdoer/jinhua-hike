# 金华徒步路线地图

把两步路（2bulu）导出的 GPX 轨迹做成一张可筛选、可看剖面、能导航到起点的地图。
纯静态站点，没有构建步骤、没有 npm，MapLibre GL 直接 vendor 在本地。

线上：<https://ijinhua.com>

数据是金华一带的徒步路线，来自两步路用户上传的轨迹。**每条路线都带着原作者信息**
（上传者、轨迹 ID、原始文件），详情页里能点回两步路原页。

## 快速开始

```bat
:: 双击 serve.bat —— 起本地服务并打开浏览器（端口 8012）
```

```bash
python -m http.server 8012     # 或者手动起
```

> 直接双击 `index.html`（`file://`）也能看，因为数据包成了 `data/routes.index.js` +
> `data/routes.geom.js`（都是 `window.HIKE_*` 赋值）而不是靠 `fetch` 加载 ——
> 后者在 `file://` 下会被浏览器拦掉。

## 目录结构

```
jinhua-hike/
├── index.html          页面骨架（筛选条 / 地图 / 面板 / 图例）
├── app.js              全部前端逻辑：地图、筛选、列表、详情、剖面
├── style.css
├── favicon.svg          站点图标（矢量，现代浏览器优先用这个）
├── favicon.ico          同图的 16/32/48 三档（浏览器按约定讨的 /favicon.ico、Windows 快捷方式）
├── apple-touch-icon.png 180px 方角版（iOS 加到主屏用）
├── vendor/             MapLibre GL 本地兜底（主路径走七牛 CDN，CDN 挂了它接管）
├── data/               构建产物，由 tools/ 下的脚本生成
│   ├── routes.json     完整数据（含 geometry / annotations）
│   ├── routes.geojson  标准 GeoJSON，供外部工具吃
│   ├── routes.index.js 列表元数据（window.HIKE_INDEX，~20KB，首屏就要）
│   ├── routes.geom.js  几何 + 标注点（window.HIKE_GEOM，~130KB，可晚一步到）
│   ├── spots.js        点位（window.SPOT_DATA，量级小，跟元数据一起上）
│   └── spots.geojson   点位的标准 GeoJSON
├── gpx/                两步路导出的原始 GPX + MANIFEST.json（字节指纹）
├── spots/              点位：人工打点的源数据（照 gpx/ 的地位，源在库里、产物在 data/）
│   ├── spots.json      一个点一条，坐标手标
│   └── photos/         自己拍的照片（WebP，宽 1200）
├── tools/              构建与自查脚本（Python 3；只有 prep_photos.py 用到 Pillow）
│   ├── build_routes.py
│   ├── build_spots.py
│   ├── check_dupes.py
│   ├── check_gpx_manifest.py
│   ├── prep_photos.py  点位照片压 WebP（手动跑一次，不进流水线）
│   └── data/jinhua_counties.json   金华 9 个县市区的行政边界多边形
├── docs/               README 用的演示截图（demo-*.png，随版本库走）
│   ├── multi-theme.md  多题材改造清单（徒步 / 玩水 / 赏秋）
│   └── icons/          图标的两个尺寸变体源码（见下节）
└── shots/              自测截图（不进版本库）
```

## 站点图标怎么来的

同一张图，三份产物。源码是 `favicon.svg`（主图）加 `docs/icons/` 里两个变体：

- `favicon.svg` —— 绿底、白色双峰、右上角一点太阳（跟页面上那个品牌绿点一个色 `#059669`）
- `docs/icons/favicon-16.svg` —— **16px 是重画的，不是缩小的。** 大图缩到 16px 会糊：
  实测太阳糊成一团黄绿、山脊全是半透明过渡色；小尺寸专版把太阳放大、脊线压到半像素上
- `docs/icons/favicon-square.svg` —— 苹果版，**不留圆角**（iOS 自己会切圆角，我们再切
  一道就是双重圆角、四角发黑）

生成过程留在 `tools/` 里了（一次性脚本，不进流水线）：

```bash
cd E:/code/jinhua-hike
NODE_PATH="$LOCALAPPDATA/Temp/jh-hike/node_modules" node tools/render_icons.js   # 需要本机 Chrome
python tools/build_icons.py                                                      # 拼 ICO，需要 Pillow
```

两条都是踩出来的：

1. **渲染前必须把 SVG 的固有 `width/height` 换成 `100%`** —— SVG 带着 `width="64"` 时
   Chrome 就按 64px 画，视口小于 64 截到的是左上角那一块（真踩过：32px 那格画出来
   是半个圆角）。脚本里改完会断言一次，改不掉直接抛。
2. 截图要 `omitBackground`，否则圆角外面糊上白底。

`build_icons.py` 把 16/32/48 三张 PNG 手拼进 ICO 容器（PNG 载荷直接塞，Vista 以后都认），
拼完两头都验：Pillow 能列出三档尺寸、浏览器 `<img>` 能解码出 48x48。

`index.html` 里三个 `<link rel="icon">` 全写上——只留 SVG 的话，按约定讨
`/favicon.ico` 的客户端（老浏览器、部分爬虫、Windows 快捷方式）照样扑空。

## 数据管线

```
gpx/*.gpx  ──build_routes.py──▶  data/routes.{json,geojson}
                                 + routes.index.js + routes.geom.js
```

```bash
python tools/build_routes.py            # 读 gpx/*.gpx，输出 data/
python tools/build_routes.py --src gpx  # 指定来源目录
```

管线**可复现**：GPX 不变，重跑一遍产物字节不变。

### 派生字段来源

这是本 README 的正题——`build_routes.py` 的注释里写着「派生字段的来源都在 README 里写明」。
下表逐条对应代码，**不确定的一律给 null，不猜不编**。

| 字段 | 来源 / 规则 |
|---|---|
| `id` | `"tb_" + TrackId`；无 TrackId 时用路线名把非单词字符换成 `_` |
| `name` | GPX `<extensions><name>`；缺失则用文件名（去扩展名） |
| `region` | 行政区归属，三步法，见下 |
| `region_source` | 上一步实际用了哪条路（说明可信度） |
| `difficulty` | 距离＋累计爬升的**透明规则**，见下 |
| `difficulty_reason` | 上面那条规则的可读文本（UI 里会显示） |
| `family` | 距离 ≤8km 且 爬升 ≤400m 且（用时未知 或 ≤5h）→ `true`，否则 `null` |
| `family_reason` | 规则文本；不满足则 `null` |
| `family_tag` | 描述 / 标注点 / 标签里出现「亲子·家庭·儿童·遛娃」→ `true`，否则 `null` |
| `has_water` | 同一段文本里出现「瀑布·溪·涧·水潭·深潭·水源·涉水」→ `true`，否则 `null` |
| `water_reason` | 命中的关键词 |
| `distance_km` | 相邻 trkpt 的大圆距离累加（R = 6371.0088 km），保留 2 位 |
| `ascent_m` / `descent_m` | 累计爬升/下降，**3 m 滞回阈值**滤掉 GPS 高程抖动 |
| `ele_min` / `ele_max` | 所有 trkpt 高程的最小/最大值 |
| `hours` | 优先首末 trkpt 时间戳之差；无时间戳退用扩展 `TimeUsed`（毫秒）；**若它为 0 视为无效，给 null** |
| `pause_hours` | 扩展 `PauseTime`（毫秒） |
| `track_points` | trkpt 原始点数（抽稀前） |
| `waypoints` | `<wpt>` 个数 |
| `geometry_from` | `trk` 或 `rte`——两步路有时导出「路线」而非「轨迹」，见下 |
| `start` / `end` | 首点 / 末点经纬度 |
| `tags` | 扩展 `TrackTags`，按 `,`、`，`、`、`、空白切分 |
| `description` | 扩展 `description` |
| `annotations` | 所有带 name 或 desc 的 `<wpt>`（lon/lat/name/desc/ele/time） |
| `source` | provider = 两步路(2bulu)、track_id、creator、creator_id、app_version、begin_time、原始文件名 |
| `geometry` | LineString，坐标为 `[lon, lat, ele?]`；**RDP 抽稀 eps = 0.00004（≈4 m）** |

### 行政区归属：三步法

`region` 不靠猜，三步依次降级，越靠前越可信：

1. **`PosStartName` 里恰好出现一个县市区名** → 直接采用。这是上传者自己填的，最可信。
   注意它是**自由文本**（形如「金华市义乌市上溪镇五星社村…」），所以用「包含」匹配而非整串相等。
2. **按真实行政边界判定** —— 拿轨迹起点做点在多边形内判断，边界取自阿里云 DataV.GeoAtlas
   的金华市 9 个县市区完整多边形（`tools/data/jinhua_counties.json`）。
   起点判不出来时（GPS 抖动 / 跨市），沿轨迹取 1/4、1/2、3/4、末点**投票取多数**。
3. **退回「离县城中心最近」**，并在 `region_source` 里明确标注是近似。

> ⚠️ **第 2 步有个必须做的坐标转换。** DataV.GeoAtlas 的边界是 **GCJ-02（火星坐标）**，
> 而 GPX 是 **WGS-84**，本地实测两者差约 **560 m**。不转换的话边界附近的点会判到隔壁县：
> 实测 25 条有上传者自报县名的路线，**直接判对 24/25，先转 GCJ 再判 25/25**。
> 所以 `county_of()` 里那步 `_wgs2gcj()` 不是可选优化。

### 难度 / 亲子 / 涉水

**难度**是系统按「距离＋累计爬升」判的，**不是两步路官方评级**（图例里也写明了）：

| 难度 | 条件 | 颜色 |
|---|---|---|
| 休闲 | ≤ 8 km 且爬升 ≤ 400 m | 绿 `#059669` |
| 中等 | ≤ 15 km 且爬升 ≤ 900 m | 橙 `#d97706` |
| 困难 | 距离 > 15 km 或爬升 > 900 m | 红 `#b91c1c` |

**亲子 / 涉水**两条都是布尔标记，数据不足时给 `null`（未知），不硬猜：
亲子可以来自系统判定（距离/爬升/用时）也可以来自文本关键词；
涉水只认文本关键词，认不出来就是未知。

### 海拔剖面为什么不单独存

`geometry` 的坐标本身就是 `[lon, lat, ele]`，**前端从几何现算剖面**。
曾经单独存过一份 240 点的抽稀剖面，单条约 1.6 KB gzip —— 等于把高程存了两遍。

有个连带约束：抽稀时**必须强制保留最高点和最低点**。否则前端从几何算出来的剖面峰值
会低于 `ele_max`，两个数字对不上。

### 「轨迹」与「路线」

两步路导出有两种形态：

- `<trk>/<trkpt>`：**轨迹**，带录制时间戳，正常路径。
- `<rte>/<rtept>`：**路线**，没有录制时间（在 App 里合并/拆分多段后导出会走这条）。

没有 trkpt 时回退用 rtept，其余口径（距离 / 爬升 / 难度 / 剖面）完全一致，
但 `geometry_from` 会记成 `rte` 以示区别。另外「路线」类文件里 `TimeUsed` / `PauseTime`
都是 0，**不能当成功耗时**，否则用时显示成 `0 h`。

## 自查脚本

都是 Python 标准库，无需依赖。

```bash
python tools/check_dupes.py             # 导入前体检：找重复/疑似重复的 GPX
python tools/check_gpx_manifest.py      # 校验 gpx/ 原始字节，不一致则退出码 1
python tools/check_gpx_manifest.py --write   # 确认改动后，按当前 gpx/ 重写清单
python tools/check_gpx_manifest.py --quiet   # 只报问题（build_routes.py 内部会调）
```

**`check_dupes.py`** 做五类检查：① 文件内容完全相同；② TrackId 相同；③ 路线名相同；
④ 几何形状高度重合（沿路径等距取 40 点，50 m 容差，双向重合 ≥ 80%）；
⑤ 与 `data/routes.json` 里已上线的路线比对。明细写到 `data/_scan.json`（自测产物，不入库）。

## GPX 原始字节为什么不能碰

站点详情页有「**下载原始 GPX**」的链接，给出去的必须是上传者导出的那串字节。这件事有三个坑：

1. 本机 `core.autocrlf=true`，git 会把 GPX 的 CRLF 压成 LF。实测「北山第一瀑石佛大盘尖.gpx」
   工作区 169314 字节、仓库里只有 164150 —— 差 5164，正好是 CRLF 的个数。
   **链接照样返回 200**，光看「能不能打开」根本发现不了。
2. 所以 `.gitattributes` 里写了 `*.gpx -text`，**禁止一切行尾转换，别删它**。
3. `gpx/MANIFEST.json` 记录 56 个 GPX 的 sha256 与字节数；`build_routes.py` 收尾时会自动
   跑一次校验（quiet 模式），不一致就提示。清单**刻意不放时间戳** —— 只有内容真变了 diff 才动。

## 点位：自己打点，跟两步路那批数据分开

徒步路线来自两步路用户上传的 GPX；**点位是本站自己实地打的点**，两套数据、两条管线，
互不参与对方的筛选。地图右上角那个「点位」开关是它们唯一的总闸。

```
spots/spots.json + spots/photos/  ──build_spots.py──▶  data/spots.js + data/spots.geojson
```

**机器只校验，不替你选点** —— 坐标必须人手填，并且写清来源与精度。这条规矩从徒步那边
沿用过来，`build_spots.py` 校验不过就退出码 1、不写产物。

```bash
python tools/build_spots.py               # 校验 + 生成
python tools/build_spots.py --check-only  # 只看校验结果
```

### 一个点长这样

```json
{
  "id": "shuanglong-shuishan",          // 小写字母/数字/连字符，稳定不改
  "name": "双龙洞外那片水杉",
  "kind": "水杉",                        // 类别，见 build_spots.py 的 KINDS（树种 / 瀑布 / 其他）
  "region": "婺城区",
  "lon": 119.62123, "lat": 29.13891,     // WGS-84，手标
  "coord_src": "Google Earth 手标",      // 坐标哪来的，必须写
  "coord_acc_m": 20,                     // 精度（米），必须写
  "intro": "秋天这里的红水杉很漂亮，沿路一整排，下午三四点斜光最好看。",
  "best_from": "11-中", "best_to": "12-上",   // 最佳观赏期，按旬
  "season_note": "2025 年偏暖，比往年晚一周",  // 今年的实际情况，可空
  "verified_at": "2025-11-23",           // 最后一次亲眼确认
  "access": "免费；车停路边空地，往里走 5 分钟",
  "tags": ["免费", "开车可达"],
  "photos": [
    {
      "file": "shuanglong-01.webp",      // 只写文件名，实际在 spots/photos/
      "caption": "11 月下旬，下午三点左右",
      "shot_at": "2025-11-23",
      "credit": null,                    // null＝本站自摄（见下）
      "credit_url": null,
      "license": null
    }
  ]
}
```

### 时间轴按「旬」——这是赏秋图的骨头

`best_from` / `best_to` 写「11-中」这种形式（月-上/中/下）。详情页和悬停气泡会根据
**今天的旬**算出一句话：还在等 / 正是时候 / 刚过去 / 今年这季已过。

不写时间，这就是一堆钉子：用户十月打开和十二月打开看到的一样。写了时间，它才回答
「现在该去哪儿」——而这一句别人抄不走，因为他们不会年年去更新。

代价也说清楚：**这是长期的债**。银杏黄得早晚年年不同，每年秋天得回来更新一次
`season_note` 和 `verified_at`。

### 图片与版权

- 图放 `spots/photos/`，**WebP、宽 1200、单张 400 KB 以内**（超过了脚本会提醒）。
  **用 `tools/prep_photos.py` 压，别手动压** —— 它顺带按 EXIF 转正（手机竖拍不转正会躺倒）、
  丢掉含 GPS 的 EXIF（站点已公开点位，没必要再交出每次拍摄的精确坐标）、宽度只缩不放。
  手动压必忘后两件。输出名是 `<前缀>-01.webp`，直接填进 `photos[].file`。
  详情页挂了 `loading="lazy"`，别让列表把图都拉下来。
- **`credit` 为 `null` 就是「本站自摄」**，详情页会写「本站自摄」。
- 别人的图**必须**同时填 `credit`（摄影者）和 `license`（授权方式），脚本会卡住不放。
  建议再填 `credit_url` 链回原帖。**没有授权就别用** —— 这个站自己的版权声明才立得住。

### 加一个点的流程

```bash
# 1. 到现场，拍照，用 Google Earth 取 WGS-84 坐标（记下精度）
# 2. 图片压成 WebP、宽 1200，丢进 spots/photos/
python tools/prep_photos.py --prefix shuanglong 原图1.jpg 原图2.jpg
# 3. 往 spots/spots.json 里加一条
# 4. python tools/build_spots.py     # 校验通过才生成 data/spots.js
# 5. 本地 serve.bat 看一眼，提交
```

## 新增一条路线

```bash
# 1. 两步路 App 导出 GPX，丢进 gpx/
# 2. 先体检，别让重复的混进去
python tools/check_dupes.py
# 3. 重新构建 data/
python tools/build_routes.py
# 4. 确认原始字节是有意改动后，更新清单
python tools/check_gpx_manifest.py --write
# 5. 本地 serve.bat 看一眼，提交
```

