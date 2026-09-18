/* =========================================================================
   金华徒步路线 Demo
   数据：两步路(2bulu)导出的 GPX -> tools/build_routes.py -> data/routes.js
   底图：OpenFreeMap(免费无 key) / OpenTopoMap(等高线) / Esri 影像
   ========================================================================= */
'use strict';

const DIFF_COLOR = { '休闲': '#059669', '中等': '#d97706', '困难': '#b91c1c' };
const JINHUA = {
  center: [119.72, 29.13],
  zoom: 9,
  // 金华市范围，留一点余量，防止用户把地图拖到天涯海角
  bounds: [[119.05, 28.42], [120.98, 29.82]],
};

let routes = ((window.HIKE_DATA || {}).routes || []).slice();
const state = {
  regions: new Set(), diffs: new Set(),
  family: false, water: false, wpt: true,
  dist: 'all', q: '', sort: 'distance',
  selected: null, base: 'liberty',
};
let lastRegionSig = '';

/* ------------------------- 管理通道（导入 GPX） -------------------------
   访客看不到导入入口。说清楚，这不是权限控制 —— 静态站没有服务端，前端任何
   开关都能被查看源码、改一行 JS 绕过。真正的守卫是 GitHub 仓库的写权限：
   只有 push 进仓库的路线才会出现在所有人面前。访客即使真调用了导入，
   结果也只活在他自己浏览器的内存里，刷新即消失，不上传、别人看不到。

   开启：带 ?admin=1 打开一次，本机记住；?admin=0 关掉。 */
const ADMIN_KEY = 'jinhua-hike-admin';
const isAdmin = (() => {
  const q = new URLSearchParams(location.search).get('admin');
  if (q === '1') { try { localStorage.setItem(ADMIN_KEY, '1'); } catch (_) { /* 隐私模式下忽略 */ } return true; }
  if (q === '0') { try { localStorage.removeItem(ADMIN_KEY); } catch (_) { } return false; }
  try { return localStorage.getItem(ADMIN_KEY) === '1'; } catch (_) { return false; }
})();

/* ----------------------------- 地图 ----------------------------- */
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: JINHUA.center,
  zoom: JINHUA.zoom,
  maxBounds: JINHUA.bounds,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-right');

const emptyFC = { type: 'FeatureCollection', features: [] };

map.on('load', () => {
  // 1) 备选底图（放在最底层，用 visibility 切换；矢量底图会被它们盖住）
  map.addSource('topo', {
    type: 'raster', tileSize: 256, maxzoom: 17,
    tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors · 样式 © OpenTopoMap (CC-BY-SA)',
  });
  map.addSource('sat', {
    type: 'raster', tileSize: 256, maxzoom: 19,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  });
  map.addLayer({ id: 'base-topo', type: 'raster', source: 'topo', layout: { visibility: 'none' } });
  map.addLayer({ id: 'base-sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } });

  // 2) 路线
  // 字号栈必须跟着当前底图样式走，否则 MapLibre 会用默认的 Open Sans/Arial Unicode MS，
  // OpenFreeMap 上没有这两个字体，中文标注直接 404 不显示
  const FONT = ((map.getStyle().layers.find(l => l.layout && l.layout['text-font']) || {}).layout || {})['text-font']
    || ['Noto Sans Regular'];

  map.addSource('routes', { type: 'geojson', data: emptyFC, promoteId: 'id' });
  map.addSource('ends', { type: 'geojson', data: emptyFC, promoteId: 'id' });
  map.addSource('annos', { type: 'geojson', data: emptyFC, promoteId: 'id' });
  map.addSource('sel', { type: 'geojson', data: emptyFC });

  map.addLayer({
    id: 'route-line', type: 'line', source: 'routes',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['match', ['get', 'difficulty'], '休闲', DIFF_COLOR['休闲'], '中等', DIFF_COLOR['中等'], '困难', DIFF_COLOR['困难'], '#64748b'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.2, 12, 3.6, 16, 6],
      'line-opacity': 0.92,
    },
  });
  map.addLayer({
    id: 'route-hover', type: 'line', source: 'routes',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#0f172a', 'line-width': 9, 'line-opacity': 0.22 },
    filter: ['==', ['get', 'id'], '__none__'],
  });
  map.addLayer({
    id: 'route-sel', type: 'line', source: 'sel',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.85 },
  });
  map.addLayer({
    id: 'route-label', type: 'symbol', source: 'routes', minzoom: 10.5,
    layout: {
      'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 12,
      'text-offset': [0, -0.9], 'text-anchor': 'bottom', 'text-allow-overlap': false,
    },
    paint: { 'text-color': '#0f172a', 'text-halo-color': '#fff', 'text-halo-width': 1.6 },
  });

  // 3) 起终点 & 沿途标注
  map.addLayer({
    id: 'end-dot', type: 'circle', source: 'ends',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 14, 8],
      'circle-color': ['match', ['get', 'role'], 'start', '#0284c7', '#0f172a'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'anno-dot', type: 'circle', source: 'annos',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 16, 7],
      'circle-color': '#7c3aed', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.6,
      'circle-opacity': 0.95,
    },
  });

  bindMapEvents();
  buildFilterChips();
  layoutPanel();
  refresh();
});

// 顶部筛选条高度会随 chip 换行变化，面板顶边跟着走，别互相压
function layoutPanel() {
  const bar = document.querySelector('.bar');
  const panel = document.getElementById('panel');
  // 窄屏下面板贴在底部（样式表里的 media query），此时别写内联 top，否则把它顶下去、底下空一截
  if (window.matchMedia('(max-width: 900px)').matches) {
    panel.style.removeProperty('top');
    return;
  }
  panel.style.top = Math.round(bar.getBoundingClientRect().bottom + 10) + 'px';
}
window.addEventListener('resize', layoutPanel);

/* --------------------------- 过滤与渲染 --------------------------- */
function matchDist(km, band) {
  if (band === 's') return km <= 8;
  if (band === 'm') return km > 8 && km <= 15;
  if (band === 'l') return km > 15;
  return true;
}

function matches(r, opts) {
  const o = opts || {};
  if (!o.skipRegion && state.regions.size && !state.regions.has(r.region)) return false;
  if (!o.skipDiff && state.diffs.size && !state.diffs.has(r.difficulty)) return false;
  if (!o.skipDist && !matchDist(r.distance_km, state.dist)) return false;
  if (!o.skipFamily && state.family && r.family !== true) return false;
  if (!o.skipWater && state.water && r.has_water !== true) return false;
  const q = (state.q || '').trim().toLowerCase();
  if (q) {
    const hay = [r.name, r.description, r.region, (r.tags || []).join(' '),
      (r.annotations || []).map(a => a.name + ' ' + a.desc).join(' ')]
      .join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function filtered() {
  const list = routes.filter(r => matches(r));
  const s = state.sort;
  list.sort((a, b) => s === 'name' ? a.name.localeCompare(b.name, 'zh')
    : s === 'ascent' ? b.ascent_m - a.ascent_m
      : a.distance_km - b.distance_km);
  return list;
}

function boundsOf(r) {
  const b = new maplibregl.LngLatBounds();
  r.geometry.coordinates.forEach(c => b.extend([c[0], c[1]]));
  return b;
}

/* 筛选后「补视野但不抢镜头」：
   只有当当前视野里**一条结果都看不见**时，才把地图移到结果集上。
   只要视野里已经有结果，就绝不动用户的地图 —— 用户拖到哪儿就是哪儿。

   为什么用 bbox 相交而不是 queryRenderedFeatures：后者依赖瓦片渲染完成，
   而 setData 是异步进 worker 的，刚设完就读会得到 0，会误判成「看不见」。
   isMoving() 那道 guard 是防跟镜头动画抢：select() 里 fitBounds 带动画，
   动画途中 getBounds() 返回的是中途状态，不拦的话会误判。 */
function ensureVisible(list) {
  if (!list.length || map.isMoving()) return;
  const v = map.getBounds();
  const w = v.getWest(), e = v.getEast(), s = v.getSouth(), n = v.getNorth();
  for (const r of list) {
    const b = boundsOf(r);
    if (!(b.getEast() < w || b.getWest() > e || b.getNorth() < s || b.getSouth() > n)) return;
  }
  const all = new maplibregl.LngLatBounds();
  list.forEach(r => all.extend(boundsOf(r)));
  map.fitBounds(all, { padding: fitPadding(), duration: 700 });
}

// 平移目标区域时给顶部筛选条和右侧/底部面板让位，别把结果藏到面板底下
function fitPadding() {
  const H = window.innerHeight, W = window.innerWidth;
  const bar = document.querySelector('.bar');
  const top = (bar ? Math.round(bar.getBoundingClientRect().height) : 40) + 20;
  let p;
  if (window.matchMedia('(max-width: 900px)').matches) {
    // 窄屏：面板贴在下方占约 46%
    p = { top, bottom: Math.round(H * 0.5), left: 24, right: 24 };
  } else {
    const panel = document.getElementById('panel');
    p = {
      top, bottom: 40, left: 40,
      right: panel ? Math.round(W - panel.getBoundingClientRect().left + 16) : 40,
    };
  }
  // 窄屏下筛选条展开能有 330+ px 高，加上面板占半屏，上下留白会把可视区挤到几乎没有，
  // fitBounds 拿不到可用高度会算出荒唐的缩放。按比例压回去，至少留 30% 视野。
  const vLimit = Math.round(H * 0.7), hLimit = Math.round(W * 0.7);
  if (p.top + p.bottom > vLimit) {
    const k = vLimit / (p.top + p.bottom);
    p.top = Math.round(p.top * k); p.bottom = Math.round(p.bottom * k);
  }
  if (p.left + p.right > hLimit) {
    const k = hLimit / (p.left + p.right);
    p.left = Math.round(p.left * k); p.right = Math.round(p.right * k);
  }
  return p;
}

function refresh() {
  const list = filtered();

  map.getSource('routes').setData({
    type: 'FeatureCollection',
    features: list.map(r => ({
      type: 'Feature', id: r.id,
      properties: {
        id: r.id, name: r.name, difficulty: r.difficulty, region: r.region,
        distance_km: r.distance_km, ascent_m: r.ascent_m,
      },
      geometry: r.geometry,
    })),
  });

  map.getSource('ends').setData({
    type: 'FeatureCollection',
    features: list.flatMap(r => [
      { type: 'Feature', id: r.id + '_s', properties: { id: r.id + '_s', route_id: r.id, role: 'start', name: r.name }, geometry: { type: 'Point', coordinates: [r.start.lon, r.start.lat] } },
      { type: 'Feature', id: r.id + '_e', properties: { id: r.id + '_e', route_id: r.id, role: 'end', name: r.name }, geometry: { type: 'Point', coordinates: [r.end.lon, r.end.lat] } },
    ]),
  });

  const annoFeats = [];
  list.forEach(r => (r.annotations || []).forEach((a, i) => annoFeats.push({
    type: 'Feature', id: r.id + '_a' + i,
    properties: { id: r.id + '_a' + i, route_id: r.id, name: a.name || '标注点', ele: a.ele, time: a.time },
    geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
  })));
  map.getSource('annos').setData({ type: 'FeatureCollection', features: annoFeats });

  map.setLayoutProperty('anno-dot', 'visibility', state.wpt ? 'visible' : 'none');
  map.setFilter('anno-dot', state.wpt && state.selected
    ? ['==', ['get', 'route_id'], state.selected]
    : ['==', ['get', 'id'], '__none__']);

  renderList(list);
  document.getElementById('cnt-hit').textContent = list.length;
  document.getElementById('cnt-all').textContent = '/ ' + routes.length + ' 条路线';

  // 导入新轨迹会带来新区域，chip 要跟着重建，否则新区域没法筛
  const sig = uniq('region').sort().join('|');
  if (sig !== lastRegionSig) { lastRegionSig = sig; buildFilterChips(); }
  updateChips();

  // 窄屏收起时，生效的筛选数写在「筛选」按钮上——筛选状态不能被折叠藏起来
  const nAct = state.regions.size + state.diffs.size + (state.dist !== 'all' ? 1 : 0)
    + (state.family ? 1 : 0) + (state.water ? 1 : 0);
  document.getElementById('filter-count').textContent = nAct ? String(nAct) : '';

  // 结果被筛到视野外了才补镜头（视野里已经有结果就不动，见 ensureVisible）
  ensureVisible(list);
}

/* --------------------------- 列表卡片 --------------------------- */
function renderList(list) {
  const box = document.getElementById('list');
  if (!list.length) {
    box.innerHTML = isAdmin
      ? `<div class="empty">
           没有匹配的路线。<br><br>
           当前数据集共 <b>${routes.length}</b> 条。加新路线：把两步路导出的 GPX 丢进
           <code>gpx/</code>，跑 <code>python tools/build_routes.py</code> 再 push。<br><br>
           或者点右上角 <code>导入 GPX</code> 先看一眼效果 —— 只在本机内存里，刷新即消失。
         </div>`
      : `<div class="empty">
           没有匹配的路线。<br><br>
           当前数据集共 <b>${routes.length}</b> 条，全部来自两步路用户上传的轨迹。
         </div>`;
    return;
  }
  box.innerHTML = list.map(r => {
    const tags = [];
    if (r.family === true) tags.push(`<span class="tag t-family">亲子可走</span>`);
    if (r.has_water === true) tags.push(`<span class="tag t-water">涉水 / 瀑布</span>`);
    if ((r.annotations || []).length) tags.push(`<span class="tag t-anno">${r.annotations.length} 个标注点</span>`);
    if (r.imported) tags.push(`<span class="tag">刚导入</span>`);
    return `<div class="card ${state.selected === r.id ? 'on' : ''}" data-id="${r.id}">
      <h3>${esc(r.name)}<span class="badge ${r.difficulty}">${r.difficulty}</span></h3>
      <div class="meta">
        <span><b>${r.distance_km}</b> km</span>
        <span>爬升 <b>${r.ascent_m}</b> m</span>
        <span>${r.hours ? '<b>' + r.hours + '</b> h' : '用时未知'}</span>
        <span>${esc(r.region || '区域未知')}</span>
      </div>
      <div class="tags">${tags.join('')}</div>
    </div>`;
  }).join('');
  box.querySelectorAll('.card').forEach(el => {
    el.onclick = () => select(el.dataset.id);
  });
}

/* --------------------------- 详情 --------------------------- */
function select(id) {
  const r = routes.find(x => x.id === id);
  if (!r) return;
  state.selected = id;
  map.getSource('sel').setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: r.geometry }],
  });
  map.fitBounds(boundsOf(r), { padding: { top: 200, right: 430, bottom: 70, left: 70 }, duration: 900 });
  renderDetail(r);
  refresh();
  if (state.wpt) {
    map.setFilter('anno-dot', ['==', ['get', 'route_id'], id]);
    map.setLayoutProperty('anno-dot', 'visibility', 'visible');
  }
}

function backToList() {
  state.selected = null;
  map.getSource('sel').setData(emptyFC);
  document.getElementById('detail').hidden = true;
  document.getElementById('list').hidden = false;
  document.getElementById('btn-back').hidden = true;
  refresh();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function navRow(k, v) {
  return v || v === 0 ? `<div class="kv"><span>${k}</span><span>${v}</span></div>` : '';
}

function renderDetail(r) {
  const s = r.source || {};
  const anno = r.annotations || [];
  const d = new Date(Number(s.begin_time) || 0);
  const exported = s.begin_time && !isNaN(d.getTime())
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;

  const nav = [
    `<a href="https://uri.amap.com/marker?position=${r.start.lon},${r.start.lat}&name=${encodeURIComponent(r.name + ' 起点')}&coordinate=wgs84&callnative=1&src=jinhua-hike-demo" target="_blank" rel="noopener">高德导航到起点</a>`,
    `<a href="https://api.map.baidu.com/marker?location=${r.start.lat},${r.start.lon}&title=${encodeURIComponent(r.name)}&content=轨迹起点&coord_type=wgs84&output=html&src=webapp.jinhua.hike" target="_blank" rel="noopener">百度导航到起点</a>`,
    `<button data-copy="${r.start.lat},${r.start.lon}">复制 WGS-84 坐标</button>`,
    `<button data-locate="${r.id}">地图上定位起点</button>`,
  ];
  // 本地导入的 GPX 不在 gpx/ 目录里，别给一个必然 404 的下载链接
  if (s.file && !r.imported) nav.push(`<a href="gpx/${encodeURIComponent(s.file)}" download>下载原始 GPX</a>`);
  else if (r.imported) nav.push('<span style="color:#94a3b8;font-size:12px">本地导入的 GPX，未随页面分发</span>');

  const generic = [
    '山里信号差，出发前把轨迹离线存到手机（两步路/户外助手均可离线）。',
    '带够水：一般按 500ml/小时估，夏季加量；沿途水源不保证可直饮。',
    '留足白天时间，按「预计用时 × 1.5」倒推出发时刻，别卡日落。',
    '告知同伴行程与预计返回时间；独行风险高。',
    '雨后石阶、泥坡极滑；雷雨、大风、大雾天不上山。',
    '蛇虫、蜂、蚂蟥季节性强，长裤＋高帮鞋。',
    '垃圾全部带走。',
  ];

  document.getElementById('detail').innerHTML = `
    <h2>${esc(r.name)}</h2>
    <div class="sub">${esc(r.region || '区域未知')} · ${esc(r.difficulty)} · 数据来自两步路用户上传</div>

    <div class="grid">
      <div><span>距离</span><b>${r.distance_km} km</b></div>
      <div><span>累计爬升</span><b>${r.ascent_m} m</b></div>
      <div><span>累计下降</span><b>${r.descent_m} m</b></div>
      <div><span>最高点</span><b>${r.ele_max == null ? '—' : r.ele_max + ' m'}</b></div>
      <div><span>最低点</span><b>${r.ele_min == null ? '—' : r.ele_min + ' m'}</b></div>
      <div><span>总用时</span><b>${r.hours ? r.hours + ' h' : '—'}</b></div>
    </div>

    ${profileSVG(r)}

    <h4>这条路线是什么样的</h4>
    <p>${r.description ? esc(r.description) : '<span style="color:#94a3b8">上传者没有写路线说明。</span>'}</p>
    <div class="note">${r.geometry_from === 'rte'
      ? `这是两步路的<b>路线</b>（计划轨迹），不是实际走过的记录：共 ${r.track_points} 个路线点、`
        + `${anno.length} 个标注点。没有录制时间，所以用时一栏是空的。`
      : `轨迹共 ${r.track_points} 个记录点，${anno.length} 个上传者标注点。用时含休息`
        + `${r.pause_hours ? '（其中停留 ' + r.pause_hours + ' h）' : ''}。`}</div>

    <h4>沿途标注（上传者留的记号）</h4>
    ${anno.length ? anno.map((a, i) => `<div class="anno">
        <span class="i">◆</span>
        <span style="flex:1">${esc(a.name || a.desc) || '未命名'}
          ${a.ele ? `<span style="color:#94a3b8"> · ${Math.round(a.ele)} m</span>` : ''}</span>
        <button data-goto="${r.id}:${i}">定位</button>
      </div>`).join('')
      : '<p style="color:#94a3b8">这条轨迹没有标注点。</p>'}

    <h4>注意事项</h4>
    ${r.description && /走错|注意|危险|塌方|封路|禁止/.test(r.description)
      ? `<p><b>上传者原话：</b>${esc(r.description)}</p>` : ''}
    <div class="warn">
      <b>通用提示</b>（针对「金华一带的山」的常规经验，不是这条路线专属的勘察结论）
      <ul>${generic.map(x => `<li>${x}</li>`).join('')}</ul>
    </div>

    <h4>怎么去</h4>
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div><span>起点坐标 WGS-84（纬度, 经度）</span><b style="font-size:12px">${r.start.lat.toFixed(5)}, ${r.start.lon.toFixed(5)}</b></div>
      <div><span>终点坐标 WGS-84（纬度, 经度）</span><b style="font-size:12px">${r.end.lat.toFixed(5)}, ${r.end.lon.toFixed(5)}</b></div>
    </div>
    <div class="links">${nav.join('')}</div>
    <div class="note">轨迹起点就是这份 GPX 的第一个记录点，未必是正规登山口或可停车的位置。
      山上坐标系是 WGS-84，国内导航 app 用火星坐标（GCJ-02），上面两个链接已经带上转换参数。</div>

    <h4>路线档案 / 数据来源</h4>
    ${navRow('数据来源', esc(s.provider || '—'))}
    ${navRow('两步路轨迹 ID', s.track_id ? `<a href="https://www.2bulu.com/track/track_detail.htm?trackId=${s.track_id}" target="_blank" rel="noopener">${s.track_id}</a>` : '—')}
    ${navRow('上传者', esc(s.creator || '—'))}
    ${navRow('上传者 ID', esc(s.creator_id || '—'))}
    ${navRow('录制 App 版本', esc(s.app_version || '—'))}
    ${navRow('轨迹录制日期', exported || '—')}
    ${navRow('GPX 文件', esc(s.file || '—'))}
    ${navRow('难度判定依据', esc(r.difficulty_reason || '—'))}
    ${navRow('亲子判定依据', r.family === true ? esc(r.family_reason || '—') : '未判定为亲子')}
    ${navRow('涉水判定依据', r.has_water === true ? esc(r.water_reason || '—') : '未识别到涉水关键词')}
    ${navRow('爬升估算口径', '3 m 滞回阈值滤 GPS 高程抖动，仍属估算')}

    <div class="note" style="margin-top:14px">
      轨迹版权归上传者所有，本页仅作展示演示；出行前请以现场路况、天气和景区公告为准。
      两步路没有开放 API，站点的轨迹页面也带 WAF 防护，批量获取唯一可行的方式是用户在 App 内导出 GPX。
    </div>
  `;
  document.getElementById('detail').querySelectorAll('[data-copy]').forEach(b => {
    b.onclick = () => copy(b.dataset.copy);
  });
  document.getElementById('detail').querySelectorAll('[data-locate]').forEach(b => {
    b.onclick = () => {
      const rr = routes.find(x => x.id === b.dataset.locate);
      map.flyTo({ center: [rr.start.lon, rr.start.lat], zoom: 15 });
    };
  });
  document.getElementById('detail').querySelectorAll('[data-goto]').forEach(b => {
    b.onclick = () => {
      const [rid, idx] = b.dataset.goto.split(':');
      const rr = routes.find(x => x.id === rid);
      const a = rr.annotations[Number(idx)];
      map.flyTo({ center: [a.lon, a.lat], zoom: 16 });
      new maplibregl.Popup().setLngLat([a.lon, a.lat])
        .setHTML(`<b>${esc(a.name || '标注点')}</b>${a.ele ? '<br>' + Math.round(a.ele) + ' m' : ''}`)
        .addTo(map);
    };
  });

  document.getElementById('detail').hidden = false;
  document.getElementById('list').hidden = true;
  document.getElementById('btn-back').hidden = false;
}

function copy(t) {
  navigator.clipboard?.writeText(t).then(
    () => toast('已复制：' + t), () => toast('复制失败，手动选一下吧：' + t));
}

/* 海拔剖面：不再单独存一份高程，直接从 geometry 坐标的第三位 [lng,lat,ele] 现算。
   两个口径上的讲究，都是为了让图上的数字跟上方网格对得上：

   1) 横轴按 r.distance_km / 几何总长 的比例拉回真值。几何是 RDP 抽稀过的
      （真实轨迹 ~1100 点 -> ~280 点），逐段累加会短 0.8~1.8%（实测：洪武古道
      12.17 -> 11.96 km）。不拉的话，图右上角写「12.0 km」而网格里写「12.18 km」，
      同一屏两个数，用户会以为哪个是错的。
   2) 纵轴的峰值靠 tools/build_routes.py 抽稀时强制保留最高/最低点来保证，
      否则图上的峰顶会低于 ele_max 一两米。 */
function profileFromGeometry(r) {
  const c = (r.geometry && r.geometry.coordinates) || [];
  if (c.length < 3) return null;
  const out = [];
  let d = 0;
  for (let i = 0; i < c.length; i++) {
    if (i) d += hav({ lon: c[i - 1][0], lat: c[i - 1][1] }, { lon: c[i][0], lat: c[i][1] });
    if (c[i].length > 2 && c[i][2] != null) out.push([d, c[i][2]]);
  }
  if (out.length < 3) return null;
  const total = out[out.length - 1][0];
  const k = total > 1e-6 && r.distance_km ? r.distance_km / total : 1;
  return k === 1 ? out : out.map(x => [x[0] * k, x[1]]);
}

function profileSVG(r) {
  const p = profileFromGeometry(r);
  if (!p || p.length < 3) return '';
  const W = 344, H = 96, PL = 34, PR = 8, PT = 10, PB = 16;
  const xs = p.map(d => d[0]), ys = p.map(d => d[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.floor(Math.min(...ys) / 50) * 50, y1 = Math.ceil(Math.max(...ys) / 50) * 50;
  const sx = v => PL + (v - x0) / Math.max(1e-9, x1 - x0) * (W - PL - PR);
  const sy = v => H - PB - (v - y0) / Math.max(1e-9, y1 - y0) * (H - PT - PB);
  const line = p.map((d, i) => (i ? 'L' : 'M') + sx(d[0]).toFixed(1) + ' ' + sy(d[1]).toFixed(1)).join(' ');
  const area = `${line} L ${sx(x1).toFixed(1)} ${H - PB} L ${sx(x0).toFixed(1)} ${H - PB} Z`;
  const hi = p.reduce((a, b) => (b[1] > a[1] ? b : a), p[0]);
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin-top:6px">
    <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#059669" stop-opacity=".45"/>
      <stop offset="1" stop-color="#059669" stop-opacity=".04"/></linearGradient></defs>
    <path d="${area}" fill="url(#pg)"/>
    <path d="${line}" fill="none" stroke="#047857" stroke-width="1.6"/>
    <line x1="${PL}" y1="${H - PB}" x2="${W - PR}" y2="${H - PB}" stroke="#e2e8f0"/>
    <circle cx="${sx(hi[0]).toFixed(1)}" cy="${sy(hi[1]).toFixed(1)}" r="3" fill="#b91c1c"/>
    <text x="${sx(hi[0]).toFixed(1)}" y="${(sy(hi[1]) - 6).toFixed(1)}" font-size="10" text-anchor="middle" fill="#b91c1c">${Math.round(hi[1])}m</text>
    <text x="${PL - 4}" y="${PT + 8}" font-size="10" text-anchor="end" fill="#94a3b8">${y1}</text>
    <text x="${PL - 4}" y="${H - PB}" font-size="10" text-anchor="end" fill="#94a3b8">${y0}</text>
    <text x="${PL}" y="${H - 4}" font-size="10" fill="#94a3b8">0 km</text>
    <text x="${W - PR}" y="${H - 4}" font-size="10" text-anchor="end" fill="#94a3b8">${x1.toFixed(1)} km</text>
  </svg>`;
}

/* --------------------------- 筛选条 UI --------------------------- */
function uniq(key) {
  return [...new Set(routes.map(r => r[key]).filter(Boolean))];
}

function countFor(group, value) {
  const skip = { region: 'skipRegion', difficulty: 'skipDiff' }[group];
  return routes.filter(r => matches(r, { [skip]: true })
    && (group === 'region' ? r.region === value : r.difficulty === value)).length;
}

function buildFilterChips() {
  document.querySelectorAll('.chips').forEach(box => {
    const g = box.dataset.group;
    const vals = g === 'difficulty' ? ['休闲', '中等', '困难'] : uniq('region');
    box.innerHTML = vals.map(v =>
      `<button class="chip" data-group="${g}" data-val="${esc(v)}">${esc(v)}<span class="n"></span></button>`).join('');
    box.querySelectorAll('.chip').forEach(c => {
      c.onclick = () => {
        const set = g === 'region' ? state.regions : state.diffs;
        const v = c.dataset.val;
        set.has(v) ? set.delete(v) : set.add(v);
        refresh();
      };
    });
  });
}

function updateChips() {
  document.querySelectorAll('.chip').forEach(c => {
    const g = c.dataset.group, v = c.dataset.val;
    const set = g === 'region' ? state.regions : state.diffs;
    c.classList.toggle('on', set.has(v));
    const n = countFor(g, v);
    c.querySelector('.n').textContent = n ? n : '';
    c.style.opacity = n ? 1 : .45;
  });
}

document.getElementById('f-dist').onchange = e => { state.dist = e.target.value; refresh(); };
document.getElementById('f-family').onchange = e => { state.family = e.target.checked; refresh(); };
document.getElementById('f-water').onchange = e => { state.water = e.target.checked; refresh(); };
document.getElementById('f-wpt').onchange = e => { state.wpt = e.target.checked; refresh(); };
document.getElementById('f-sort').onchange = e => { state.sort = e.target.value; refresh(); };
let qt = null;
document.getElementById('f-q').oninput = e => {
  clearTimeout(qt);
  qt = setTimeout(() => { state.q = e.target.value; refresh(); }, 180);
};
document.getElementById('btn-reset').onclick = () => {
  state.regions.clear(); state.diffs.clear();
  state.family = state.water = false; state.dist = 'all'; state.q = '';
  state.sort = 'distance'; state.selected = null;
  document.getElementById('f-dist').value = 'all';
  document.getElementById('f-family').checked = false;
  document.getElementById('f-water').checked = false;
  document.getElementById('f-sort').value = 'distance';
  document.getElementById('f-q').value = '';
  map.getSource('sel').setData(emptyFC);
  backToList();
  map.fitBounds(JINHUA.bounds, { padding: 40, duration: 700 });
};
document.getElementById('btn-back').onclick = backToList;

/* 窄屏折叠：筛选条件默认收成一行，点「筛选」展开（宽屏这个按钮不出现） */
const barEl = document.getElementById('bar');
const filterToggle = document.getElementById('btn-filter-toggle');
function setFiltersOpen(open) {
  barEl.classList.toggle('open', open);
  filterToggle.setAttribute('aria-expanded', String(open));
}
filterToggle.onclick = () => setFiltersOpen(!barEl.classList.contains('open'));
// 窄屏搜索框只有一百多像素宽，长占位文案会被切掉半句，换成短的
const qInput = document.getElementById('f-q');
const Q_LONG = qInput.placeholder;
const Q_SHORT = '搜索路线 / 标注点';
function syncPlaceholder() {
  qInput.placeholder = window.matchMedia('(max-width: 900px)').matches ? Q_SHORT : Q_LONG;
}
syncPlaceholder();
// 拖到宽屏就把折叠状态丢掉，免得缩回来时莫名其妙是展开的
window.addEventListener('resize', () => {
  if (!window.matchMedia('(max-width: 900px)').matches) setFiltersOpen(false);
  syncPlaceholder();
});

document.querySelectorAll('#base-switch button').forEach(b => {
  b.onclick = () => {
    state.base = b.dataset.base;
    document.querySelectorAll('#base-switch button').forEach(x => x.classList.toggle('on', x === b));
    map.setLayoutProperty('base-topo', 'visibility', state.base === 'topo' ? 'visible' : 'none');
    map.setLayoutProperty('base-sat', 'visibility', state.base === 'sat' ? 'visible' : 'none');
    if (state.base !== 'liberty') {
      // 栅格底图压在矢量之上，加不透明度让路线更容易看清
      map.setPaintProperty('route-line', 'line-opacity', 0.95);
      map.setPaintProperty('route-sel', 'line-opacity', 0.9);
    } else {
      map.setPaintProperty('route-line', 'line-opacity', 0.92);
      map.setPaintProperty('route-sel', 'line-opacity', 0.85);
    }
  };
});

/* --------------------------- 地图交互 --------------------------- */
function bindMapEvents() {
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  const ROUTE_LAYERS = ['route-line'];

  map.on('mousemove', e => {
    const f = map.queryRenderedFeatures(e.point, { layers: ROUTE_LAYERS })[0];
    map.getCanvas().style.cursor = f ? 'pointer' : '';
    map.setFilter('route-hover', ['==', ['get', 'id'], f ? f.properties.id : '__none__']);
    if (f) {
      popup.setLngLat(e.lngLat).setHTML(
        `<b>${esc(f.properties.name)}</b><br>${f.properties.distance_km} km · 爬升 ${f.properties.ascent_m} m<br>
         <span style="color:#64748b">${esc(f.properties.region || '')} · ${f.properties.difficulty}</span>`).addTo(map);
    } else popup.remove();
  });
  map.on('mouseleave', () => { popup.remove(); map.setFilter('route-hover', ['==', ['get', 'id'], '__none__']); });
  map.on('click', 'route-line', e => {
    if (e.features[0]) select(e.features[0].properties.id);
  });

  map.on('click', 'anno-dot', e => {
    const p = e.features[0].properties;
    new maplibregl.Popup().setLngLat(e.lngLat)
      .setHTML(`<b>${esc(p.name)}</b>${p.ele ? '<br>' + Math.round(p.ele) + ' m' : ''}`).addTo(map);
    map.getCanvas().style.cursor = '';
  });
  map.on('mouseenter', 'anno-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'anno-dot', () => { map.getCanvas().style.cursor = ''; });
}

/* --------------------------- 导入 GPX（仅管理通道） --------------------------- */
const btnImport = document.getElementById('btn-import');
if (isAdmin) {
  btnImport.hidden = false;
  btnImport.title = '管理通道：导入只在本机内存里，不会上传';
  btnImport.onclick = () => document.getElementById('file-input').click();
  document.getElementById('file-input').onchange = e => {
    importFiles([...e.target.files]);
    e.target.value = '';
  };
} else {
  btnImport.remove();
  document.getElementById('file-input').remove();
}

// 拖放导入：用计数器判断是否真的离开了窗口，别用 relatedTarget（不可靠）
let dragDepth = 0;
const dropEl = document.getElementById('drop');
// 不管是不是管理员都要 preventDefault：不然访客往页面里拖个文件，
// 浏览器会直接跳走打开那个文件，地图就没了。
window.addEventListener('dragenter', e => {
  e.preventDefault();
  if (!isAdmin) return;
  dragDepth++; dropEl.hidden = false;
});
window.addEventListener('dragover', e => { e.preventDefault(); });
window.addEventListener('dragleave', e => {
  e.preventDefault();
  if (!isAdmin) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropEl.hidden = true;
});
window.addEventListener('drop', e => {
  e.preventDefault();
  if (!isAdmin) return;
  dragDepth = 0; dropEl.hidden = true;
  importFiles([...(e.dataTransfer?.files || [])].filter(f => /\.gpx$/i.test(f.name)));
});
// 兜底：窗口失焦/ESC 也收起来，免得再出现蒙层赖着不走
window.addEventListener('blur', () => { dragDepth = 0; dropEl.hidden = true; });
window.addEventListener('keydown', e => { if (e.key === 'Escape') { dragDepth = 0; dropEl.hidden = true; } });

async function importFiles(files) {
  if (!files.length) return toast('没读到 .gpx 文件');
  let ok = 0, bad = [];
  for (const f of files) {
    try {
      const r = parseGpxText(await f.text(), f.name);
      // 双保险：id 相同，或两步路 TrackId 相同，都算已存在
      const dup = routes.find(x => x.id === r.id
        || (r.source.track_id && x.source && x.source.track_id === r.source.track_id));
      if (dup) { bad.push(f.name + '（已存在：' + dup.name + '）'); continue; }
      routes.push(r); ok++;
    } catch (err) { bad.push(f.name + '（' + err.message + '）'); }
  }
  refresh();
  toast(`导入 ${ok} 条${bad.length ? '，跳过 ' + bad.length + ' 条：' + bad.join('、') : ''}`);
}

/* 客户端解析两步路 GPX：与 tools/build_routes.py 同一套口径 */
function parseGpxText(text, filename) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const ns = n => [...doc.getElementsByTagNameNS('*', n)];
  const txt = (el, n) => { const x = el.getElementsByTagNameNS('*', n)[0]; return x ? (x.textContent || '').trim() : null; };

  const readPts = tag => ns(tag).map(p => ({
    lat: +p.getAttribute('lat'), lon: +p.getAttribute('lon'),
    ele: txt(p, 'ele') ? +txt(p, 'ele') : null, time: txt(p, 'time'),
  })).filter(p => isFinite(p.lat) && isFinite(p.lon));

  // 两步路有时导出「路线」（<rte>/<rtept>，计划轨迹，没有录制时间）而不是「轨迹」。
  // 与 build_routes.py 同口径：没有 trkpt 时退回 rtept，其余算法完全一致。
  let trkpts = readPts('trkpt');
  let geometryFrom = 'trk';
  if (trkpts.length < 2) {
    trkpts = readPts('rtept');
    geometryFrom = 'rte';
    if (trkpts.length < 2) throw new Error('没有轨迹点');
  }

  const wpts = ns('wpt').map(p => ({
    lat: +p.getAttribute('lat'), lon: +p.getAttribute('lon'),
    name: txt(p, 'name') || '', desc: txt(p, 'desc') || '',
    ele: txt(p, 'ele') ? +txt(p, 'ele') : null, time: txt(p, 'time'),
  }));

  const ext = {};
  const extEl = [...doc.documentElement.children].find(c => c.localName === 'extensions');
  if (extEl) [...extEl.children].forEach(c => { ext[c.localName] = (c.textContent || '').trim(); });

  let dist = 0, asc = 0, des = 0, ref = null;
  for (let i = 0; i < trkpts.length; i++) {
    if (i) dist += hav(trkpts[i - 1], trkpts[i]);
    const p = trkpts[i];
    if (p.ele == null) continue;
    if (ref == null) { ref = p.ele; continue; }
    const d = p.ele - ref;
    if (d >= 3) { asc += d; ref = p.ele; } else if (d <= -3) { des -= d; ref = p.ele; }
  }
  const eles = trkpts.filter(p => p.ele != null).map(p => p.ele);
  const times = trkpts.map(p => p.time).filter(Boolean);
  let hours = null;
  if (times.length > 1) {
    const a = Date.parse(times[0]), b = Date.parse(times[times.length - 1]);
    if (isFinite(a) && isFinite(b)) hours = +(((b - a) / 3600000).toFixed(2));
  } else if (ext.TimeUsed && +ext.TimeUsed > 0) hours = +(ext.TimeUsed / 3600000).toFixed(2);

  const name = ext.name || filename.replace(/\.gpx$/i, '');
  const desc = ext.description || '';
  const tags = (ext.TrackTags || '').split(/[,，、\s]+/).filter(Boolean);
  // 与 build_routes.py 同口径的第一步：PosStartName 里含且仅含一个县名才认。
  // 它是自由文本（「金华市义乌市上溪镇五星社村岩下村1号」），不能整串比对。
  // 这里不做行政边界判定（那要 77 KB 边界数据，只用于构建期）—— 认不出来就留空，不猜。
  const COUNTIES = ['婺城区', '金东区', '兰溪市', '义乌市', '东阳市', '永康市', '武义县', '浦江县', '磐安县'];
  const psHits = COUNTIES.filter(c => (ext.PosStartName || '').includes(c));
  const region = psHits.length === 1 ? psHits[0] : null;
  const distKm = +dist.toFixed(2), ascM = Math.round(asc);
  const difficulty = (distKm <= 8 && ascM <= 400) ? '休闲' : (distKm <= 15 && ascM <= 900) ? '中等' : '困难';
  const blob = desc + ' ' + wpts.map(w => w.name).join(' ') + ' ' + tags.join(' ');
  const water = ['瀑布', '溪', '涧', '水潭', '深潭', '水源', '涉水'].some(k => blob.includes(k));

  // 抽稀（约 4m 容差）。坐标必须写成 [lon,lat,ele] 三元组 —— 海拔要在几何里，
  // 否则前端画不出剖面（这里原先只存了 [lon,lat]，与 build_routes.py 口径不一致）。
  // 最高/最低点强制保留，保证剖面峰值等于 ele_max。
  const forced = [];
  let hi = -1, lo = -1;
  trkpts.forEach((p, i) => {
    if (p.ele == null) return;
    if (hi < 0 || p.ele > trkpts[hi].ele) hi = i;
    if (lo < 0 || p.ele < trkpts[lo].ele) lo = i;
  });
  if (hi >= 0) forced.push(hi);
  if (lo >= 0) forced.push(lo);
  const coords = rdp(trkpts.map(p => (p.ele == null ? [p.lon, p.lat] : [p.lon, p.lat, p.ele])),
    0.00004, forced);
  // id 规则必须和 tools/build_routes.py 一致，否则同一份 GPX 导两次会变成两条
  const id = 'tb_' + (ext.TrackId || name.replace(/[^\p{L}\p{N}_]+/gu, '_'));

  return {
    id, name, region, region_source: '两步路 PosStartName',
    difficulty, difficulty_reason: difficulty === '休闲' ? '≤8km 且爬升≤400m' : difficulty === '中等' ? '≤15km 且爬升≤900m' : '距离>15km 或爬升>900m',
    family: (distKm <= 8 && ascM <= 400 && (hours == null || hours <= 5)) ? true : null,
    family_reason: '距离≤8km、爬升≤400m、用时≤5h（系统判定）',
    has_water: water ? true : null, water_reason: water ? '描述或标注点含涉水关键词' : null,
    distance_km: distKm, ascent_m: ascM, descent_m: Math.round(des),
    ele_min: eles.length ? Math.round(Math.min(...eles)) : null,
    ele_max: eles.length ? Math.round(Math.max(...eles)) : null,
    hours, pause_hours: ext.PauseTime ? +(ext.PauseTime / 3600000).toFixed(2) : null,
    track_points: trkpts.length, waypoints: wpts.length,
    geometry_from: geometryFrom,
    start: { lon: trkpts[0].lon, lat: trkpts[0].lat },
    end: { lon: trkpts[trkpts.length - 1].lon, lat: trkpts[trkpts.length - 1].lat },
    tags, description: desc,
    annotations: wpts.filter(w => w.name || w.desc),
    source: {
      provider: '两步路(2bulu) · 本地导入', track_id: ext.TrackId || null,
      creator: ext.CreaterName || null, creator_id: ext.CreaterId || null,
      app_version: ext.ProductVersion || null, begin_time: ext.BeginTime || null, file: filename,
    },
    geometry: { type: 'LineString', coordinates: coords },
    imported: true,
  };
}

function hav(a, b) {
  const R = 6371.0088, r = Math.PI / 180;
  const dp = (b.lat - a.lat) * r, dl = (b.lon - a.lon) * r;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function rdp(points, eps, mustKeep) {
  if (points.length < 3) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  // mustKeep：必须保留的点下标（用来锁住最高/最低点，与 build_routes.py 同口径）
  if (mustKeep) for (const i of mustKeep) if (i >= 0 && i < points.length) keep[i] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 <= i0 + 1) continue;
    const [x0, y0] = points[i0], [x1, y1] = points[i1];
    const dx = x1 - x0, dy = y1 - y0, seg = Math.hypot(dx, dy) || 1e-12;
    let best = -1, bi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = Math.abs(dy * points[i][0] - dx * points[i][1] + x1 * y0 - y1 * x0) / seg;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) { keep[bi] = true; stack.push([i0, bi], [bi, i1]); }
  }
  return points.filter((_, i) => keep[i]);
}

/* --------------------------- 小工具 --------------------------- */
let tt = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(tt);
  tt = setTimeout(() => { el.hidden = true; }, 3600);
}
window.__hike = { state, get routes() { return routes; }, filtered, select, map };
