/* =========================================================
   Kanal-Dashboard – Online-Version
   Der GitHub-Bot (track.py) holt alle 20 Minuten neue Zahlen – auch wenn dein PC aus ist –
   und speichert sie VERSCHLÜSSELT in data/. Den Schlüssel gibt es nur in deinem
   persönlichen Link (#k=…). Ohne ihn sieht man nichts.
   ========================================================= */

const STORAGE_KEY = 'kanal-dashboard-v1';

// Plattformen: Farbe, Wort für Follower, Ziel für Monetarisierung
const PLATFORMS = {
  youtube:   { label: 'YouTube',   short: 'YT', color: 'var(--youtube)',   followerWord: 'Abonnenten',
               goal: { followers: 1000, text: 'YouTube-Partnerprogramm (1.000 Abos)' } },
  tiktok:    { label: 'TikTok',    short: 'TT', color: 'var(--tiktok-2)',  followerWord: 'Follower',
               goal: { followers: 10000, text: 'TikTok Creator Rewards (10.000 Follower)' } },
  instagram: { label: 'Instagram', short: 'IG', color: 'var(--instagram)', followerWord: 'Follower',
               goal: null },
  other:     { label: 'Andere',    short: '•',  color: 'var(--other)',     followerWord: 'Follower',
               goal: null },
};

// Zahlen, die pro Account gespeichert werden
const METRICS = [
  { key: 'followers', label: 'Follower / Abos' },
  { key: 'views',     label: 'Aufrufe' },
  { key: 'likes',     label: 'Likes' },
  { key: 'comments',  label: 'Kommentare' },
  { key: 'shares',    label: 'Geteilt' },
  { key: 'videos',    label: 'Videos' },
  { key: 'revenue',   label: 'Einnahmen (echt)', money: true },
];
const CHART_METRICS = METRICS.filter(m => !m.money);

const DEFAULT_SETTINGS = { currency: '€', rpm: { youtube: 0.05, tiktok: 0.7, instagram: 0.1, other: 0 } };

/* ---------- Daten: verschlüsselte Schnappschüsse ---------- */
let state = normalize({ accounts: [] });
let pendingSaves = 0;
const ui = { platform: 'all', brand: 'all', compare: 'views', growth: 'views' };
try { Object.assign(ui, JSON.parse(localStorage.getItem(STORAGE_KEY + '-ui') || '{}')); } catch {}

function normalize(s) {
  s.settings = Object.assign({}, DEFAULT_SETTINGS, s.settings || {});
  s.settings.rpm = Object.assign({}, DEFAULT_SETTINGS.rpm, s.settings.rpm || {});
  try { // eigene Einstellungen (Währung, Schätzwerte) gelten nur auf diesem Gerät
    const mine = JSON.parse(localStorage.getItem(STORAGE_KEY + '-settings') || 'null');
    if (mine) { s.settings.currency = mine.currency || s.settings.currency; Object.assign(s.settings.rpm, mine.rpm || {}); }
  } catch {}
  s.accounts = (s.accounts || []).map(a => ({ history: [], ...a }));
  s.accounts.forEach(a => a.history.sort((x, y) => x.date.localeCompare(y.date)));
  return s;
}
function save() { try { localStorage.setItem(STORAGE_KEY + '-ui', JSON.stringify(ui)); } catch {} }

const b64d = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
let privKey = null;
async function importKey(d) {
  const pk = await (await fetch('pubkey.json', { cache: 'no-store' })).json();
  return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: pk.x, y: pk.y, d, ext: true },
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}
async function decryptFile(f) {
  const epk = await crypto.subtle.importKey('raw', b64d(f.epk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: epk }, privKey, 256);
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('kanal-dashboard v1') },
    hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const gz = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(f.iv) }, key, b64d(f.ct));
  return JSON.parse(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
}
const fileCache = new Map();
async function loadEnc(name) {
  if (!fileCache.has(name)) {
    fileCache.set(name, (async () => {
      const r = await fetch('data/' + name, { cache: name === 'base.enc' ? 'default' : 'no-store' });
      if (!r.ok) throw new Error('Datei fehlt: ' + name);
      return decryptFile(await r.json());
    })().catch(e => { fileCache.delete(name); throw e; }));
  }
  return fileCache.get(name);
}

// Datum im deutschen Kalender (Tagesgrenze Mitternacht in Berlin)
const berlinDay = iso => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

function mergeVideos(a, fresh, complete, at) {
  const old = new Map((a.videoList || []).map(v => [v.id, v]));
  const seen = new Set();
  for (const n of fresh) {
    let v = old.get(n.id);
    if (!v) { v = { id: n.id, history: [] }; old.set(n.id, v); }
    const last = v.history[v.history.length - 1] || {};
    for (const k of ['views', 'likes', 'comments']) if (!n[k] && last[k]) n[k] = last[k]; // 0 ersetzt keine echte Zahl
    for (const k of ['title', 'published', 'thumb', 'duration', 'url']) if (n[k]) v[k] = n[k];
    if (n.shares) v.shares = n.shares;
    delete v.missing;
    const point = { t: at, views: n.views, likes: n.likes, comments: n.comments };
    if (last.t && v.history.length > 1 && Date.parse(at) - Date.parse(last.t) < 3600e3) v.history[v.history.length - 1] = point;
    else v.history.push(point);
    if (v.history.length > 400) v.history.splice(0, v.history.length - 400);
    seen.add(n.id);
  }
  if (complete) for (const [id, v] of old) if (!seen.has(id)) v.missing = (v.missing || 0) + 1;
  a.videoList = [...old.values()].sort((x, y) => (y.published || '').localeCompare(x.published || ''));
  a.videosUpdated = at;
}
function addSnapshot(a, stats, date) {
  const last = a.history[a.history.length - 1] || {};
  const snap = { ...last, date };
  for (const [k, v] of Object.entries(stats)) if (v || !last[k]) snap[k] = v; // 0 ersetzt keine echte Zahl
  if (last.date === date) a.history[a.history.length - 1] = snap; else a.history.push(snap);
}
const lastPoints = a => (a.videoList || []).filter(v => v.history?.length).map(v => v.history[v.history.length - 1]);
const sumOf = (pts, k) => pts.reduce((t, p) => t + (p[k] || 0), 0);

function applySnapshot(s, snap) {
  const at = snap.at;
  for (const a of s.accounts) {
    const r = snap.accounts[a.id];
    if (!r) continue;
    a.status = a.status || {};
    a.status.lastTry = at;
    if (!r.ok) { a.status.error = r.error; continue; }
    const stats = { ...r.stats };
    const before = lastPoints(a), prev = a.history[a.history.length - 1] || {};
    if (r.videos?.length) mergeVideos(a, r.videos, r.complete, at);
    const after = lastPoints(a);
    if (after.length && a.platform === 'tiktok') {
      // Summe über ALLE bekannten Videos – fehlt mal eins, zählt es mit den letzten Zahlen weiter
      stats.views = sumOf(after, 'views');
      stats.comments = sumOf(after, 'comments');
      stats.shares = (a.videoList || []).reduce((t, v) => t + (v.shares || 0), 0);
      stats.likes = Math.max(stats.likes || 0, sumOf(after, 'likes'));
    } else if (after.length && r.partial) {
      // YouTube ohne Schlüssel: Kanal-Summe wächst um das, was die Videos dazubekommen haben
      for (const k of ['views', 'likes', 'comments']) {
        const grow = sumOf(after, k) - sumOf(before, k);
        stats[k] = Math.max(sumOf(after, k), (prev[k] || 0) + Math.max(0, grow));
      }
    }
    if (a.videoList?.length) stats.videos = Math.max(stats.videos || 0, a.videoList.filter(v => (v.missing || 0) < 6).length);
    addSnapshot(a, stats, berlinDay(at));
    if (r.comments) a.commentList = r.comments;
    a.status.lastOk = at;
    a.status.error = r.warning || '';
  }
  s.trackedAt = at;
}

let indexAt = null;
async function loadData(force = false) {
  const idx = await (await fetch('data/index.json?t=' + Date.now(), { cache: 'no-store' })).json();
  if (!force && idx.updatedAt === indexAt) return false;
  const base = structuredClone(await loadEnc('base.enc'));
  // Kanäle aus config.json (neue Kanäle kommen von selbst dazu)
  const cfg = await (await fetch('config.json?t=' + Date.now(), { cache: 'no-store' })).json();
  for (const c of cfg.accounts) {
    const a = base.accounts.find(x => x.id === c.id);
    if (a) Object.assign(a, c); else base.accounts.push({ ...c, history: [] });
  }
  base.accounts = base.accounts.filter(a => cfg.accounts.some(c => c.id === a.id));
  const s = normalize(base);
  const files = idx.files.filter(x => !s.at || x.at > s.at);
  const snaps = await Promise.all(files.map(x => loadEnc(x.f).catch(() => null)));
  snaps.filter(Boolean).sort((x, y) => x.at.localeCompare(y.at)).forEach(sn => applySnapshot(s, sn));
  state = s;
  indexAt = idx.updatedAt;
  return true;
}

/* ---------- Hilfen ---------- */
const $ = sel => document.querySelector(sel);
const nf = new Intl.NumberFormat('de-DE');
const fmt = n => nf.format(Math.round(n || 0));
const fmtShort = n => {
  n = n || 0;
  if (Math.abs(n) >= 1e6) return (n / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' Mio.';
  if (Math.abs(n) >= 1e4) return (n / 1e3).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' Tsd.';
  return fmt(n);
};
const money = n => (n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + state.settings.currency;
const fmtDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–';
const today = () => new Date().toLocaleDateString('sv-SE'); // JJJJ-MM-TT
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plat = a => PLATFORMS[a.platform] || PLATFORMS.other;
const latest = a => a.history[a.history.length - 1] || {};
const previous = a => a.history[a.history.length - 2] || null;
const estRevenue = a => (latest(a).views || 0) / 1000 * (state.settings.rpm[a.platform] || 0);
const brands = () => [...new Set(state.accounts.map(a => a.brand || 'Ohne Projekt'))];

function filtered() {
  return state.accounts.filter(a =>
    (ui.platform === 'all' || a.platform === ui.platform) &&
    (ui.brand === 'all' || (a.brand || 'Ohne Projekt') === ui.brand));
}
function sum(accs, key, fn = latest) {
  return accs.reduce((t, a) => t + (Number((fn(a) || {})[key]) || 0), 0);
}

/* ---------- Anzeige ---------- */
function render() {
  // Detailseite? (#konto=ID)
  const id = decodeURIComponent((location.hash.match(/^#konto=(.+)$/) || [])[1] || '');
  const acc = id && state.accounts.find(a => a.id === id);
  $('#overview').hidden = !!acc;
  $('#detail').hidden = !acc;
  if (acc) { renderSyncButton(); renderDetail(acc); renderTicker($('#ticker-detail'), [acc]); save(); return; }

  renderFilters();
  const accs = filtered();
  renderTicker($('#ticker-overview'), accs);
  renderKpis(accs);
  renderMoney(accs);
  renderCompare(accs);
  renderGrowth(accs);
  renderSplit(accs);
  renderAccounts(accs);
  renderAllVideos(accs);
  save();
}

// Sortierungen für Videolisten (Übersicht + Detailseite)
const VIDEO_SORTERS = {
  published: (x, y) => y.published.localeCompare(x.published),
  views: (x, y) => vNow(y).views - vNow(x).views,
  likes: (x, y) => vNow(y).likes - vNow(x).likes,
  delta: (x, y) => ((vNow(y).views - (vRef(y)?.p.views ?? vNow(y).views)) - (vNow(x).views - (vRef(x)?.p.views ?? vNow(x).views))),
  rate: (x, y) => (vNow(y).likes / Math.max(1, vNow(y).views)) - (vNow(x).likes / Math.max(1, vNow(x).views)),
};

// Alle Videos aller (gefilterten) Kanäle in einer Liste
const allVidUi = { sort: 'published', open: false };
function renderAllVideos(accs) {
  const rows = accs.flatMap(a => (a.videoList || []).filter(v => v.published).map(v => ({ a, v })));
  rows.sort((x, y) => (VIDEO_SORTERS[allVidUi.sort] || VIDEO_SORTERS.published)(x.v, y.v));
  $('#vid-count').textContent = `(${rows.length})`;
  $('#all-video-sort').value = allVidUi.sort;
  if (!rows.length) { $('#all-videos').innerHTML = '<div class="empty">Noch keine Videos geladen.</div>'; return; }
  const shown = allVidUi.open ? rows : rows.slice(0, 10);
  $('#all-videos').innerHTML = `<div class="table-wrap"><table class="videos">
    <thead><tr><th>Video</th><th>Kanal</th><th>Aufrufe</th><th>+/−</th><th>Likes</th><th>Like-Rate</th><th>Kommentare</th></tr></thead>
    <tbody>${shown.map(({ a, v }) => {
      const n = vNow(v), r = vRef(v);
      const rate = n.views ? n.likes / n.views * 100 : 0;
      return `<tr>
        <td class="vcell">
          <a href="${esc(vUrl(v))}" target="_blank" rel="noopener" class="vthumb${a.platform === 'tiktok' ? ' tall' : ''}">
            <img src="${esc(v.thumb)}" alt="" loading="lazy" onerror="this.remove()">${v.duration ? `<span>${fmtDur(v.duration)}</span>` : ''}</a>
          <div class="vmeta">
            <a href="${esc(vUrl(v))}" target="_blank" rel="noopener">${esc(v.title || 'Video ohne Text')}</a>
            <small>${fmtDate(v.published.slice(0, 10))} · ${ago(v.published)}</small>
          </div></td>
        <td><a class="vchan" href="#konto=${encodeURIComponent(a.id)}"><span class="pbadge mini ${a.platform}" style="--pc:${plat(a).color}">${plat(a).short}</span>${esc(a.name)}</a></td>
        <td class="num"><b>${fmt(n.views)}</b></td>
        <td class="num">${r ? deltaHtml(n.views - r.p.views, r.label) : deltaHtml(null)}</td>
        <td class="num">${fmt(n.likes)}</td>
        <td class="num">${rate.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %</td>
        <td class="num">${fmt(n.comments)}</td>
      </tr>`;
    }).join('')}</tbody></table></div>
    ${rows.length > 10 ? `<div class="more"><button class="btn small" id="btn-all-videos">${allVidUi.open ? 'Weniger anzeigen' : `Alle ${rows.length} Videos anzeigen`}</button></div>` : ''}`;
}

function renderSyncButton() {
  $('#btn-sync').hidden = false;
  renderTrackStatus();
}

function renderFilters() {
  renderSyncButton();
  const usedPlatforms = Object.keys(PLATFORMS).filter(p => state.accounts.some(a => a.platform === p));
  if (ui.platform !== 'all' && !usedPlatforms.includes(ui.platform)) ui.platform = 'all';
  if (ui.brand !== 'all' && !brands().includes(ui.brand)) ui.brand = 'all';
  const chip = (group, val, label) =>
    `<button class="chip ${ui[group] === val ? 'on' : ''}" data-group="${group}" data-val="${esc(val)}">${esc(label)}</button>`;
  $('#filter-platform').innerHTML = chip('platform', 'all', 'Alle Plattformen') +
    usedPlatforms.map(p => chip('platform', p, PLATFORMS[p].label)).join('');
  $('#filter-brand').innerHTML = brands().length > 1
    ? chip('brand', 'all', 'Alle Projekte') + brands().map(b => chip('brand', b, b)).join('')
    : '';
}

function renderKpis(accs) {
  const tiles = [
    ...CHART_METRICS.map(m => ({ label: m.key === 'followers' ? 'Follower + Abos' : m.label, key: m.key })),
  ];
  $('#kpis').innerHTML = tiles.map(t => {
    const now = sum(accs, t.key);
    const before = accs.reduce((s, a) => s + (Number((previous(a) || latest(a))[t.key]) || 0), 0);
    const d = now - before;
    return `<div class="kpi">
      <div class="label">${t.label}</div>
      <div class="value" title="${fmt(now)}">${fmtShort(now)}</div>
      <div class="delta ${d > 0 ? 'up' : ''}">${d > 0 ? '+' + fmt(d) + ' seit letztem Update' : 'keine Änderung'}</div>
    </div>`;
  }).join('') + (() => {
    const views = sum(accs, 'views'), likes = sum(accs, 'likes');
    const rate = views ? likes / views * 100 : 0;
    return `<div class="kpi"><div class="label">Like-Rate</div>
      <div class="value">${rate.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %</div>
      <div class="delta">Likes pro Aufruf</div></div>`;
  })();
}

function renderMoney(accs) {
  const real = sum(accs, 'revenue');
  const est = accs.reduce((t, a) => t + estRevenue(a), 0);
  const goals = accs.filter(a => plat(a).goal);
  const reached = goals.filter(a => (latest(a).followers || 0) >= plat(a).goal.followers).length;
  $('#money').innerHTML = `
    <div class="kpi"><div class="label">Echte Einnahmen (eingetragen)</div>
      <div class="value">${money(real)}</div>
      <div class="note">Trag hier ein, was YouTube Studio / TikTok wirklich auszahlt.</div></div>
    <div class="kpi"><div class="label">Geschätzt aus den Aufrufen</div>
      <div class="value">${money(est)}</div>
      <div class="note">So viel wäre es, wenn alle Accounts monetarisiert wären. Werte unter ⚙ Einstellungen.</div></div>
    <div class="kpi"><div class="label">Monetarisiert</div>
      <div class="value">${reached} / ${goals.length}</div>
      <div class="note">Accounts, die die Follower-Grenze schon erreicht haben.</div></div>`;
}

function colorFor(a, i) {
  // Accounts derselben Plattform leicht verschieden einfärben
  const palette = { youtube: ['#ff2d2d', '#ff8a3d', '#c2185b'], tiktok: ['#25d6e0', '#6c4cff', '#00b894'],
                    instagram: ['#d6307a', '#f77737'], other: ['#7b8494', '#a0a7b4'] };
  const list = palette[a.platform] || palette.other;
  const sameBefore = state.accounts.filter(x => x.platform === a.platform).indexOf(a);
  return list[Math.max(0, sameBefore) % list.length];
}

function renderCompare(accs) {
  const key = ui.compare;
  const rows = accs.map(a => ({ a, v: Number(latest(a)[key]) || 0 })).sort((x, y) => y.v - x.v);
  const max = Math.max(1, ...rows.map(r => r.v));
  $('#chart-compare').innerHTML = rows.length ? `<div class="bars">${rows.map(r => `
    <div class="bar-row">
      <span class="bar-name" title="${esc(r.a.name)} (${plat(r.a).label})">${esc(r.a.name)} · ${plat(r.a).short}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${r.v / max * 100}%;background:${colorFor(r.a)}"></div></div>
      <span class="bar-val">${fmtShort(r.v)}</span>
    </div>`).join('')}</div>` : '<div class="empty">Keine Accounts</div>';
}

function renderGrowth(accs) {
  const key = ui.growth;
  const dates = [...new Set(accs.flatMap(a => a.history.map(h => h.date)))].sort();
  if (dates.length < 2) {
    $('#chart-growth').innerHTML = '<div class="empty">Sobald du die Zahlen an mindestens 2 Tagen aktualisierst, siehst du hier das Wachstum.</div>';
    return;
  }
  // Wert eines Accounts an einem Tag = letzter bekannter Stand bis dahin
  const valueAt = (a, d) => {
    let v = 0;
    for (const h of a.history) { if (h.date <= d) v = Number(h[key]) || 0; else break; }
    return v;
  };
  const series = accs.map(a => ({ a, pts: dates.map(d => valueAt(a, d)) }));
  const total = dates.map((_, i) => series.reduce((t, s) => t + s.pts[i], 0));
  const W = 560, H = 220, L = 52, R = 12, T = 10, B = 26;
  const max = Math.max(1, ...total);
  const x = i => L + (W - L - R) * (dates.length === 1 ? 0 : i / (dates.length - 1));
  const y = v => T + (H - T - B) * (1 - v / max);
  const path = pts => pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ticks = [0, .25, .5, .75, 1].map(f => max * f);
  const step = Math.ceil(dates.length / 6);
  $('#chart-growth').innerHTML = `
    <svg class="line" viewBox="0 0 ${W} ${H}" role="img" aria-label="Wachstum">
      ${ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>
        <text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${fmtShort(t)}</text>`).join('')}
      ${dates.map((d, i) => i % step === 0 || i === dates.length - 1
        ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${d.slice(8, 10)}.${d.slice(5, 7)}.</text>` : '').join('')}
      ${series.map(s => `<path d="${path(s.pts)}" fill="none" stroke="${colorFor(s.a)}" stroke-width="2" opacity=".75"/>`).join('')}
      <path d="${path(total)}" fill="none" stroke="var(--text)" stroke-width="3"/>
      ${total.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="var(--text)"><title>${fmtDate(dates[i])}: ${fmt(v)}</title></circle>`).join('')}
    </svg>
    <div class="legend"><span><i style="background:var(--text)"></i>Zusammen</span>
      ${series.map(s => `<span><i style="background:${colorFor(s.a)}"></i>${esc(s.a.name)} · ${plat(s.a).short}</span>`).join('')}</div>`;
}

function renderSplit(accs) {
  const cols = CHART_METRICS.filter(m => m.key !== 'shares' || sum(accs, 'shares') > 0);
  const head = `<tr><th></th>${cols.map(m => `<th>${m.label}</th>`).join('')}<th>Geschätzt</th></tr>`;
  const row = (name, list, cls = '') => `<tr class="${cls}"><td>${esc(name)}</td>
    ${cols.map(m => `<td>${fmt(sum(list, m.key))}</td>`).join('')}
    <td>${money(list.reduce((t, a) => t + estRevenue(a), 0))}</td></tr>`;
  const byPlatform = Object.keys(PLATFORMS).map(p => [PLATFORMS[p].label, accs.filter(a => a.platform === p)]).filter(([, l]) => l.length);
  const byBrand = brands().map(b => [b, accs.filter(a => (a.brand || 'Ohne Projekt') === b)]).filter(([, l]) => l.length);
  const span = cols.length + 2;
  $('#split').innerHTML = head +
    `<tr class="group"><td colspan="${span}">Nach Plattform</td></tr>` + byPlatform.map(([n, l]) => row(n, l)).join('') +
    `<tr class="group"><td colspan="${span}">Nach Projekt</td></tr>` + byBrand.map(([n, l]) => row(n, l)).join('') +
    row('Alle zusammen', accs, 'total');
}

function renderAccounts(accs) {
  $('#acc-count').textContent = `(${accs.length})`;
  // Nach Projekt gruppiert, im Projekt erst YouTube, dann TikTok, dann Rest
  const order = Object.keys(PLATFORMS);
  const groups = brands().map(b => [b, accs.filter(a => (a.brand || 'Ohne Projekt') === b)
    .sort((x, y) => order.indexOf(x.platform) - order.indexOf(y.platform))]).filter(([, l]) => l.length);
  $('#accounts').innerHTML = groups.map(([b, list]) => `
    <div class="acc-group">
      <h3 class="group-title">${esc(b)} <span class="count">· ${fmt(sum(list, 'followers'))} Follower/Abos · ${fmtShort(sum(list, 'views'))} Aufrufe</span></h3>
      <div class="accounts">${accountCards(list)}</div>
    </div>`).join('');
}

function accountCards(accs) {
  return accs.map(a => {
    const p = plat(a), s = latest(a);
    const goal = p.goal ? (() => {
      const pct = Math.min(100, (s.followers || 0) / p.goal.followers * 100);
      return `<div class="goal">${p.goal.text}: ${fmt(s.followers)} / ${fmt(p.goal.followers)}
        <div class="track"><div class="fill" style="width:${pct}%"></div></div></div>`;
    })() : '';
    return `<article class="card acc" style="--pc:${colorFor(a)}">
      <div class="acc-head">
        <span class="pbadge ${a.platform}" style="--pc:${p.color}">${p.short}</span>
        <div class="acc-title">
          <h3><a class="acc-link" href="#konto=${encodeURIComponent(a.id)}">${esc(a.name)}</a></h3>
          ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.handle || a.url)} ↗</a>` : `<span>${esc(a.handle)}</span>`}
        </div>
        ${a.brand ? `<span class="tag">${esc(a.brand)}</span>` : ''}
      </div>
      <div class="stats">
        <div class="stat"><b>${fmtShort(s.followers)}</b><span>${p.followerWord}</span></div>
        <div class="stat"><b>${fmtShort(s.views)}</b><span>Aufrufe</span></div>
        <div class="stat"><b>${fmtShort(s.likes)}</b><span>Likes</span></div>
        <div class="stat"><b>${fmtShort(s.comments)}</b><span>Kommentare</span></div>
        <div class="stat"><b>${fmtShort(s.videos)}</b><span>Videos</span></div>
        <div class="stat"><b>${money(s.revenue)}</b><span>Einnahmen</span></div>
      </div>
      ${goal}
      ${a.notes ? `<p class="acc-notes">${esc(a.notes)}</p>` : ''}
      ${s.date && s.date < today() ? `<p class="stale">⚠ Zahlen vom ${fmtDate(s.date)} – ${a.platform === 'youtube' || a.platform === 'tiktok' ? 'klick oben auf „↻ Jetzt laden“' : 'bitte mit „Zahlen aktualisieren“ neu eintragen'}.</p>` : ''}
      <div class="acc-foot">
        <span>Stand: ${fmtDate(s.date)} · geschätzt ${money(estRevenue(a))}</span>
        
      </div>
      <a class="btn open-detail" href="#konto=${encodeURIComponent(a.id)}">${a.platform === 'youtube' || a.videoList?.length ? 'Videos & Verlauf ansehen →' : 'Verlauf ansehen →'}</a>
    </article>`;
  }).join('');
}

/* ---------- Kommentar-Laufband ----------
   Zeigt einen Kommentar, blendet ihn nach ein paar Sekunden aus und
   zeigt den nächsten – endlos im Kreis. Darunter optional die ganze Liste. */
const TICKER_MS = 6000;
const ticker = { list: [], i: 0, timer: null, open: false };

function commentsFor(accs) {
  return accs.flatMap(a => (a.commentList || []).map(c => ({ ...c, acc: a })))
    .sort((x, y) => y.published.localeCompare(x.published));
}

function commentHtml(c, big) {
  return `<div class="cmt ${big ? 'big' : ''}">
    ${c.avatar ? `<img class="cav" src="${esc(c.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="cav"></span>'}
    <div class="cbody">
      <div class="chead"><b>${esc(c.author)}</b> <span>${ago(c.published)} · ${esc(c.acc.name)} ${plat(c.acc).short}</span></div>
      <p class="ctext">${esc(c.text)}</p>
      <a class="cvid" href="https://www.youtube.com/watch?v=${esc(c.videoId)}&lc=${esc(c.id)}" target="_blank" rel="noopener">▶ ${esc(c.videoTitle)}</a>
      ${c.likes || c.replies ? `<span class="cstat">${c.likes ? '♥ ' + fmt(c.likes) : ''} ${c.replies ? '💬 ' + fmt(c.replies) + ' Antworten' : ''}</span>` : ''}
    </div></div>`;
}

// Baut den Kasten in das Element `host` (Übersicht oder Detailseite)
function renderTicker(host, accs) {
  const list = commentsFor(accs);
  const sameList = list.length === ticker.list.length && list.every((c, k) => c.id === ticker.list[k]?.id);
  ticker.list = list;
  if (!sameList) ticker.i = 0;
  if (!list.length) {
    const ytAcc = accs.some(a => a.platform === 'youtube');
    host.innerHTML = ytAcc
      ? `<div class="card ticker"><div class="ticker-head"><h3>💬 Neueste Kommentare</h3></div>
         <div class="empty">Noch keine Kommentare – sobald jemand auf YouTube kommentiert, erscheinen sie hier.</div></div>`
      : '';
    stopTicker();
    return;
  }
  host.innerHTML = `<div class="card ticker">
    <div class="ticker-head">
      <h3>💬 Neueste Kommentare <span class="count">(${list.length})</span></h3>
      <div class="ticker-ctrl">
        <button class="btn small" data-tick="-1" title="Vorheriger">‹</button>
        <span id="tick-pos"></span>
        <button class="btn small" data-tick="1" title="Nächster">›</button>
        <button class="btn small" data-tick="list">${ticker.open ? 'Liste zu' : 'Alle anzeigen'}</button>
      </div>
    </div>
    <div class="ticker-stage" id="tick-stage"></div>
    <div class="ticker-bar"><i id="tick-bar"></i></div>
    ${ticker.open ? `<div class="cmt-list">${list.map(c => commentHtml(c)).join('')}</div>` : ''}
  </div>`;
  showTick(false);
  startTicker();
}

function showTick(animate = true) {
  const stage = $('#tick-stage');
  if (!stage || !ticker.list.length) return;
  const c = ticker.list[ticker.i % ticker.list.length];
  const put = () => {
    stage.innerHTML = commentHtml(c, true);
    stage.classList.remove('out');
    const pos = $('#tick-pos');
    if (pos) pos.textContent = `${ticker.i % ticker.list.length + 1} / ${ticker.list.length}`;
    const bar = $('#tick-bar');
    if (bar) { bar.style.transition = 'none'; bar.style.width = '0'; bar.offsetWidth; bar.style.transition = `width ${TICKER_MS}ms linear`; bar.style.width = '100%'; }
  };
  if (animate) { stage.classList.add('out'); setTimeout(put, 400); } else put();
}
function startTicker() {
  stopTicker();
  if (ticker.list.length < 2) return;
  ticker.timer = setInterval(() => { ticker.i = (ticker.i + 1) % ticker.list.length; showTick(); }, TICKER_MS);
}
function stopTicker() { clearInterval(ticker.timer); ticker.timer = null; }

/* ---------- Detailseite: Videos + Verlauf eines Kanals ---------- */
const detailUi = { sort: 'published' };
try { Object.assign(detailUi, JSON.parse(localStorage.getItem(STORAGE_KEY + '-detail') || '{}')); } catch {}

const fmtDur = s => s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
                              : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function ago(iso) {
  const h = (Date.now() - Date.parse(iso)) / 3600e3;
  if (h < 1) return 'vor ' + Math.max(1, Math.round(h * 60)) + ' Min.';
  if (h < 48) return 'vor ' + Math.round(h) + ' Std.';
  return 'vor ' + Math.round(h / 24) + ' Tagen';
}
const vUrl = v => v.url || `https://www.youtube.com/watch?v=${v.id}`;
const vNow = v => v.history[v.history.length - 1] || { views: 0, likes: 0, comments: 0 };

// Vergleichspunkt für +/-: der letzte Stand, der mind. 20 Std. alt ist,
// sonst der allererste gespeicherte Stand.
function vRef(v) {
  const h = v.history;
  if (h.length < 2) return null;
  const limit = Date.now() - 20 * 3600e3;
  for (let i = h.length - 2; i >= 0; i--) if (Date.parse(h[i].t) <= limit) return { p: h[i], label: '24 Std.' };
  return { p: h[0], label: 'seit ' + new Date(h[0].t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) };
}
function deltaHtml(d, title = '') {
  if (d == null) return '<span class="d zero" title="Noch kein Vergleich – kommt beim nächsten Laden">–</span>';
  if (d === 0) return `<span class="d zero" title="${esc(title)}">±0</span>`;
  return `<span class="d ${d > 0 ? 'up' : 'down'}" title="${esc(title)}">${d > 0 ? '▲ +' : '▼ '}${fmt(d)}</span>`;
}

function renderDetail(a) {
  const p = plat(a), s = latest(a), prev = previous(a);
  const vids = (a.videoList || []).slice();
  const avg = vids.length ? vids.reduce((t, v) => t + vNow(v).views, 0) / vids.length : 0;
  const newest = vids.slice().sort((x, y) => y.published.localeCompare(x.published))[0];
  const best = vids.slice().sort((x, y) => vNow(y).views - vNow(x).views)[0];

  vids.sort(VIDEO_SORTERS[detailUi.sort] || VIDEO_SORTERS.published);

  const kpi = (label, key) => {
    const d = prev ? (s[key] || 0) - (prev[key] || 0) : null;
    return `<div class="kpi"><div class="label">${label}</div><div class="value">${fmtShort(s[key])}</div>
      <div class="delta">${d == null ? 'erster Stand' : deltaHtml(d) + ' seit ' + fmtDate(prev.date)}</div></div>`;
  };

  // Hinweis zum neuesten Video
  let newestBox = '';
  if (newest) {
    const n = vNow(newest), r = vRef(newest);
    const pct = avg ? (n.views / avg - 1) * 100 : 0;
    newestBox = `<div class="card highlight">
      <img src="${esc(newest.thumb)}" alt="" loading="lazy" onerror="this.remove()">
      <div>
        <div class="label">Neuestes Video · ${ago(newest.published)}</div>
        <h3>${esc(newest.title || 'Video ohne Text')}</h3>
        <p>${fmt(n.views)} Aufrufe · ${fmt(n.likes)} Likes · ${fmt(n.comments)} Kommentare
          ${r ? ' · ' + deltaHtml(n.views - r.p.views) + ' Aufrufe ' + r.label : ''}</p>
        <p class="${pct >= 0 ? 'good' : 'bad'}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toLocaleString('de-DE', { maximumFractionDigits: 0 })} % ${pct >= 0 ? 'mehr' : 'weniger'} Aufrufe als dein Durchschnitt (${fmt(avg)} pro Video)${Date.now() - Date.parse(newest.published) < 48 * 3600e3 ? ` <span class="muted">– das Video ist erst ${ago(newest.published).replace('vor ', '')} online, es kann noch wachsen.</span>` : ''}</p>
      </div></div>`;
  }

  const videoTable = vids.length ? `
    <div class="table-wrap"><table class="videos">
      <thead><tr><th>Video</th><th>Aufrufe</th><th>+/−</th><th>Likes</th><th>+/−</th><th>Like-Rate</th><th>Kommentare</th><th>vs. Ø</th></tr></thead>
      <tbody>${vids.map(v => {
        const n = vNow(v), r = vRef(v);
        const pct = avg ? (n.views / avg - 1) * 100 : 0;
        const rate = n.views ? n.likes / n.views * 100 : 0;
        const badges = (v === newest ? '<span class="vb new">Neu</span>' : '') + (v === best ? '<span class="vb best">Bestes</span>' : '');
        return `<tr>
          <td class="vcell">
            <a href="${esc(vUrl(v))}" target="_blank" rel="noopener" class="vthumb${a.platform === 'tiktok' ? ' tall' : ''}">
              <img src="${esc(v.thumb)}" alt="" loading="lazy" onerror="this.remove()">${v.duration ? `<span>${fmtDur(v.duration)}</span>` : ''}</a>
            <div class="vmeta">
              <a href="${esc(vUrl(v))}" target="_blank" rel="noopener">${esc(v.title || 'Video ohne Text')}</a>
              <small>${fmtDate(v.published.slice(0, 10))} · ${ago(v.published)} ${badges}</small>
            </div></td>
          <td class="num"><b>${fmt(n.views)}</b></td>
          <td class="num">${r ? deltaHtml(n.views - r.p.views, r.label) : deltaHtml(null)}</td>
          <td class="num">${fmt(n.likes)}</td>
          <td class="num">${r ? deltaHtml(n.likes - r.p.likes, r.label) : deltaHtml(null)}</td>
          <td class="num">${rate.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %</td>
          <td class="num">${fmt(n.comments)}</td>
          <td class="num"><span class="d ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : '−'}${Math.abs(pct).toLocaleString('de-DE', { maximumFractionDigits: 0 })} %</span></td>
        </tr>`;
      }).join('')}</tbody></table></div>
    <p class="hint">+/− = Veränderung seit gestern (bzw. seit dem ersten Laden heute). vs. Ø = Aufrufe im Vergleich zum Durchschnitt aller Videos des Kanals.
      ${a.videosUpdated ? 'Zuletzt geladen ' + ago(a.videosUpdated) + '.' : ''}</p>`
    : a.platform === 'youtube'
      ? `<div class="empty">Noch keine Videos geladen – der Bot holt sie beim nächsten Durchlauf (oder oben „↻ Jetzt laden“).</div>`
      : a.platform === 'tiktok'
        ? `<div class="empty">Noch keine TikTok-Videos geladen – der Bot holt alle Videos des Profils beim nächsten Durchlauf (oder oben „↻ Jetzt laden“).</div>`
        : `<div class="empty">${p.label} hat keine freie Schnittstelle, deshalb können die einzelnen Videos nicht automatisch geladen werden. Den Verlauf des Accounts siehst du unten.</div>`;

  // Tagesverlauf des Accounts (neuester Tag oben)
  const hist = a.history.slice().reverse();
  const histRows = hist.map((h, i) => {
    const before = hist[i + 1];
    const cell = k => `<td class="num">${fmt(h[k])} ${before ? deltaHtml((h[k] || 0) - (before[k] || 0)) : ''}</td>`;
    return `<tr><td>${fmtDate(h.date)}</td>${cell('followers')}${cell('views')}${cell('likes')}${cell('comments')}${cell('videos')}</tr>`;
  }).join('');

  $('#detail').innerHTML = `
    <div class="detail-top">
      <a class="btn" href="#">← Zurück</a>
      <span class="pbadge ${a.platform}" style="--pc:${p.color}">${p.short}</span>
      <div class="acc-title">
        <h2>${esc(a.name)} · ${p.label}</h2>
        ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.handle || a.url)} ↗</a>` : `<span>${esc(a.handle)}</span>`}
      </div>
      
    </div>
    <div class="kpis">
      ${kpi(p.followerWord, 'followers')}${kpi('Aufrufe', 'views')}${kpi('Likes', 'likes')}${kpi('Kommentare', 'comments')}${kpi('Videos', 'videos')}
      ${vids.length ? `<div class="kpi"><div class="label">Ø Aufrufe pro Video</div><div class="value">${fmtShort(avg)}</div><div class="delta">${vids.length} Videos</div></div>` : ''}
    </div>
    ${newestBox}
    <div id="ticker-detail" class="ticker-wrap"></div>
    <div class="card-head detail-head">
      <h2>Videos</h2>
      ${vids.length ? `<select id="video-sort">
        <option value="published">Neueste zuerst</option>
        <option value="views">Meiste Aufrufe</option>
        <option value="delta">Größtes Plus</option>
        <option value="likes">Meiste Likes</option>
        <option value="rate">Beste Like-Rate</option>
      </select>` : ''}
    </div>
    ${a.status?.error ? `<p class="stale">⚠ Letzter Versuch: ${esc(a.status.error)}${a.status.lastOk ? ' – angezeigt werden die Zahlen von ' + ago(a.status.lastOk) + '.' : ''}</p>` : ''}
    <div class="card">${videoTable}</div>
    <h2>Verlauf des Kanals</h2>
    <div class="card table-wrap"><table class="split hist">
      <thead><tr><th>Tag</th><th>${p.followerWord}</th><th>Aufrufe</th><th>Likes</th><th>Kommentare</th><th>Videos</th></tr></thead>
      <tbody>${histRows}</tbody></table></div>
    <p class="hint">${a.platform === 'tiktok' ? 'Die TikTok-Zahlen kommen von deiner öffentlichen TikTok-Seite – alle Videos, auch neue, werden automatisch gefunden. ' : ''}Wie viele ${p.followerWord} ein einzelnes Video gebracht hat, zeigt nur die App der Plattform (z. B. YouTube Studio). Hier siehst du dafür, wie sie sich von Tag zu Tag ändern.</p>`;


  const sel = $('#video-sort');
  if (sel) {
    sel.value = detailUi.sort;
    sel.onchange = e => {
      detailUi.sort = e.target.value;
      try { localStorage.setItem(STORAGE_KEY + '-detail', JSON.stringify(detailUi)); } catch {}
      render();
    };
  }
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

/* ---------- Einstellungen ---------- */
const dlgS = $('#dlg-settings'), formS = $('#form-settings');
function openSettings() {
  formS.elements.currency.value = state.settings.currency;
  $('#rpm-fields').innerHTML = Object.entries(PLATFORMS).map(([k, p]) =>
    `<label>${p.label}<input name="rpm_${k}" type="number" min="0" step="0.01" value="${state.settings.rpm[k] ?? 0}"></label>`).join('');
  dlgS.showModal();
}
formS.addEventListener('submit', e => {
  if (e.submitter && e.submitter.value !== 'save') return;
  const mine = { currency: formS.elements.currency.value.trim() || '€',
    rpm: Object.fromEntries(Object.keys(PLATFORMS).map(k => [k, Number(formS.elements['rpm_' + k].value) || 0])) };
  try { localStorage.setItem(STORAGE_KEY + '-settings', JSON.stringify(mine)); } catch {}
  state.settings.currency = mine.currency;
  Object.assign(state.settings.rpm, mine.rpm);
  render();
});
$('#btn-settings-cancel').onclick = () => dlgS.close();
$('#btn-logout').onclick = () => {
  if (confirm('Schlüssel auf diesem Gerät löschen? Danach brauchst du wieder deinen persönlichen Link.')) {
    try { localStorage.removeItem(STORAGE_KEY + '-key'); } catch {}
    location.replace(location.pathname);
  }
};

/* ---------- Aktualisieren ----------
   Die Zahlen holt der GitHub-Bot (track.py, alle 30 Minuten).
   Die Seite schaut jede Minute nach, ob es eine neue data.json gibt. */
function showStatus(cls, text) {
  const st = $('#sync-status');
  st.hidden = false;
  st.className = 'status ' + cls;
  st.textContent = text;
  clearTimeout(showStatus.t);
  if (cls === 'ok') showStatus.t = setTimeout(renderTrackStatus, 4000);
}
const hm = iso => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
function renderTrackStatus() {
  const st = $('#sync-status');
  if (!state.trackedAt || pendingSaves) return;
  const age = (Date.now() - Date.parse(state.trackedAt)) / 60000;
  const errs = state.accounts.filter(a => a.status?.error).map(a => `${a.name} (${plat(a).label}): ${a.status.error}`);
  st.hidden = false;
  st.className = 'status ' + (age > 120 || errs.length ? 'bad' : 'ok');
  st.textContent = `Automatisch aktualisiert ${ago(state.trackedAt)} (${hm(state.trackedAt)}) · nächstes Update ca. ${hm(Date.parse(state.trackedAt) + 20 * 60000)}`
    + (age > 120 ? ' · ⚠ Der Bot läuft seit über 2 Stunden nicht – auf GitHub unter „Actions“ nachsehen.' : '')
    + (errs.length ? ' · ⚠ ' + errs.join(' · ') : '');
}

async function refresh(manual = false) {
  if (!privKey || (document.hidden && !manual)) return;
  try {
    if (manual) showStatus('', 'Lade …');
    if (await loadData()) render(); else renderTrackStatus();
  } catch (err) { showStatus('bad', 'Laden fehlgeschlagen: ' + err.message); }
}

/* ---------- Backup ---------- */
$('#btn-export').onclick = () => {
  const copy = state;
  const blob = new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kanal-dashboard-backup-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
/* ---------- Ereignisse ---------- */
const metricOptions = CHART_METRICS.map(m => `<option value="${m.key}">${m.label}</option>`).join('');
$('#compare-metric').innerHTML = metricOptions;
$('#growth-metric').innerHTML = metricOptions;
$('#compare-metric').value = ui.compare;
$('#growth-metric').value = ui.growth;
$('#compare-metric').onchange = e => { ui.compare = e.target.value; render(); };
$('#growth-metric').onchange = e => { ui.growth = e.target.value; render(); };
$('#all-video-sort').onchange = e => { allVidUi.sort = e.target.value; renderAllVideos(filtered()); };

document.addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (chip) { ui[chip.dataset.group] = chip.dataset.val; render(); return; }
  if (e.target.closest('#btn-settings')) openSettings();
  if (e.target.closest('#btn-sync')) refresh(true);
  if (e.target.closest('#btn-all-videos')) { allVidUi.open = !allVidUi.open; renderAllVideos(filtered()); return; }
  const tick = e.target.closest('[data-tick]');
  if (tick) {
    if (tick.dataset.tick === 'list') { ticker.open = !ticker.open; render(); return; }
    const n = ticker.list.length;
    ticker.i = (ticker.i + Number(tick.dataset.tick) + n) % n;
    showTick();
    startTicker(); // Timer neu starten, damit der Kommentar volle Zeit bleibt
  }
});

/* ---------- Start: Schlüssel aus dem persönlichen Link ---------- */
function showLock(msg) {
  $('#login').hidden = false;
  $('#app').hidden = true;
  $('#login-msg').textContent = msg || '';
}

(async () => {
  let d = (location.hash.match(/[#&]k=([\w-]{43})/) || [])[1];
  if (d) {
    try { localStorage.setItem(STORAGE_KEY + '-key', d); } catch {}
    history.replaceState(null, '', location.pathname); // Schlüssel aus der Adresszeile entfernen
  } else {
    try { d = localStorage.getItem(STORAGE_KEY + '-key'); } catch {}
  }
  if (!d) return showLock();
  try {
    privKey = await importKey(d);
    await loadData(true);
  } catch (err) {
    console.error(err);
    return showLock('⚠ Dieser Link passt nicht (oder die Daten sind noch nicht da). Öffne deinen persönlichen Link nochmal.');
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  render();
  setInterval(refresh, 2 * 60 * 1000); // alle 2 Minuten nachsehen, ob der Bot neue Zahlen hat
  document.addEventListener('visibilitychange', () => refresh());
})();
