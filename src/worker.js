/*! Navestigio © 2026 Oscar Stiven Garay Acosta · Todos los derechos reservados · SPDX-License-Identifier: LicenseRef-Navestigio · uso según LICENSE; prohibido modificar o redistribuir */
"use strict";
/* Worker de SQLite: todas las bases (evidencias y caso) viven aquí, fuera del hilo de la página.
   Si una consulta tarda demasiado (por ejemplo, una vista maliciosa con recursión infinita), la página
   termina este Worker con «Cancelar», crea uno nuevo y vuelve a abrir las evidencias. La interfaz nunca se congela. */
let SQL = null, SUM_TZ = -5;
const DBS = new Map();
const db = id => { const d = DBS.get(id); if (!d) throw new Error("Base no abierta"); return d; };
function regFns(d) {
  d.create_function("vt_alert", (txt, cat) => { const re = rulesRe(cat); return re && txt && re.test(matchText(txt)) ? 1 : 0; });
  // segundos Unix en hora local para el resumen (respeta horario de verano)
  d.create_function("vt_local", m => { if (m == null) return null; const ms = Number(m) / 1000 - 11644473600000; return Math.floor((ms + tzOffMin(SUM_TZ, ms) * 60000) / 1000); });
  d.create_function("vt_url", u => typeof u === "string" ? interpretUrl(u) : "");
  d.create_function("vt_cookie", (n, v) => typeof v === "string" ? interpretCookie(n, v) : "");
  return d;
}
function all(d, sql, params) {
  const st = d.prepare(sql); const rows = [];
  try { if (params) st.bind(params); while (st.step()) rows.push(st.get(null, {useBigInt: true})); }
  finally { st.free(); }
  return rows;
}
function colsOf(d, sql) { const st = d.prepare(`SELECT * FROM (${sql}) LIMIT 0`); try { return st.getColumnNames(); } finally { st.free(); } }

/* ---------------- Artefactos JSON (Bookmarks, Preferences, Local State) ---------------- */
function flatten(obj, rows, path, limit) {
  if (rows.length >= limit) return;
  if (obj !== null && typeof obj === "object") { for (const [k, v] of Object.entries(obj)) flatten(v, rows, path ? path + "." + k : k, limit); return; }
  rows.push([path, obj === null ? "" : String(obj)]);
}
const getp = (o, path) => path.split(".").reduce((a, k) => a == null ? undefined : a[k], o);
function insertRows(sdb, table, cols, rows) {
  sdb.run(`CREATE TABLE ${qi(table)}(${cols.map(c => qi(c[0]) + " " + c[1]).join(",")})`);
  if (!rows.length) return;
  const st = sdb.prepare(`INSERT INTO ${qi(table)} VALUES(${cols.map(c => c[1] === "INTEGER" ? "CAST(? AS INTEGER)" : "?").join(",")})`);
  sdb.run("BEGIN"); try { for (const r of rows) st.run(r.map(v => v === undefined ? null : typeof v === "object" && v !== null ? JSON.stringify(v) : v)); } finally { st.free(); sdb.run("COMMIT"); }
}
/* ---------------- mozLz4 (sessionstore.jsonlz4 de Firefox) ----------------
   Encabezado "mozLz40\0", tamaño descomprimido (uint32 little-endian) y un bloque LZ4. Descompresor propio, con límites. */
const MOZLZ4 = [0x6d, 0x6f, 0x7a, 0x4c, 0x7a, 0x34, 0x30, 0x00];
const isMozLz4 = b => b.length >= 12 && MOZLZ4.every((x, i) => b[i] === x);
function mozLz4(b) {
  const n = (b[8] | b[9] << 8 | b[10] << 16 | b[11] << 24) >>> 0;
  if (n > 512 * 1024 * 1024) throw new Error("mozLz4 declara un tamaño descomprimido imposible");
  const out = new Uint8Array(n); let i = 12, o = 0;
  const len = () => { let v = 0, x; do { if (i >= b.length) throw new Error("bloque LZ4 truncado"); x = b[i++]; v += x; } while (x === 255); return v; };
  while (i < b.length) {
    const tok = b[i++]; let lit = tok >> 4; if (lit === 15) lit += len();
    if (i + lit > b.length || o + lit > n) throw new Error("bloque LZ4 inválido (literales)");
    out.set(b.subarray(i, i + lit), o); i += lit; o += lit;
    if (i >= b.length) break;
    if (i + 2 > b.length) throw new Error("bloque LZ4 truncado");
    const off = b[i] | b[i + 1] << 8; i += 2;
    let ml = tok & 15; if (ml === 15) ml += len(); ml += 4;
    if (!off || off > o || o + ml > n) throw new Error("bloque LZ4 inválido (referencia)");
    for (let k = 0; k < ml; k++, o++) out[o] = out[o - off];
  }
  return out.subarray(0, o);
}
/* Pestañas de la sesión de Firefox: una fila por entrada del historial de cada pestaña (atrás/adelante); «actual» marca la que se veía */
function sessionRows(obj) {
  const rows = []; let nOpen = 0, nClosed = 0;
  const tab = (t, vi, wState, ti, estado, closedAt) => {
    if (!t || !Array.isArray(t.entries)) return;
    const cur = Math.min(Math.max(Number(t.index) || t.entries.length, 1), t.entries.length) - 1;
    estado === "abierta" ? nOpen++ : nClosed++;
    t.entries.forEach((e, ei) => { if (!e || typeof e !== "object") return;
      rows.push([vi, wState, ti, estado, ei + 1, ei === cur ? "sí" : "no", e.url || "", e.title || "", e.referrer || (e.referrerInfo ? "(referrerInfo serializado)" : ""),
        t.lastAccessed ?? null, closedAt ?? null, t.pinned ? "sí" : "no", t.hidden ? "sí" : "no", e.originalURI == null ? "" : String(e.originalURI)]); });
  };
  const win = (w, vi, wState) => {
    if (!w || typeof w !== "object") return;
    (w.tabs || []).forEach((t, ti) => tab(t, vi, wState, ti + 1, wState === "cerrada" ? "cerrada" : "abierta", wState === "cerrada" ? w.closedAt : null));
    (w._closedTabs || []).forEach((c, ti) => c && tab(c.state, vi, wState, ti + 1, "cerrada", c.closedAt));
  };
  (obj.windows || []).forEach((w, i) => win(w, i + 1, "abierta"));
  (obj._closedWindows || []).forEach((w, i) => win(w, (obj.windows || []).length + i + 1, "cerrada"));
  return {rows, nOpen, nClosed};
}
const SENSITIVE = ["<all_urls>", "*://*/*", "http://*/*", "https://*/*", "webRequest", "webRequestBlocking", "declarativeNetRequest", "cookies", "history", "tabs", "debugger",
  "nativeMessaging", "proxy", "management", "clipboardRead", "downloads", "privacy", "browsingData", "scripting", "desktopCapture", "tabCapture", "webNavigation"];
function buildJsonTables(sdb, name, obj) {
  const kind = obj && obj.__navestigio === "extensiones_chromium" ? "chromext" : obj && Array.isArray(obj.windows) && (obj.session || obj.version) ? "session"
    : obj && Array.isArray(obj.addons) && "schemaVersion" in obj ? "ffaddons"
    : /bookmarks/i.test(name) ? "bookmarks" : /preferences/i.test(name) ? "prefs" : /local state/i.test(name) ? "localstate" : "generic";
  if (kind === "session") {
    const {rows, nOpen, nClosed} = sessionRows(obj);
    insertRows(sdb, "pestanas", [["ventana","INTEGER"],["estado_ventana","TEXT"],["pestana","INTEGER"],["estado","TEXT"],["entrada","INTEGER"],["actual","TEXT"],["url","TEXT"],["titulo","TEXT"],
      ["referente","TEXT"],["last_accessed","INTEGER"],["closed_at","INTEGER"],["fijada","TEXT"],["oculta","TEXT"],["url_original","TEXT"]], rows);
    const ss = obj.session || {};
    insertRows(sdb, "sesion", [["archivo","TEXT"],["last_update","INTEGER"],["start_time","INTEGER"],["recent_crashes","INTEGER"],["ventanas","INTEGER"],["ventanas_cerradas","INTEGER"],
      ["pestanas_abiertas","INTEGER"],["pestanas_cerradas","INTEGER"],["version","TEXT"]],
      [[name, ss.lastUpdate ?? null, ss.startTime ?? null, ss.recentCrashes ?? null, (obj.windows || []).length, (obj._closedWindows || []).length, nOpen, nClosed, JSON.stringify(obj.version ?? "")]]);
  }
  if (kind === "ffaddons") {
    const rows = obj.addons.filter(a => a && typeof a === "object").map(a => { const perm = a.userPermissions || {}, perms = [...(perm.permissions || []), ...(perm.origins || [])];
      return [a.id, (a.defaultLocale && a.defaultLocale.name) || "", a.version, a.type, a.installDate ?? null, a.updateDate ?? null, a.active ? "sí" : "no", a.userDisabled ? "sí" : "no",
        a.location || "", a.sourceURI || "", perms.join(", "), perms.filter(p => SENSITIVE.includes(p)).join(", ")]; });
    insertRows(sdb, "complementos", [["id","TEXT"],["nombre","TEXT"],["version","TEXT"],["tipo","TEXT"],["install_date","INTEGER"],["update_date","INTEGER"],["activo","TEXT"],
      ["deshabilitado_por_usuario","TEXT"],["ubicacion","TEXT"],["origen","TEXT"],["permisos","TEXT"],["permisos_sensibles","TEXT"]], rows);
  }
  if (kind === "chromext") {
    const rows = (obj.extensiones || []).map(e => { const perms = [...(e.permissions || []), ...(e.host_permissions || [])].map(p => typeof p === "string" ? p : JSON.stringify(p));
      return [e.perfil, e.id, e.nombre, e.version, e.manifest_version, e.update_url === "https://clients2.google.com/service/update2/crx" ? "sí" : e.update_url ? "no (" + e.update_url + ")" : "no",
        perms.join(", "), perms.filter(p => SENSITIVE.includes(p)).join(", "), (e.content_scripts || []).join(", "), e.descripcion, e.ruta]; });
    insertRows(sdb, "extensiones_instaladas", [["perfil","TEXT"],["id","TEXT"],["nombre","TEXT"],["version","TEXT"],["manifest_version","INTEGER"],["desde_webstore","TEXT"],["permisos","TEXT"],
      ["permisos_sensibles","TEXT"],["scripts_en","TEXT"],["descripcion","TEXT"],["ruta","TEXT"]], rows);
    return; // los manifiestos ya están resumidos; no se aplana el JSON sintético
  }
  if (kind === "bookmarks" && obj.roots) {
    const bm = [], folders = [];
    const walk = (n, path, root) => {
      if (!n || typeof n !== "object") return;
      if (n.type === "url") bm.push([path, n.name, n.url, n.date_added, n.date_last_used, n.guid, root]);
      else if (Array.isArray(n.children)) { const p = path ? path + " / " + (n.name || "") : (n.name || root);
        folders.push([p, n.date_added, n.date_modified, n.children.length]); n.children.forEach(c => walk(c, p, root)); }
    };
    for (const [root, n] of Object.entries(obj.roots)) walk(n, "", root);
    insertRows(sdb, "marcadores", [["carpeta","TEXT"],["nombre","TEXT"],["url","TEXT"],["date_added","INTEGER"],["date_last_used","INTEGER"],["guid","TEXT"],["raiz","TEXT"]], bm);
    insertRows(sdb, "carpetas", [["carpeta","TEXT"],["date_added","INTEGER"],["date_modified","INTEGER"],["elementos","INTEGER"]], folders);
  }
  if (kind === "prefs") {
    const acc = (obj.account_info || []).map(a => [a.email, a.full_name, a.given_name, a.gaia, a.account_id, a.hd, a.locale]);
    insertRows(sdb, "cuentas", [["email","TEXT"],["nombre_completo","TEXT"],["nombre","TEXT"],["gaia_id","TEXT"],["account_id","TEXT"],["dominio","TEXT"],["idioma","TEXT"]], acc);
    const ext = Object.entries(getp(obj, "extensions.settings") || {}).filter(([, v]) => v && typeof v === "object").map(([id, v]) => [id, (v.manifest && v.manifest.name) || "", (v.manifest && v.manifest.version) || "",
      v.install_time || v.first_install_time, v.last_update_time, v.state === 1 ? "habilitada" : v.state === 0 ? "deshabilitada" : (v.state ?? ""), v.from_webstore ? "sí" : "no", v.path || "",
      ((v.active_permissions && v.active_permissions.api) || []).join(", ")]);
    insertRows(sdb, "extensiones", [["id","TEXT"],["nombre","TEXT"],["version","TEXT"],["install_time","INTEGER"],["last_update_time","INTEGER"],["estado","TEXT"],["desde_webstore","TEXT"],["ruta","TEXT"],["permisos","TEXT"]], ext);
    const keys = ["profile.name","profile.created_by_version","profile.exit_type","google.services.last_username","google.services.last_gaia_id","google.services.signin.allowed","sync.has_setup_completed",
      "download.default_directory","savefile.default_directory","download.prompt_for_download","session.restore_on_startup","session.startup_urls","homepage","homepage_is_newtabpage",
      "default_search_provider_data.template_url_data.short_name","default_search_provider_data.template_url_data.url","intl.accept_languages","browser.has_seen_welcome_page","credentials_enable_service","profile.password_manager_enabled"];
    insertRows(sdb, "preferencias", [["clave","TEXT"],["valor","TEXT"]], keys.map(k => [k, getp(obj, k)]).filter(r => r[1] !== undefined));
  }
  if (kind === "localstate") {
    const last = getp(obj, "profile.last_used");
    const pr = Object.entries(getp(obj, "profile.info_cache") || {}).filter(([, v]) => v && typeof v === "object").map(([dir, v]) => [dir, v.name, v.user_name, v.gaia_name, v.gaia_id, v.active_time, dir === last ? "sí" : "no"]);
    insertRows(sdb, "perfiles", [["carpeta","TEXT"],["nombre","TEXT"],["email","TEXT"],["gaia_name","TEXT"],["gaia_id","TEXT"],["active_time","REAL"],["ultimo_usado","TEXT"]], pr);
    const key = getp(obj, "os_crypt.encrypted_key");
    const est = [["profile.last_used", last], ["profile.profiles_order", getp(obj, "profile.profiles_order")],
      ["uninstall_metrics.installation_date2 (Unix s)", getp(obj, "uninstall_metrics.installation_date2")], ["variations_country", getp(obj, "variations_country")],
      ["browser.enabled_labs_experiments", getp(obj, "browser.enabled_labs_experiments")], ["os_crypt.encrypted_key", key ? `presente (${String(key).length} caracteres; clave para descifrar contraseñas y cookies)` : undefined]];
    insertRows(sdb, "estado", [["clave","TEXT"],["valor","TEXT"]], est.filter(r => r[1] !== undefined));
  }
  const flat = []; flatten(obj, flat, "", 50000);
  insertRows(sdb, "json_completo", [["ruta","TEXT"],["valor","TEXT"]], flat);
}

const OPS = {
  async init({wasm}) { SQL = await initSqlJs({wasmBinary: wasm}); return true; },
  rules({text, ver}) { RULES = parseRules(text); RULES_VER = ver; _reCache.clear(); },
  tz({tz}) { SUM_TZ = tz; },
  open({id, bytes}) { const d = regFns(new SQL.Database(bytes)); d.run("PRAGMA query_only = ON"); DBS.set(id, d); },
  json({id, name, bytes}) {
    const obj = JSON.parse(new TextDecoder("utf-8").decode(isMozLz4(bytes) ? mozLz4(bytes) : bytes));
    const d = regFns(new SQL.Database()); buildJsonTables(d, name, obj); d.run("PRAGMA query_only = ON"); DBS.set(id, d);
  },
  create({id, sql}) { const d = regFns(new SQL.Database()); if (sql) d.run(sql); DBS.set(id, d); },
  close({id}) { const d = DBS.get(id); if (d) d.close(); DBS.delete(id); },
  all({id, sql, params}) { return all(db(id), sql, params); },
  cols({id, sql}) { return colsOf(db(id), sql); },
  run({id, sql, params}) { db(id).run(sql, params); },
  insertMany({id, pre, sql, rows}) {
    const d = db(id); if (pre) d.run(pre);
    const st = d.prepare(sql); d.run("BEGIN");
    try { for (const r of rows) st.run(r); } finally { st.free(); d.run("COMMIT"); }
  },
  sample({id, sql}) { // muestra de hasta 300 valores no vacíos por columna para detectar fechas
    const d = db(id), st = d.prepare(`SELECT * FROM (${sql}) LIMIT 5000`); let smp = null;
    try { while (st.step()) { const r = st.get(null, {useBigInt: true}); if (!smp) smp = r.map(() => []); let full = true;
        for (let i = 0; i < r.length; i++) { const v = r[i]; if (smp[i].length < 300) { full = false; if (v !== null && v !== "" && v != 0) smp[i].push(v); } }
        if (full) break; } } finally { st.free(); }
    return smp;
  },
  timeline({items}) { // items: [{id, tset, art, recovered, extra}] -> llena eventos del caso y devuelve conteo y alertas
    const c = db("caso");
    c.run("DROP INDEX IF EXISTS ev_momento; DROP INDEX IF EXISTS ev_tipo; DELETE FROM eventos");
    const st = c.prepare("INSERT INTO eventos VALUES(CAST(? AS INTEGER),?,?,?,?,?,?,?,?,?,?)"); c.run("BEGIN");
    // Las alertas solo miran las 7 columnas de contenido, no las de procedencia
    const stats = newAlertStats(), ins = v => { st.run(v); addAlertStats(stats, v.slice(0, EV_COLS.length)); };
    try {
      for (const it of items) {
        const d = DBS.get(it.id); if (!d) continue; const tset = new Set(it.tset);
        for (const [req, sqlT] of EXTRACT) {
          if (!req.every(t => tset.has(t))) continue;
          let rows; try { rows = all(d, sqlT); } catch (e) { continue; }
          const auto = String(sqlT).includes("'auto'");
          for (const r of rows) { const wk = toWebkit(r[0], String(r[1])); if (wk === null) continue;
            ins([wk.toString(), bindVal(r[2]), it.art, bindVal(r[3]), bindVal(r[4]), bindVal(r[5]), bindVal(r[6]),
              "registro vigente", auto ? "media" : "alta", auto ? "formato de fecha inferido" : "columna de fecha del registro", interpretUrl(r[3])]); }
        }
        for (const r of it.recovered) ins([String(r.lvt), "URL recuperada (borrada)", it.art, r.url, r.title, r.origen, "recuperados",
          "recuperado de espacio libre o -wal", "media", "last_visit_time del registro borrado", interpretUrl(r.url)]);
        for (const v of it.extra || []) ins(v);
      }
    } finally { st.free(); c.run("COMMIT"); }
    c.run("CREATE INDEX IF NOT EXISTS ev_momento ON eventos(momento); CREATE INDEX IF NOT EXISTS ev_tipo ON eventos(tipo, momento)");
    return {n: Number(all(c, "SELECT COUNT(*) FROM eventos")[0][0]), stats};
  },
  alertStats() { const stats = newAlertStats(), [ac, ap] = alertCond(EV_COLS);
    for (const r of all(db("caso"), `SELECT ${EV_COLS.map(qi).join(", ")} FROM eventos WHERE ${ac}`, ap)) addAlertStats(stats, r); return stats; },
  integrity({id}) { // hechos estructurales medidos; la interpretación la arma la página
    const d = db(id), tset = new Set(all(d, "SELECT name FROM sqlite_master WHERE type='table'").map(r => String(r[0])));
    const colSet = t => new Set(all(d, `PRAGMA table_info(${qi(t)})`).map(r => String(r[1])));
    const one = q => { try { const r = all(d, q)[0]; return r ? r[0] : null; } catch (e) { return null; } };
    const out = {ic: [], free: Number(one("PRAGMA freelist_count") || 0), ids: [], back: [], cookieInv: null, enc: {}};
    try { out.ic = all(d, "PRAGMA integrity_check(10)").map(r => String(r[0])); } catch (e) { out.ic = ["no se pudo ejecutar: " + e.message]; }
    const seq = tset.has("sqlite_sequence") ? new Map(all(d, "SELECT name, seq FROM sqlite_sequence").map(r => [String(r[0]), Number(r[1])])) : new Map();
    // tabla -> [columna de fecha, formato, ¿importan los huecos internos?]
    const IDT = {visits: ["visit_time", "webkit", true], downloads: ["start_time", "webkit", true], urls: ["last_visit_time", "webkit", false],
      moz_historyvisits: ["visit_date", "unix_us", true], moz_places: ["last_visit_date", "unix_us", false], logins: ["date_created", "webkit", false],
      history_visits: ["visit_time", "mac_s", true], history_items: ["", "mac_s", false]};
    for (const [t, [tc0, kind, inner]] of Object.entries(IDT)) {
      if (!tset.has(t)) continue;
      let r; try { r = all(d, `SELECT COUNT(*), MIN(rowid), MAX(rowid) FROM ${qi(t)}`)[0]; } catch (e) { continue; }
      const tc = colSet(t).has(tc0) ? qi(tc0) : "NULL", at = rid => one(`SELECT ${tc} FROM ${qi(t)} WHERE rowid = ${Number(rid)}`);
      const n = Number(r[0]), mn = r[1] == null ? null : Number(r[1]), mx = r[2] == null ? null : Number(r[2]);
      const e = {t, kind, inner, n, mn, mx, seq: seq.has(t) ? seq.get(t) : null, holes: mx == null ? 0 : mx - mn + 1 - n, top: [], tailTime: mx == null ? null : at(mx)};
      if (inner && e.holes > 0) {
        try { e.top = all(d, `SELECT prev, id, id - prev - 1 FROM (SELECT rowid AS id, LAG(rowid) OVER (ORDER BY rowid) AS prev FROM ${qi(t)}) WHERE id - prev > 1 ORDER BY id - prev DESC LIMIT 5`)
          .map(([pv, i, k]) => ({prev: Number(pv), id: Number(i), k: Number(k), tPrev: at(pv), tNext: at(i)})); } catch (err) {}
      }
      out.ids.push(e);
    }
    // Fechas que retroceden más de 60 s al avanzar el id. Chrome marca las visitas sincronizadas con originator_cache_guid.
    // Safari marca con origin != 0 las visitas que llegaron por iCloud desde otro dispositivo
    for (const [t, tc, kind, unit] of [["visits", "visit_time", "webkit", 1e6], ["moz_historyvisits", "visit_date", "unix_us", 1e6], ["history_visits", "visit_time", "mac_s", 1]]) {
      if (!tset.has(t) || !colSet(t).has(tc)) continue;
      const local = t === "visits" && colSet(t).has("originator_cache_guid") ? "WHERE coalesce(originator_cache_guid,'') = ''"
        : t === "history_visits" && colSet(t).has("origin") ? "WHERE coalesce(origin, 0) = 0" : "";
      try { const r = all(d, `SELECT COUNT(*), MIN(dt) FROM (SELECT ${qi(tc)} - LAG(${qi(tc)}) OVER (ORDER BY rowid) AS dt FROM ${qi(t)} ${local}) WHERE dt < ${-60 * unit}`)[0];
        if (Number(r[0])) out.back.push({t, kind, n: Number(r[0]), worstSec: Math.round(-Number(r[1]) / unit), syncExcluded: !!local}); } catch (e) {}
    }
    // Safari: cada borrado de historial deja un tombstone con el rango borrado (y la URL si fue un solo sitio)
    if (tset.has("history_tombstones")) {
      out.tombN = Number(one("SELECT COUNT(*) FROM history_tombstones") || 0);
      try { out.tomb = all(d, "SELECT start_time, end_time, url FROM history_tombstones ORDER BY end_time DESC LIMIT 50").map(r => ({start: r[0], end: r[1], url: r[2] == null ? "" : String(r[2])})); } catch (e) { out.tomb = []; }
    }
    if (tset.has("cookies") && colSet("cookies").has("last_access_utc"))
      out.cookieInv = Number(one("SELECT COUNT(*) FROM cookies WHERE last_access_utc > 0 AND creation_utc > last_access_utc + 1000000") || 0);
    else if (tset.has("moz_cookies") && colSet("moz_cookies").has("lastAccessed"))
      out.cookieInv = Number(one("SELECT COUNT(*) FROM moz_cookies WHERE lastAccessed > 0 AND creationTime > lastAccessed + 1000000") || 0);
    const enc = (k, t, c) => { if (tset.has(t) && colSet(t).has(c)) out.enc[k] = Number(one(`SELECT COUNT(*) FROM ${qi(t)} WHERE length(${qi(c)}) > 0`) || 0); };
    enc("valores de cookies", "cookies", "encrypted_value"); enc("contraseñas guardadas", "logins", "password_value"); enc("números de tarjeta", "credit_cards", "card_number_encrypted");
    return out;
  },
  build({stmts}) { const d = new SQL.Database(); try { for (const [q, p] of stmts) d.run(q, p); return d.export(); } finally { d.close(); } },
};
onmessage = async e => {
  const {rid, op, args} = e.data;
  try { const r = await OPS[op](args || {}); postMessage({rid, ok: true, r}); }
  catch (err) { postMessage({rid, ok: false, e: String((err && err.message) || err)}); }
};
