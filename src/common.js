/*! Navestigio © 2026 Oscar Stiven Garay Acosta · Licencia MIT (ver LICENSE) */
"use strict";
/* Código compartido entre la página y el Worker de SQLite: fechas, reglas de alerta y línea de tiempo.
   En la página se ejecuta como un <script> normal; en el Worker se antepone al código de sql.js. */
let RULES = [], RULES_VER = 0;
const qi = n => '"' + String(n).replace(/"/g, '""') + '"';
const RANGES = [["webkit",1.26e16,1.6e16,false],["unix_us",9.4e14,4.2e15,true],["unix_ms",9.4e11,4.2e12,true],["unix_s",9.4e8,4.2e9,true],["mac_s",1.0e8,9.4e8,true]];
function toMs(v, kind) { // devuelve milisegundos Unix (Number) o null
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") { const t = v.trim(); if (/^-?\d+$/.test(t)) v = BigInt(t); else if (/^-?\d+\.\d*$/.test(t)) v = Number(t); else return NaN; }
  if (typeof v !== "bigint" && typeof v !== "number") return NaN;
  if (v == 0) return null;
  const big = typeof v === "bigint";
  switch (kind) {
    case "webkit": return big ? Number(v / 1000n - 11644473600000n) : v / 1000 - 11644473600000;
    case "unix_us": return big ? Number(v / 1000n) : v / 1000;
    case "unix_ms": return Number(v);
    case "unix_s": return Number(v) * 1000;
    case "mac_s": return Number(v) * 1000 + 978307200000;
  }
  return NaN;
}
function classify(n, hinted) { for (const [k, lo, hi, need] of RANGES) if (n >= lo && n <= hi && (hinted || !need)) return k; return null; }
/* Desfase en minutos respecto a UTC en un instante dado. Un número es un desfase fijo (GMT-5); un texto es una zona IANA
   (America/Bogota, Europe/Madrid) y aplica el horario de verano vigente en ese instante. Se cachea por bloques de 15 min. */
const _tzFmt = new Map(), _tzOff = new Map();
function tzOffMin(tz, ms) {
  if (typeof tz === "number") return tz * 60;
  const b = Math.floor(ms / 900000), key = tz + "|" + b; let o = _tzOff.get(key); if (o !== undefined) return o;
  let f = _tzFmt.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", {timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"}); _tzFmt.set(tz, f); }
  const t = b * 900000, p = {}; for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  const u = new Date(0); u.setUTCFullYear(Number(p.year), Number(p.month) - 1, Number(p.day)); u.setUTCHours(Number(p.hour) % 24, Number(p.minute), Number(p.second), 0);
  o = Math.round((u.getTime() - t) / 60000);
  if (_tzOff.size > 200000) _tzOff.clear(); _tzOff.set(key, o); return o;
}
const TRANSITION = `CASE (v.transition & 255) WHEN 0 THEN 'LINK' WHEN 1 THEN 'TYPED' WHEN 2 THEN 'AUTO_BOOKMARK' WHEN 3 THEN 'AUTO_SUBFRAME' WHEN 4 THEN 'MANUAL_SUBFRAME' WHEN 5 THEN 'GENERATED' WHEN 6 THEN 'AUTO_TOPLEVEL' WHEN 7 THEN 'FORM_SUBMIT' WHEN 8 THEN 'RELOAD' WHEN 9 THEN 'KEYWORD' WHEN 10 THEN 'KEYWORD_GENERATED' ELSE (v.transition & 255) END`;
const WB = "[\\p{L}\\p{N}]";
function kwPattern(k) {
  const prefix = k.endsWith("*"); if (prefix) k = k.slice(0, -1);
  const e = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (k.startsWith(".")) return `${e}(?!${WB})`;
  if (k.includes(".") && !/\s/.test(k)) return `(?<![\\p{L}\\p{N}-])${e}(?![\\p{L}\\p{N}-])`;
  return `(?<!${WB})${e}${prefix ? "" : `(?!${WB})`}`;
}
function kwRe(kws) { return new RegExp(kws.map(kwPattern).join("|"), "u"); }
const BLOB = /[A-Za-z0-9+\/=_-]{40,}/g;
function pctDecode(x) { if (!x.includes("%")) return x;
  try { return decodeURIComponent(x); } catch (e) { return x.replace(/(%[0-9a-f]{2})+/gi, m => { try { return decodeURIComponent(m); } catch (e2) { return m; } }); } }
function matchText(raw) {
  let x = pctDecode(pctDecode(String(raw)));
  x = x.replace(BLOB, m => { const up = (m.match(/[A-Z]/g) || []).length, dg = (m.match(/[0-9]/g) || []).length, lo = (m.match(/[a-z]/g) || []).length;
    return up >= 3 && lo >= 3 && dg >= 2 || /^[0-9a-f]{40,}$/i.test(m) ? " " : m; });
  return x.replace(/\+/g, " ").toLowerCase();
}
function matchedTerm(rule, txt) { const i = rule.res.findIndex(r => r.test(txt)); return i >= 0 ? rule.kws[i] : null; }
function parseRules(text) {
  return text.split(/\r?\n/).map(l => { const i = l.indexOf(":"); if (i < 1) return null;
    const kws = l.slice(i + 1).split(",").map(k => k.trim().toLowerCase()).filter(Boolean);
    return kws.length ? {name: l.slice(0, i).trim(), kws, re: kwRe(kws), res: kws.map(k => kwRe([k]))} : null; }).filter(Boolean);
}
const _reCache = new Map();
function rulesRe(cat) { // una sola expresión por categoría (o todas): mucho más rápido que un LIKE por palabra
  const key = RULES_VER + "|" + (cat || ""); if (_reCache.has(key)) return _reCache.get(key);
  const rs = cat ? RULES.filter(r => r.name === cat) : RULES, kws = rs.flatMap(r => r.kws), re = kws.length ? kwRe(kws) : null;
  _reCache.set(key, re); return re;
}
const DANGER = "Descarga peligrosa";
function rowText(row) { return matchText(row.map(v => v instanceof Uint8Array ? "" : cellText(v, true)).join(" ")); }
function tagTerms(row) { const txt = rowText(row), o = {}; for (const r of RULES) { const k = matchedTerm(r, txt); if (k) o[r.name] = k; } return o; }
function tagRow(row, cols) {
  const txt = rowText(row), tags = RULES.filter(r => r.re.test(txt)).map(r => r.name);
  const di = cols.indexOf("danger_type");
  if (di >= 0 && row[di] != null && row[di] != 0) tags.push(DANGER);
  return tags;
}
function alertCond(cols, cat) {
  const conds = [], params = [];
  if (cat !== DANGER && rulesRe(cat)) {
    const txt = cols.map(c => `(CASE WHEN typeof(${qi(c)})='blob' THEN '' ELSE coalesce(CAST(${qi(c)} AS TEXT),'') END)`).join("||' '||");
    conds.push(`vt_alert(${txt}, ?)`); params.push(cat || "");
  }
  if (cols.includes("danger_type") && (!cat || cat === DANGER)) conds.push(`(danger_type IS NOT NULL AND danger_type != 0)`);
  return conds.length ? ["(" + conds.join(" OR ") + ")", params] : ["0", []];
}
const EXTRACT = [
  [["visits","urls"], `SELECT v.visit_time, 'webkit', 'Visita', u.url, u.title, ${TRANSITION}, 'visits' FROM visits v LEFT JOIN urls u ON u.id = v.url`],
  [["downloads"], `SELECT start_time, 'webkit', 'Descarga iniciada', tab_url, target_path, 'bytes: ' || total_bytes, 'downloads' FROM downloads`],
  [["downloads"], `SELECT end_time, 'webkit', 'Descarga finalizada', tab_url, target_path, 'bytes: ' || received_bytes || ' de ' || total_bytes, 'downloads' FROM downloads`],
  [["keyword_search_terms","urls"], `SELECT u.last_visit_time, 'webkit', 'Búsqueda', u.url, k.term, '', 'keyword_search_terms' FROM keyword_search_terms k JOIN urls u ON u.id = k.url_id`],
  [["logins"], `SELECT date_created, 'webkit', 'Credencial guardada', origin_url, username_value, '', 'logins' FROM logins`],
  [["logins"], `SELECT date_last_used, 'webkit', 'Credencial usada', origin_url, username_value, 'veces usada: ' || times_used, 'logins' FROM logins`],
  [["logins"], `SELECT date_password_modified, 'webkit', 'Contraseña modificada', origin_url, username_value, '', 'logins' FROM logins`],
  [["autofill"], `SELECT date_created, 'unix_s', 'Autocompletar (primer uso)', '', name, value, 'autofill' FROM autofill`],
  [["autofill"], `SELECT date_last_used, 'unix_s', 'Autocompletar (último uso)', '', name, value || ' · usos: ' || count, 'autofill' FROM autofill`],
  [["cookies"], `SELECT creation_utc, 'webkit', 'Cookie creada', host_key, name, '', 'cookies' FROM cookies`],
  [["cookies"], `SELECT last_access_utc, 'webkit', 'Cookie usada', host_key, name, '', 'cookies' FROM cookies`],
  [["omni_box_shortcuts"], `SELECT last_access_time, 'webkit', 'Atajo de la barra de direcciones', url, text, contents, 'omni_box_shortcuts' FROM omni_box_shortcuts`],
  [["icon_mapping","favicons","favicon_bitmaps"], `SELECT b.last_updated, 'webkit', 'Favicon descargado', m.page_url, f.url, '', 'favicon_bitmaps' FROM icon_mapping m JOIN favicons f ON f.id = m.icon_id JOIN favicon_bitmaps b ON b.icon_id = f.id`],
  [["collections","items","collections_items_relationship"], `SELECT i.date_created, 'auto', 'Elemento agregado a colección (Edge)', CAST(i.source AS TEXT), i.title, c.title, 'items' FROM items i LEFT JOIN collections_items_relationship r ON r.item_id = i.id LEFT JOIN collections c ON c.id = r.parent_id`],
  [["marcadores"], `SELECT date_added, 'webkit', 'Marcador agregado', url, nombre, carpeta, 'marcadores' FROM marcadores`],
  [["marcadores"], `SELECT date_last_used, 'webkit', 'Marcador usado', url, nombre, carpeta, 'marcadores' FROM marcadores`],
  [["extensiones"], `SELECT install_time, 'webkit', 'Extensión instalada', '', nombre, id, 'extensiones' FROM extensiones`],
  [["perfiles"], `SELECT active_time, 'unix_s', 'Perfil usado por última vez', email, nombre, carpeta, 'perfiles' FROM perfiles`],
  [["moz_historyvisits","moz_places"], `SELECT v.visit_date, 'unix_us', 'Visita (Firefox)', p.url, p.title, v.visit_type, 'moz_historyvisits' FROM moz_historyvisits v LEFT JOIN moz_places p ON p.id = v.place_id`],
];
function toWebkit(v, kind) {
  if (v === null || v === undefined || v === "" || v == 0) return null;
  if (kind === "auto") { kind = classify(Number(v), true); if (!kind) return null; }
  if (kind === "webkit") { try { return BigInt(typeof v === "number" ? Math.round(v) : v); } catch (e) { return null; } }
  const ms = toMs(v, kind); if (ms === null || !isFinite(ms)) return null;
  return BigInt(Math.round(ms)) * 1000n + 11644473600000000n;
}
const bindVal = v => typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? cellText(v, true) : (v === undefined ? null : v);
const EV_URL = 3;
function newAlertStats() { return {ver: RULES_VER, n: 0, cats: new Map()}; }
function addAlertStats(stats, row) {
  const tags = tagRow(row, EV_COLS); if (!tags.length) return;
  stats.n++; const u = row[EV_URL], h = hostOf(u) || (u ? String(u).slice(0, 60) : "(sin URL)");
  for (const tg of tags) { let c = stats.cats.get(tg); if (!c) stats.cats.set(tg, c = {n: 0, hosts: new Map()}); c.n++; c.hosts.set(h, (c.hosts.get(h) || 0) + 1); }
}
const EV_COLS = ["momento", "tipo", "artefacto", "url", "titulo", "detalle", "tabla_origen"];
function hostOf(u) { const m = /^[a-z]+:\/\/([^\/?#:]+)/i.exec(u || ""); return m ? m[1].replace(/^www\./, "") : null; }
function cellText(v, full) {
  if (v instanceof Uint8Array) {
    const hex = [...(full ? v : v.subarray(0, 32))].map(b => b.toString(16).padStart(2, "0")).join("");
    return full ? hex : `<BLOB ${v.length} bytes> ${hex}${v.length > 32 ? "…" : ""}`;
  }
  if (v === null || v === undefined) return "";
  return String(v);
}

/* ---------------- Interpretación de URLs y cookies ----------------
   Reimplementación propia de ideas comunes en DFIR (búsquedas en la URL, cookies de Google Analytics, BIG-IP).
   Solo describe lo que contiene el valor; no afirma qué hizo el usuario. Fechas en UTC para que no dependan de la zona elegida. */
const SEARCH_ENGINES = [
  [/(^|\.)google\.[a-z.]+$/, ["/search", "/webhp", "/"], ["q"], "Google"], [/(^|\.)bing\.com$/, ["/search"], ["q"], "Bing"],
  [/(^|\.)duckduckgo\.com$/, ["/"], ["q"], "DuckDuckGo"], [/(^|\.)search\.yahoo\.com$/, ["/search"], ["p"], "Yahoo"],
  [/(^|\.)youtube\.com$/, ["/results"], ["search_query"], "YouTube"], [/(^|\.)yandex\.[a-z.]+$/, ["/search"], ["text"], "Yandex"],
  [/(^|\.)baidu\.com$/, ["/s"], ["wd", "word"], "Baidu"], [/(^|\.)ecosia\.org$/, ["/search"], ["q"], "Ecosia"],
  [/(^|\.)search\.brave\.com$/, ["/search"], ["q"], "Brave"], [/(^|\.)amazon\.[a-z.]+$/, ["/s"], ["k"], "Amazon"],
  [/(^|\.)facebook\.com$/, ["/search"], ["q"], "Facebook"], [/(^|\.)(x|twitter)\.com$/, ["/search"], ["q"], "X/Twitter"],
  [/(^|\.)wikipedia\.org$/, ["/w/index.php", "/wiki/Especial:Buscar", "/wiki/Special:Search"], ["search"], "Wikipedia"],
  [/(^|\.)mercadolibre\.[a-z.]+$/, ["/"], ["as_word"], "Mercado Libre"]];
const NOISE_PARAM = /^(utm_|gclid$|fbclid$|msclkid$|ei$|ved$|sxsrf$|oq$|aqs$|sourceid$|ie$|oe$|gs_|sca_|iflsig$|uact$|client$|rlz$|bih$|biw$|dpr$|sa$|source$|sclient$|form$|pc$|cvid$)/i;
const cut = (v, n) => v.length > n ? v.slice(0, n) + "…" : v;
function interpretUrl(u) {
  if (typeof u !== "string" || !/^https?:\/\//i.test(u)) return "";
  let url; try { url = new URL(u); } catch (e) { return ""; }
  const host = url.hostname.toLowerCase(), q = url.searchParams, out = [];
  // Google pone a veces la búsqueda en el fragmento (#q=)
  const frag = url.hash.length > 1 ? new URLSearchParams(url.hash.slice(1)) : null;
  for (const [re, paths, keys, name] of SEARCH_ENGINES) {
    if (!re.test(host) || !paths.some(p => p === "/" ? true : url.pathname.startsWith(p))) continue;
    for (const k of keys) { const v = q.get(k) || (frag && frag.get(k)); if (v && v.trim()) { out.push(`Búsqueda en ${name}: «${cut(v.trim(), 200)}»`); break; } }
    if (out.length) break;
  }
  const camp = ["utm_source", "utm_medium", "utm_campaign", "utm_term"].map(k => [k.slice(4), q.get(k)]).filter(([, v]) => v);
  if (camp.length) out.push("Campaña: " + camp.map(([k, v]) => `${k}=${cut(v, 60)}`).join(", "));
  if (!out.length) { const ps = [...q].filter(([k, v]) => v && !NOISE_PARAM.test(k)).slice(0, 6).map(([k, v]) => `${cut(k, 30)}=${cut(v, 80)}`);
    if (ps.length) out.push("Parámetros: " + ps.join(" · ")); }
  return out.join(" · ");
}
function utcTxt(sec) { const n = Number(sec); if (!isFinite(n) || n < 946684800 || n > 2524608000) return null; return new Date(n * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC"; }
function interpretCookie(name, value) {
  const n = String(name || ""), v = String(value || ""); if (!v) return "";
  let m;
  if (n === "_ga" && (m = /^GA\d\.\d+\.(\d+)\.(\d{10})$/.exec(v))) return `Google Analytics: id de visitante ${m[1]}.${m[2]}; primera visita ${utcTxt(m[2]) || m[2]}`;
  if (/^_ga_/.test(n)) {
    if ((m = /^GS2\.\d+\.(.*)$/.exec(v))) { const f = Object.fromEntries(m[1].split("$").map(x => [x[0], x.slice(1)]));
      return `Google Analytics 4: sesión iniciada ${utcTxt(f.s) || f.s}; sesión n.º ${f.o}; última actividad ${utcTxt(f.t) || f.t}`; }
    if ((m = /^GS1\.\d+\.(\d{10})\.(\d+)\.\d+\.(\d{10})/.exec(v))) return `Google Analytics 4: sesión iniciada ${utcTxt(m[1])}; sesión n.º ${m[2]}; última actividad ${utcTxt(m[3])}`;
  }
  if (n === "__utma" && (m = /^\d+\.(\d+)\.(\d{10})\.(\d{10})\.(\d{10})\.(\d+)$/.exec(v)))
    return `Google Analytics (clásico): visitante ${m[1]}; primera visita ${utcTxt(m[2])}; visita anterior ${utcTxt(m[3])}; visita actual ${utcTxt(m[4])}; ${m[5]} sesiones`;
  if (n === "__utmb" && (m = /^\d+\.(\d+)\.\d+\.(\d{10})$/.exec(v))) return `Google Analytics (clásico): ${m[1]} páginas vistas en la sesión iniciada ${utcTxt(m[2])}`;
  if (n === "__utmz" && (m = /^\d+\.(\d{10})\.\d+\.\d+\.(.*)$/.exec(v))) {
    const f = Object.fromEntries(m[2].split("|").map(x => x.split("=")).filter(x => x.length === 2));
    return `Google Analytics (clásico): llegó el ${utcTxt(m[1])} desde ${f.utmcsr || "?"} (medio ${f.utmcmd || "?"}${f.utmctr ? `, término «${cut(pctDecode(f.utmctr), 100)}»` : ""})`;
  }
  if (/^BIGipServer/i.test(n) && (m = /^(\d+)\.(\d+)\.\d+$/.exec(v))) {
    const ip = Number(m[1]), p = Number(m[2]);
    return `Balanceador F5 BIG-IP: servidor interno ${[ip & 255, ip >>> 8 & 255, ip >>> 16 & 255, ip >>> 24 & 255].join(".")}:${((p & 255) << 8) | (p >>> 8)}`;
  }
  if (n === "__qca" && (m = /^P\d-\d+-(\d{10})/.exec(v))) return `Quantcast: primera visita ${utcTxt(m[1])}`;
  if ((m = /(?:^|\D)(1[0-9]{9})(?:\D|$)/.exec(v)) && utcTxt(m[1])) return `Contiene una fecha Unix: ${utcTxt(m[1])}`;
  return "";
}
