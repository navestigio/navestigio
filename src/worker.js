/*! Navestigio © 2026 Oscar Stiven Garay Acosta · Licencia MIT (ver LICENSE) */
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
function buildJsonTables(sdb, name, obj) {
  const kind = /bookmarks/i.test(name) ? "bookmarks" : /preferences/i.test(name) ? "prefs" : /local state/i.test(name) ? "localstate" : "generic";
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
    const obj = JSON.parse(new TextDecoder("utf-8").decode(bytes));
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
      moz_historyvisits: ["visit_date", "unix_us", true], moz_places: ["last_visit_date", "unix_us", false], logins: ["date_created", "webkit", false]};
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
    for (const [t, tc, kind] of [["visits", "visit_time", "webkit"], ["moz_historyvisits", "visit_date", "unix_us"]]) {
      if (!tset.has(t) || !colSet(t).has(tc)) continue;
      const local = t === "visits" && colSet(t).has("originator_cache_guid") ? "WHERE coalesce(originator_cache_guid,'') = ''" : "";
      try { const r = all(d, `SELECT COUNT(*), MIN(dt) FROM (SELECT ${qi(tc)} - LAG(${qi(tc)}) OVER (ORDER BY rowid) AS dt FROM ${qi(t)} ${local}) WHERE dt < -60000000`)[0];
        if (Number(r[0])) out.back.push({t, kind, n: Number(r[0]), worstSec: Math.round(-Number(r[1]) / 1e6), syncExcluded: !!local}); } catch (e) {}
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
