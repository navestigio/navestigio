/*! Navestigio © 2026 Oscar Stiven Garay Acosta · Licencia MIT (ver LICENSE) */
"use strict";
const PAGE_SRC = "<!doctype html>\n" + document.documentElement.outerHTML;
const WASM_B64 = "@@WASM_B64@@";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const S = {dbs: [], db: null, src: null, offset: 0, sort: null, desc: false, data: null};
/* ---------------- Motor SQLite en un Web Worker ----------------
   Todas las consultas corren fuera del hilo de la página. Si una tarda más de un segundo aparece «Cancelar»:
   se termina el Worker, se crea uno nuevo, se reabren las evidencias (desde los archivos originales) y la
   página sigue respondiendo. Así una base malformada o una vista maliciosa no pueden colgar la herramienta. */
let BUSY_EXT = false;
function showBusy(msg) { document.body.classList.add("busy"); $("busyMsg").textContent = msg; }
function hideBusy() { document.body.classList.remove("busy"); $("busy").classList.remove("cancelable"); }
const DB = (() => {
  let w = null, url = null, seq = 0, slowT = null, restarting = false; const pend = new Map();
  const api = {slow: false};
  function spawn() {
    if (!url) url = URL.createObjectURL(new Blob([$("vt-sqljs").textContent, "\n;(function () {\n", $("vt-common").textContent, "\n", $("vt-worker").textContent, "\n})();\n"], {type: "text/javascript"}));
    w = new Worker(url);
    w.onmessage = e => { const m = e.data, p = pend.get(m.rid); if (!p) return; pend.delete(m.rid); settle(); m.ok ? p.res(m.r) : p.rej(new Error(m.e)); };
    w.onerror = e => { e.preventDefault(); const ps = [...pend.values()]; pend.clear(); settle(); for (const p of ps) p.rej(new Error("El motor SQLite se detuvo: " + (e.message || "error"))); };
  }
  function settle() {
    if (pend.size) return; clearTimeout(slowT); slowT = null;
    if (api.slow) { api.slow = false; $("busy").classList.remove("cancelable"); if (!BUSY_EXT) hideBusy(); }
  }
  // quiet: tareas de fondo (conteo de alertas) que no muestran el aviso; si otra consulta queda detrás, esa sí lo muestra
  api.call = (op, args, transfer, quiet) => new Promise((res, rej) => {
    const rid = ++seq; pend.set(rid, {res, rej});
    if (!quiet && !slowT && !api.slow && !restarting) slowT = setTimeout(() => { slowT = null; if (!pend.size) return; api.slow = true;
      if (!BUSY_EXT) showBusy("Consultando la evidencia…"); $("busy").classList.add("cancelable"); }, 1000);
    w.postMessage({rid, op, args}, transfer || []);
  });
  api.start = async () => {
    spawn();
    const wasm = Uint8Array.from(atob(WASM_B64), c => c.charCodeAt(0));
    await api.call("init", {wasm}, [wasm.buffer]);
    await api.call("rules", {text: RULES_TEXT, ver: RULES_VER});
  };
  api.cancel = async () => {
    if (restarting) return; restarting = true;
    w.terminate(); clearTimeout(slowT); slowT = null; api.slow = false;
    const ps = [...pend.values()]; pend.clear();
    for (const p of ps) { const e = new Error("Consulta cancelada"); e.cancelled = true; p.rej(e); }
    BUSY_EXT = true; $("busy").classList.remove("cancelable"); showBusy("Consulta cancelada. Reiniciando el motor SQLite y reabriendo las evidencias…");
    try {
      await api.start();
      for (const d of realDbs()) {
        const bytes = await d.reopen();
        if (d.json) await api.call("json", {id: d.id, name: d.label, bytes}, [bytes.buffer]);
        else await api.call("open", {id: d.id, bytes}, [bytes.buffer]);
      }
      await api.call("create", {id: "caso", sql: CASE_SCHEMA});
      for (const d of S.dbs) if (d.countCache) d.countCache.clear();
      restarting = false;
      await rebuildCase();
      toast("Consulta cancelada. Las evidencias siguen abiertas.");
    } catch (e) { toast("No se pudo reiniciar el motor SQLite: " + (e.message || e) + ". Recargue la página."); }
    finally { restarting = false; BUSY_EXT = false; hideBusy(); }
    $("summary").dataset.key = ""; pick("caso", "s:resumen");
  };
  return api;
})();
const qAll = (id, sql, params) => DB.call("all", {id, sql, params});
const qCols = (id, sql) => DB.call("cols", {id, sql});
const rethrowCancel = e => { if (e && e.cancelled) throw e; };
window.addEventListener("unhandledrejection", e => { if (e.reason && e.reason.cancelled) e.preventDefault(); });
/* Columnas ocultas: por tabla/vista (se recuerdan en este navegador) */
const HID = (() => { try { return JSON.parse(localStorage.getItem("visor_hidden") || "{}"); } catch (e) { return {}; } })();
if (!("s:hallazgos" in HID)) HID["s:hallazgos"] = ["r:id", "r:momento", "r:marcado_el", "r:detalle"];
let HIDE_RAW = (() => { try { return localStorage.getItem("visor_hideraw") === "1"; } catch (e) { return false; } })();
const saveHid = () => { try { localStorage.setItem("visor_hidden", JSON.stringify(HID)); localStorage.setItem("visor_hideraw", HIDE_RAW ? "1" : "0"); } catch (e) {} };
const WID = (() => { try { return JSON.parse(localStorage.getItem("visor_widths") || "{}"); } catch (e) { return {}; } })();
let WRAP = (() => { try { return localStorage.getItem("visor_wrap") === "1"; } catch (e) { return false; } })();
const saveWid = () => { try { localStorage.setItem("visor_widths", JSON.stringify(WID)); localStorage.setItem("visor_wrap", WRAP ? "1" : "0"); } catch (e) {} };
function applyWidths() {
  let st = $("colw"); if (!st) { st = document.createElement("style"); st.id = "colw"; document.head.appendChild(st); }
  const w = WID[S.src] || {};
  const aw = S.showAl && w.__alertas;
  st.textContent = (aw ? `#grid th.al,#grid td.al{width:${aw}px;min-width:${aw}px;max-width:${aw}px;white-space:normal}#grid td.al .chip{white-space:normal;overflow-wrap:break-word;max-width:100%;margin-bottom:3px}\n` : "") + (S.colOrder || []).map((k, i) => w[k] ? `#grid th:nth-child(${i + 1 + S.colOffset}),#grid td:nth-child(${i + 1 + S.colOffset}){width:${w[k]}px;min-width:${w[k]}px;max-width:${w[k]}px;white-space:normal;overflow-wrap:anywhere}` : "").join("\n");
  document.body.classList.toggle("wrap", WRAP);
}
const colKey = c => (c.conv ? "c:" : "r:") + c.src;
function hiddenSet() { return new Set(HID[S.src] || []); }
function isHidden(c, hs) { return hs.has(colKey(c)) || (HIDE_RAW && c.kind && !c.conv); }
function visibleIdx() { const hs = hiddenSet(); return S.data.columns.map((c, i) => isHidden(c, hs) ? -1 : i).filter(i => i >= 0); }
function setHidden(key, hide) { const hs = hiddenSet(); hide ? hs.add(key) : hs.delete(key); if (hs.size) HID[S.src] = [...hs]; else delete HID[S.src]; saveHid(); }

/* ---------------- Fechas ---------------- */
const EPOCHS = {
  webkit: "WebKit/Chrome (µs desde 1601-01-01)",
  unix_s: "Unix (segundos desde 1970)",
  unix_ms: "Unix (milisegundos)",
  unix_us: "Unix (µs) / PRTime Firefox",
  mac_s: "Mac/Cocoa (segundos desde 2001, Safari)",
};
const NAME_HINT = /(time|date|_utc|utc_|created|modified|expir|last_|accessed|visited|_used|timestamp|_at$|^at_|when|since|until)/i;
const NAME_EXCLUDE = /(duration|count|times_|size|bytes|_id$|^id$|length|offset|version)/i;

const p2 = n => String(n).padStart(2, "0");
function fmt(v, kind, tz) {
  const ms = toMs(v, kind);
  if (ms === null) return "";
  if (!isFinite(ms) || Math.abs(ms) > 8.64e15) return "¿?";
  const d = new Date(ms + tzOffMin(tz, ms) * 60000);
  if (isNaN(d)) return "¿?";
  return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth()+1)}/${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}
function tzLabel(tz) { if (typeof tz === "string") return tz; if (tz == 0) return "UTC"; const h = Math.abs(tz); const s = Number.isInteger(h) ? String(h) : `${Math.floor(h)}:${p2(Math.round((h%1)*60))}`; return "GMT" + (tz > 0 ? "+" : "-") + s; }
function detectKind(name, samples) {
  if (NAME_EXCLUDE.test(name)) return null;
  const hinted = NAME_HINT.test(name);
  const nums = [];
  for (const s of samples) {
    if (typeof s === "bigint" || typeof s === "number") nums.push(Number(s));
    else if (typeof s === "string" && /^-?\d+(\.\d+)?$/.test(s.trim())) nums.push(Number(s));
    else return null;
  }
  const nz = nums.filter(n => n !== 0);
  if (!nz.length) return null;
  const votes = new Map();
  for (const n of nz) { const k = classify(n, hinted); votes.set(k, (votes.get(k) || 0) + 1); }
  let best = null, cnt = 0; for (const [k, c] of votes) if (c > cnt) { best = k; cnt = c; }
  return best && cnt / nz.length >= 0.8 ? best : null;
}
function tz() { const v = $("tz").value; return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v; }

/* ---------------- Vistas predefinidas ---------------- */
const PRESETS = [
  ["hist_timeline", "Línea de tiempo de navegación (visits + urls)", ["visits","urls"],
   `SELECT v.id AS visit_id, v.visit_time, u.url, u.title, ${TRANSITION} AS tipo_transicion, u.visit_count, u.typed_count, v.from_visit, v.visit_duration AS visit_duration_us, vt_url(u.url) AS interpretacion FROM visits v LEFT JOIN urls u ON u.id = v.url ORDER BY v.visit_time DESC`],
  ["hist_downloads", "Descargas con cadena de redirecciones", ["downloads","downloads_url_chains"],
   `SELECT d.id, d.start_time, d.end_time, d.target_path, d.tab_url, d.referrer, (SELECT group_concat(c.url, '  ->  ') FROM (SELECT url FROM downloads_url_chains WHERE id = d.id ORDER BY chain_index) c) AS cadena_urls, d.mime_type, d.total_bytes, d.received_bytes, CASE d.state WHEN 0 THEN 'EN_CURSO' WHEN 1 THEN 'COMPLETA' WHEN 2 THEN 'CANCELADA' WHEN 3 THEN 'INTERRUMPIDA' WHEN 4 THEN 'INTERRUMPIDA' ELSE d.state END AS estado, d.danger_type, d.interrupt_reason, d.opened, d.last_access_time FROM downloads d ORDER BY d.start_time DESC`],
  ["hist_search", "Términos buscados", ["keyword_search_terms","urls"],
   `SELECT k.term, u.last_visit_time, u.url, u.title, u.visit_count, vt_url(u.url) AS interpretacion FROM keyword_search_terms k LEFT JOIN urls u ON u.id = k.url_id ORDER BY u.last_visit_time DESC`],
  ["login_logins", "Credenciales guardadas", ["logins"],
   `SELECT origin_url, action_url, username_value, date_created, date_last_used, date_password_modified, times_used, blacklisted_by_user, password_value FROM logins ORDER BY date_created DESC`],
  ["webdata_autofill", "Autocompletar de formularios", ["autofill"],
   `SELECT name, value, count, date_created, date_last_used FROM autofill ORDER BY date_last_used DESC`],
  ["cookies", "Cookies", ["cookies"],
   `SELECT host_key, name, path, creation_utc, last_access_utc, expires_utc, is_secure, is_httponly, value, CASE WHEN coalesce(value,'') = '' AND length(encrypted_value) > 0 THEN 'valor cifrado: no se descifra' ELSE vt_cookie(name, value) END AS interpretacion, encrypted_value FROM cookies ORDER BY last_access_utc DESC`],
  ["ff_history", "Firefox: historial (moz_historyvisits + moz_places)", ["moz_historyvisits","moz_places"],
   `SELECT v.id AS visit_id, v.visit_date, p.url, p.title, v.visit_type, p.visit_count, vt_url(p.url) AS interpretacion FROM moz_historyvisits v LEFT JOIN moz_places p ON p.id = v.place_id ORDER BY v.visit_date DESC`],
  ["ff_cookies", "Firefox: cookies", ["moz_cookies"],
   `SELECT host, name, path, creationTime, lastAccessed, expiry, isSecure, isHttpOnly, value, vt_cookie(name, value) AS interpretacion FROM moz_cookies ORDER BY lastAccessed DESC`],
];
PRESETS.push(
  ["shortcuts", "Atajos de la barra de direcciones", ["omni_box_shortcuts"],
   `SELECT text AS texto_tecleado, url, contents AS sugerencia, last_access_time, number_of_hits FROM omni_box_shortcuts ORDER BY last_access_time DESC`],
  ["topsites", "Sitios principales (Top Sites)", ["top_sites"], `SELECT url_rank, url, title FROM top_sites ORDER BY url_rank`],
  ["favicons", "Favicons por página visitada", ["icon_mapping","favicons","favicon_bitmaps"],
   `SELECT m.page_url, b.image_data AS icono, f.url AS favicon_url, b.last_updated, b.width FROM icon_mapping m JOIN favicons f ON f.id = m.icon_id LEFT JOIN favicon_bitmaps b ON b.icon_id = f.id ORDER BY b.last_updated DESC`],
  ["edge_collections", "Colecciones de Edge", ["collections","items","collections_items_relationship"],
   `SELECT c.title AS coleccion, i.title AS elemento, i.date_created, i.date_modified, CAST(i.source AS TEXT) AS origen FROM items i LEFT JOIN collections_items_relationship r ON r.item_id = i.id LEFT JOIN collections c ON c.id = r.parent_id ORDER BY i.date_created DESC`]);
const PRIORITY = new Set(["omni_box_shortcuts","top_sites","icon_mapping","favicon_bitmaps","collections","items","marcadores","cuentas","extensiones","perfiles","preferencias","estado","urls","downloads","visits","downloads_url_chains","logins","autofill","cookies","keyword_search_terms","moz_places","moz_historyvisits","credit_cards","autofill_profiles"]);

/* ---------------- Alertas ---------------- */
const DEFAULT_RULES = `Nube/transferencia: mega.nz, mega.io, wetransfer, we.tl, drive.google, dropbox, onedrive.live, 1drv.ms, box.com, mediafire, sendspace, gofile, pcloud, icloud.com, transfer.sh, file.io, anonfiles, filemail
Correo personal: mail.google, gmail.com, outlook.live, hotmail, mail.yahoo, protonmail, proton.me, tutanota
Antiforense/evasión: borrar historial, eliminar historial, borrar cookies, incognito, incógnito, ccleaner, bleachbit, eraser, wipe, shred, vpn, nordvpn, expressvpn, protonvpn, tor browser, torproject, ocultar ip
Herramientas de ataque: mimikatz, keylogger, lazagne, nirsoft, metasploit, exploit, payload, keygen, crack
Pegado de texto: pastebin, paste.ee, ghostbin, hastebin, privatebin, controlc
Mensajería web: web.whatsapp, web.telegram, discord.com
Ejecutable/comprimido: .exe, .msi, .bat, .ps1, .vbs, .scr, .hta, .dll, .iso, .zip, .rar, .7z
Malware/spyware/adware: malware, spyware, adware, ransomware, troyano, trojan, infostealer, stealer, botnet, cryptominer, xmrig, njrat, remcos, asyncrat, darkcomet, redline stealer, kmspico, kmsauto, kms auto, activador windows, hacktool, warez, serial gratis, crack gratis
Material ilegal: .onion, darknet, dark web, deep web, thepiratebay.org, 1337x.to, rarbg, yts.mx, cuevana, pelisplus, descargar pelicula gratis, comprar drogas, venta de drogas, venta de armas, comprar armas, carding, fullz, cvv gratis, documentos falsos, billetes falsos, lavado de dinero
Contenido sexual: pornhub.com, xvideos.com, xnxx.com, xhamster.com, redtube.com, youporn.com, onlyfans.com, chaturbate.com, stripchat.com, brazzers.com, camsoda.com, spankbang.com, eporner.com, porn, porno, pornografía, pornografia, xxx, nsfw, escorts, desnudas, desnudos, videos para adultos, contenido para adultos, sexo explícito, sexo explicito
Discriminatorio/difamatorio: supremacista*, supremacía blanca, supremacia blanca, white power, white supremacy, neonazi*, kkk, ku klux klan, odio racial, discurso de odio, homofob*, xenofob*, misógin*, racista*, difamación, calumnia`;
/* Criterio de coincidencia:
   - palabra o frase: palabra completa ("porn" no coincide con "pornhub" ni con letras dentro de un código);
   - termina en *: prefijo de palabra ("homofob*" = homofobia, homofóbico…);
   - empieza con punto (.exe, .onion): extensión o dominio de primer nivel;
   - contiene un punto (pornhub.com, drive.google): dominio, incluye subdominios.
   El texto se prepara con matchText: se decodifica %XX y se descartan los bloques codificados largos
   (tokens SAML, base64, identificadores) donde las letras forman palabras por casualidad. */
const OLD_DEFAULT_LINES = new Set(["Malware/spyware/adware: malware, spyware, adware, ransomware, troyano, trojan, stealer, botnet, cryptominer, xmrig, njrat, remcos, asyncrat, darkcomet, kmspico, kms auto, activador windows, hacktool, warez, serial gratis, virus gratis", "Material ilegal: .onion, darknet, dark web, deep web, thepiratebay, 1337x, rarbg, yts.mx, cuevana, pelisplus, descargar pelicula gratis, comprar drogas, venta de armas, carding, fullz, cvv gratis, documentos falsos, billetes falsos, lavado de dinero", "Contenido sexual: porn, xxx, pornhub, xvideos, xnxx, xhamster, redtube, youporn, onlyfans, chaturbate, stripchat, brazzers, camsoda, nsfw, escort, desnudos, videos para adultos, contenido para adultos", "Discriminatorio/difamatorio: supremacia, supremacía, neonazi, white power, kkk, odio racial, homofob, xenofob, racista, misógin, discurso de odio, difamación, calumnia", "Antiforense/evasión: borrar historial, eliminar historial, borrar cookies, incognito, incógnito, ccleaner, bleachbit, eraser, wipe, shred, vpn, tor browser, torproject, ocultar ip"]);
let RULES_TEXT = (() => { try {
  let t = localStorage.getItem("visor_rules"); if (!t) return DEFAULT_RULES;
  if (localStorage.getItem("visor_rules_v") !== "3") { // actualiza reglas guardadas: agrega categorías nuevas y reemplaza las predeterminadas antiguas no editadas
    const defs = new Map(DEFAULT_RULES.split("\n").map(l => [l.slice(0, l.indexOf(":")).trim(), l]));
    t = t.split(/\r?\n/).map(l => OLD_DEFAULT_LINES.has(l.trim()) ? defs.get(l.slice(0, l.indexOf(":")).trim()) || l : l).join("\n");
    const have = new Set(parseRules(t).map(r => r.name));
    for (const [n, l] of defs) if (!have.has(n)) t += "\n" + l;
    localStorage.setItem("visor_rules", t); localStorage.setItem("visor_rules_v", "3");
  }
  return t; } catch (e) { return DEFAULT_RULES; } })();
RULES = parseRules(RULES_TEXT);

/* ---------------- Hallazgos marcados ---------------- */
/* Se guardan agrupados por el SHA-256 de cada evidencia y solo se cargan los de las evidencias abiertas, para que no se mezclen casos.
   Abierto con doble clic (file://), Chrome y Edge comparten el almacenamiento entre todos los HTML locales: ahí los hallazgos
   solo se guardan en esta pestaña (sessionStorage). Servido por servir_navestigio.py se recuerdan en este navegador. */
const MK_FILE = location.protocol === "file:", MK_KEY = "visor_marks_caso";
const MK_STORE = (() => { try { return MK_FILE ? sessionStorage : localStorage; } catch (e) { return null; } })();
let ALLM = (() => { let o = {};
  try { o = JSON.parse((MK_STORE && MK_STORE.getItem(MK_KEY)) || "{}") || {}; } catch (e) {}
  try { const old = localStorage.getItem("visor_marks"); // migración desde v2.9 (una sola lista para todos los casos)
    if (old !== null) { for (const m of JSON.parse(old) || []) (o[m.sha || ""] = o[m.sha || ""] || []).push(m);
      localStorage.removeItem("visor_marks"); if (MK_STORE) MK_STORE.setItem(MK_KEY, JSON.stringify(o)); } } catch (e) {}
  return o; })();
function activeShas() { return new Set(realDbs().map(d => d.hashes[0] && d.hashes[0][1]).filter(Boolean)); }
let MARKS = [];
function refreshMarks() { const s = activeShas(); MARKS = Object.entries(ALLM).filter(([k]) => s.has(k)).flatMap(([, v]) => v); }
const saveMarks = () => {
  for (const k of activeShas()) delete ALLM[k];
  for (const m of MARKS) { const b = ALLM[m.sha] = ALLM[m.sha] || []; if (!b.includes(m)) b.push(m); }
  try { if (MK_STORE) MK_STORE.setItem(MK_KEY, JSON.stringify(ALLM)); } catch (e) {} };
const markKeys = () => new Set(MARKS.map(m => m.key));

/* ---------------- Análisis del caso (línea de tiempo + hallazgos) ---------------- */
let CASE = null;
const PRI_ORDER = "CASE prioridad WHEN 'Alta' THEN 0 WHEN 'Media' THEN 1 ELSE 2 END";
const CASE_SCHEMA = `CREATE TABLE eventos(momento INTEGER, tipo TEXT, artefacto TEXT, url TEXT, titulo TEXT, detalle TEXT, tabla_origen TEXT, fuente TEXT, confianza TEXT, base_tiempo TEXT, interpretacion TEXT);
    CREATE INDEX ev_momento ON eventos(momento); CREATE INDEX ev_tipo ON eventos(tipo, momento);
    CREATE TABLE recuperados(artefacto TEXT, url TEXT, titulo TEXT, last_visit_time INTEGER, visitas INTEGER, tecleadas INTEGER, estructura TEXT, confianza TEXT, origen TEXT, pagina INTEGER, desplazamiento INTEGER);
    CREATE TABLE integridad(momento INTEGER, momento_fin INTEGER, artefacto TEXT, indicador TEXT, prioridad TEXT, confianza TEXT, detalle TEXT, interpretacion TEXT, tabla TEXT);
    CREATE TABLE hallazgos(id TEXT, momento INTEGER, artefacto TEXT, fuente TEXT, resumen TEXT, nota TEXT, marcado_el INTEGER, sha256 TEXT, detalle TEXT);`;
async function makeCase() {
  CASE = {id: "caso", label: "Análisis del caso", path: "Todas las evidencias abiertas", virtual: true, hashes: [], walInfo: null, notes: [], sample: false, size: 0,
    countCache: new Map(), sources: [], kindCache: new Map(), overrides: new Map(), queries: new Map(),
    forced: {"s:timeline": {momento: "webkit"}, "s:hallazgos": {momento: "webkit", marcado_el: "webkit"}, "s:recuperados": {last_visit_time: "webkit"}, "s:integridad": {momento: "webkit", momento_fin: "webkit"}}};
  await DB.call("create", {id: "caso", sql: CASE_SCHEMA});
  CASE.sources = [
    {id: "s:resumen", title: "Resumen del caso", kind: "case", sql: null, rows: null},
    {id: "s:timeline", title: "Línea de tiempo unificada", kind: "case", sql: "SELECT * FROM eventos ORDER BY momento DESC", rows: 0},
    {id: "s:hallazgos", title: "Hallazgos marcados", kind: "case", sql: "SELECT * FROM hallazgos ORDER BY momento DESC", rows: 0},
    {id: "s:recuperados", title: "Registros recuperados (borrados)", kind: "case", sql: "SELECT * FROM recuperados ORDER BY last_visit_time DESC", rows: 0},
    {id: "s:integridad", title: "Indicadores de integridad", kind: "case", sql: `SELECT * FROM integridad ORDER BY ${PRI_ORDER}, momento DESC`, rows: 0}];
  CASE.src = id => CASE.sources.find(s => s.id === id);
  S.dbs.unshift(CASE);
  await rebuildFindings();
}
const artOf = d => d.sample ? d.label + " (ejemplo)" : d.path;
function realDbs() { return S.dbs.filter(d => !d.virtual); }
async function rebuildTimeline() {
  const items = realDbs().map(d => ({id: d.id, art: artOf(d), tset: d.sources.filter(s => s.id.startsWith("t:") && !s.view).map(s => s.id.slice(2)),
    recovered: (d.recovered || []).filter(r => r.lvt).map(r => ({lvt: r.lvt, url: r.url, title: r.title, origen: r.origen})),
    // los indicadores con fecha también van a la línea de tiempo, marcados como tales
    extra: integrityRows(d).filter(r => r[0] != null).map(r => [r[0], "Indicador de integridad", r[2], "", r[3], r[6], r[8] || "", "indicador de integridad (estructura de la base)", r[5], "fecha del registro conservado más cercano", ""])}));
  const r = await DB.call("timeline", {items});
  CASE.src("s:timeline").rows = r.n;
  CASE.hashes = realDbs().map(d => [artOf(d), d.hashes[0][1]]);
  CASE.kindCache.delete("s:timeline"); CASE.alertStats = r.stats; caseChanged();
}
/* Estadísticas de alertas de la línea de tiempo: se calculan una vez al construirla (no en cada vista) */
async function caseAlertStats() { // recalcula solo si cambiaron las reglas
  if (CASE.alertStats && CASE.alertStats.ver === RULES_VER) return CASE.alertStats;
  return CASE.alertStats = await DB.call("alertStats");
}
async function rebuildFindings() {
  await DB.call("insertMany", {id: "caso", pre: "DELETE FROM hallazgos", sql: "INSERT INTO hallazgos VALUES(?,CAST(? AS INTEGER),?,?,?,?,CAST(? AS INTEGER),?,?)",
    rows: MARKS.map(m => [m.id, m.momento || null, m.artefacto, m.fuente, m.resumen, m.nota || "", (BigInt(m.marcado) * 1000n + 11644473600000000n).toString(), m.sha, m.detalle])});
  CASE.src("s:hallazgos").rows = MARKS.length;
  CASE.kindCache.delete("s:hallazgos"); caseChanged();
}
async function rebuildRecovered() {
  const rows = [];
  for (const d of realDbs()) { const art = artOf(d); for (const r of d.recovered || []) rows.push([art, r.url, r.title, r.lvt, r.vc, r.tc, r.estructura, r.estructura === "fragmento" ? "baja" : "media", r.origen, r.page, r.off]); }
  await DB.call("insertMany", {id: "caso", pre: "DELETE FROM recuperados", sql: "INSERT INTO recuperados VALUES(?,?,?,CAST(? AS INTEGER),?,?,?,?,?,?,?)", rows});
  CASE.src("s:recuperados").rows = rows.length; CASE.kindCache.delete("s:recuperados"); caseChanged();
}
let CASE_VER = 0;
function caseChanged() { CASE_VER++; if (CASE && CASE.countCache) CASE.countCache.clear(); }
async function rebuildIntegrity() {
  const rows = realDbs().flatMap(integrityRows);
  await DB.call("insertMany", {id: "caso", pre: "DELETE FROM integridad", sql: "INSERT INTO integridad VALUES(CAST(? AS INTEGER),CAST(? AS INTEGER),?,?,?,?,?,?,?)", rows});
  CASE.src("s:integridad").rows = rows.length; CASE.kindCache.delete("s:integridad"); caseChanged();
}
async function rebuildCase() { refreshMarks(); await rebuildFindings(); await rebuildRecovered(); await rebuildIntegrity(); await rebuildTimeline(); renderSide();
  // el resumen solo se recalcula si sigue en pantalla (al abrir evidencia se suele saltar a otra tabla)
  clearTimeout(rebuildCase.h); rebuildCase.h = setTimeout(() => { if (S.src === "s:resumen") renderSummary(); }, 0); }

/* ---------------- Indicadores de integridad ----------------
   Tres ejes separados: prioridad (dónde mirar primero), confianza (qué tan sólido es el hecho medido) e
   interpretación (con qué es consistente el hecho). Ninguno afirma qué hizo el usuario. */
function durTxt(sec) { return sec >= 86400 ? `${nf(Math.round(sec / 3600) / 24 >= 2 ? Math.round(sec / 86400) : Math.round(sec / 8640) / 10)} días` : sec >= 3600 ? `${nf(Math.round(sec / 360) / 10)} h` : `${Math.round(sec / 60)} min`; }
function integrityRows(d) {
  const g = d.integ; if (!g) return [];
  const art = artOf(d), rows = [], wk = (v, k) => { if (v == null) return null; const w = toWebkit(v, k); return w == null ? null : w.toString(); };
  const add = (momento, fin, indicador, prioridad, confianza, detalle, interp, tabla) => rows.push([momento, fin, art, indicador, prioridad, confianza, detalle, interp, tabla || ""]);
  if (g.ic.length && !(g.ic.length === 1 && g.ic[0] === "ok"))
    add(null, null, "Estructura SQLite dañada", "Alta", "alta", "PRAGMA integrity_check: " + g.ic.slice(0, 5).join(" | "),
      "Consistente con una escritura interrumpida (apagado, copia hecha con el navegador abierto) o con manipulación de páginas. Por sí solo no prueba manipulación.");
  for (const e of g.ids) {
    const T = e.t;
    if (e.seq != null && e.seq > (e.mx || 0)) {
      const k = e.seq - (e.mx || 0);
      add(wk(e.tailTime, e.kind), null, (k === 1 ? `Falta el registro más reciente de ${T}` : `Faltan los ${nf(k)} registros más recientes de ${T}`), "Alta", "alta",
        `sqlite_sequence registra ${nf(e.seq)} inserciones en ${T}; ${e.mx == null ? "la tabla está vacía" : `el id más alto que queda es ${nf(e.mx)}`}. La fecha es la del último registro conservado.`,
        "Consistente con un borrado de la actividad más reciente, por ejemplo «Borrar datos de navegación» de la última hora o del último día. La expiración automática del navegador elimina los registros más antiguos, no los más recientes.", T);
    }
    if (e.inner) {
      for (const h of e.top) add(wk(h.tPrev, e.kind), wk(h.tNext, e.kind), `Hueco de ${nf(h.k)} id en ${T}`, h.k >= 10 ? "Media" : "Baja", "media",
        `No existen los id ${nf(h.prev + 1)} a ${nf(h.id - 1)}: faltan ${nf(h.k)} registros entre el id ${nf(h.prev)} y el id ${nf(h.id)}. momento y momento_fin son las fechas de esos dos registros.`,
        "Consistente con la eliminación de entradas o de un rango de tiempo entre esas dos fechas. También puede deberse a la sincronización con otro dispositivo; compárelo con el resto de la línea de tiempo.", T);
      const listed = e.top.reduce((a, h) => a + h.k, 0), lead = e.mn > 1 ? e.mn - 1 : 0;
      if (e.top.length >= 5 && e.holes > listed) add(null, null, `${nf(e.holes)} id sin usar en total en ${T}`, "Baja", "alta",
        `Se listan arriba los 5 huecos mayores (${nf(listed)} id). El resto está repartido en huecos menores.`, "Consistente con borrados puntuales o con la depuración normal del navegador.", T);
      if (lead) add(null, null, `Los primeros ${nf(lead)} id de ${T} ya no existen`, "Baja", "alta", `El id más bajo que queda es ${nf(e.mn)}.`,
        "Consistente con la expiración automática del historial antiguo (Chrome conserva unos 90 días).", T);
    } else if (e.holes > 0) add(null, null, `${nf(e.holes)} id sin usar en ${T}`, "Baja", "alta", `Entre el id ${nf(e.mn)} y el ${nf(e.mx)} hay ${nf(e.n)} filas.`,
      "Habitual: el navegador borra registros antiguos al expirar el historial. Solo es relevante junto a otros indicadores.", T);
  }
  for (const b of g.back) add(null, null, `${nf(b.n)} ${b.n === 1 ? "retroceso" : "retrocesos"} de fecha en ${b.t}`, "Media", "baja",
    `Al avanzar el id, la fecha retrocede más de 60 s ${b.n === 1 ? "una vez" : `en ${nf(b.n)} ocasiones`} (${b.n === 1 ? "" : "el mayor, "}${durTxt(b.worstSec)}).${b.syncExcluded ? " Ya se excluyeron las visitas sincronizadas." : ""}`,
    "Consistente con un cambio del reloj del sistema, visitas sincronizadas o importadas desde otro equipo, o edición manual de la base.", b.t);
  if (g.cookieInv) add(null, null, `${nf(g.cookieInv)} ${g.cookieInv === 1 ? "cookie creada" : "cookies creadas"} después de su último uso`, "Media", "media", "La fecha de creación es posterior a la de último acceso en más de 1 s.",
    "Una cookie no puede usarse antes de crearse. Consistente con un cambio del reloj del sistema o con fechas editadas.", "cookies");
  if (d.walInfo) add(null, null, "Había un archivo -wal", "Baja", "alta", `${nf(d.walInfo.commits)} transacciones confirmadas aplicadas a la copia de trabajo${d.walInfo.note ? " · " + d.walInfo.note : ""}.`,
    "El -wal guarda los cambios más recientes que aún no pasaban a la base. Ya se aplicaron, y las versiones anteriores de sus páginas se revisaron en busca de registros borrados.");
  if (d.journal) add(null, null, "Había un archivo -journal", "Baja", "alta", "No se aplicó.", "Puede contener páginas anteriores a la última transacción. Revíselo con otra herramienta si es relevante.");
  if (g.free) add(null, null, `${nf(g.free)} ${g.free === 1 ? "página libre" : "páginas libres"} en la base`, "Baja", "alta", "PRAGMA freelist_count.",
    "Consistente con datos borrados. Navestigio las revisa; lo que encuentre aparece en «Registros recuperados».");
  return rows;
}
/* Alcance: lo que se analizó y, sobre todo, lo que no, para que un resultado limpio no pase por completo */
function scopeInfo() {
  const dbs = realDbs(), enc = new Map();
  for (const d of dbs) for (const [k, n] of Object.entries((d.integ && d.integ.enc) || {})) if (n) enc.set(k, (enc.get(k) || 0) + n);
  const frag = dbs.reduce((a, d) => a + (d.recovered || []).filter(r => !r.lvt).length, 0), jr = dbs.filter(d => d.journal);
  const done = [`${nf(dbs.length)} ${dbs.length === 1 ? "evidencia abierta" : "evidencias abiertas"}, cada una con su SHA-256`,
    "Tablas reconocidas de Chrome, Edge y Firefox, unidas en la línea de tiempo",
    "Registros borrados en páginas libres, freeblocks y -wal", "Indicadores de integridad de cada base SQLite"];
  const not = [...[...enc].map(([k, n]) => `${nf(n)} ${k} cifrados: se cuentan, no se descifran`),
    ...jr.map(d => `-journal de ${d.label}: no se aplicó`),
    ...(frag ? [`${nf(frag)} ${frag === 1 ? "fragmento" : "fragmentos"} de URL sin fecha: ${frag === 1 ? "está" : "están"} en «Registros recuperados», no en la línea de tiempo`] : []),
    "Caché del navegador y reconstrucción de páginas", "Local Storage, Session Storage e IndexedDB", "Sesiones y pestañas abiertas (Current Session, sessionstore)",
    "Safari", "Memoria RAM", "Archivos que no se cargaron: solo se analiza lo que usted abre"];
  return {done, not};
}

/* ---------------- Recuperación de registros borrados (carving) ---------------- */
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
function varint(b, i) {
  let v = 0;
  for (let k = 0; k < 9; k++) { const x = b[i + k]; if (x === undefined) return null;
    if (k === 8) return [v * 256 + x, i + 9];
    v = v * 128 + (x & 0x7f); if (!(x & 0x80)) return [v, i + k + 1]; }
  return null;
}
const stSize = n => n <= 4 ? n : n === 5 ? 6 : (n === 6 || n === 7) ? 8 : (n === 8 || n === 9) ? 0 : n >= 12 ? (n - (n % 2 ? 13 : 12)) / 2 : -1;
function readIntBE(b, o, n) { let v = 0n; for (let k = 0; k < n; k++) v = (v << 8n) | BigInt(b[o + k]); if (n && (b[o] & 0x80)) v -= 1n << BigInt(8 * n); return v; }
const UTF8 = new TextDecoder("utf-8", {fatal: false}), LATIN = new TextDecoder("latin1");
// Registro de la tabla urls de Chrome: [id NULL][url][title][visit_count][typed_count][last_visit_time][hidden]
function parseUrlRecord(b, p) {
  for (let q = p - 1; q >= Math.max(0, p - 16); q--) {
    if (b[q] !== 0) continue;
    const ser = []; let i = q + 1;
    while (i < p && ser.length < 6) { const r = varint(b, i); if (!r) break; ser.push(r[0]); i = r[1]; }
    if (i !== p || ser.length !== 6) continue;
    const [su, stt, s3, s4, s5, s6] = ser;
    if (su < 13 || su % 2 === 0 || !(stt === 0 || (stt >= 13 && stt % 2 === 1))) continue;
    if ([s3, s4, s5, s6].some(x => x > 9 || x === 7)) continue;
    const ul = stSize(su), tl = stSize(stt); let o = p;
    if (ul < 8 || o + ul + tl > b.length) continue;
    const url = LATIN.decode(b.subarray(o, o + ul)); o += ul;
    if (!/^https?:\/\/[\x21-\x7e]+$/.test(url)) continue;
    const title = UTF8.decode(b.subarray(o, o + tl)); o += tl;
    const vc = readIntBE(b, o, stSize(s3)); o += stSize(s3);
    const tc = readIntBE(b, o, stSize(s4)); o += stSize(s4);
    const lvt = s5 === 8 ? 0n : s5 === 9 ? 1n : readIntBE(b, o, stSize(s5));
    if (lvt !== 0n && (lvt < 12591158400000000n || lvt > 16000000000000000n)) continue;
    return {url, title, vc: Number(vc), tc: Number(tc), lvt: lvt ? lvt.toString() : null, estructura: "registro urls"};
  }
  return null;
}
function carveRegion(buf, start, end, origen, page, found) {
  if (end - start < 12) return;
  const txt = LATIN.decode(buf.subarray(start, end)), re = /https?:\/\/[\x21-\x7e]{3,2048}/g; let m;
  while ((m = re.exec(txt))) {
    const p = start + m.index, rec = parseUrlRecord(buf, p);
    if (rec) { found.push({...rec, origen, page, off: p}); re.lastIndex = m.index + rec.url.length; }
    else found.push({url: m[0], title: "", vc: null, tc: null, lvt: null, estructura: "fragmento", origen, page, off: p});
    if (found.length > 50000) return;
  }
}
async function carveDb(db) {
  const b = db.rawBytes, found = [];
  const ps0 = u16(b, 16), ps = ps0 === 1 ? 65536 : ps0; if (!ps || ps < 512) return [];
  const nPages = Math.floor(b.length / ps), free = new Set();
  let trunk = u32(b, 32), guard = 0;
  while (trunk && trunk <= nPages && guard++ < 100000) {
    free.add(trunk); const o = (trunk - 1) * ps, n = u32(b, o + 4);
    for (let i = 0; i < n && i < ps / 4 - 2; i++) { const lp = u32(b, o + 8 + 4 * i); if (lp && lp <= nPages) free.add(lp); }
    trunk = u32(b, o);
  }
  for (let pg = 1; pg <= nPages; pg++) {
    const o = (pg - 1) * ps;
    if (free.has(pg)) { carveRegion(b, o, o + ps, "página libre (freelist)", pg, found); continue; }
    const h = pg === 1 ? 100 : 0, type = b[o + h];
    if (![0x0d, 0x05, 0x0a, 0x02].includes(type)) continue;
    const n = u16(b, o + h + 3), cs = u16(b, o + h + 5) || 65536, hl = (type === 0x0d || type === 0x0a) ? 8 : 12;
    const ptrEnd = h + hl + 2 * n;
    if (cs > ptrEnd && cs <= ps) carveRegion(b, o + ptrEnd, o + cs, "espacio no asignado de página", pg, found);
    let fb = u16(b, o + h + 1), g = 0;
    while (fb && fb + 4 <= ps && g++ < 1000) { const sz = u16(b, o + fb + 2); if (sz < 4 || fb + sz > ps) break;
      carveRegion(b, o + fb, o + fb + sz, "freeblock (celda borrada)", pg, found); fb = u16(b, o + fb); }
  }
  for (const pg of db.walReplaced || []) if (pg <= nPages) carveRegion(b, (pg - 1) * ps, pg * ps, "versión anterior de la página (reemplazada por el -wal)", pg, found);
  if (db.walBytes && db.walBytes.length > 32) {
    const w = db.walBytes, wps = u32(w, 8), fl = 24 + wps; let f = 0;
    if (wps >= 512 && wps <= 65536) for (let o = 32; o + fl <= w.length; o += fl) { f++; carveRegion(w, o + 24, o + fl, `frame ${f} del -wal`, u32(w, o), found); }
  }
  // Descartar lo que sigue existiendo en la base actual
  const live = new Set();
  for (const s of db.sources.filter(s => s.id.startsWith("t:") && !s.view)) {
    let cols = []; try { cols = await qCols(db.id, s.sql); } catch (e) { rethrowCancel(e); continue; }
    for (const c of cols) { try { for (const r of await qAll(db.id, `SELECT DISTINCT ${qi(c)} FROM ${qi(s.id.slice(2))} WHERE typeof(${qi(c)}) = 'text' AND ${qi(c)} LIKE 'http%'`)) live.add(r[0]); } catch (e) { rethrowCancel(e); } }
  }
  const out = [], seen = new Set();
  for (const r of found) {
    if (live.has(r.url)) continue;
    if (r.estructura === "fragmento") { let hit = false; for (let L = 10; L <= r.url.length && !hit; L++) if (live.has(r.url.slice(0, L))) hit = true; if (hit) continue; }
    const k = r.url + "|" + r.title + "|" + r.lvt; if (seen.has(k)) continue; seen.add(k); out.push(r);
  }
  // Los registros con estructura primero
  return out.sort((a, b) => (a.estructura === b.estructura ? 0 : a.estructura === "fragmento" ? 1 : -1));
}

/* ---------------- Resumen del caso ---------------- */
let SUM_MODE = "visitas";
const nf = n => Number(n).toLocaleString("es-CO");
function barPath(x, y, w, h, r) { r = Math.min(r, w / 2, h); if (h <= 0) return ""; return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; }
function niceMax(v) { if (v <= 5) return 5; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return 10 * p; }
function barChart(data, opt) {
  // data: [{label, value, tip, key}] — una sola serie: color de acento, sin leyenda
  const W = opt.w || 900, H = opt.h || 200, L = 34, B = 22, T = 8, iw = W - L - 6, ih = H - B - T;
  const max = niceMax(Math.max(1, ...data.map(d => d.value))), n = data.length, step = iw / Math.max(n, 1), gap = Math.min(2 + step * 0.18, 8), bw = Math.max(1, step - gap);
  let g = "";
  for (let k = 0; k <= 5; k++) { const v = max * k / 5, y = T + ih - ih * k / 5; g += `<line class="grid" x1="${L}" x2="${W - 6}" y1="${y}" y2="${y}"/><text class="ax" x="${L - 5}" y="${y + 3}" text-anchor="end">${nf(Math.round(v))}</text>`; }
  const every = Math.ceil(n / (opt.maxLabels || 12));
  data.forEach((d, i) => {
    const x = L + i * step + gap / 2, h = ih * d.value / max, y = T + ih - h;
    g += `<rect class="hit" x="${L + i * step}" y="${T}" width="${step}" height="${ih}" data-tip="${esc(d.tip)}" data-key="${esc(d.key || "")}" data-chart="${opt.id}"/>`;
    g += `<path class="bar grow" style="animation-delay:${Math.min(i * 12, 500)}ms" d="${barPath(x, y, bw, h, 4)}"/>`;
    if (i % every === 0) g += `<text class="ax" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opt.aria)}">${g}</svg>`;
}
async function renderSummary() {
  const el = $("summary"), t = tz();
  const skey = [CASE_VER, t, SUM_MODE, RULES_VER, realDbs().length].join("|");
  if (el.dataset.key === skey && el.innerHTML) return; // sin cambios: no recalcular
  await DB.call("tz", {tz: t});
  const secs = "vt_local(momento)"; // segundos Unix en hora local (respeta horario de verano)
  const Q = (q, p) => qAll("caso", q, p);
  const one = async (q, p) => { const r = (await Q(q, p))[0]; return r ? r[0] : null; };
  const isVisit = "tipo LIKE 'Visita%'", act = SUM_MODE === "visitas" ? isVisit : "tipo NOT LIKE 'Cookie%' AND tipo NOT LIKE 'Favicon%'";
  const visits = Number(await one(`SELECT COUNT(*) FROM eventos WHERE ${isVisit}`));
  const first = (await one(`SELECT MIN(momento) FROM eventos WHERE ${isVisit}`)) ?? (await one("SELECT MIN(momento) FROM eventos WHERE tipo NOT LIKE 'Cookie%'"));
  const last = (await one(`SELECT MAX(momento) FROM eventos WHERE ${isVisit}`)) ?? (await one("SELECT MAX(momento) FROM eventos WHERE tipo NOT LIKE 'Cookie%'"));
  const cntOf = new Map(); for (const tp of ["Descarga iniciada", "Búsqueda", "Credencial guardada"]) cntOf.set(tp, Number(await one("SELECT COUNT(*) FROM eventos WHERE tipo = ?", [tp])));
  const cnt = tp => cntOf.get(tp);
  const hosts = new Map(); for (const [u] of await Q(`SELECT url FROM eventos WHERE ${isVisit}`)) { const h = hostOf(u); if (h) hosts.set(h, (hosts.get(h) || 0) + 1); }
  const top = [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 12);
  let alerts = 0;
  // Alertas por categoría: eventos, dominios y sitios principales de cada una
  let catMap = new Map();
  try { const st = await caseAlertStats(); catMap = st.cats; alerts = st.n; } catch (e) { rethrowCancel(e); }
  const cats = [...catMap].sort((a, b) => b[1].n - a[1].n), catMax = cats.length ? cats[0][1].n : 1;
  const nInt = Number(await one("SELECT COUNT(*) FROM integridad WHERE prioridad IN ('Alta','Media')"));
  const integ = await Q(`SELECT prioridad, indicador, artefacto, interpretacion FROM integridad ORDER BY ${PRI_ORDER}, momento DESC LIMIT 8`);
  const nIntAll = CASE.src("s:integridad").rows || 0, scope = scopeInfo();
  const rec = CASE.src("s:recuperados").rows || 0, recDated = Number(await one("SELECT COUNT(*) FROM recuperados WHERE last_visit_time IS NOT NULL"));
  const kpis = [
    ["Evidencias abiertas", realDbs().length], ["Visitas", visits], ["Dominios distintos", hosts.size], ["Descargas", cnt("Descarga iniciada")],
    ["Búsquedas", cnt("Búsqueda")], ["Credenciales guardadas", cnt("Credencial guardada")], ["Eventos con alerta (revisar primero)", alerts, "warn"],
    ["Hallazgos marcados", MARKS.length], ["URLs recuperadas (borradas)", rec, rec ? "warn" : ""], ["Indicadores de integridad (prioridad alta o media)", nInt, nInt ? "warn" : ""]];
  const fd = v => v == null ? "—" : fmt(v, "webkit", t);
  // Actividad por hora
  const byH = new Array(24).fill(0);
  for (const [h, c] of await Q(`SELECT CAST(strftime('%H', ${secs}, 'unixepoch') AS INTEGER), COUNT(*) FROM eventos WHERE ${act} GROUP BY 1`)) byH[Number(h)] = Number(c);
  const hourData = byH.map((v, h) => ({label: p2(h), value: v, tip: `${p2(h)}:00–${p2(h)}:59 · ${nf(v)} eventos`, key: String(h)}));
  // Actividad por día (o por mes si el rango es muy largo)
  const days = (await Q(`SELECT strftime('%Y-%m-%d', ${secs}, 'unixepoch') d, COUNT(*) FROM eventos WHERE ${act} GROUP BY 1 ORDER BY 1`)).map(r => [r[0], Number(r[1])]);
  let dayData = [], dayTitle = "Actividad por día";
  if (days.length) {
    const d0 = Date.parse(days[0][0] + "T00:00:00Z"), d1 = Date.parse(days[days.length - 1][0] + "T00:00:00Z"), span = Math.round((d1 - d0) / 864e5) + 1, m = new Map(days);
    if (span <= 400) { for (let i = 0; i < span; i++) { const k = new Date(d0 + i * 864e5).toISOString().slice(0, 10), v = m.get(k) || 0;
        dayData.push({label: `${k.slice(8, 10)}/${k.slice(5, 7)}`, value: v, tip: `${k.slice(8, 10)}/${k.slice(5, 7)}/${k.slice(0, 4)} · ${nf(v)} eventos`, key: k}); } }
    else { dayTitle = "Actividad por mes"; const mm = new Map(); for (const [k, v] of days) mm.set(k.slice(0, 7), (mm.get(k.slice(0, 7)) || 0) + v);
      for (const [k, v] of mm) dayData.push({label: `${k.slice(5, 7)}/${k.slice(2, 4)}`, value: v, tip: `${k.slice(5, 7)}/${k.slice(0, 4)} · ${nf(v)} eventos`, key: k}); }
  }
  const catHtml = cats.length ? `<div class="chart full"><h3>Alertas por categoría</h3><p class="sub">${nf(cats.length)} categorías con eventos. Un evento puede tener varias. Clic en una categoría o sitio para ver esos eventos en la línea de tiempo.</p>
      <p class="sub note">Una alerta es una <b>prioridad de revisión</b>, no una prueba: indica que la URL o el título contienen un término de la regla. Antes de concluir, revise el contexto (cómo llegó a la página, redirecciones, anuncios o pestañas abiertas solas).</p>
      <div class="toplist">${cats.map(([nm, c], i) => `<div class="toprow cat" data-cat="${esc(nm)}" data-tip="${esc(nm)} · ${nf(c.n)} eventos en ${nf(c.hosts.size)} sitios"><div class="track" style="transform:scaleX(${c.n / catMax});animation-delay:${i * 40}ms"></div><div class="nm">${esc(nm)}</div><div class="ct">${nf(c.n)}</div></div>`).join("")}</div></div>
    ${cats.map(([nm, c], ci) => { const th = [...c.hosts].sort((a, b) => b[1] - a[1]).slice(0, 6), mx = th[0][1];
      return `<div class="chart catcard" style="--i:${ci}"><h3><span class="chip">${esc(nm)}</span></h3><p class="sub">${nf(c.n)} ${c.n === 1 ? "evento" : "eventos"} · ${nf(c.hosts.size)} ${c.hosts.size === 1 ? "sitio" : "sitios"}${c.hosts.size > 6 ? " · top 6" : ""}</p>
        <div class="toplist">${th.map(([h, n], i) => `<div class="toprow" data-cat="${esc(nm)}" data-host="${h === "(sin URL)" ? "" : esc(h)}" data-tip="${esc(h)} · ${nf(n)} eventos de ${esc(nm)}"><div class="track" style="transform:scaleX(${n / mx});animation-delay:${i * 40}ms"></div><div class="nm">${esc(h)}</div><div class="ct">${nf(n)}</div></div>`).join("")}</div></div>`; }).join("")}` : "";
  const peakH = byH.indexOf(Math.max(...byH)), topMax = top.length ? top[0][1] : 1;
  const modeLbl = SUM_MODE === "visitas" ? "visitas" : "eventos de navegación (sin cookies ni favicons)";
  if (skey !== [CASE_VER, tz(), SUM_MODE, RULES_VER, realDbs().length].join("|")) return; // cambió mientras se calculaba
  el.dataset.key = skey;
  el.innerHTML = `<h2>Resumen del caso</h2>
    <p class="muted">${realDbs().length} ${realDbs().length === 1 ? "evidencia" : "evidencias"} · fechas en ${tzLabel(t)}${realDbs().some(d => d.sample) ? ' · <span class="tag">incluye datos de ejemplo</span>' : ""}</p>
    <div class="kpis">${kpis.map((k, i) => `<div class="kpi ${k[2] || ""}" style="--i:${i}"><div class="v">${nf(k[1])}</div><div class="l">${k[0]}</div></div>`).join("")}
      <div class="kpi wide" style="--i:10"><div class="v">${fd(first)}</div><div class="l">Primer uso del navegador registrado</div></div>
      <div class="kpi wide" style="--i:11"><div class="v">${fd(last)}</div><div class="l">Último uso del navegador registrado</div></div>
      ${recDated ? `<div class="kpi wide warn" style="--i:12"><div class="v">${nf(recDated)} con fecha</div><div class="l">URLs borradas con fecha de última visita recuperada</div></div>` : ""}</div>
    <p><span class="seg" role="group" aria-label="Qué contar en los gráficos"><button type="button" data-sum="visitas" class="${SUM_MODE === "visitas" ? "on" : ""}">Visitas</button><button type="button" data-sum="todo" class="${SUM_MODE === "todo" ? "on" : ""}">Toda la actividad</button></span></p>
    <div class="charts">
      <div class="chart full"><h3>${dayTitle}</h3><p class="sub">${nf(dayData.reduce((a, d) => a + d.value, 0))} ${modeLbl}. Haga clic en una barra para ver ese día en la línea de tiempo.</p>
        ${dayData.length ? barChart(dayData, {id: "day", w: 1100, h: 210, aria: dayTitle, maxLabels: 14}) : '<p class="muted">Sin eventos con fecha.</p>'}</div>
      <div class="chart"><h3>Actividad por hora del día</h3><p class="sub">Hora local ${tzLabel(t)}${byH.some(v => v) ? ` · pico a las ${p2(peakH)}:00` : ""}.</p>
        ${barChart(hourData, {id: "hour", w: 560, h: 200, aria: "Actividad por hora", maxLabels: 12})}</div>
      <div class="chart"><h3>Sitios más visitados</h3><p class="sub">Por número de visitas. Clic para ver el dominio en la línea de tiempo.</p>
        <div class="toplist">${top.length ? top.map(([h, c], i) => `<div class="toprow" data-host="${esc(h)}" title="${esc(h)} · ${nf(c)} visitas"><div class="track" style="transform:scaleX(${c / topMax});animation-delay:${i * 40}ms"></div><div class="nm">${esc(h)}</div><div class="ct">${nf(c)}</div></div>`).join("") : '<p class="muted">Sin visitas.</p>'}</div></div>
      ${catHtml}
      <div class="chart full integ"><h3>Integridad y posibles borrados</h3><p class="sub">Hechos medidos en la estructura de cada base. La <b>prioridad</b> dice dónde mirar primero, la <b>confianza</b> qué tan sólido es el hecho y la <b>interpretación</b> con qué es consistente; ninguna afirma lo que hizo el usuario.${nIntAll ? ` Clic para ver los ${nf(nIntAll)} indicadores con su detalle.` : ""}</p>
        ${integ.length ? `<div class="ilist">${integ.map(([p, ind, a, it], i) => `<div class="irow" style="--i:${i}" tabindex="0" role="button"><span class="pri p${p}">${esc(p)}</span><div><b>${esc(ind)}</b> <span class="muted">· ${esc(a)}</span><div class="muted">${esc(it)}</div></div></div>`).join("")}</div>` : '<p class="muted">Sin indicadores: las bases abiertas no muestran huecos, fechas fuera de orden ni daño estructural.</p>'}</div>
      <div class="chart full scope"><h3>Alcance del análisis</h3><p class="sub">Un resultado limpio solo vale para lo que se revisó.</p>
        <div class="scols"><div><h4>Se analizó</h4><ul>${scope.done.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>
        <div><h4>No se analizó</h4><ul>${scope.not.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div></div></div>
    </div>`;
}
function sumGoto(f) {
  pick("caso", "s:timeline");
  $("q").value = f.q || ""; $("dFrom").value = f.from || ""; $("dTo").value = f.to || ""; $("onlyAlerts").checked = !!f.cat; $("alertCat").value = f.cat || "";
  S.offset = 0; load(); if (f.msg) toast(f.msg);
}
$("summary").addEventListener("click", e => {
  const b = e.target.closest("[data-sum]"); if (b) { SUM_MODE = b.dataset.sum; renderSummary(); return; }
  if (e.target.closest(".irow")) { pick("caso", "s:integridad"); return; }
  const r = e.target.closest(".toprow"); if (r) { const c = r.dataset.cat, h = r.dataset.host;
    sumGoto({q: h || "", cat: c || "", msg: c ? `Línea de tiempo: alerta «${c}»${h ? ` en «${h}»` : ""}` : `Línea de tiempo filtrada por «${h}»`}); return; }
  const h = e.target.closest(".hit"); if (!h) return;
  if (h.dataset.chart === "day" && /^\d{4}-\d{2}-\d{2}$/.test(h.dataset.key)) sumGoto({from: h.dataset.key + "T00:00:00", to: h.dataset.key + "T23:59:59", msg: "Línea de tiempo del día seleccionado"});
  if (h.dataset.chart === "day" && /^\d{4}-\d{2}$/.test(h.dataset.key)) { const [y, m] = h.dataset.key.split("-").map(Number), endD = new Date(Date.UTC(y, m, 0)).getUTCDate();
    sumGoto({from: h.dataset.key + "-01T00:00:00", to: `${h.dataset.key}-${p2(endD)}T23:59:59`, msg: "Línea de tiempo del mes seleccionado"}); }
});
$("summary").addEventListener("mousemove", e => {
  const h = e.target.closest(".hit,.toprow"), tip = $("tip");
  document.querySelectorAll(".chart .bar.hl").forEach(x => x.classList.remove("hl"));
  if (!h || !h.dataset.tip) { tip.classList.remove("on"); return; }
  if (h.nextElementSibling) h.nextElementSibling.classList.add("hl");
  tip.textContent = h.dataset.tip; tip.classList.add("on");
  const x = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8); tip.style.left = x + "px"; tip.style.top = (e.clientY - 34) + "px";
});
$("summary").addEventListener("mouseleave", () => $("tip").classList.remove("on"));

/* ---------------- Artefactos JSON (Bookmarks, Preferences, Local State) ---------------- */
const JSON_NAMES = new Set(["Bookmarks", "Preferences", "Secure Preferences", "Local State"]);
const newId = () => Math.random().toString(36).slice(2, 10);
async function loadJsonEvidence(label, path, bytes, reopen) {
  const id = newId(), hashes = [await hashPair(label, bytes)], size = bytes.length;
  if (!reopen) { const keep = bytes.slice(0); reopen = async () => keep.slice(0); }
  const work = bytes.slice(0); await DB.call("json", {id, name: label, bytes: work}, [work.buffer]);
  const db = {id, label, path, hashes, walInfo: null, notes: ["Artefacto JSON convertido a tablas"], sample: false, json: true,
    size, sources: [], kindCache: new Map(), overrides: new Map(), queries: new Map(), recovered: [], reopen};
  await buildSources(db); S.dbs.push(db); return db;
}
async function looksJson(f) { if (f.size > 60e6) return false; const t = new TextDecoder().decode(await f.slice(0, 64).arrayBuffer()).trimStart(); return t.startsWith("{"); }

/* ---------------- WAL ---------------- */
function applyWal(db, wal) {
  // Aplica las transacciones confirmadas del -wal sobre una copia en memoria de la base.
  const info = {frames: 0, commits: 0, pages: 0, note: ""};
  if (wal.length < 32) { info.note = "WAL vacío"; return {bytes: db, info}; }
  const dv = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);
  const magic = dv.getUint32(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) { info.note = "Encabezado WAL no válido"; return {bytes: db, info}; }
  const be = (magic & 1) === 1;
  const pageSize = dv.getUint32(8), salt1 = dv.getUint32(16), salt2 = dv.getUint32(20);
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1))) { info.note = "Tamaño de página del WAL no válido"; return {bytes: db, info}; }
  const cks = (off, len, s0, s1) => {
    for (let i = off; i < off + len; i += 8) {
      const a = dv.getUint32(i, !be), b = dv.getUint32(i + 4, !be);
      s0 = (s0 + a + s1) >>> 0; s1 = (s1 + b + s0) >>> 0;
    }
    return [s0, s1];
  };
  let [s0, s1] = cks(0, 24, 0, 0);
  if (s0 !== dv.getUint32(24) || s1 !== dv.getUint32(28)) { info.note = "Checksum del encabezado WAL no coincide"; return {bytes: db, info}; }
  const frameLen = 24 + pageSize;
  let pending = new Map(), committed = new Map(), dbPages = 0;
  for (let off = 32; off + frameLen <= wal.length; off += frameLen) {
    if (dv.getUint32(off + 8) !== salt1 || dv.getUint32(off + 12) !== salt2) break;
    [s0, s1] = cks(off, 8, s0, s1);
    [s0, s1] = cks(off + 24, pageSize, s0, s1);
    if (s0 !== dv.getUint32(off + 16) || s1 !== dv.getUint32(off + 20)) break;
    info.frames++;
    pending.set(dv.getUint32(off), off + 24);
    const commitSize = dv.getUint32(off + 4);
    if (commitSize) { for (const [k, v] of pending) committed.set(k, v); pending = new Map(); dbPages = commitSize; info.commits++; }
  }
  if (!info.commits) { info.note = "Sin transacciones confirmadas"; return {bytes: db, info}; }
  // Límite de memoria: la base no puede crecer más que las páginas que trae el propio -wal
  if (dbPages > Math.ceil(db.length / pageSize) + info.frames) { info.note = "WAL inconsistente (declara una base más grande de lo posible): no se aplica"; return {bytes: db, info}; }
  const out = new Uint8Array(dbPages * pageSize);
  out.set(db.subarray(0, Math.min(db.length, out.length)));
  for (const [pg, off] of committed) if (pg <= dbPages) { out.set(wal.subarray(off, off + pageSize), (pg - 1) * pageSize); info.pages++; }
  const odv = new DataView(out.buffer);
  odv.setUint32(28, dbPages);
  odv.setUint32(92, odv.getUint32(24));
  info.replaced = [...committed.keys()];
  return {bytes: out, info};
}

/* ---------------- Apertura de evidencia ---------------- */
async function sha256(bytes) {
  try { const h = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join(""); }
  catch (e) { return "(SHA-256 no disponible en este navegador)"; }
}
/* MD5 propio (WebCrypto no lo trae): solo para el manifiesto, junto al SHA-256 que es el hash de referencia */
const MD5_K = Uint32Array.from({length: 64}, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
function md5(bytes) {
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const n = bytes.length, tail = new Uint8Array(((n % 64) + 9 > 64) ? 128 : 64), full = n - (n % 64), M = new Uint32Array(16);
  tail.set(bytes.subarray(full)); tail[n % 64] = 0x80;
  const tv = new DataView(tail.buffer); tv.setUint32(tail.length - 8, (n * 8) >>> 0, true); tv.setUint32(tail.length - 4, Math.floor(n / 536870912), true);
  const block = (src, off) => {
    for (let i = 0; i < 16; i++) { const o = off + i * 4; M[i] = src[o] | src[o + 1] << 8 | src[o + 2] << 16 | src[o + 3] << 24; }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g; const r = i >> 4;
      if (r === 0) { F = (B & C) | (~B & D); g = i; } else if (r === 1) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (r === 2) { F = B ^ C ^ D; g = (3 * i + 5) & 15; } else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      const sh = MD5_S[(r << 2) | (i & 3)]; F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D; D = C; C = B; B = (B + ((F << sh) | (F >>> (32 - sh)))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  };
  for (let o = 0; o < full; o += 64) block(bytes, o);
  for (let o = 0; o < tail.length; o += 64) block(tail, o);
  return [a0, b0, c0, d0].map(x => [0, 8, 16, 24].map(s => ((x >>> s) & 255).toString(16).padStart(2, "0")).join("")).join("");
}
async function hashPair(label, bytes) { return [label, await sha256(bytes), md5(bytes)]; }
async function isSqlite(file) {
  if (file.size < 100) return false;
  const h = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  return new TextDecoder().decode(h) === "SQLite format 3\u0000";
}
const frame = () => new Promise(r => setTimeout(r, 20));
async function busy(msg) { BUSY_EXT = true; showBusy(msg); await frame(); }
function idle() { BUSY_EXT = false; if (!DB.slow) hideBusy(); }
async function openFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  try { await openFilesInner(files); } catch (e) { rethrowCancel(e); toast(e.message || String(e)); } finally { idle(); }
}
async function openFilesInner(files) {
  await busy("Buscando bases SQLite…");
  const byName = new Map(files.map(f => [f.webkitRelativePath || f.name, f]));
  const mains = [], jsons = [], fromFolder = files.some(f => f.webkitRelativePath);
  for (const [path, f] of byName) {
    if (/-(wal|journal|shm)$/i.test(path)) continue;
    if (await isSqlite(f)) mains.push([path, f]);
    else if (JSON_NAMES.has(f.name) || (!fromFolder && /\.json$|^[^.]+$/i.test(f.name) && await looksJson(f))) jsons.push([path, f]);
  }
  if (!mains.length && !jsons.length) { toast("Ninguno de los archivos es una base SQLite ni un artefacto JSON del navegador."); return; }
  let first = null;
  for (const [path, f] of mains) {
    try {
      await busy(`Calculando SHA-256, abriendo ${f.name} y buscando registros borrados…`);
      const wf = byName.get(path + "-wal");
      const reopen = async () => prepWork(new Uint8Array(await f.arrayBuffer()), wf ? new Uint8Array(await wf.arrayBuffer()) : null).work;
      const db = await loadEvidence(f.name, path, new Uint8Array(await f.arrayBuffer()), wf, byName.get(path + "-journal"), false, reopen);
      first = first || db;
    } catch (e) { if (e.cancelled) return; toast(`${f.name}: ${e.message || e}`); }
  }
  for (const [path, f] of jsons) {
    try { await busy(`Leyendo ${f.name}…`); const db = await loadJsonEvidence(f.name, path, new Uint8Array(await f.arrayBuffer()), async () => new Uint8Array(await f.arrayBuffer())); first = first || db; }
    catch (e) { if (e.cancelled) return; toast(`${f.name}: no es un JSON válido (${e.message})`); }
  }
  await busy("Construyendo la línea de tiempo…");
  await rebuildCase(); bumpCounts();
  if (first) pickFirst(first);
}
/* Copia de trabajo en memoria: aplica el -wal y quita la marca de modo WAL (el original no se toca) */
function prepWork(bytes, wal) {
  let work = bytes.slice(0), walInfo = null;
  if (wal) { const r = applyWal(work, wal); work = r.bytes; walInfo = r.info; }
  if (work[18] === 2 || work[19] === 2) { work[18] = 1; work[19] = 1; }
  return {work, walInfo};
}
async function loadEvidence(label, path, bytes, walFile, journalFile, sample, reopen) {
  const hashes = [await hashPair(label, bytes)], notes = [];
  let walBytes = null;
  if (walFile) { walBytes = new Uint8Array(await walFile.arrayBuffer()); hashes.push(await hashPair(label + "-wal", walBytes)); }
  if (journalFile) {
    hashes.push(await hashPair(label + "-journal", new Uint8Array(await journalFile.arrayBuffer())));
    notes.push("Hay un -journal: no se aplica (puede contener páginas anteriores a la última transacción).");
  }
  const {work, walInfo} = prepWork(bytes, walBytes);
  if (!reopen) { const keep = bytes.slice(0), keepWal = walBytes && walBytes.slice(0); reopen = async () => prepWork(keep, keepWal).work; }
  const id = newId();
  await DB.call("open", {id, bytes: work}, [work.buffer]);
  const db = {id, label, path, hashes, walInfo, notes, sample: !!sample,
    size: bytes.length, sources: [], kindCache: new Map(), overrides: new Map(), queries: new Map(),
    rawBytes: bytes, walBytes, walReplaced: walInfo && walInfo.replaced || [], recovered: [], journal: !!journalFile, reopen};
  try {
    await buildSources(db);
    try { db.recovered = await carveDb(db); } catch (e) { rethrowCancel(e); db.notes.push("No se pudo analizar el espacio libre: " + e.message); }
    try { db.integ = await DB.call("integrity", {id}); } catch (e) { rethrowCancel(e); db.notes.push("No se pudieron medir los indicadores de integridad: " + e.message); }
  } catch (e) { DB.call("close", {id}).catch(() => {}); throw e; }
  if (db.recovered.length) db.notes.push(`${db.recovered.length} URLs recuperadas de espacio libre o del -wal`);
  db.rawBytes = null; db.walBytes = null;
  S.dbs.push(db);
  return db;
}
async function buildSources(db) {
  const objs = await qAll(db.id, "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name COLLATE NOCASE");
  const tables = objs.map(r => r[0]), views = new Set(objs.filter(r => r[1] === "view").map(r => r[0]));
  const tset = new Set(tables.filter(t => !views.has(t)));
  for (const [id, title, req, sql] of PRESETS) {
    if (!req.every(t => tset.has(t))) continue;
    try { await qCols(db.id, sql); db.sources.push({id: "p:" + id, title, kind: "preset", sql}); } catch (e) { rethrowCancel(e); /* esquema distinto */ }
  }
  for (const t of tables) {
    // Las vistas de la evidencia no se ejecutan al abrir: una vista malformada (CTE recursiva) podría colgar la consulta
    let n = null; if (!views.has(t)) try { n = Number((await qAll(db.id, `SELECT COUNT(*) FROM ${qi(t)}`))[0][0]); } catch (e) { rethrowCancel(e); }
    db.sources.push({id: "t:" + t, title: views.has(t) ? t + " (vista)" : t, view: views.has(t), rows: n, kind: PRIORITY.has(t) && !views.has(t) ? "priority" : "table", sql: `SELECT * FROM ${qi(t)}`});
  }
}
function sourceSql(db, sid) {
  const s = db.sources.find(s => s.id === sid); if (s) return s.sql;
  if (db.queries.has(sid)) return db.queries.get(sid);
  throw new Error("Fuente desconocida");
}
async function kindsFor(db, sid, sql, cols) {
  if (!db.kindCache.has(sid) && db.forced && db.forced[sid]) {
    const k = {}; for (const c of cols) k[c] = db.forced[sid][c] || null; db.kindCache.set(sid, k);
  }
  if (!db.kindCache.has(sid)) {
    // Una sola lectura de muestra para todas las columnas, hecha en el Worker
    let smp = null; try { smp = await DB.call("sample", {id: db.id, sql}); } catch (e) { rethrowCancel(e); }
    const k = {}; cols.forEach((c, i) => { k[c] = detectKind(c, smp ? smp[i] : []); });
    db.kindCache.set(sid, k);
  }
  const out = {...db.kindCache.get(sid)};
  for (const [key, kind] of db.overrides) { const [s, c] = JSON.parse(key); if (s === sid && c in out) out[c] = kind === "none" ? null : kind; }
  return out;
}

/* ---------------- Filas ---------------- */
function imgUrl(v) {
  if (!(v instanceof Uint8Array) || v.length < 8 || v.length > 300000) return null;
  const s = v, t = s[0] === 0x89 && s[1] === 0x50 ? "png" : s[0] === 0xff && s[1] === 0xd8 ? "jpeg" : s[0] === 0x47 && s[1] === 0x49 ? "gif" : s[0] === 0 && s[1] === 0 && s[2] === 1 && s[3] === 0 ? "x-icon" : s[0] === 0x52 && s[8] === 0x57 ? "webp" : null;
  if (!t) return null;
  let bin = ""; for (let i = 0; i < s.length; i += 8192) bin += String.fromCharCode.apply(null, s.subarray(i, i + 8192));
  return `data:image/${t};base64,${btoa(bin)}`;
}
function expand(cols, kinds, t) {
  const out = [];
  for (const c of cols) { if (kinds[c]) out.push({name: `${c} (${tzLabel(t)})`, src: c, conv: true, kind: kinds[c]}); out.push({name: c, src: c, conv: false, kind: kinds[c]}); }
  return out;
}
function transform(row, cols, kinds, t, full) {
  const out = [];
  cols.forEach((c, i) => { if (kinds[c]) out.push(fmt(row[i], kinds[c], t)); out.push(cellText(row[i], full)); });
  return out;
}
/* Filtros: texto, rango de fechas (hora local de la zona elegida) y solo alertas */
function readFilters() { return {q: $("q").value, from: $("dFrom").value, to: $("dTo").value, col: $("dCol").value, alerts: $("onlyAlerts").checked, cat: $("onlyAlerts").checked ? $("alertCat").value : ""}; }
const NOF = {q: "", from: "", to: "", col: "", alerts: false};
function localToUtcMs(v, end) {
  if (!v) return null; const hasSec = v.length > 16;
  const wall = Date.parse(v + "Z"); if (isNaN(wall)) return null;
  const z = tz(); let u = wall - tzOffMin(z, wall) * 60000; u = wall - tzOffMin(z, u) * 60000; // dos pasadas: cambio de horario
  return u + (end ? (hasSec ? 999 : 59999) : 0);
}
function rawBound(ms, kind) {
  switch (kind) {
    case "webkit": return (BigInt(Math.round(ms)) * 1000n + 11644473600000000n).toString();
    case "unix_us": return (BigInt(Math.round(ms)) * 1000n).toString();
    case "unix_ms": return String(Math.round(ms));
    case "unix_s": return String(ms / 1000);
    case "mac_s": return String((ms - 978307200000) / 1000);
  }
  return null;
}
function pickRangeCol(cols, kinds, wanted) { return kinds[wanted] ? wanted : (cols.find(c => kinds[c]) || ""); }
function buildWhere(cols, kinds, f) {
  const conds = [], params = [];
  if (f.q) { conds.push("(" + cols.map(c => `CAST(${qi(c)} AS TEXT) LIKE ?`).join(" OR ") + ")"); cols.forEach(() => params.push(`%${f.q}%`)); }
  const rc = pickRangeCol(cols, kinds, f.col);
  if (rc && (f.from || f.to)) {
    const lo = localToUtcMs(f.from, false), hi = localToUtcMs(f.to, true);
    if (lo !== null) conds.push(`${qi(rc)} >= ${rawBound(lo, kinds[rc])}`);
    if (hi !== null) conds.push(`${qi(rc)} <= ${rawBound(hi, kinds[rc])}`);
  }
  if (f.alerts) { const [c, p] = alertCond(cols, f.cat); conds.push(c); params.push(...p); }
  return [conds.length ? " WHERE " + conds.join(" AND ") : "", params, rc];
}
async function fetchRows(db, sid, t, f, sort, desc, offset, limit) {
  const sql = sourceSql(db, sid), cols = await qCols(db.id, sql), kinds = await kindsFor(db, sid, sql, cols);
  const [w, params, rc] = buildWhere(cols, kinds, f);
  if (!db.countCache) db.countCache = new Map();
  const ck = sid + "\u0001" + sql + "\u0001" + w + "\u0001" + JSON.stringify(params) + "\u0001" + RULES_VER, cc = db.countCache.get(ck) || {};
  const total = cc.total ?? (cc.total = Number((await qAll(db.id, `SELECT COUNT(*) FROM (${sql})${w}`, params))[0][0]));
  const order = cols.includes(sort) ? ` ORDER BY ${qi(sort)} ${desc ? "DESC" : "ASC"}` : "";
  const rows = await qAll(db.id, `SELECT * FROM (${sql})${w}${order} LIMIT ${limit} OFFSET ${offset}`, params);
  let nAlert = null, alertJob = null;
  if (cc.nAlert === undefined && db === CASE && sid === "s:timeline" && !w && CASE.alertStats && CASE.alertStats.ver === RULES_VER) cc.nAlert = CASE.alertStats.n;
  if (cc.nAlert !== undefined) nAlert = cc.nAlert;
  else if (RULES.length || cols.includes("danger_type")) { const [ac, ap] = alertCond(cols);
    // El conteo de alertas recorre toda la vista: se calcula después de mostrar la tabla
    alertJob = async () => { try { cc.nAlert = Number((await DB.call("all", {id: db.id, sql: `SELECT COUNT(*) FROM (${sql})${w ? w + " AND " : " WHERE "}${ac}`, params: params.concat(ap)}, null, true))[0][0]); } catch (e) { cc.nAlert = null; } return cc.nAlert; }; }
  db.countCache.set(ck, cc);
  return {cols, kinds, rc, nAlert, alertJob, columns: expand(cols, kinds, t), rows: rows.map(r => transform(r, cols, kinds, t, false)),
    raws: rows.map(r => r.map(v => cellText(v, true))), imgs: rows.map(r => r.map(imgUrl)), alerts: rows.map(r => tagRow(r, cols)), terms: rows.map(r => tagTerms(r)), total, offset};
}
async function csvFor(db, sid, t, f, sep, onlyVisible) {
  const sql = sourceSql(db, sid), cols = await qCols(db.id, sql), kinds = await kindsFor(db, sid, sql, cols);
  const [w, params] = buildWhere(cols, kinds, f);
  // Protección contra fórmulas (CSV injection): el texto que Excel interpretaría como fórmula lleva un apóstrofo inicial.
  // Los números (incluidos los negativos) no se tocan; el valor original sigue intacto en la evidencia.
  const cell = s => { s = String(s); if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n;\t]/.test(s) || s.includes(sep) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const ex = expand(cols, kinds, t), hs = new Set(HID[sid] || []);
  const keep = ex.map((c, i) => onlyVisible && isHidden(c, hs) ? -1 : i).filter(i => i >= 0);
  const lines = [["alertas", ...keep.map(i => ex[i].name)].map(cell).join(sep)];
  const rows = await qAll(db.id, `SELECT * FROM (${sql})${w}`, params);
  for (const r of rows) { const tr = transform(r, cols, kinds, t, true); lines.push([tagRow(r, cols).join(" | "), ...keep.map(i => tr[i])].map(cell).join(sep)); }
  return {text: "\ufeff" + lines.join("\r\n") + "\r\n", n: rows.length, kinds};
}

/* ---------------- ZIP (sin compresión) ---------------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makeZip(entries) {
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
  const now = new Date(), dtime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), ddate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, data] of entries) {
    const nb = enc.encode(name), db = typeof data === "string" ? enc.encode(data) : data, crc = crc32(db);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dtime, true); h.setUint16(12, ddate, true); h.setUint32(14, crc, true); h.setUint32(18, db.length, true); h.setUint32(22, db.length, true);
    h.setUint16(26, nb.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), nb, db);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dtime, true); c.setUint16(14, ddate, true); c.setUint32(16, crc, true); c.setUint32(20, db.length, true); c.setUint32(24, db.length, true);
    c.setUint16(28, nb.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nb);
    offset += 30 + nb.length + db.length;
  }
  const csize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, csize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], {type: "application/zip"});
}

/* ---------------- Guardar archivos ---------------- */
let downloadsNs;
async function saveFile(filename, data) {
  if (downloadsNs === undefined) downloadsNs = window.claude && window.claude.use ? await window.claude.use("downloads").catch(() => null) : null;
  if (downloadsNs) {
    try { await downloadsNs.save({filename, data}); toast("Archivo entregado: " + filename); }
    catch (e) { if (e && e.code !== "declined") toast("No se pudo guardar: " + (e.message || e.code)); }
    return;
  }
  const blob = data instanceof Blob ? data : new Blob([data]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
const safe = s => String(s).replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "tabla";
function sepVal() { const v = $("sep").value; return v === "tab" ? "\t" : v; }
function nowLocal() { return fmt(BigInt(Date.now()), "unix_ms", tz()); }

async function exportCsv() {
  const db = cur(); if (!db) return;
  const fmtSel = $("expFmt").value, t = tz(), base = `${safe(db.label)}_${safe(S.src.slice(2))}_${tzLabel(t)}`;
  try {
    if (fmtSel === "csv") { const r = await csvFor(db, S.src, t, readFilters(), sepVal(), true); saveFile(base + ".csv", r.text); return; }
    const r = await fmtFor(db, S.src, t, readFilters(), fmtSel);
    if (!r.n) { toast(fmtSel === "jsonl" ? "No hay filas para exportar." : "No hay filas con fecha para exportar en este formato."); return; }
    saveFile(base + {jsonl: ".jsonl", body: ".bodyfile.txt", l2t: ".l2t.csv"}[fmtSel], r.text);
  } catch (e) { if (!e.cancelled) toast("No se pudo exportar: " + e.message); }
}
/* JSONL, bodyfile (mactime de The Sleuth Kit) y l2t CSV (log2timeline): para llevar la línea de tiempo a Timesketch, Plaso o mactime */
async function fmtFor(db, sid, t, f, kind) {
  const sql = sourceSql(db, sid), cols = await qCols(db.id, sql), kinds = await kindsFor(db, sid, sql, cols);
  const [w, params] = buildWhere(cols, kinds, f), ex = expand(cols, kinds, t), rows = await qAll(db.id, `SELECT * FROM (${sql})${w}`, params);
  const rc = pickRangeCol(cols, kinds, (f && f.col) || "momento"), ri = rc ? cols.indexOf(rc) : -1, ci = c => cols.indexOf(c);
  const view = (db.sources.find(x => x.id === sid) || {}).title || "Consulta SQL", out = [];
  const textOf = r => { // descripción: en la línea de tiempo, tipo + url + título + detalle; en otras tablas, las columnas que no son fecha
    if (ci("tipo") >= 0 && ci("url") >= 0) return [r[ci("tipo")], r[ci("url")], r[ci("titulo")], r[ci("detalle")], r[ci("interpretacion")]].map(v => cellText(v, false)).filter(Boolean).join(" · ");
    return cols.map((c, i) => kinds[c] ? "" : (r[i] instanceof Uint8Array ? "" : cellText(r[i], false))).filter(Boolean).join(" · ");
  };
  const csvCell = s => { s = String(s ?? ""); if (s !== "-" && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  if (kind === "l2t") out.push("date,time,timezone,MACB,source,sourcetype,type,user,host,short,desc,version,filename,inode,notes,format,extra");
  for (const r of rows) {
    const ms = ri >= 0 ? toMs(r[ri], kinds[rc]) : null, ok = ms != null && isFinite(ms) && Math.abs(ms) < 8.64e15;
    if (kind === "jsonl") {
      const tr = transform(r, cols, kinds, t, true), o = {evidencia: db.virtual ? undefined : db.path, vista: view};
      if (ok) o.timestamp_utc = new Date(ms).toISOString();
      ex.forEach((c, i) => { o[c.name] = tr[i]; });
      const tags = tagRow(r, cols); if (tags.length) o.alertas = tags;
      out.push(JSON.stringify(o)); continue;
    }
    if (!ok) continue;
    const desc = textOf(r), alerts = tagRow(r, cols).join(" | ");
    if (kind === "body") { const sec = Math.floor(ms / 1000), name = `[${db.virtual ? cellText(r[ci("artefacto")], false) : db.label}] ${desc}`.replace(/[|\r\n]/g, " ").slice(0, 2000);
      out.push(`0|${name}|0|-|0|0|0|${sec}|${sec}|${sec}|${sec}`); continue; }
    const d = new Date(ms + tzOffMin(t, ms) * 60000), date = `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${d.getUTCFullYear()}`, time = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
    const typ = ci("tipo") >= 0 ? cellText(r[ci("tipo")], false) : rc, short = ci("url") >= 0 && r[ci("url")] ? cellText(r[ci("url")], false) : desc;
    const extra = ["fuente", "confianza", "base_tiempo"].filter(c => ci(c) >= 0 && r[ci(c)]).map(c => `${c}: ${r[ci(c)]}`).join("; ");
    out.push([date, time, tzLabel(t), ".A..", "WEBHIST", `Navestigio: ${view}`, typ, "-", "-", short.slice(0, 200), desc, 2,
      db.virtual ? cellText(r[ci("artefacto")], false) : db.path, "-", alerts, "navestigio", extra].map(csvCell).join(","));
  }
  return {text: (kind === "l2t" ? "﻿" : "") + out.join(kind === "l2t" ? "\r\n" : "\n") + "\n", n: kind === "l2t" ? out.length - 1 : out.length};
}

/* ---------------- Paquete de entrega verificable ----------------
   El ZIP lleva: CSV por tabla, informe.html, manifest.json (cadena de custodia en formato de máquina) y
   SHA256SUMS.txt con el hash de cada archivo del paquete, verificable con «sha256sum -c SHA256SUMS.txt». */
const BUILD_ID = "@@BUILD@@";
async function exportZip() {
  const db = cur(); if (!db) return;
  const t = tz(), entries = [], dbs = db.virtual ? realDbs() : [db], files = [];
  const lines = [`Navestigio v@@VERSION@@ · forense de navegadores · compilación ${BUILD_ID.slice(0, 16)}`, `Generado: ${nowLocal()} (${tzLabel(t)})`, `Evidencia: ${db.path}${db.sample ? " (DATOS DE EJEMPLO)" : ""}`,
    "Hashes de la evidencia original (SHA-256 · MD5):", ...dbs.flatMap(d => d.hashes.map(([k, v, m]) => `  ${k}  ${v}  ${m || ""}`))];
  for (const d of dbs) if (d.walInfo) lines.push(`WAL aplicado (${d.label}): ${d.walInfo.commits} transacciones, ${d.walInfo.frames} frames, ${d.walInfo.pages} páginas${d.walInfo.note ? " · " + d.walInfo.note : ""}`);
  const ir = dbs.flatMap(integrityRows).sort((a, b) => ({Alta: 0, Media: 1}[a[4]] ?? 2) - ({Alta: 0, Media: 1}[b[4]] ?? 2)), sc = scopeInfo();
  const when = r => r[0] ? (r[1] ? `Desde ${fmt(r[0], "webkit", t)} hasta ${fmt(r[1], "webkit", t)} (${tzLabel(t)})` : `Fecha: ${fmt(r[0], "webkit", t)} (${tzLabel(t)})`) : "";
  lines.push("", "Indicadores de integridad (prioridad · confianza · indicador · detalle · interpretación):",
    ...(ir.length ? ir.map(r => `  [${r[4]} · confianza ${r[5]}] ${r[3]}${db.virtual ? ` (${r[2]})` : ""}. ${r[6]}${r[0] ? " " + when(r) + "." : ""} ${r[7]}`) : ["  Ninguno."]),
    "", "Alcance: se analizó", ...sc.done.map(x => "  - " + x), "Alcance: no se analizó", ...sc.not.map(x => "  - " + x), "");
  lines.push(...db.notes, `Zona horaria de conversión: ${tzLabel(t)}`, "Las columnas convertidas llevan el sufijo de la zona horaria; la columna cruda se conserva al lado.", "Protección para Excel: las celdas de texto que empiezan por = + - @ llevan un apóstrofo (') inicial para que no se ejecuten como fórmula; los números no se modifican.", "", "Archivo | filas | columnas de fecha (formato)");
  for (const s of db.sources) {
    if (!s.sql) continue;
    try {
      const r = await csvFor(db, s.id, t, NOF, sepVal());
      const fname = (s.kind === "preset" ? "00_vista_" : "") + safe(s.id.slice(2)) + ".csv", kinds = Object.entries(r.kinds).filter(([, k]) => k).map(([c, k]) => `${c}(${k})`).join(", ") || "-";
      entries.push([fname, r.text]); files.push({archivo: fname, tabla: s.title, filas: r.n, fechas: kinds});
      lines.push(`${fname} | ${r.n} | ${kinds}`);
    } catch (e) { if (e.cancelled) return; lines.push(`${s.title}: ERROR ${e.message}`); }
  }
  if (db.virtual) for (const [k, ext] of [["jsonl", "jsonl"], ["body", "bodyfile.txt"], ["l2t", "l2t.csv"]]) {
    try { const r = await fmtFor(db, "s:timeline", t, NOF, k), fname = `linea_de_tiempo.${ext}`; entries.push([fname, r.text]); files.push({archivo: fname, tabla: "Línea de tiempo unificada", filas: r.n, formato: k}); lines.push(`${fname} | ${r.n} | momento`); }
    catch (e) { if (e.cancelled) return; }
  }
  lines.push("", "Verificación: SHA256SUMS.txt trae el SHA-256 de cada archivo de este paquete. En Linux o macOS: sha256sum -c SHA256SUMS.txt. En Windows: certutil -hashfile <archivo> SHA256.");
  entries.push(["LEEME_cadena_custodia.txt", lines.join("\r\n")]);
  let sqliteVer = ""; try { sqliteVer = String((await qAll("caso", "SELECT sqlite_version()"))[0][0]); } catch (e) { rethrowCancel(e); }
  entries.push(["informe.html", reportHtml(db, dbs, ir, sc, t)]);
  const enc = new TextEncoder(), bytesOf = x => typeof x === "string" ? enc.encode(x) : x;
  const sums = []; for (const [n, d] of entries) { const b = bytesOf(d); sums.push({archivo: n, bytes: b.length, sha256: await sha256(b)}); }
  const manifest = {
    formato: "navestigio-manifest/1",
    herramienta: {nombre: "Navestigio", version: "@@VERSION@@", compilacion: BUILD_ID, sqlite: sqliteVer, navegador: navigator.userAgent},
    generado: {utc: new Date().toISOString(), local: nowLocal(), zona_horaria: tzLabel(t), regla_zona: typeof t === "string" ? "zona IANA, con horario de verano" : "desfase fijo, sin horario de verano"},
    exportacion: {vista: db.virtual ? "Análisis del caso" : db.label, filtros: "ninguno: el ZIP exporta las tablas completas"},
    evidencias: dbs.map(d => ({nombre: d.label, ruta: d.path, bytes: d.size, datos_de_ejemplo: !!d.sample, tipo: d.json ? "JSON" : "SQLite",
      archivos: d.hashes.map(([k, v, m]) => ({archivo: k, sha256: v, md5: m || null})),
      wal: d.walInfo ? {transacciones: d.walInfo.commits, frames: d.walInfo.frames, paginas: d.walInfo.pages, nota: d.walInfo.note || null} : null, journal_presente: !!d.journal, notas: d.notes})),
    reglas_de_alerta: {sha256: await sha256(enc.encode(RULES_TEXT)), categorias: RULES.map(r => r.name)},
    indicadores_de_integridad: ir.map(r => ({artefacto: r[2], indicador: r[3], prioridad: r[4], confianza: r[5], detalle: r[6], interpretacion: r[7], tabla: r[8] || null,
      desde_utc: r[0] ? new Date(toMs(r[0], "webkit")).toISOString() : null, hasta_utc: r[1] ? new Date(toMs(r[1], "webkit")).toISOString() : null})),
    alcance: {analizado: sc.done, no_analizado: sc.not},
    hallazgos_marcados: marksOf(dbs).length,
    archivos: sums.map(x => ({...x, ...(files.find(f => f.archivo === x.archivo) || {})})),
    verificacion: "sha256sum -c SHA256SUMS.txt (Linux/macOS) · certutil -hashfile <archivo> SHA256 (Windows)"};
  const mj = JSON.stringify(manifest, null, 2);
  entries.push(["manifest.json", mj]); sums.push({archivo: "manifest.json", sha256: await sha256(enc.encode(mj))});
  entries.push(["SHA256SUMS.txt", sums.map(x => `${x.sha256}  ${x.archivo}`).join("\n") + "\n"]);
  saveFile(`${safe(db.label)}_completo_${tzLabel(t)}.zip`, makeZip(entries));
}
function marksOf(dbs) { const shas = new Set(dbs.map(d => d.hashes[0] && d.hashes[0][1])); return MARKS.filter(m => shas.has(m.sha)); }
/* Informe HTML autónomo: sin scripts ni recursos externos (CSP), todo el texto escapado */
function reportHtml(db, dbs, ir, sc, t) {
  const tbl = (head, rows) => rows.length ? `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>` : '<p class="m">Ninguno.</p>';
  const when = r => r[0] ? esc(fmt(r[0], "webkit", t)) + (r[1] ? " – " + esc(fmt(r[1], "webkit", t)) : "") : "";
  const marks = marksOf(dbs).slice().sort((a, b) => String(b.momento || "").localeCompare(String(a.momento || ""), undefined, {numeric: true}));
  const st = db.virtual && CASE.alertStats ? [...CASE.alertStats.cats].sort((a, b) => b[1].n - a[1].n) : [];
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Informe Navestigio · ${esc(db.label)}</title><style>
body{font:14px/1.5 system-ui,"Segoe UI",Roboto,sans-serif;color:#17202b;background:#fff;max-width:1100px;margin:24px auto;padding:0 16px}
h1{font-size:24px;margin:0}h2{font-size:17px;margin:28px 0 8px;border-bottom:2px solid #1f5fae;padding-bottom:4px}
.m{color:#5d6b7a}table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{border:1px solid #dfe4ea;padding:4px 6px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{background:#f4f6f8;white-space:nowrap}.s{white-space:nowrap}code,.h{font-family:Consolas,monospace;font-size:11.5px}.p{font-weight:600;white-space:nowrap}.Alta{color:#b42318}.Media{color:#7a4b00}
.n{background:#fdf6e3;border-left:3px solid #a8650a;padding:8px 10px;margin:12px 0}ul{margin:4px 0}
@media print{body{margin:0}h2{break-after:avoid}tr{break-inside:avoid}}</style></head><body>
<h1>Informe de análisis de navegador</h1>
<p class="m">${esc(db.virtual ? "Análisis del caso: todas las evidencias abiertas" : db.path)} · generado ${esc(nowLocal())} · fechas en ${esc(tzLabel(t))} · Navestigio v@@VERSION@@ (compilación <code>${esc(BUILD_ID.slice(0, 16))}</code>)</p>
<div class="n">Prioridad, confianza e interpretación son cosas distintas. La <b>prioridad</b> indica dónde mirar primero. La <b>confianza</b> indica qué tan sólido es el hecho medido. La <b>interpretación</b> dice con qué es consistente el hecho; no afirma lo que hizo el usuario.</div>
<h2>Evidencias</h2>${tbl(["Evidencia", "Ruta", "Tamaño", "SHA-256", "MD5"], dbs.flatMap(d => d.hashes.map(([k, v, m], i) => [esc(k) + (d.sample ? " (ejemplo)" : ""), i ? "" : esc(d.path), i ? "" : `<span class="s">${esc(fmtSize(d.size))}</span>`, `<span class="h">${esc(v)}</span>`, `<span class="h">${esc(m || "")}</span>`])))}
<h2>Indicadores de integridad</h2>${tbl(["Prioridad", "Confianza", "Indicador", "Evidencia", "Fechas", "Detalle", "Interpretación"], ir.map(r => [`<span class="p ${esc(r[4])}">${esc(r[4])}</span>`, `<span class="s">${esc(r[5])}</span>`, esc(r[3]), `<span class="s">${esc(r[2])}</span>`, when(r), esc(r[6]), esc(r[7])]))}
<h2>Hallazgos marcados</h2>${tbl(["Momento", "Evidencia", "Origen", "Resumen", "Nota del analista"], marks.map(m => [m.momento ? esc(fmt(m.momento, "webkit", t)) : "", esc(m.artefacto), esc(m.fuente), esc(m.resumen), esc(m.nota || "")]))}
${db.virtual ? `<h2>Alertas por categoría</h2><p class="m">Prioridad de revisión, no prueba de conducta: la URL o el título contienen un término de la regla.</p>${tbl(["Categoría", "Eventos", "Sitios principales"], st.map(([nm, c]) => [esc(nm), nf(c.n), esc([...c.hosts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([h, n]) => `${h} (${n})`).join(", "))]))}` : ""}
<h2>Alcance del análisis</h2><p><b>Se analizó</b></p><ul>${sc.done.map(x => `<li>${esc(x)}</li>`).join("")}</ul><p><b>No se analizó</b></p><ul>${sc.not.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
<h2>Verificación</h2><p>Este paquete incluye <code>manifest.json</code> (hashes de cada evidencia, versión, zona horaria y reglas) y <code>SHA256SUMS.txt</code> con el SHA-256 de cada archivo. Verifíquelo con <code>sha256sum -c SHA256SUMS.txt</code> en Linux o macOS, o con <code>certutil -hashfile archivo SHA256</code> en Windows.</p>
</body></html>`;
}

/* ---------------- Interfaz ---------------- */
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.remove("hide"); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add("hide"), 4500); }
function cur() { return S.dbs.find(d => d.id === S.db); }
function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : (n / 1024).toFixed(0) + " KB"; }
function renderSide() {
  const el = $("side");
  if (!S.dbs.length) { el.innerHTML = '<p class="muted">Abra un artefacto con «Abrir archivos…» o arrástrelo a la ventana.</p>'; return; }
  el.innerHTML = S.dbs.map(d => {
    const item = s => `<div class="src ${s.kind}${S.db === d.id && S.src === s.id ? " on" : ""}" tabindex="0" data-db="${d.id}" data-src="${esc(s.id)}"><span class="t">${esc(s.title)}</span>${s.rows != null ? `<span class="n">${s.rows}</span>` : ""}</div>`;
    const grp = (label, list) => list.length ? `<div class="sect">${label}</div>` + list.map(item).join("") : "";
    if (d.virtual) return `<div class="db dbcase"><div class="dbh"><b>${esc(d.label)}</b></div><div class="meta">${realDbs().length} ${realDbs().length === 1 ? "evidencia abierta" : "evidencias abiertas"}</div>${d.sources.map(item).join("")}</div>`;
    const wal = d.walInfo ? `<div class="meta">WAL: ${d.walInfo.commits} transacciones aplicadas${d.walInfo.note ? " · " + esc(d.walInfo.note) : ""}</div>` : "";
    return `<div class="db"><div class="dbh"><b title="${esc(d.path)}">${esc(d.label)}${d.sample ? '<span class="tag">ejemplo</span>' : ""}</b><button type="button" data-close="${d.id}" aria-label="Cerrar ${esc(d.label)}">✕</button></div>
      <div class="meta">${fmtSize(d.size)} · SHA-256<br>${d.hashes.map(([k, v]) => esc(k) + ": " + v).join("<br>")}</div>${wal}${d.notes.map(n => `<div class="meta">${esc(n)}</div>`).join("")}
      ${grp("Vistas de análisis", d.sources.filter(s => s.kind === "preset"))}${grp("Tablas clave", d.sources.filter(s => s.kind === "priority"))}${grp("Otras tablas", d.sources.filter(s => s.kind === "table"))}</div>`;
  }).join("");
}
function pickFirst(d) { const s = d.sources.find(s => s.kind === "preset") || d.sources.find(s => s.kind === "priority") || d.sources.find(s => !s.view); if (s) pick(d.id, s.id); }
function pick(dbId, sid) {
  Object.assign(S, {db: dbId, src: sid, offset: 0, sort: null, desc: false}); $("q").value = "";
  if (sid === "s:resumen") { showPanel("summary"); renderSide(); renderSummary(); return; }
  showPanel("view");
  renderSide(); load();
}
let LOADGEN = 0;
async function load() {
  const db = cur(); if (!db) return;
  const gen = ++LOADGEN;
  if (S.src === "s:resumen") { renderSummary().catch(rethrowCancel); return; }
  let data;
  try { data = await fetchRows(db, S.src, tz(), readFilters(), S.sort, S.desc, S.offset, Number($("limit").value)); }
  catch (e) { if (gen === LOADGEN) $("grid").innerHTML = `<p class="err" style="padding:12px">${esc(e.cancelled ? "Consulta cancelada." : e.message)}</p>`; return; }
  if (gen !== LOADGEN || cur() !== db) return; // el usuario ya pidió otra vista
  S.data = data;
  const s = db.sources.find(s => s.id === S.src);
  $("vtitle").textContent = db.label + " › " + (s ? s.title : "Consulta SQL");
  renderGrid(); renderKinds(); renderFbar();
  const sl = $("scanline"); if (sl && !document.body.classList.contains("capture")) { sl.style.setProperty("--h", Math.min($("grid").scrollHeight, $("grid").clientHeight) + "px"); sl.style.top = $("grid").scrollTop + "px"; sl.classList.add("go"); }
  const v = $("view"); v.classList.remove("enter"); void v.offsetWidth; v.classList.add("enter");
}
function renderFbar() {
  const d = S.data, sel = $("dCol"), dc = d.cols.filter(c => d.kinds[c]);
  sel.innerHTML = dc.length ? dc.map(c => `<option value="${esc(c)}"${c === d.rc ? " selected" : ""}>${esc(c)}</option>`).join("") : '<option value="">(sin columnas de fecha)</option>';
  const f = readFilters(), active = f.from || f.to || f.alerts;
  $("fbar").classList.toggle("active", !!active);
  $("fsum").textContent = d.nAlert != null ? `${d.nAlert} filas con alerta en esta vista` : d.alertJob ? "contando alertas…" : "";
  if (d.alertJob) { const job = d.alertJob; d.alertJob = null; clearTimeout(renderFbar.h);
    renderFbar.h = setTimeout(async () => { if (S.data !== d) return; d.nAlert = await job(); if (S.data === d) $("fsum").textContent = d.nAlert != null ? `${d.nAlert} filas con alerta en esta vista` : ""; }, 60); }
}
function renderGrid() {
  const d = S.data;
  const vis = visibleIdx(), mk = markKeys(), isF = S.src === "s:hallazgos", showAl = d.alerts.some(a => a.length);
  const idI = d.cols.indexOf("id");
  d.marked = d.raws.map((r, ri) => isF || mk.has(rowKey(ri)));
  let h = `<table><thead><tr><th class="mk" title="Marcar como hallazgo">★</th>${showAl ? '<th class="al">Alertas<span class="rs" data-rs="__alertas" title="Arrastre para cambiar el ancho · doble clic para ajuste automático"></span></th>' : ""}` + vis.map(i => { const c = d.columns[i]; return `<th class="${c.conv ? "conv" : ""}" data-sort="${esc(c.src)}" title="${c.kind ? esc(EPOCHS[c.kind]) : ""}">${esc(c.name)}${S.sort === c.src && !c.conv ? (S.desc ? " ▼" : " ▲") : ""}<span class="x" role="button" tabindex="0" data-hide="${esc(colKey(c))}" title="Ocultar columna" aria-label="Ocultar ${esc(c.name)}">✕</span><span class="rs" data-rs="${esc(colKey(c))}" title="Arrastre para cambiar el ancho · doble clic para ajuste automático"></span></th>`; }).join("") + "</tr></thead><tbody>";
  d.rows.forEach((r, ri) => { const tags = d.alerts[ri], on = d.marked[ri];
    h += `<tr data-row="${ri}" style="--i:${Math.min(ri, 40)}" class="${tags.length ? "alert" : ""}${on ? " marked" : ""}"><td class="mk"><button type="button" class="star${on ? " on" : ""}" data-mark="${ri}" aria-label="${on ? "Quitar hallazgo" : "Marcar como hallazgo"}" title="${on ? "Quitar hallazgo" : "Marcar como hallazgo"}">${on ? "★" : "☆"}</button></td>${showAl ? `<td class="al">${tags.map(t => `<span class="chip${t === DANGER ? " danger" : ""}" title="${t === DANGER ? "danger_type distinto de 0" : esc("Prioridad de revisión · coincide con «" + (d.terms[ri][t] || "") + "» · no prueba intención")}">${esc(t).replace(/\//g, "/<wbr>")}</span>`).join("")}</td>` : ""}` + vis.map(i => { const c = d.columns[i], v = r[i], im = !c.conv && d.imgs[ri][d.cols.indexOf(c.src)]; return `<td class="${c.conv ? "conv" : c.kind ? "raw" : ""}${String(v).length > 40 && !im ? " long" : ""}" title="${esc(v)}">${im ? `<img class="thumb" src="${im}" alt="imagen">` : ""}${esc(v)}</td>`; }).join("") + "</tr>"; });
  if (!d.rows.length) h += `<tr><td class="muted" colspan="${vis.length + 2}">${isF ? "Aún no hay hallazgos. Marque filas con ☆ en cualquier tabla." + (MK_FILE ? " Abierto con doble clic, los hallazgos solo duran mientras esta pestaña esté abierta: exporte el caso (ZIP) antes de cerrarla o use iniciar_navestigio.bat." : "") : "Sin resultados."}</td></tr>`;
  if (!vis.length) h = `<p class="muted" style="padding:12px">Todas las columnas están ocultas. Use «Columnas visibles» para mostrarlas.</p>`;
  $("grid").innerHTML = (vis.length ? h + "</tbody></table>" : h) + '<div id="scanline"></div>';
  S.colOrder = vis.map(i => colKey(d.columns[i])); S.colOffset = 1 + (showAl ? 1 : 0); S.showAl = showAl; applyWidths();
  const end = Math.min(d.offset + d.rows.length, d.total), nh = d.columns.length - vis.length;
  $("pinfo").textContent = `${d.total ? d.offset + 1 : 0}–${end} de ${d.total} filas${nh ? ` · ${nh} columnas ocultas` : ""} · doble clic en una fila para ver el detalle`;
  renderCols(); renderCaption();
}
function renderKinds() {
  const opts = k => ["auto", "none", ...Object.keys(EPOCHS)].map(o => `<option value="${o}"${o === k ? " selected" : ""}>${o === "auto" ? "(automático)" : o === "none" ? "no es fecha" : o}</option>`).join("");
  $("kinds").innerHTML = '<span class="muted">Formato por columna (cámbielo si la detección automática se equivoca):</span><div class="kinds">' +
    S.data.cols.map(c => `<label class="${S.data.kinds[c] ? "" : "muted"}">${esc(c)} <select data-col="${esc(c)}">${opts(S.data.kinds[c] || "none")}</select></label>`).join("") + "</div>";
}
function renderCols() {
  const d = S.data, hs = hiddenSet();
  $("colsbar").innerHTML = `<span class="muted">Marque las columnas que quiere ver. Se recuerda para esta tabla en este navegador.</span>
    <button type="button" data-colact="all">Mostrar todas</button>
    <button type="button" data-colact="raw">${HIDE_RAW ? "Mostrar" : "Ocultar"} valores crudos de fecha</button>
    <button type="button" data-colact="none">Ocultar todas</button>
    <button type="button" data-colact="wrap">${WRAP ? "No ajustar" : "Ajustar"} texto a la celda</button>
    <button type="button" data-colact="widths">Restablecer anchos</button>
    <div class="cols">` + d.columns.map(c => { const off = isHidden(c, hs);
      return `<label class="${c.conv ? "c" : ""}${off ? " off" : ""}"><input type="checkbox" data-col="${esc(colKey(c))}"${off ? "" : " checked"}${HIDE_RAW && c.kind && !c.conv ? " disabled" : ""}>${esc(c.name)}</label>`; }).join("") + "</div>";
}
function renderCaption() {
  const db = cur(); if (!db) return; const d = S.data;
  const s = db.sources.find(s => s.id === S.src), q = $("q").value;
  const end = Math.min(d.offset + d.rows.length, d.total);
  $("caption").innerHTML = `<b>${esc(db.label)} › ${esc(s ? s.title : "Consulta SQL")}</b>${db.sample ? ' <span class="tag">ejemplo</span>' : ""}
    <div class="meta">Evidencia: ${esc(db.path)} · ${db.hashes.map(([k, v]) => `SHA-256 ${esc(k)}: ${v}`).join(" · ")}</div>
    <div class="meta">Fechas en ${tzLabel(tz())} · filas ${d.total ? d.offset + 1 : 0}–${end} de ${d.total}${q ? ` · filtro: «${esc(q)}»` : ""}${(() => { const f = readFilters(); return (f.from || f.to ? ` · ${esc(d.rc)} entre ${esc((f.from || "…").replace("T", " "))} y ${esc((f.to || "…").replace("T", " "))}` : "") + (f.alerts ? (f.cat ? ` · alerta: ${esc(f.cat)}` : " · solo filas con alerta") : ""); })()}${S.sort ? ` · orden: ${esc(S.sort)} ${S.desc ? "desc" : "asc"}` : ""}${db.walInfo && db.walInfo.commits ? " · WAL aplicado" : ""} · generado ${nowLocal()}</div>`;
}
function setCapture(on) { document.body.classList.toggle("capture", on); $("detail").classList.add("hide"); if (on) toast("Modo captura: tome el pantallazo. Esc para salir."); }
function rowKey(ri) { const db = cur(), d = S.data, s = db.sources.find(s => s.id === S.src);
  return (db.virtual ? "caso" : db.hashes[0] ? db.hashes[0][1] : db.id) + "|" + (s ? s.title : S.src) + "|" + JSON.stringify(d.raws[ri]); }
function markFor(ri) {
  const d = S.data;
  if (S.src === "s:hallazgos") { const id = d.raws[ri][d.cols.indexOf("id")]; return MARKS.find(m => m.id === id); }
  const k = rowKey(ri); return MARKS.find(m => m.key === k);
}
async function addMark(ri) {
  const db = cur(), d = S.data, s = db.sources.find(s => s.id === S.src);
  const dc = d.rc || d.cols.find(c => d.kinds[c]); let momento = "";
  if (dc) { const w = toWebkit(d.raws[ri][d.cols.indexOf(dc)], d.kinds[dc]); momento = w === null ? "" : w.toString(); }
  const vis = visibleIdx().filter(i => !(d.columns[i].kind && !d.columns[i].conv));
  let artefacto = db.sample ? db.label + " (ejemplo)" : db.path, sha = db.hashes[0] ? db.hashes[0][1] : "";
  if (db.virtual) { const ai = d.cols.indexOf("artefacto"); if (ai >= 0) { artefacto = d.raws[ri][ai]; const h = db.hashes.find(x => x[0] === artefacto); sha = h ? h[1] : (realDbs()[0] && realDbs()[0].hashes[0] ? realDbs()[0].hashes[0][1] : ""); } }
  const m = {id: Math.random().toString(36).slice(2, 10), key: rowKey(ri), artefacto, sha, fuente: s ? s.title : "Consulta SQL", momento,
    resumen: vis.map(i => d.rows[ri][i]).filter(v => v !== "").join(" | ").slice(0, 600),
    detalle: d.columns.map((c, i) => `${c.name}: ${d.rows[ri][i]}`).join("\n"), nota: "", marcado: Date.now()};
  MARKS.push(m); saveMarks(); await rebuildFindings(); return m;
}
async function removeMark(m) { MARKS = MARKS.filter(x => x !== m); saveMarks(); await rebuildFindings(); }
async function toggleMark(ri) {
  const m = markFor(ri);
  if (m) await removeMark(m); else await addMark(ri);
  renderSide(); bumpCounts("s:hallazgos"); if (S.src === "s:hallazgos") load(); else { renderGrid(); popStar(ri); }
}
function popStar(ri) { const b = document.querySelector(`[data-mark="${ri}"]`); if (b) { b.classList.add("pop"); b.parentElement.parentElement.style.animation = "none"; } }
function bumpCounts(only) { document.querySelectorAll(only ? `.src[data-src="${only}"] .n` : ".src.case .n").forEach(n => { n.classList.remove("bump"); void n.offsetWidth; n.classList.add("bump"); }); }
function detail(ri) {
  const d = S.data, r = d.rows[ri], m = markFor(ri);
  const box = m ? `<div class="mkbox"><b>★ Hallazgo marcado</b><label for="mkNote" class="muted">Nota para el informe</label><textarea id="mkNote" rows="3">${esc(m.nota || "")}</textarea><div><button type="button" id="mkSave" class="primary">Guardar nota</button> <button type="button" id="mkDel">Quitar hallazgo</button></div></div>`
    : `<div class="mkbox"><button type="button" id="mkAdd" class="primary">☆ Marcar como hallazgo</button></div>`;
  const tags = d.alerts[ri].length ? `<p>${d.alerts[ri].map(t => `<span class="chip">${esc(t)}${d.terms[ri][t] ? ` · «${esc(d.terms[ri][t])}»` : ""}</span>`).join("")}</p>
    <p class="muted interp"><b>Prioridad:</b> revisar primero. <b>Interpretación:</b> la fila contiene un término de la regla; es consistente con una visita, una búsqueda o una carga automática de esa dirección. No prueba intención ni conducta.</p>` : "";
  const rcI = d.rc ? d.cols.indexOf(d.rc) : -1, rawT = rcI >= 0 ? d.raws[ri][rcI] : "", atMs = rawT ? toMs(rawT, d.kinds[d.rc]) : null;
  const around = atMs != null && isFinite(atMs) ? `<div class="mkbox"><b>Qué pasó justo antes y después</b><div><label for="arW" class="muted">Ventana</label> <select id="arW"><option value="5">± 5 min</option><option value="15" selected>± 15 min</option><option value="60">± 1 hora</option><option value="1440">± 1 día</option></select> <button type="button" id="arGo" class="primary">Ver en la línea de tiempo</button></div></div>` : "";
  $("detail").innerHTML = `<p><button type="button" id="closeDetail">Cerrar</button></p>${box}${around}${tags}<table>` + d.columns.map((c, i) => `<tr><th>${esc(c.name)}</th><td class="${c.conv ? "conv" : ""}">${esc(r[i])}</td></tr>`).join("") + "</table>";
  $("detail").classList.remove("hide"); $("closeDetail").onclick = () => $("detail").classList.add("hide");
  if (around) $("arGo").onclick = () => {
    const w = Number($("arW").value) * 60000, z = tz(), loc = x => new Date(x + tzOffMin(z, x) * 60000).toISOString().slice(0, 19);
    $("detail").classList.add("hide");
    sumGoto({from: loc(atMs - w), to: loc(atMs + w), msg: `Línea de tiempo ${$("arW").selectedOptions[0].textContent} alrededor de ${fmt(rawT, d.kinds[d.rc], z)}`});
  };
  const after = () => { renderSide(); if (S.src === "s:hallazgos") load(); else renderGrid(); };
  if (m) {
    $("mkSave").onclick = async () => { m.nota = $("mkNote").value; saveMarks(); await rebuildFindings(); toast("Nota guardada"); after(); };
    $("mkDel").onclick = async () => { await removeMark(m); $("detail").classList.add("hide"); after(); };
  } else $("mkAdd").onclick = async () => { await addMark(ri); after(); detail(ri); };
}
async function runSql() {
  const db = cur(); if (!db) return;
  const sql = $("sql").value.trim().replace(/;\s*$/, "");
  if (!/^\s*(select|with)\b/i.test(sql) || /;\s*\S/.test(sql)) { toast("Solo se permite una consulta SELECT o WITH."); return; }
  try { await qCols(db.id, sql); } catch (e) { if (!e.cancelled) toast("Error SQL: " + e.message); return; }
  const id = "q:" + Math.random().toString(36).slice(2, 8); db.queries.set(id, sql);
  Object.assign(S, {src: id, offset: 0, sort: null}); $("q").value = ""; renderSide(); load();
}
function convert() {
  const t = tz(), kindSel = $("ckind").value;
  const rows = $("cvals").value.split(/[\s,;]+/).filter(Boolean).map(raw => {
    if (!/^-?\d+(\.\d+)?$/.test(raw)) return `<tr><td>${esc(raw)}</td><td colspan="3" class="err">No es numérico</td></tr>`;
    const v = /\./.test(raw) ? Number(raw) : BigInt(raw);
    const kind = kindSel === "auto" ? (classify(Number(raw), true) || "webkit") : kindSel;
    return `<tr><td class="mono">${esc(raw)}</td><td>${esc(EPOCHS[kind])}</td><td class="conv">${fmt(v, kind, t)}</td><td>${fmt(v, kind, 0)}</td></tr>`;
  });
  $("cout").innerHTML = `<table class="convtable"><thead><tr><th>Valor</th><th>Formato</th><th>${tzLabel(t)}</th><th>UTC</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

/* Eventos */
(function initTz() {
  const sel = $("tz");
  const g1 = document.createElement("optgroup"); g1.label = "Desfase fijo (sin horario de verano)";
  const fixed = []; for (let h = -12; h <= 14; h++) fixed.push(h);
  fixed.concat([-9.5, -3.5, 3.5, 4.5, 5.5, 5.75, 6.5, 8.75, 9.5, 10.5, 12.75, 13.75]).sort((a, b) => a - b)
    .forEach(h => g1.appendChild(new Option(tzLabel(h) + (h === -5 ? " (Colombia)" : ""), String(h), false, h === -5)));
  sel.appendChild(g1);
  try { const g2 = document.createElement("optgroup"); g2.label = "Zona con horario de verano (IANA)";
    for (const z of Intl.supportedValuesOf("timeZone")) g2.appendChild(new Option(z.replace(/_/g, " "), z)); sel.appendChild(g2); } catch (e) {}
  try { const v = localStorage.getItem("visor_tz"); if (v !== null) sel.value = v; } catch (e) {}
  const ck = $("ckind"); ck.add(new Option("Detectar", "auto")); for (const [k, v] of Object.entries(EPOCHS)) ck.add(new Option(v, k));
})();
$("btnFiles").onclick = () => $("files").click();
$("btnFolder").onclick = () => $("folder").click();
$("files").onchange = e => { openFiles(e.target.files).finally(() => e.target.value = ""); };
$("folder").onchange = e => { openFiles(e.target.files).finally(() => e.target.value = ""); };
$("tz").onchange = () => { try { localStorage.setItem("visor_tz", $("tz").value); } catch (e) {} if (S.db) load(); if (!$("conv").classList.contains("hide")) convert(); };
$("btnSearch").onclick = () => { S.offset = 0; load(); };
$("btnApplyF").onclick = () => { S.offset = 0; load(); };
$("onlyAlerts").onchange = () => { S.offset = 0; load(); };
function fillAlertCats() { const sel = $("alertCat"), v = sel.value;
  sel.innerHTML = `<option value="">todas las categorías</option>` + RULES.map(r => r.name).concat(DANGER).map(n => `<option>${esc(n)}</option>`).join("");
  sel.value = [...sel.options].some(o => o.value === v) ? v : ""; }
fillAlertCats();
$("alertCat").onchange = () => { if ($("alertCat").value) $("onlyAlerts").checked = true; S.offset = 0; load(); };
$("dCol").onchange = () => { S.offset = 0; load(); };
["dFrom", "dTo"].forEach(id => $(id).addEventListener("keydown", e => { if (e.key === "Enter") { S.offset = 0; load(); } }));
$("btnClearF").onclick = () => { $("q").value = ""; $("dFrom").value = ""; $("dTo").value = ""; $("onlyAlerts").checked = false; $("alertCat").value = ""; S.offset = 0; load(); };
function showPanel(id) { ["welcome", "view", "conv", "rulesPanel", "summary"].forEach(x => $(x).classList.toggle("hide", x !== id)); }
$("btnClearMarks").onclick = async () => {
  if (!MARKS.length) { toast("No hay hallazgos guardados de las evidencias abiertas."); return; }
  if (!confirm(`¿Borrar ${MARKS.length} ${MARKS.length === 1 ? "hallazgo" : "hallazgos"} de las evidencias abiertas? Exporte antes el caso (ZIP) si los necesita.`)) return;
  MARKS = []; saveMarks(); await rebuildFindings(); renderSide(); if (S.db) load(); toast("Hallazgos borrados de este navegador"); };
$("btnRules").onclick = () => { $("rules").value = RULES_TEXT; showPanel("rulesPanel"); };
$("btnCloseRules").onclick = () => showPanel(S.db ? "view" : "welcome");
$("btnResetRules").onclick = () => { $("rules").value = DEFAULT_RULES; };
$("btnSaveRules").onclick = async () => { RULES_TEXT = $("rules").value; RULES = parseRules(RULES_TEXT); RULES_VER++; caseChanged(); await DB.call("rules", {text: RULES_TEXT, ver: RULES_VER}); try { localStorage.setItem("visor_rules", RULES_TEXT); } catch (e) {} fillAlertCats();
  toast(`Reglas guardadas: ${RULES.length} categorías`); showPanel(S.db ? "view" : "welcome"); if (S.db) load(); };
$("q").onkeydown = e => { if (e.key === "Enter") { S.offset = 0; load(); } };
$("limit").onchange = () => { S.offset = 0; load(); };
$("prev").onclick = () => { const l = Number($("limit").value); if (S.offset - l >= 0) { S.offset -= l; load(); } };
$("next").onclick = () => { const l = Number($("limit").value); if (S.data && S.offset + l < S.data.total) { S.offset += l; load(); } };
$("btnCsv").onclick = exportCsv; $("btnZip").onclick = exportZip;
$("btnSql").onclick = () => $("sqlbox").classList.toggle("hide");
$("btnKinds").onclick = () => $("kinds").classList.toggle("hide");
$("btnCols").onclick = () => $("colsbar").classList.toggle("hide");
$("btnCapture").onclick = () => setCapture(true);
$("exitCapture").onclick = () => setCapture(false);
document.addEventListener("keydown", e => { if (e.key === "Escape") { if (document.body.classList.contains("capture")) setCapture(false); else $("detail").classList.add("hide"); } });
$("colsbar").addEventListener("change", e => { const cb = e.target.closest("input[data-col]"); if (cb) { setHidden(cb.dataset.col, !cb.checked); renderGrid(); } });
$("colsbar").addEventListener("click", e => { const b = e.target.closest("[data-colact]"); if (!b) return; const a = b.dataset.colact;
  if (a === "wrap") { WRAP = !WRAP; saveWid(); renderGrid(); return; }
  if (a === "widths") { delete WID[S.src]; saveWid(); renderGrid(); return; }
  if (a === "all") { delete HID[S.src]; HIDE_RAW = false; }
  else if (a === "raw") HIDE_RAW = !HIDE_RAW;
  else if (a === "none") HID[S.src] = S.data.columns.map(colKey);
  saveHid(); renderGrid(); });
$("btnRun").onclick = runSql;
$("btnCancelQ").onclick = () => DB.cancel();
$("btnConv").onclick = () => { showPanel("conv"); convert(); };
$("btnConvert").onclick = convert;
$("btnSelf").onclick = () => saveFile("navestigio.html", PAGE_SRC);
document.addEventListener("pointerdown", e => {
  const b = e.target.closest("button"); if (!b || b.classList.contains("star")) return;
  const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height), sp = document.createElement("span");
  sp.className = "ripple"; sp.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
  b.appendChild(sp); setTimeout(() => sp.remove(), 600);
});
/* "Guardar herramienta" solo tiene sentido en la versión en línea */
if (!(window.claude && typeof window.claude.use === "function")) $("btnSelf").classList.add("hide");
/* Aplicación instalable (PWA): solo cuando se sirve con servir_navestigio.py en 127.0.0.1 */
if (location.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(location.hostname) && "serviceWorker" in navigator) {
  const ml = document.createElement("link"); ml.rel = "manifest"; ml.href = "/manifest.webmanifest"; document.head.appendChild(ml);
  const tc = document.createElement("meta"); tc.name = "theme-color"; tc.content = "#12324f"; document.head.appendChild(tc);
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  let deferredInstall = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstall = e; $("btnInstall").classList.remove("hide"); });
  window.addEventListener("appinstalled", () => { $("btnInstall").classList.add("hide"); toast("Navestigio quedó instalada. Ánclala a la barra de tareas desde su ícono."); });
  $("btnInstall").onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice.catch(() => {}); deferredInstall = null; $("btnInstall").classList.add("hide"); };
}
$("side").addEventListener("click", e => {
  const c = e.target.closest("[data-close]");
  if (c) { const id = c.dataset.close; const d = S.dbs.find(x => x.id === id); if (d) DB.call("close", {id}).catch(() => {}); S.dbs = S.dbs.filter(x => x.id !== id);
    if (S.db === id) { S.db = null; showPanel("welcome"); } rebuildCase().then(() => { if (S.db === "caso") load(); }).catch(rethrowCancel); return; }
  const s = e.target.closest(".src"); if (s) pick(s.dataset.db, s.dataset.src);
});
$("side").addEventListener("keydown", e => { const s = e.target.closest(".src"); if (s && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pick(s.dataset.db, s.dataset.src); } });
$("grid").addEventListener("keydown", e => { const x = e.target.closest("[data-hide]"); if (x && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setHidden(x.dataset.hide, true); renderGrid(); } });
let RS = null;
$("grid").addEventListener("pointerdown", e => {
  const h = e.target.closest(".rs"); if (!h) return;
  e.preventDefault(); e.stopPropagation();
  const th = h.parentElement; RS = {key: h.dataset.rs, x: e.clientX, w: th.getBoundingClientRect().width, h, moved: false};
  h.classList.add("on"); document.body.classList.add("resizing");
});
document.addEventListener("pointermove", e => {
  if (!RS) return; RS.moved = true;
  const w = Math.max(RS.key === "__alertas" ? 96 : 48, Math.round(RS.w + e.clientX - RS.x));
  (WID[S.src] = WID[S.src] || {})[RS.key] = w; applyWidths();
});
document.addEventListener("pointerup", () => {
  if (!RS) return; RS.h.classList.remove("on"); document.body.classList.remove("resizing");
  saveWid(); S.justResized = RS.moved; RS = null; setTimeout(() => S.justResized = false, 50);
});
$("grid").addEventListener("dblclick", e => { const h = e.target.closest(".rs"); if (!h) return; e.stopPropagation();
  if (WID[S.src]) { delete WID[S.src][h.dataset.rs]; saveWid(); applyWidths(); } }, true);
$("grid").addEventListener("click", e => { if (e.target.closest(".rs") || S.justResized) { e.stopPropagation(); return; } const mkb = e.target.closest("[data-mark]"); if (mkb) { toggleMark(Number(mkb.dataset.mark)); return; } const x = e.target.closest("[data-hide]"); if (x) { e.stopPropagation(); setHidden(x.dataset.hide, true); renderGrid(); return; } const th = e.target.closest("th[data-sort]"); if (!th) return; const c = th.dataset.sort; if (S.sort === c) S.desc = !S.desc; else { S.sort = c; S.desc = true; } S.offset = 0; load(); });
$("grid").addEventListener("dblclick", e => { const tr = e.target.closest("tr[data-row]"); if (tr) detail(Number(tr.dataset.row)); });
$("kinds").addEventListener("change", e => { const sel = e.target.closest("select[data-col]"); if (!sel) return; const db = cur(); const key = JSON.stringify([S.src, sel.dataset.col]);
  if (sel.value === "auto") db.overrides.delete(key); else db.overrides.set(key, sel.value); load(); });
const drop = $("drop");
["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
document.addEventListener("drop", e => openFiles(e.dataTransfer.files));

/* ---------------- Datos de ejemplo ---------------- */
async function sampleHistory() {
  const wk = s => (BigInt(Date.parse(s)) * 1000n + 11644473600000000n).toString();
  const stmts = [], d = {run: (q, p) => stmts.push([q, p || null])};
  d.run(`CREATE TABLE urls(id INTEGER PRIMARY KEY,url LONGVARCHAR,title LONGVARCHAR,visit_count INTEGER DEFAULT 0 NOT NULL,typed_count INTEGER DEFAULT 0 NOT NULL,last_visit_time INTEGER NOT NULL,hidden INTEGER DEFAULT 0 NOT NULL);
    CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER NOT NULL,visit_time INTEGER NOT NULL,from_visit INTEGER,transition INTEGER DEFAULT 0 NOT NULL,segment_id INTEGER,visit_duration INTEGER DEFAULT 0 NOT NULL);
    CREATE TABLE downloads(id INTEGER PRIMARY KEY,guid VARCHAR NOT NULL,current_path LONGVARCHAR NOT NULL,target_path LONGVARCHAR NOT NULL,start_time INTEGER NOT NULL,received_bytes INTEGER NOT NULL,total_bytes INTEGER NOT NULL,state INTEGER NOT NULL,danger_type INTEGER NOT NULL,interrupt_reason INTEGER NOT NULL,end_time INTEGER NOT NULL,opened INTEGER NOT NULL,last_access_time INTEGER NOT NULL,referrer VARCHAR NOT NULL,tab_url VARCHAR NOT NULL,mime_type VARCHAR NOT NULL);
    CREATE TABLE downloads_url_chains(id INTEGER NOT NULL,chain_index INTEGER NOT NULL,url LONGVARCHAR NOT NULL,PRIMARY KEY(id,chain_index));
    CREATE TABLE keyword_search_terms(keyword_id INTEGER NOT NULL,url_id INTEGER NOT NULL,term LONGVARCHAR NOT NULL,normalized_term LONGVARCHAR NOT NULL);`);
  const U = [[1,"https://www.google.com/search?q=como+borrar+historial+chrome","como borrar historial chrome - Buscar con Google",2,0,"2024-03-15T02:30:00Z"],
    [2,"https://wetransfer.com/downloads/7f3a","WeTransfer",1,1,"2024-03-15T02:35:10Z"],
    [3,"https://drive.google.com/drive/my-drive","Mi unidad - Google Drive",5,3,"2024-03-15T03:02:44Z"],
    [4,"https://outlook.office.com/mail/","Correo - Outlook",12,4,"2024-03-14T21:15:00Z"]];
  for (const u of U) d.run(`INSERT INTO urls VALUES(?,?,?,?,?,${wk(u[5])},0)`, u.slice(0, 5));
  [[1,4,"2024-03-14T21:15:00Z",0,805306369,0],[2,1,"2024-03-15T02:30:00Z",0,805306368,4200000],[3,2,"2024-03-15T02:35:10Z",2,805306369,0],[4,3,"2024-03-15T03:02:44Z",0,805306369,61000000]]
    .forEach(v => d.run(`INSERT INTO visits VALUES(?,?,${wk(v[2])},?,?,0,?)`, [v[0], v[1], v[3], v[4], v[5]]));
  d.run(`INSERT INTO downloads VALUES(1,'a1','C:\\Users\\empleado\\Downloads\\proyecto_final.zip.crdownload','C:\\Users\\empleado\\Downloads\\proyecto_final.zip',${wk("2024-03-15T02:36:00Z")},48318382,48318382,1,0,0,${wk("2024-03-15T02:36:41Z")},1,${wk("2024-03-15T02:40:12Z")},'https://wetransfer.com/','https://wetransfer.com/downloads/7f3a','application/zip')`);
  d.run(`INSERT INTO downloads_url_chains VALUES(1,0,'https://wetransfer.com/api/v4/transfers/7f3a/download'),(1,1,'https://download.wetransfer.com/eu2/7f3a/proyecto_final.zip')`);
  d.run(`INSERT INTO keyword_search_terms VALUES(2,1,'como borrar historial chrome','como borrar historial chrome')`);
  d.run("PRAGMA secure_delete = OFF");
  d.run(`INSERT INTO urls VALUES(5,'https://mega.nz/folder/Qx81LZbA#confidencial','Carpeta compartida - MEGA',3,1,${wk("2024-03-15T02:50:31Z")},0)`);
  d.run(`INSERT INTO urls VALUES(6,'https://pastebin.com/raw/9vKq2Lm4','pastebin.com/raw/9vKq2Lm4',1,0,${wk("2024-03-15T02:58:02Z")},0)`);
  d.run("DELETE FROM urls WHERE id IN (5, 6)");
  return DB.call("build", {stmts});
}
function sampleBookmarks() {
  const wk = s => (BigInt(Date.parse(s)) * 1000n + 11644473600000000n).toString();
  return JSON.stringify({roots: {
    bookmark_bar: {type: "folder", name: "Barra de marcadores", date_added: wk("2023-11-02T14:00:00Z"), date_modified: wk("2024-03-15T02:37:00Z"), children: [
      {type: "url", name: "Intranet", url: "https://intranet.example.com/", date_added: wk("2023-11-02T14:05:00Z"), date_last_used: wk("2024-03-14T21:10:00Z"), guid: "a1"},
      {type: "folder", name: "Personal", date_added: wk("2024-03-15T02:37:00Z"), date_modified: wk("2024-03-15T02:37:30Z"), children: [
        {type: "url", name: "WeTransfer", url: "https://wetransfer.com/", date_added: wk("2024-03-15T02:37:30Z"), date_last_used: "0", guid: "a2"}]}]},
    other: {type: "folder", name: "Otros marcadores", children: []}}, version: 1});
}

/* ---------------- Arranque ---------------- */
(async function boot() {
  try {
    await DB.start();
    $("loading").remove();
    await makeCase();
    await loadEvidence("History", "Datos de ejemplo generados por la herramienta", await sampleHistory(), null, null, true);
    await loadJsonEvidence("Bookmarks", "Datos de ejemplo generados por la herramienta", new TextEncoder().encode(sampleBookmarks()));
    S.dbs[S.dbs.length - 1].sample = true;
    await rebuildCase(); pick("caso", "s:resumen");
  } catch (e) { $("loading").textContent = "No se pudo cargar el motor SQLite: " + (e.message || e); }
})();
