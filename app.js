/* =========================================================================
   金华徒步路线
   数据：两步路(2bulu)导出的 GPX -> tools/build_routes.py
         -> data/routes.index.js（列表元数据）+ data/routes.geom.js（几何）
   底图：OpenFreeMap(免费无 key) / OpenTopoMap(等高线) / 卫星影像
   赏秋点：spots/spots.json（人工打点）-> tools/build_spots.py -> data/spots.js
   ========================================================================= */
'use strict';

const DIFF_COLOR = { '休闲': '#059669', '中等': '#d97706', '困难': '#b91c1c' };
const JINHUA = {
  center: [119.72, 29.13],
  zoom: 9,
  // 金华市范围，留一点余量，防止用户把地图拖到天涯海角
  bounds: [[119.05, 28.42], [120.98, 29.82]],
};

/* 赏秋点：本站自己实地打的位置，跟两步路那批路线是两回事。
   源数据在 spots/spots.json（人工维护、坐标手标、机器只校验），
   走 tools/build_spots.py 生成 data/spots.js —— 也用 <script> 加载，file:// 能跑。 */
const KIND_COLOR = {
  '水杉': '#c2410c', '银杏': '#ca8a04', '红枫': '#b91c1c', '枫香': '#dc2626',
  '乌桕': '#7c2d12', '芦花': '#a8a29e', '稻田': '#d97706', '油菜花': '#65a30d',
  '其他': '#ea580c',
};
const spots = ((window.SPOT_DATA || {}).spots || []).slice();

/* 列表只要元数据（routes.index.js，~20KB）；几何（routes.geom.js，~130KB）
   晚一步到，到了再挂上去 —— 首屏不必等它，反正地图本来也得等 maplibre。 */
let routes = ((window.HIKE_INDEX || {}).routes || []).slice();

function attachGeometry() {
  const g = window.HIKE_GEOM;
  if (!g) return;
  routes.forEach(r => {
    const it = g[r.id];
    if (it) { r.geometry = it.geometry; r.annotations = it.annotations || []; }
  });
  // 几何（~130KB）比列表晚好几秒，用户完全可能在它到之前就点开了一条路线 —— 那时
  // 渲染出来的是「0 个上传者标注点」「这条轨迹没有标注点」，剖面也是空的。
  // 几何一到就得把已经打开的那页重画一遍，否则用户盯着一个假的空详情，等多久都不变。
  // 位置在 attachGeometry 里而不是 __onGeomReady 里：几何先到、maplibre 后到时，
  // 真正把几何挂上去的是这里（bootMap 要两样齐了才跑）。renderDetail 自己重新绑
  // 事件，重复调用是安全的。
  if (state.selected) {
    const box = document.getElementById('detail');
    const r = routes.find(x => x.id === state.selected);
    if (box && !box.hidden && r) {
      const keepScroll = box.scrollTop;   // 别把正在读的人弹回页首
      renderDetail(r);
      box.scrollTop = keepScroll;
    }
  }
}
const state = {
  regions: new Set(), diffs: new Set(),
  family: false, water: false, wpt: true,
  dist: 'all', q: '', sort: 'distance',
  selected: null, base: 'liberty',
  spotsOn: true, spotSel: null,
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

/* ----------------------------- 地图 -----------------------------
   建图推迟到 initMap()：列表不依赖地图，得先让它出来。maplibre 有 ~250KB，
   比列表数据重得多 —— 原先两者一起 gate 在 map 的 load 事件上，等于白等。 */
let map = null;

const emptyFC = { type: 'FeatureCollection', features: [] };

/* 默认底图（openfreemap 的 liberty）在境内实测会 TLS 断连。样式拉不回来时
   style.load 不触发，而列表、筛选、交互全挂在初始化里 —— 整个页面跟着瘫掉，
   不只是地图空白。所以留一条兜底：超时就换成纯栅格样式，照常初始化。 */
const FALLBACK_STYLE = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef2f5' } }],
};
const FALLBACK_AFTER_MS = 6000;
let inited = false;
let fallbackTimer = null;

function applyBase() {
  if (!inited) return;  // 图层还没加，onStyleReady 里会统一应用一次
  map.setLayoutProperty('base-topo', 'visibility', state.base === 'topo' ? 'visible' : 'none');
  map.setLayoutProperty('base-sat', 'visibility', state.base === 'sat' ? 'visible' : 'none');
  const onRaster = state.base !== 'liberty';
  // 栅格底图压在矢量之上，路线加一点不透明度更容易看清
  map.setPaintProperty('route-line', 'line-opacity', onRaster ? 0.95 : 0.92);
  map.setPaintProperty('route-sel', 'line-opacity', onRaster ? 0.9 : 0.85);
  document.querySelectorAll('#base-switch button')
    .forEach(x => x.classList.toggle('on', x.dataset.base === state.base));
}

// 用 style.load 而不是 load：setStyle 之后 load 不会再触发，style.load 会
function onStyleReady() {
  if (inited) return;
  inited = true;
  clearTimeout(fallbackTimer);

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

  // 4) 赏秋点。它是独立的点图层，不参与路线的筛选，也不进左侧列表
  map.addSource('spots', { type: 'geojson', data: emptyFC, promoteId: 'id' });
  map.addSource('spotSel', { type: 'geojson', data: emptyFC });
  map.addLayer({
    id: 'spot-halo', type: 'circle', source: 'spotSel',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 14, 16, 22],
      'circle-color': '#fff', 'circle-opacity': .9,
    },
  });
  map.addLayer({
    id: 'spot-dot', type: 'circle', source: 'spots',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 13, 8, 16, 11],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'spot-label', type: 'symbol', source: 'spots', minzoom: 10.5,
    layout: {
      'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 12,
      'text-offset': [0, -1.15], 'text-anchor': 'bottom', 'text-allow-overlap': false,
    },
    paint: { 'text-color': '#7c2d12', 'text-halo-color': '#fff', 'text-halo-width': 1.6 },
  });

  applyBase();
  bindMapEvents();
  buildFilterChips();
  layoutPanel();
  refresh();
}

function initMap() {
  if (map) return;
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: JINHUA.center,
    zoom: JINHUA.zoom,
    maxBounds: JINHUA.bounds,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-right');
  map.on('style.load', onStyleReady);

  fallbackTimer = setTimeout(() => {
    if (inited) return;
    state.base = 'topo';
    const libBtn = document.querySelector('#base-switch button[data-base="liberty"]');
    if (libBtn) { libBtn.disabled = true; libBtn.title = '默认底图加载失败，已切到备用底图'; }
    toast('默认底图加载超时，已切到备用底图');
    try {
      map.setStyle(FALLBACK_STYLE);
    } catch (_) {
      onStyleReady();
    }
  }, FALLBACK_AFTER_MS);
}
/* 地图要两样齐了才建：maplibre 本体 + 几何数据。两个都是 async 拉的，先后随意。 */
let geomReady = typeof window.HIKE_GEOM !== 'undefined';
function bootMap() {
  if (!window.maplibregl || !geomReady) return;
  attachGeometry();
  initMap();
}
window.__initMap = bootMap;
window.__onGeomReady = () => { geomReady = true; bootMap(); };

/* 先把列表摆出来，不等地图。refresh() 里地图那一段在 map === null 时整块跳过。 */
refresh();
bootMap();   // 两个资源都在缓存里时，这一步就已经齐了

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
  if (!map || !list.length || map.isMoving()) return;
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
    // 窄屏：面板贴在下方，而且是可收起的 —— 按它实际占了多高来留白，
    // 别写死 50% 视口，否则收起之后留白还照旧，等于白收。
    const panel = document.getElementById('panel');
    const bottom = panel
      ? Math.round(H - panel.getBoundingClientRect().top + 16)
      : Math.round(H * 0.5);
    p = { top, bottom, left: 24, right: 24 };
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

// 把镜头对准某条路线。留白一律走 fitPadding()，别再出现写死的数字。
// maxZoom 只是防退化的护栏（bbox 缩成一个点之类）；实测真实路线选中时缩放落在 13.9~16.5。
function fitToRoute(r, duration) {
  if (!map) return;
  map.fitBounds(boundsOf(r), { padding: fitPadding(), maxZoom: 17, duration: duration || 900 });
}

// 赏秋点是个点，fitBounds 对它没意义，直接飞过去。留白同样走 fitPadding()。
function fitToSpot(s, duration) {
  if (!map || !s) return;
  map.flyTo({ center: [s.lon, s.lat], zoom: 14, padding: fitPadding(), duration: duration || 800 });
}

/* 窄屏：把面板收成一条，给地图腾地方。
   收起来之后必须按新的可视区把已选路线重新摆一次 —— 否则路线还缩在上半屏，
   底下空一大块，「腾地方」就白腾了。 */
let collapseTimer = null;
function setPanelCollapsed(collapsed) {
  const panel = document.getElementById('panel');
  if (panel.classList.contains('collapsed') === collapsed) return;
  panel.classList.toggle('collapsed', collapsed);
  const btn = document.getElementById('btn-collapse');
  btn.textContent = collapsed ? '展开' : '收起';
  btn.title = collapsed ? '展开面板' : '收起面板';
  btn.setAttribute('aria-expanded', String(!collapsed));
  const r = state.selected ? routes.find(x => x.id === state.selected) : null;
  const sp = state.spotSel ? spots.find(x => x.id === state.spotSel) : null;
  if (r || sp) {
    // 等高度过渡走完再量 fitPadding —— 量到中途尺寸会算歪
    clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => { if (r) fitToRoute(r, 500); else fitToSpot(sp, 500); }, 260);
  }
}
document.getElementById('btn-collapse').onclick = () => {
  setPanelCollapsed(!document.getElementById('panel').classList.contains('collapsed'));
};

function refresh() {
  const list = filtered();

  if (map) {
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

    // 赏秋点：只受自己那个开关控制，路线怎么筛都不影响它
    map.setLayoutProperty('spot-dot', 'visibility', state.spotsOn ? 'visible' : 'none');
    map.setLayoutProperty('spot-label', 'visibility', state.spotsOn ? 'visible' : 'none');
    if (!state.spotsOn) map.setLayoutProperty('spot-halo', 'visibility', 'none');
    else map.setLayoutProperty('spot-halo', 'visibility', 'visible');
    map.getSource('spots').setData({
      type: 'FeatureCollection',
      features: state.spotsOn ? spots.map(s => ({
        type: 'Feature', id: s.id,
        properties: {
          id: s.id, name: s.name, kind: s.kind,
          color: KIND_COLOR[s.kind] || KIND_COLOR['其他'],
          season: seasonText(s),
        },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })) : [],
    });
  }

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
    const nAnno = r.anno_count != null ? r.anno_count : (r.annotations || []).length;
    if (nAnno) tags.push(`<span class="tag t-anno">${nAnno} 个标注点</span>`);
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
  // 详情面板只有一块 378px 的地方，路线和赏秋点两个选中必须互斥
  state.spotSel = null;
  if (map) map.getSource('spotSel').setData(emptyFC);
  if (map) {
    map.getSource('sel').setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: r.geometry }],
    });
  }
  // 留白必须按屏幕实际算，别写死：原来这里是 { top:200, right:430, bottom:70, left:70 }，
  // 那是给桌面右侧面板配的，窄屏下把可用宽度压成负的，地图干脆不动。见 fitToRoute()。
  // 窄屏收起状态下点中一条：得先把面板放出来，否则详情渲染在一个 48px 的横条里，
  // 用户以为点了没反应。展开本身会触发一次按新可视区的重摆，那就别再自己 fit 一遍。
  const wasCollapsed = document.getElementById('panel').classList.contains('collapsed');
  if (wasCollapsed) setPanelCollapsed(false);
  if (map && !wasCollapsed) fitToRoute(r, 900);
  renderDetail(r);
  track('路线', '点开', r.name);
  refresh();
  if (map && state.wpt) {
    map.setFilter('anno-dot', ['==', ['get', 'route_id'], id]);
    map.setLayoutProperty('anno-dot', 'visibility', 'visible');
  }
}

function backToList() {
  state.selected = null;
  state.spotSel = null;
  // 收起状态下点「返回列表」得先把面板放出来，否则列表是隐藏的，用户对着一条空条发呆
  setPanelCollapsed(false);
  if (map) { map.getSource('sel').setData(emptyFC); map.getSource('spotSel').setData(emptyFC); }
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
    ${navRow('两步路轨迹 ID', s.track_id ? esc(s.track_id) : '—')}
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
    </div>
  `;
  document.getElementById('detail').querySelectorAll('[data-copy]').forEach(b => {
    b.onclick = () => copy(b.dataset.copy);
  });
  document.getElementById('detail').querySelectorAll('[data-locate]').forEach(b => {
    b.onclick = () => {
      const rr = routes.find(x => x.id === b.dataset.locate);
      if (rr && map) map.flyTo({ center: [rr.start.lon, rr.start.lat], zoom: 15 });
    };
  });
  document.getElementById('detail').querySelectorAll('[data-goto]').forEach(b => {
    b.onclick = () => {
      const [rid, idx] = b.dataset.goto.split(':');
      const rr = routes.find(x => x.id === rid);
      const a = (rr.annotations || [])[Number(idx)];
      if (!a || !map) return;
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

/* --------------------------- 访问统计 ---------------------------
   百度统计的脚本是**延迟注入**的（见 index.html），所以这里只管往 _hmt 队列里 push；
   脚本到位后百度统计会把队列补发。没装统计、或脚本被拦下来时，这两行静默无反应 ——
   统计绝不能连累页面本身。 */
function track(cat, action, label) {
  try {
    (window._hmt = window._hmt || []).push(
      ['_trackEvent', String(cat), String(action), String(label == null ? '' : label)]);
  } catch (_) { /* 统计坏了不能影响页面 */ }
}

/* --------------------------- 赏秋点 ---------------------------
   数据来自 spots/spots.json（人工打点，见 tools/build_spots.py）。
   和路线分开走：路线是「一条线」，赏秋点是「一个点」，谁也不参与对方的筛选。
   唯一共用的是那块详情面板，所以两者选中要互斥。 */

const SEG_LABEL = ['上旬', '中旬', '下旬'];

// 「11-中」-> 从 1 月起算的旬序号（1 月上旬 = 0）。构建期已经算好 best_i_*，
// 前端不重算一遍，免得同一个字段出现两套口径。
function todaySeg(d) {
  return d.getMonth() * 3 + (d.getDate() <= 10 ? 0 : d.getDate() <= 20 ? 1 : 2);
}

function segText(i) {
  return i == null ? null : (Math.floor(i / 3) + 1) + '月' + SEG_LABEL[i % 3];
}

function bestRange(s) {
  return (s.best_i_from == null || s.best_i_to == null)
    ? null : segText(s.best_i_from) + ' ~ ' + segText(s.best_i_to);
}

/* 当季文案 —— 赏秋图的价值全落在这一句上。
   十月打开和十二月打开，看到的应该是不同的答案；否则这张图就只是一堆钉子。
   刻度用「旬」：再细没人维护得起，再粗（按月）就不够用。 */
function seasonText(s) {
  const f = s.best_i_from, t = s.best_i_to;
  if (f == null || t == null) return null;
  const now = todaySeg(new Date());
  if (now >= f && now <= t) return '正在最佳观赏期（' + bestRange(s) + '）';
  if (now < f) {
    const d = f - now;
    return d <= 18 ? '还要等约 ' + (d * 10) + ' 天（' + bestRange(s) + '）'
      : '还没到季节（最佳期 ' + bestRange(s) + '）';
  }
  const d = now - t;
  return d <= 6 ? '刚过最佳期（' + bestRange(s) + '）' : '今年这季已过（最佳期 ' + bestRange(s) + '）';
}

function selectSpot(id) {
  const s = spots.find(x => x.id === id);
  if (!s) return;
  state.spotSel = id;
  state.selected = null;
  if (map) {
    map.getSource('sel').setData(emptyFC);
    map.getSource('spotSel').setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } }],
    });
  }
  // 同一个理由：窄屏收起时点它，先把面板放出来再飞（见 select()）
  const wasCollapsed = document.getElementById('panel').classList.contains('collapsed');
  if (wasCollapsed) setPanelCollapsed(false);
  else fitToSpot(s, 800);
  renderSpotDetail(s);
  track('赏秋点', '点开', s.name);
}

/* 每张图底下必须有一行来源。credit 为 null 是约定：本站自己拍的。
   别人的图则必须带 credit（授权人）+ license，这是 build_spots.py 卡死的规矩。 */
function photoBlock(s) {
  const ps = s.photos || [];
  if (!ps.length) return '<p style="color:#94a3b8">这个点还没有图。</p>';
  return ps.map(p => `
    <figure class="shot">
      <a href="${esc(p.src)}" target="_blank" rel="noopener">
        <img src="${esc(p.src)}" alt="${esc(p.caption || s.name)}" loading="lazy">
      </a>
      ${(p.caption || p.shot_at) ? `<figcaption>${esc(p.caption || '')}${
        p.shot_at ? `<span class="date">${esc(p.shot_at)}</span>` : ''}</figcaption>` : ''}
      <div class="credit">${p.credit
        ? '摄影：' + (p.credit_url
          ? `<a href="${esc(p.credit_url)}" target="_blank" rel="noopener">${esc(p.credit)}</a>`
          : esc(p.credit)) + (p.license ? ' · ' + esc(p.license) : '')
        : '本站自摄'}</div>
    </figure>`).join('');
}

function renderSpotDetail(s) {
  const season = seasonText(s);
  const nav = [
    `<a href="https://uri.amap.com/marker?position=${s.lon},${s.lat}&name=${encodeURIComponent(s.name)}&coordinate=wgs84&callnative=1&src=jinhua-autumn-map" target="_blank" rel="noopener">高德导航到这个点</a>`,
    `<button data-copy="${s.lat},${s.lon}">复制 WGS-84 坐标</button>`,
    `<button data-locate="${s.id}">地图上定位</button>`,
  ];
  document.getElementById('detail').innerHTML = `
    <h2>${esc(s.name)}${s.example ? '<span class="badge ex">示例</span>' : ''}</h2>
    <div class="sub">${esc(s.kind)} · ${esc(s.region || '区域未知')} · 本站实地打点</div>

    ${season ? `<div class="season">${esc(season)}</div>` : ''}

    ${photoBlock(s)}

    <h4>这里是什么样</h4>
    <p>${esc(s.intro)}</p>

    <h4>什么时候来看</h4>
    <div class="grid">
      <div><span>最佳观赏期</span><b style="font-size:13px">${bestRange(s) || '未填'}</b></div>
      <div><span>最后一次确认</span><b style="font-size:13px">${s.verified_at || '未填'}</b></div>
      <div><span>坐标精度</span><b style="font-size:13px">${s.coord_acc_m != null ? '±' + s.coord_acc_m + ' m' : '未填'}</b></div>
    </div>
    ${s.season_note ? `<div class="note">今年的实际情况：${esc(s.season_note)}</div>` : ''}

    <h4>怎么去</h4>
    <p>${s.access ? esc(s.access) : '<span style="color:#94a3b8">没写到达方式。</span>'}</p>
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div><span>坐标 WGS-84（纬度, 经度）</span><b style="font-size:12px">${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</b></div>
      <div><span>坐标来源</span><b style="font-size:12px">${esc(s.coord_src || '—')}</b></div>
    </div>
    <div class="links">${nav.join('')}</div>

    <div class="note" style="margin-top:14px">
      这个点是本站自己实地打的位置，拍摄时间见每张图下方。树什么时候变色年年不同，
      出发前再看一眼本周的实际情况。坐标精度一栏写的是打点时的定位误差，不是树的分布范围。
    </div>
  `;
  document.getElementById('detail').querySelectorAll('[data-copy]').forEach(b => {
    b.onclick = () => copy(b.dataset.copy);
  });
  document.getElementById('detail').querySelectorAll('[data-locate]').forEach(b => {
    b.onclick = () => {
      const ss = spots.find(x => x.id === b.dataset.locate);
      if (ss && map) map.flyTo({ center: [ss.lon, ss.lat], zoom: 14, padding: fitPadding() });
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
  qt = setTimeout(() => {
    state.q = e.target.value; refresh();
    if (state.q.trim()) track('搜索', '关键词', state.q.trim());
  }, 180);
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
  if (map) map.getSource('sel').setData(emptyFC);
  backToList();
  if (map) map.fitBounds(JINHUA.bounds, { padding: 40, duration: 700 });
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
  b.onclick = () => { state.base = b.dataset.base; applyBase(); track('底图', '切换', state.base); };
});

// 赏秋点的总开关：显式的开关，不按别的东西自动推断（这站的规矩）
const spotsChk = document.getElementById('f-spots');
if (spotsChk) {
  spotsChk.checked = state.spotsOn;
  spotsChk.onchange = e => { state.spotsOn = e.target.checked; refresh(); };
}

/* --------------------------- 地图交互 --------------------------- */
function bindMapEvents() {
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  const ROUTE_LAYERS = ['route-line'];

  map.on('mousemove', e => {
    // 赏秋点压在路线上面，命中它就不再管路线，免得两个气泡打架
    const sp = state.spotsOn ? map.queryRenderedFeatures(e.point, { layers: ['spot-dot'] })[0] : null;
    const f = sp ? null : map.queryRenderedFeatures(e.point, { layers: ROUTE_LAYERS })[0];
    map.getCanvas().style.cursor = (sp || f) ? 'pointer' : '';
    map.setFilter('route-hover', ['==', ['get', 'id'], f ? f.properties.id : '__none__']);
    if (sp) {
      // 气泡里只放两样：是什么树、现在是不是时候
      popup.setLngLat(e.lngLat).setHTML(
        `<b>${esc(sp.properties.name)}</b><br>${esc(sp.properties.kind)}<br>
         <span style="color:#64748b">${esc(sp.properties.season || '最佳观赏期未填')}</span>`).addTo(map);
    } else if (f) {
      popup.setLngLat(e.lngLat).setHTML(
        `<b>${esc(f.properties.name)}</b><br>${f.properties.distance_km} km · 爬升 ${f.properties.ascent_m} m<br>
         <span style="color:#64748b">${esc(f.properties.region || '')} · ${f.properties.difficulty}</span>`).addTo(map);
    } else popup.remove();
  });
  map.on('mouseleave', () => { popup.remove(); map.setFilter('route-hover', ['==', ['get', 'id'], '__none__']); });
  map.on('click', 'route-line', e => {
    if (e.features[0]) select(e.features[0].properties.id);
  });
  map.on('click', 'spot-dot', e => {
    if (e.features[0]) selectSpot(e.features[0].properties.id);
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

  // 与 build_routes.py 同口径：显示名一律取文件名。GPX 里的 <name> 指望不上
  // （可能是录制时刻、可能是「时刻 + 真名」、也可能跟文件对不上），文件名才是
  // 审核过、与文件一一对得上的那一个。原始 <name> 仍存进 source.gpx_name 备查。
  const name = filename.replace(/\.gpx$/i, '');
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
      // 上传者在 GPX 里写的名字（可能带录制时刻、也可能与文件名不同）。只备查，不显示。
      gpx_name: ext.name || null,
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
// map 得用 getter：这个对象是脚本末尾求值的，那时 map 还是 null，写死就永远是 null
window.__hike = { state, get routes() { return routes; }, get spots() { return spots; },
  filtered, select, selectSpot, get map() { return map; } };
