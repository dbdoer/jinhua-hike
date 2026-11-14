/* 浙BA 出线形势 —— 枚举引擎 + 渲染
   规则：胜 2 分、负 1 分；同分依次比 相互比赛积分 → 相互净胜分 → 相互得分 → 全组净胜分 → 全组得分。
   出线：各组前 4 名。
   所有结论都由「枚举剩余比赛的全部胜负组合」算出。
*/
(function () {
  const DATA = window.ZBA_DATA;
  const R = DATA.rules;
  const ADV = R.advance_per_group;
  const LSK = 'zheba.overrides.v2';

  let overrides = {};
  try { overrides = JSON.parse(localStorage.getItem(LSK) || '{}'); } catch (e) { overrides = {}; }

  const state = { group: 'B', target: null, mode: 'even', detailW: null };
  const cache = {};
  const mkey = (m) => `${m.group}|${m.date}|${m.home}|${m.away}`;

  /* ---------------- 数据准备 ---------------- */
  function prepGroup(g) {
    const teams = DATA.groups[g];
    const idx = {};
    teams.forEach((t, i) => (idx[t] = i));
    const base = [], sched = [];
    for (const m of DATA.matches) {
      if (m.group !== g) continue;
      const ov = overrides[mkey(m)];
      if (m.status === 'played' || ov) {
        let hs = m.home_score, as = m.away_score, known = m.score_known, winner = m.winner;
        if (ov && m.status === 'scheduled') { hs = ov[0]; as = ov[1]; known = true; winner = hs > as ? m.home : m.away; }
        base.push({
          h: idx[m.home], a: idx[m.away], hs, as, known, homeWin: winner === m.home,
          home: m.home, away: m.away, date: m.date,
        });
      } else {
        sched.push({
          h: idx[m.home], a: idx[m.away], home: m.home, away: m.away,
          date: m.date, time: m.time, si: sched.length,
        });
      }
    }
    const adjD = teams.map((t) => DATA.teams[t].adj_diff);
    const adjPF = teams.map((t) => Math.round(DATA.teams[t].official.ppg * (DATA.teams[t].official.w + DATA.teams[t].official.l)));
    const bW = new Int8Array(teams.length), bL = new Int8Array(teams.length);
    for (const m of base) { if (m.homeWin) { bW[m.h]++; bL[m.a]++; } else { bW[m.a]++; bL[m.h]++; } }
    const rem = new Int8Array(teams.length);
    for (const m of sched) { rem[m.h]++; rem[m.a]++; }
    return { g, teams, idx, base, sched, adjD, adjPF, bW, bL, rem, n: teams.length };
  }

  function rank(P, oc) {
    const n = P.n;
    const W = new Int8Array(n), L = new Int8Array(n), DF = new Float64Array(n), PF = new Float64Array(n);
    for (const m of P.base) {
      if (m.homeWin) { W[m.h]++; L[m.a]++; } else { W[m.a]++; L[m.h]++; }
      if (m.known) { DF[m.h] += m.hs - m.as; DF[m.a] -= m.hs - m.as; PF[m.h] += m.hs; PF[m.a] += m.as; }
    }
    for (let i = 0; i < P.sched.length; i++) {
      const m = P.sched[i];
      if (oc[i] === 0) { W[m.h]++; L[m.a]++; } else { W[m.a]++; L[m.h]++; }
    }
    const pts = new Int16Array(n);
    for (let i = 0; i < n; i++) pts[i] = 2 * W[i] + L[i];

    const byPts = new Map();
    for (let i = 0; i < n; i++) {
      if (!byPts.has(pts[i])) byPts.set(pts[i], []);
      byPts.get(pts[i]).push(i);
    }
    const hP = new Int16Array(n), hD = new Float64Array(n), hS = new Float64Array(n);
    for (const grp of byPts.values()) {
      if (grp.length < 2) continue;
      const set = new Set(grp);
      for (const m of P.base) {
        if (!set.has(m.h) || !set.has(m.a)) continue;
        if (m.homeWin) { hP[m.h] += 2; hP[m.a] += 1; } else { hP[m.a] += 2; hP[m.h] += 1; }
        if (m.known) { hD[m.h] += m.hs - m.as; hD[m.a] -= m.hs - m.as; hS[m.h] += m.hs; hS[m.a] += m.as; }
      }
      for (let i = 0; i < P.sched.length; i++) {
        const m = P.sched[i];
        if (!set.has(m.h) || !set.has(m.a)) continue;
        if (oc[i] === 0) { hP[m.h] += 2; hP[m.a] += 1; } else { hP[m.a] += 2; hP[m.h] += 1; }
      }
    }
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((a, b) =>
      pts[b] - pts[a] || hP[b] - hP[a] || hD[b] - hD[a] ||
      P.adjD[b] - P.adjD[a] || P.adjPF[b] - P.adjPF[a] || a - b);
    return { order, pts, W, L };
  }

  /* ---------------- 全枚举 ---------------- */
  function enumerate(P) {
    const N = P.sched.length, T = 1 << N, n = P.n;
    const ord = new Int8Array(T * n), pts = new Int16Array(T * n), win = new Int8Array(T * n);
    const oc = new Uint8Array(N);
    for (let k = 0; k < T; k++) {
      for (let i = 0; i < N; i++) oc[i] = (k >> i) & 1;
      const r = rank(P, oc);
      // ord 按名次存队伍索引；pts / win 按队伍索引存数值
      for (let j = 0; j < n; j++) ord[k * n + j] = r.order[j];
      for (let u = 0; u < n; u++) { pts[k * n + u] = r.pts[u]; win[k * n + u] = r.W[u]; }
    }
    const pHome = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const m = P.sched[i];
      const sh = P.adjD[m.h] / 12, sa = P.adjD[m.a] / 12;
      pHome[i] = 1 / (1 + Math.exp(-(sh - sa + 2) / 8));
    }
    const wtsW = new Float64Array(T);
    for (let k = 0; k < T; k++) {
      let w = 1;
      for (let i = 0; i < N; i++) w *= ((k >> i) & 1) === 0 ? pHome[i] : 1 - pHome[i];
      wtsW[k] = w;
    }
    return { N, T, n, ord, pts, win, wtsW };
  }

  // 权重：五五开 = 1；按实力 = 各场胜率连乘
  const wt = (E, k) => (state.mode === 'even' ? 1 : E.wtsW[k]);

  function model(g) {
    const key = g + '|' + JSON.stringify(overrides);
    if (cache[key]) return cache[key];
    const P = prepGroup(g);
    const E = enumerate(P);
    return (cache[key] = { P, E });
  }

  const posOf = (M, k, tIdx) => {
    const { E } = M;
    for (let j = 0; j < E.n; j++) if (E.ord[k * E.n + j] === tIdx) return j;
    return E.n;
  };

  const currentRank = (P) => rank({ ...P, sched: [] }, new Uint8Array(0));

  function teamProb(M, tIdx) {
    const { E } = M;
    let tot = 0, q = 0;
    for (let k = 0; k < E.T; k++) {
      const w = wt(E, k);
      tot += w;
      if (posOf(M, k, tIdx) < ADV) q += w;
    }
    return tot ? q / tot : 0;
  }

  function analyzeTarget(M, tIdx) {
    const { P, E } = M, n = P.n, T = E.T;
    const inTop = new Uint8Array(T);
    for (let k = 0; k < T; k++) inTop[k] = posOf(M, k, tIdx) < ADV ? 1 : 0;

    let totW = 0, qW = 0;
    for (let k = 0; k < T; k++) {
      const w = wt(E, k);
      totW += w; if (inTop[k]) qW += w;
    }

    const kTarget = P.rem[tIdx];
    const tiers = [];
    for (let w = kTarget; w >= 0; w--) {
      const idxs = [];
      let tt = 0, qq = 0;
      for (let k = 0; k < T; k++) {
        if (E.win[k * n + tIdx] - P.bW[tIdx] !== w) continue;
        const g2 = wt(E, k);
        idxs.push(k); tt += g2; if (inTop[k]) qq += g2;
      }
      tiers.push({ w, idxs, prob: tt ? qq / tt : 0 });
    }

    const sens = P.sched.map((m, i) => {
      let tw = 0, qw = 0, twa = 0, qwa = 0;
      for (let k = 0; k < T; k++) {
        const w = wt(E, k);
        if (((k >> i) & 1) === 0) { tw += w; if (inTop[k]) qw += w; }
        else { twa += w; if (inTop[k]) qwa += w; }
      }
      return {
        home: m.home, away: m.away, date: m.date,
        pHome: tw ? qw / tw : 0, pAway: twa ? qwa / twa : 0,
        delta: (tw ? qw / tw : 0) - (twa ? qwa / twa : 0),
      };
    }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    return { tIdx, inTop, tiers, sens, prob: totW ? qW / totW : 0, n, T };
  }

  function tierDetail(M, A, tier) {
    const { P, E } = M, n = P.n;
    const idxs = tier.idxs;
    if (!idxs.length) return null;
    let tot = 0, q = 0;
    for (const k of idxs) { const w = wt(E, k); tot += w; if (A.inTop[k]) q += w; }
    const base = tot ? q / tot : 0;

    const scores = [];
    const tPos = A.tIdx;
    for (let u = 0; u < n; u++) {
      if (u === tPos) continue;
      const buckets = new Map();
      let wIn = 0, aIn = 0, wOut = 0, aOut = 0;
      for (const k of idxs) {
        const v = E.win[k * n + u] - P.bW[u];
        if (!buckets.has(v)) buckets.set(v, [0, 0]);
        const b = buckets.get(v);
        const w = wt(E, k);
        b[0] += w; if (A.inTop[k]) b[1] += w;
        const ahead = posOf(M, k, u) < posOf(M, k, tPos) ? 1 : 0;
        if (A.inTop[k]) { wIn += w; aIn += w * ahead; } else { wOut += w; aOut += w * ahead; }
      }
      // 谁在"踢我出前四"：出线情形里它常排我前面、不出线情形里更常排我前面
      const score = (wIn && wOut)
        ? Math.abs(aIn / wIn - aOut / wOut) * Math.min(wIn, wOut)
        : 0;
      scores.push({ u, score, buckets });
    }
    scores.sort((a, b) => b.score - a.score || a.u - b.u);
    const comps = scores.slice(0, 2);

    const rule = findRule(M, A, idxs);

    let matrix = null;
    if (comps.length === 2) {
      const [c1, c2] = comps;
      const rows = Math.max(...c1.buckets.keys()) + 1;
      const cols = Math.max(...c2.buckets.keys()) + 1;
      const cell = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ w: 0, q: 0 })));
      for (const k of idxs) {
        const v1 = E.win[k * n + c1.u] - P.bW[c1.u];
        const v2 = E.win[k * n + c2.u] - P.bW[c2.u];
        const c = cell[v1][v2];
        c.w += wt(E, k);
        if (A.inTop[k]) c.q += wt(E, k);
      }
      matrix = { c1, c2, cell, rows, cols };
    }
    return { base, rule, matrix, comps };
  }

  function findRule(M, A, idxs) {
    const { P, E } = M, n = P.n;
    const allQ = idxs.every((k) => A.inTop[k]);
    const noneQ = idxs.every((k) => !A.inTop[k]);
    if (allQ) return { text: '这一档无论别人打成什么样都能出线。', type: 'safe' };
    if (noneQ) return { text: '这一档已经没戏了，别人怎么打都追不上。', type: 'dead' };

    const val = new Int8Array(idxs.length * n);
    idxs.forEach((k, i) => {
      for (let u = 0; u < n; u++) val[i * n + u] = E.win[k * n + u] - P.bW[u];
    });
    const check = (fn) => {
      for (let i = 0; i < idxs.length; i++) if (fn(i) !== !!A.inTop[idxs[i]]) return false;
      return true;
    };
    const singles = [];
    for (let u = 0; u < n; u++) {
      if (u === A.tIdx) continue;
      for (let x = 0; x <= P.rem[u]; x++) {
        if (check((i) => val[i * n + u] <= x)) singles.push({ u, x, op: '<=' });
        if (check((i) => val[i * n + u] >= x)) singles.push({ u, x, op: '>=' });
      }
    }
    if (singles.length) {
      singles.sort((a, b) => (a.op === b.op ? a.x - b.x : a.op === '<=' ? -1 : 1));
      return { text: ruleText(M, singles[0]), type: 'single' };
    }
    const cand = [];
    for (let u = 0; u < n; u++) {
      if (u === A.tIdx) continue;
      for (let x = 0; x <= P.rem[u]; x++) {
        for (let v = u + 1; v < n; v++) {
          if (v === A.tIdx) continue;
          for (let y = 0; y <= P.rem[v]; y++) {
            if (check((i) => val[i * n + u] <= x && val[i * n + v] <= y)) {
              cand.push({ a: { u, x, op: '<=' }, b: { u: v, x: y, op: '<=' }, cost: x + y, kind: 'and' });
            }
            if (check((i) => val[i * n + u] <= x || val[i * n + v] <= y)) {
              cand.push({ a: { u, x, op: '<=' }, b: { u: v, x: y, op: '<=' }, cost: x + y, kind: 'or' });
            }
          }
        }
      }
    }
    if (cand.length) {
      cand.sort((p, q) => p.cost - q.cost || (p.kind === 'and' ? -1 : 1));
      const c = cand[0];
      const joiner = c.kind === 'and' ? '，且' : '，或者';
      return { text: `${ruleText(M, c.a)}${joiner}${ruleText(M, c.b)}`, type: c.kind };
    }
    return { text: null, type: 'none' };
  }

  function ruleText(M, s) {
    const name = M.P.teams[s.u];
    if (s.op === '<=') {
      if (s.x === 0) return `${name}剩余比赛全输`;
      return `${name}最多再赢 ${s.x} 场`;
    }
    if (s.x === 0) return `${name}别全输`;
    return `${name}至少再赢 ${s.x} 场`;
  }

  // 矩阵的自然语言摘要：逐行（c1 的胜场）读分界
  function matrixSummary(M, det) {
    const { P } = M;
    const { c1, c2, cell, rows, cols } = det.matrix;
    const n1 = P.teams[c1.u], n2 = P.teams[c2.u];
    const out = [];
    for (let i = 0; i < rows; i++) {
      let qi = 0, wi = 0;
      for (let j = 0; j < cols; j++) { qi += cell[i][j].q; wi += cell[i][j].w; }
      if (!wi) continue;
      if (qi === wi) out.push(`${n1}赢 ${i} 场 → 出线`);
      else if (qi === 0) out.push(`${n1}赢 ${i} 场 → 出局`);
      else {
        let lastIn = -1, firstOut = -1;
        for (let j = 0; j < cols; j++) {
          const c = cell[i][j];
          if (!c.w) continue;
          if (c.q === c.w) lastIn = j;
          else if (c.q === 0 && firstOut < 0) firstOut = j;
        }
        if (lastIn >= 0 && firstOut > lastIn) out.push(`${n1}赢 ${i} 场 → ${n2} 最多 ${lastIn} 胜才出线`);
        else out.push(`${n1}赢 ${i} 场 → 要看 ${n2} 的细节（见矩阵）`);
      }
    }
    return out;
  }

  /* ---------------- 渲染 ---------------- */
  const $ = (id) => document.getElementById(id);
  const pct = (x) => {
    const v = x * 100;
    if (v > 99.9) return '100%';
    if (v < 0.1) return '0%';
    return v.toFixed(1) + '%';
  };
  const TEAM_COLOR = ['#ff6b2c', '#4aa8ff', '#2fd27b', '#f7c948', '#c084fc', '#ff5c8a', '#39d0d8'];
  const colorOf = (g, t) => TEAM_COLOR[DATA.groups[g].indexOf(t) % TEAM_COLOR.length];
  const clearCache = () => { for (const k in cache) delete cache[k]; };

  function render() {
    try {
      $('updated').textContent = `数据截至 ${DATA.updated_at}`;
      renderNotice();
      renderTabs();
      const M = model(state.group);
      const { P } = M;
      if (!state.target || !P.teams.includes(state.target)) state.target = P.teams[Math.min(4, P.teams.length - 1)];
      const probs = P.teams.map((t) => teamProb(M, P.idx[t]));
      renderStandings(M, probs);
      renderProbList(M, probs);
      renderAnalysis(M);
      renderSchedule(P);
      renderFoot(M);
    } catch (err) {
      $('analysis').innerHTML = `<div class="notice" style="display:block">渲染出错：${err && err.message}<pre style="white-space:pre-wrap;font-size:12px;color:#f2dca4">${(err && err.stack || '').slice(0, 800)}</pre></div>`;
      throw err;
    }
  }

  function renderNotice() {
    const n = Object.keys(overrides).length;
    $('notice').innerHTML = n
      ? `<div class="notice">本机已改过 <b>${n}</b> 场比分（只存在这台电脑的浏览器里，别人看不到）。
         <button class="btn sm" id="btnClearLocal">清除本地修改</button></div>`
      : '';
    const b = $('btnClearLocal');
    if (b) b.onclick = () => { overrides = {}; localStorage.removeItem(LSK); clearCache(); render(); };
  }

  function renderTabs() {
    $('tabs').innerHTML = Object.keys(DATA.groups).map((g) => {
      const P = prepGroup(g);
      return `<button class="tab ${g === state.group ? 'on' : ''}" data-g="${g}">
        <b>${g} 组</b><span class="sub">剩 ${P.sched.length} 场</span></button>`;
    }).join('');
    $('tabs').querySelectorAll('.tab').forEach((el) => {
      el.onclick = () => { state.group = el.dataset.g; state.target = null; state.detailW = null; render(); };
    });
  }

  function renderStandings(M, probs) {
    const { P } = M;
    const r0 = currentRank(P);
    const lines = r0.order.map((t, j) => {
      const w = r0.W[t], l = r0.L[t], pts = r0.pts[t];
      const p = probs[t];
      const done = P.rem[t] === 0;
      let badge = '<span class="badge b-live">争夺中</span>';
      if (p > 0.9995) badge = '<span class="badge b-q">已出线</span>';
      else if (p < 0.0005) badge = '<span class="badge b-out">已出局</span>';
      if (done && p <= 0.9995 && p >= 0.0005) badge = '<span class="badge b-dim">已赛完</span>';
      const diff = DATA.teams[P.teams[t]].adj_diff;
      const miss = DATA.teams[P.teams[t]].missing_scores || 0;
      const cls = p > 0.9995 ? 'q' : (p < 0.0005 ? 'out' : '');
      const sel = P.teams[t] === state.target ? 'sel' : '';
      return `<tr class="${cls} ${sel}" data-t="${P.teams[t]}">
        <td style="text-align:center;color:var(--dim2)">${j + 1}</td>
        <td class="t"><div class="team"><i class="dot" style="background:${colorOf(P.g, P.teams[t])}"></i>${P.teams[t]}</div></td>
        <td class="num">${w + l}</td>
        <td class="num">${w}</td>
        <td class="num">${l}</td>
        <td class="num" style="font-weight:700">${pts}</td>
        <td class="num" style="color:${diff > 0 ? 'var(--green)' : 'var(--red)'}">${diff > 0 ? '+' : ''}${diff}${miss ? '≈' : ''}</td>
        <td class="num" style="color:var(--dim)">${P.rem[t]}</td>
        <td style="text-align:right">${badge}</td>
      </tr>`;
    }).join('');
    $('standings').innerHTML = `<thead><tr>
      <th style="text-align:center">#</th><th class="t">球队</th>
      <th>场</th><th>胜</th><th>负</th><th>积分</th><th>净胜分</th><th>剩</th><th style="text-align:right">出线</th>
      </tr></thead><tbody>${lines}</tbody>`;
    $('standings').querySelectorAll('tbody tr').forEach((tr) => {
      tr.onclick = () => { state.target = tr.dataset.t; state.detailW = null; render(); };
    });
  }

  function renderProbList(M, probs) {
    const { P } = M;
    $('probHint').textContent = state.mode === 'even'
      ? '把本组剩余比赛的所有胜负组合等概率跑一遍（每场五五开），看每队进前四的占比。'
      : '按各队净胜分实力推算每场胜率再跑一遍，主场略有加成。只作参考。';
    const arr = P.teams.map((t, i) => ({ t, p: probs[i], rem: P.rem[i] })).sort((a, b) => b.p - a.p);
    $('probList').innerHTML = arr.map((x) => `
      <div style="margin-bottom:11px">
        <div style="display:flex;justify-content:space-between;font-size:13.5px;margin-bottom:3px">
          <span>${x.t} <span style="color:var(--dim2);font-size:12px">剩 ${x.rem} 场</span></span>
          <b class="num">${pct(x.p)}</b>
        </div>
        <div class="pbar"><i style="width:${Math.max(1.5, x.p * 100)}%" class="${x.p < 0.15 ? 'low' : ''}"></i></div>
      </div>`).join('');
  }

  // 为什么"全胜也不一定行"：把铁定压在目标队前面的队点出来
  function h2hBetween(P, a, b) {
    let aw = 0, bw = 0, n = 0;
    for (const m of P.base) {
      if (!((m.h === a && m.a === b) || (m.h === b && m.a === a))) continue;
      n++;
      const aIsHome = m.h === a;
      if (m.homeWin === aIsHome) aw++; else bw++;
    }
    return { n, aw, bw };
  }

  function blockerNote(M, tIdx) {
    const { P } = M;
    const r0 = currentRank(P);
    const maxPts = r0.pts[tIdx] + 2 * P.rem[tIdx];
    const sure = [], maybe = [];
    for (let u = 0; u < P.n; u++) {
      if (u === tIdx) continue;
      const minPts = r0.pts[u] + P.rem[u]; // 全输也每场拿 1 分
      if (minPts < maxPts) continue;
      const h = h2hBetween(P, u, tIdx);
      const h2hDone = h.n >= 2;
      if (minPts > maxPts || (h2hDone && h.aw > h.bw)) sure.push(P.teams[u]);
      else maybe.push(P.teams[u]);
    }
    return { maxPts, sure, maybe };
  }

  function blockerHtml(M, tIdx, tName) {
    const bl = blockerNote(M, tIdx);
    const bits = [];
    if (bl.sure.length) {
      bits.push(`<b>${bl.sure.join('、')}</b> 就算剩下全输，积分也不低于 ${tName} 全胜的 ${bl.maxPts} 分`
        + `（同分还要先比相互战绩，对${tName}是吃亏的一方）`);
    }
    if (bl.maybe.length) {
      bits.push(`<b>${bl.maybe.join('、')}</b> 与 ${tName} 同分时，要先比相互战绩/净胜分，还有得争`);
    }
    if (!bits.length) return '';
    const tail = bl.sure.length >= ADV
      ? `也就是说 ${tName} 就算全赢也挤不进前四。`
      : (bl.sure.length ? `所以 ${tName} 最多也就第 ${bl.sure.length + 1} 名，能抢的名额剩 ${ADV - bl.sure.length} 个。` : '');
    return `<p class="hint" style="margin:-4px 0 16px;line-height:1.9">${bits.join('；')}。${tail}</p>`;
  }

  function renderAnalysis(M) {
    const { P } = M;
    const tIdx = P.idx[state.target];
    const A = analyzeTarget(M, tIdx);
    const tName = state.target;
    const W0 = P.bW[tIdx], L0 = P.bL[tIdx];
    const pts0 = 2 * W0 + L0;
    const pos0 = currentRank(P).order.indexOf(tIdx) + 1;
    const kRem = P.rem[tIdx];
    const p = A.prob;

    if (state.detailW === null || state.detailW > kRem) state.detailW = kRem;
    const tier = A.tiers.find((x) => x.w === state.detailW) || A.tiers[0];
    const det = tierDetail(M, A, tier);

    const t0p = A.tiers[0].prob;
    const headline = p > 0.9995
      ? '前四已经锁了，剩下只争排名。'
      : (p < 0.0005 ? '已经出局，只能等明年。'
        : (t0p > 0.9995
          ? '自己全赢就稳；输一场就得看别人。'
          : (t0p > 0.5
            ? '全赢也得看别人脸色。'
            : '既看自己，也看别人。')));

    const tierRows = A.tiers.map((x) => {
      const d = tierDetail(M, A, x);
      const finalW = W0 + x.w, finalL = L0 + (kRem - x.w);
      const cls = x.prob > 0.9995 ? 'q' : (x.prob < 0.0005 ? 'out' : '');
      const cond = d && d.rule && d.rule.text ? d.rule.text
        : (x.prob > 0.9995 ? '必出线' : x.prob < 0.0005 ? '没戏'
          : (d && d.matrix ? matrixSummary(M, d).slice(0, 2).join('；') + ' …（点开看全部）' : '点开看'));
      return `<tr class="${cls} ${x.w === state.detailW ? 'sel' : ''}" data-w="${x.w}">
        <td class="t"><span class="res">${x.w} 胜 ${kRem - x.w} 负</span></td>
        <td class="num">${finalW}-${finalL}</td>
        <td class="num">${2 * finalW + finalL}</td>
        <td class="num" style="font-weight:700">${pct(x.prob)}</td>
        <td class="t" style="color:${x.prob > 0.9995 ? 'var(--green)' : x.prob < 0.0005 ? 'var(--red)' : '#c9d4e2'}">${cond}</td>
      </tr>`;
    }).join('');

    let detail = '';
    if (det) {
      const c1 = det.comps[0], c2 = det.comps[1];
      let matrix = '';
      if (det.matrix && c1 && c2) {
        const { rows, cols, cell } = det.matrix;
        let head = `<tr><th class="t ax">${P.teams[c1.u]} ＼ ${P.teams[c2.u]}</th>`;
        for (let j = 0; j < cols; j++) head += `<th>${j} 胜</th>`;
        head += '</tr>';
        let body = '';
        for (let i = 0; i < rows; i++) {
          body += `<tr><th class="t ax">${i} 胜</th>`;
          for (let j = 0; j < cols; j++) {
            const c = cell[i][j];
            if (!c.w) { body += '<td class="m-na">—</td>'; continue; }
            const r = c.q / c.w;
            const cls = r > 0.9995 ? 'm-in' : (r < 0.0005 ? 'm-out' : 'm-part');
            const txt = r > 0.9995 ? '出线' : (r < 0.0005 ? '出局' : pct(r));
            body += `<td class="${cls}">${txt}</td>`;
          }
          body += '</tr>';
        }
        matrix = `<table class="matrix"><thead>${head}</thead><tbody>${body}</tbody></table>`;
      }

      const sensRows = A.sens.map((s) => `
        <tr>
          <td class="t">${s.date ? s.date.slice(5) + ' ' : ''}${s.home} vs ${s.away}</td>
          <td class="num">${pct(s.pHome)}</td>
          <td class="num">${pct(s.pAway)}</td>
          <td class="num delta ${s.delta > 0 ? 'up' : 'down'}">${s.delta > 0 ? '+' : ''}${(s.delta * 100).toFixed(0)}</td>
        </tr>`).join('');

      detail = `
        <h3 style="font-size:15px;margin:18px 0 6px">
          ${tName} 接下来 ${tier.w} 胜 ${kRem - tier.w} 负 的话
        </h3>
        <p style="color:${det.rule.type === 'safe' ? 'var(--green)' : det.rule.type === 'dead' ? 'var(--red)' : '#dfe8f3'};margin:0 0 10px;font-size:14.5px">
          ${det.rule.text || '这一档没有一句话能概括的条件，按对手战绩分行看：'}
        </p>
        ${!det.rule.text && det.matrix ? `<ul style="margin:0 0 12px;padding-left:18px;color:#dfe8f3;font-size:14px;line-height:1.9">
          ${matrixSummary(M, det).map((s) => `<li>${s}</li>`).join('')}</ul>` : ''}
        ${matrix ? `<p class="hint" style="margin:10px 0 6px">
           行＝${P.teams[c1.u]} 剩余 ${P.rem[c1.u]} 场的胜场数，列＝${P.teams[c2.u]} 剩余 ${P.rem[c2.u]} 场的胜场数。
           格子是「${tName} 出线」在这个格子里所有情形中的占比，其余队伍的战绩已合并计入。</p>${matrix}
           <div style="margin-top:10px"><button class="btn sm" id="btnCases">下载这一档的全部情形（CSV，${tier.idxs.length} 种）</button></div>` : ''}
        <h3 style="font-size:15px;margin:20px 0 6px">哪几场最要命</h3>
        <p class="hint" style="margin:0 0 8px">其他比赛不动，只看这一场谁赢对 ${tName} 出线概率的影响，按影响大小排。</p>
        <table class="sens"><thead><tr>
          <th class="t">比赛</th><th>主队赢</th><th>客队赢</th><th>差值(百分点)</th>
        </tr></thead><tbody>${sensRows}</tbody></table>`;
    }

    $('analysis').innerHTML = `
      <div class="hero">
        <div class="col" style="flex:0 0 auto">
          <div class="big">${pct(p)}<small> 出线概率</small></div>
          <p>${headline}</p>
        </div>
        <div class="col">
          <div class="kv">
            <div>当前战绩<b>${W0} 胜 ${L0} 负 · ${pts0} 分</b></div>
            <div>当前排名<b>第 ${pos0} 名</b></div>
            <div>剩余比赛<b>${kRem} 场</b></div>
            <div>全赢的话<b>${W0 + kRem} 胜 ${L0} 负 · ${2 * (W0 + kRem) + L0} 分</b></div>
          </div>
        </div>
      </div>
      ${blockerHtml(M, tIdx, tName)}
      <h2 style="font-size:16px;margin:4px 0 2px">${tName}：每种自家战绩，分别需要什么</h2>
      <p class="hint">点任一行，看它的完整条件与对手战绩矩阵。</p>
      <table class="paths"><thead><tr>
        <th class="t">剩余战绩</th><th>最终</th><th>积分</th><th>出线概率</th><th class="t">出线条件</th>
      </tr></thead><tbody>${tierRows}</tbody></table>
      ${detail}`;

    $('analysis').querySelectorAll('tr[data-w]').forEach((tr) => {
      tr.onclick = () => { state.detailW = +tr.dataset.w; render(); };
    });
    const bc = $('btnCases');
    if (bc && tier) bc.onclick = () => exportCases(M, A, tier);
  }

  function download(name, text) {
    const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
  }

  function exportCases(M, A, tier) {
    const { P, E } = M, n = P.n;
    const head = ['情形', ...P.teams.map((t) => t + '剩余胜'), ...P.teams.map((t) => t + '积分'),
      state.target + '出线', '前四名'];
    const lines = [head.join(',')];
    tier.idxs.forEach((k, i) => {
      const remW = P.teams.map((t, u) => E.win[k * n + u] - P.bW[u]);
      const pts = P.teams.map((t, u) => E.pts[k * n + u]);
      const top = [];
      for (let j = 0; j < ADV; j++) top.push(P.teams[E.ord[k * n + j]]);
      lines.push([i + 1, ...remW, ...pts, A.inTop[k] ? '出线' : '出局', top.join(' / ')].join(','));
    });
    download(`zheba-${state.target}-${tier.w}胜.csv`, lines.join('\n'));
  }

  function renderSchedule(P) {
    const rows = P.sched.map((m) => {
      const d = m.date ? m.date.slice(5) : '待定';
      return `<tr><td class="t num" style="color:var(--dim)">${d}</td>
        <td class="t">${m.home} <span style="color:var(--dim2)">主场</span> vs ${m.away}</td>
        <td class="num" style="color:var(--dim2)">${m.time || ''}</td></tr>`;
    }).join('');
    $('schedule').innerHTML = P.sched.length
      ? `<thead><tr><th class="t">日期</th><th class="t">对阵</th><th>时间</th></tr></thead><tbody>${rows}</tbody>`
      : '<tbody><tr><td class="t" style="color:var(--dim)">本组比赛已全部结束。</td></tr></tbody>';
  }

  function renderFoot(M) {
    const cov = DATA.coverage;
    const miss = M.P.teams.filter((t) => (DATA.teams[t].missing_scores || 0) > 0);
    $('foot').innerHTML = `
      <p><b>规则</b>：小组赛主客场双循环，每队 12 场；胜 1 场得 2 分、负 1 场得 1 分、弃权告负 0 分。
      同分依次比：同分队之间的比赛积分 → 相互净胜分 → 相互得分 → 全组净胜分 → 全组得分 → 抽签。各组前 4 名进 16 强。</p>
      <p><b>怎么算的</b>：不模拟、不估算——把本组剩余比赛的每一种胜负组合都排一遍（当前 ${M.E.T} 种 × 官方同分规则），
      数出每队进前四的占比。比分一改，结论立刻重算。</p>
      <p><b>数据</b>：已赛 ${cov.played} 场、剩余 ${cov.scheduled} 场，共 ${cov.total} 场；逐队战绩与官方积分榜核对一致。
      其中 ${cov.played_score_unknown} 场（9 月上旬）只查到胜负、没查到具体比分，涉及：${miss.length ? miss.join('、') : '无'}。
      这些场次不影响积分，只影响「净胜分」这层比较，所以相关球队的净胜分标了 ≈（用官方场均得失分校准）。</p>
      <p><b>加时</b>：赛制提到加时胜另有 0.5 分加成，但公开积分榜与「胜2负1」完全对得上，故未单列。</p>
      <p><b>更新</b>：页面上的「录入新赛果」只改这台电脑的浏览器；要改数据本身，编辑 <code>data/zba-2026.json</code>，
      或重跑 <code>python3 tools/fetch_zjej.py</code> 和 <code>python3 tools/build_data.py</code>。</p>`;
  }

  /* ---------------- 录入面板 ---------------- */
  function openSheet() {
    const list = DATA.matches.filter((m) => m.status === 'scheduled' || overrides[mkey(m)]);
    list.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    $('recordList').innerHTML = list.map((m) => {
      const ov = overrides[mkey(m)] || ['', ''];
      return `<div class="matchrow" data-key="${mkey(m)}">
        <div class="hn">${m.home}</div>
        <input type="number" min="0" max="200" class="hs" value="${ov[0] === undefined ? '' : ov[0]}" placeholder="-">
        <div style="text-align:center;color:var(--dim2)">:</div>
        <input type="number" min="0" max="200" class="as" value="${ov[1] === undefined ? '' : ov[1]}" placeholder="-">
        <div class="an">${m.away} <span class="mdate">${m.group}组 ${m.date ? m.date.slice(5) : ''}</span></div>
      </div>`;
    }).join('') || '<p class="hint">没有待赛的比赛了。</p>';
    $('sheet').classList.add('on');
  }

  function saveSheet() {
    const rows = $('recordList').querySelectorAll('.matchrow');
    let bad = 0;
    rows.forEach((r) => {
      const hs = r.querySelector('.hs').value.trim();
      const as = r.querySelector('.as').value.trim();
      const key = r.dataset.key;
      if (hs === '' && as === '') { delete overrides[key]; return; }
      const a = parseInt(hs, 10), b = parseInt(as, 10);
      if (!isFinite(a) || !isFinite(b) || a < 0 || b < 0 || a === b) { bad++; return; }
      overrides[key] = [a, b];
    });
    if (bad) alert(`有 ${bad} 场比分无效（要两个非负整数且不相等），这些行没保存。`);
    localStorage.setItem(LSK, JSON.stringify(overrides));
    clearCache();
    $('sheet').classList.remove('on');
    render();
  }

  function exportJSON() {
    const clone = JSON.parse(JSON.stringify(DATA));
    for (const m of clone.matches) {
      const ov = overrides[mkey(m)];
      if (ov && m.status === 'scheduled') {
        m.status = 'played';
        m.home_score = ov[0]; m.away_score = ov[1];
        m.score_known = true;
        m.winner = ov[0] > ov[1] ? m.home : m.away;
      }
    }
    clone.updated_at = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(clone, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'zba-2026.json';
    a.click();
  }

  /* ---------------- 事件 ---------------- */
  $('btnRecord').onclick = openSheet;
  $('btnClose').onclick = () => $('sheet').classList.remove('on');
  $('sheet').onclick = (e) => { if (e.target === $('sheet')) $('sheet').classList.remove('on'); };
  $('btnSave').onclick = saveSheet;
  $('btnExport').onclick = exportJSON;
  $('btnReset').onclick = () => {
    if (confirm('清除本机所有比分修改？')) {
      overrides = {}; localStorage.removeItem(LSK); clearCache();
      $('sheet').classList.remove('on'); render();
    }
  };
  $('btnEven').onclick = () => { state.mode = 'even'; syncMode(); render(); };
  $('btnWeighted').onclick = () => { state.mode = 'weighted'; syncMode(); render(); };
  function syncMode() {
    $('btnEven').classList.toggle('on', state.mode === 'even');
    $('btnWeighted').classList.toggle('on', state.mode === 'weighted');
  }

  syncMode();
  render();

  // 调试入口（不影响页面）
  window.__ZBA = {
    state,
    model: (g) => { const M = model(g || state.group); return { T: M.E.T, N: M.E.N, n: M.E.n, teams: M.P.teams, rem: Array.from(M.P.rem), bW: Array.from(M.P.bW) }; },
    tier: (team, w, g) => {
      const M = model(g || state.group);
      const A = analyzeTarget(M, M.P.idx[team]);
      const tier = A.tiers.find((x) => x.w === w);
      const d = tierDetail(M, A, tier);
      return { prob: tier.prob, cases: tier.idxs.length, rule: d.rule, comps: d.comps.map((c) => M.P.teams[c.u]), matrix: d.matrix ? { rows: d.matrix.rows, cols: d.matrix.cols, cell: d.matrix.cell } : null };
    },
  };
})();
