/* Prueba de humo de Navestigio en Chromium (Playwright).
   Uso: node tests/smoke.cjs        (requiere Python 3 y Playwright; ver README, sección Pruebas)
   Genera evidencias sintéticas, sirve app/ en 127.0.0.1 y comprueba seguridad, detección e integridad de la exportación. */
"use strict";
const {chromium} = require("playwright");
const {spawn, execFileSync} = require("child_process");
const crypto = require("crypto"), fs = require("fs"), os = require("os"), path = require("path");

const ROOT = path.resolve(__dirname, ".."), APP = path.join(ROOT, "app"), PORT = 8799, BASE = `http://127.0.0.1:${PORT}/`;
const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const EV = fs.mkdtempSync(path.join(os.tmpdir(), "navestigio-ev-")), OUT = fs.mkdtempSync(path.join(os.tmpdir(), "navestigio-out-"));
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ok " : "FALLA"} ${msg}`); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Lector mínimo de ZIP sin compresión (el formato que genera Navestigio)
function unzip(buf) {
  const files = {}; let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const size = buf.readUInt32LE(o + 18), nl = buf.readUInt16LE(o + 26), xl = buf.readUInt16LE(o + 28);
    const name = buf.slice(o + 30, o + 30 + nl).toString("utf8"), start = o + 30 + nl + xl;
    files[name] = buf.slice(start, start + size); o = start + size;
  }
  return files;
}
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex"), md5 = b => crypto.createHash("md5").update(b).digest("hex");

(async () => {
  execFileSync(PY, [path.join(__dirname, "fixtures.py"), EV], {stdio: "inherit"});
  const srv = spawn(PY, [path.join(APP, "servir_navestigio.py"), "--port", String(PORT), "--no-browser"], {stdio: "ignore"});
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE)).ok) break; } catch (e) {} await sleep(200); }
    const ctx = await browser.newContext({acceptDownloads: true, viewport: {width: 1400, height: 1000}});
    const page = await ctx.newPage(), pageErrors = [], cspErrors = [], external = [];
    page.on("pageerror", e => pageErrors.push(String(e)));
    page.on("console", m => { if (/Content Security Policy|Refused to/i.test(m.text())) cspErrors.push(m.text()); });
    page.on("request", r => { if (!/^(http:\/\/127\.0\.0\.1:\d+\/|blob:|data:)/.test(r.url())) external.push(r.url()); });
    const click = async sel => { await page.click(sel); await sleep(700); };
    const gridText = () => page.evaluate(() => document.getElementById("grid").innerText);

    console.log("Carga y seguridad");
    await page.goto(BASE); await page.waitForFunction(() => document.querySelectorAll(".db").length >= 3, null, {timeout: 30000});
    ok(await page.evaluate(() => document.title) === "Navestigio", "la página carga con el título correcto");
    const hdr = (await fetch(BASE)).headers;
    ok(/connect-src 'none'/.test(hdr.get("content-security-policy") || ""), "el servidor envía la CSP que bloquea la red");
    const st = await new Promise(res => require("http").get({host: "127.0.0.1", port: PORT, path: "/", headers: {Host: "evil.example:" + PORT}}, r => { r.resume(); res(r.statusCode); }).on("error", () => res(0)));
    ok(st === 400, "el servidor rechaza otro Host (DNS rebinding)");
    ok(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length === 1), "el service worker queda registrado");

    console.log("Evidencias válidas y malformadas");
    const names = ["History", "Cookies", "recursiva.sqlite", "basura.sqlite", "truncada.sqlite", "ConWal", "ConWal-wal", "Preferences"];
    await page.setInputFiles("#files", names.map(n => path.join(EV, n)));
    await page.waitForFunction(() => !document.body.classList.contains("busy"), null, {timeout: 60000}); await sleep(2500);
    const opened = await page.evaluate(() => [...document.querySelectorAll(".db .dbh b")].map(b => b.textContent));
    ok(opened.includes("History") && opened.includes("Cookies"), "abre History y Cookies junto a archivos malformados: " + opened.join(", "));
    ok(pageErrors.length === 0, "ninguna evidencia malformada produce errores no controlados " + JSON.stringify(pageErrors));

    console.log("Indicadores de integridad e interpretación");
    await click('.src[data-src="s:integridad"]');
    const integ = await gridText();
    for (const t of ["Faltan los 5 registros más recientes de visits", "Hueco de 20 id en visits", "retroceso de fecha en visits", "2 cookies creadas después de su último uso"])
      ok(integ.includes(t), "detecta: " + t);
    await click('.src[data-src="s:resumen"]');
    ok(await page.evaluate(() => /No se analizó/.test(document.getElementById("summary").innerText) && /valores de cookies cifrados/.test(document.getElementById("summary").innerText)), "el resumen muestra el alcance del análisis");
    await click('.src[data-src="s:timeline"]');
    ok((await gridText()).includes("Búsqueda en Google: «como borrar historial»"), "interpreta la búsqueda de Google en la línea de tiempo");
    ok(await page.evaluate(() => [...document.querySelectorAll("#grid th")].some(th => th.textContent.startsWith("confianza"))), "la línea de tiempo trae la columna de confianza");

    console.log("Exportaciones");
    const save = async (sel, name) => { const [d] = await Promise.all([page.waitForEvent("download"), page.click(sel)]); const f = path.join(OUT, name); await d.saveAs(f); return fs.readFileSync(f); };
    await page.selectOption("#expFmt", "jsonl");
    const jsonl = (await save("#btnCsv", "tl.jsonl")).toString("utf8").trim().split("\n");
    ok(jsonl.length > 50 && jsonl.every(l => { try { JSON.parse(l); return true; } catch (e) { return false; } }), `JSONL válido (${jsonl.length} líneas)`);
    await page.selectOption("#expFmt", "l2t");
    const l2t = (await save("#btnCsv", "tl.l2t.csv")).toString("utf8").replace(/^﻿/, "").split("\r\n").filter(Boolean);
    ok(l2t[0].split(",").length === 17, "l2t CSV con las 17 columnas de log2timeline");
    await page.selectOption("#expFmt", "body");
    const body = (await save("#btnCsv", "tl.body")).toString("utf8").trim().split("\n");
    ok(body.every(l => l.split("|").length === 11), "bodyfile con 11 campos por línea");
    await page.selectOption("#expFmt", "csv");
    const files = unzip(await save("#btnZip", "caso.zip"));
    ok(["manifest.json", "SHA256SUMS.txt", "informe.html", "LEEME_cadena_custodia.txt", "linea_de_tiempo.jsonl"].every(n => files[n]), "el ZIP trae manifiesto, sumas, informe y línea de tiempo");
    const sums = files["SHA256SUMS.txt"].toString("utf8").trim().split("\n").map(l => l.split(/\s+/));
    ok(sums.length === Object.keys(files).length - 1 && sums.every(([h, n]) => files[n] && sha256(files[n]) === h), "SHA256SUMS.txt verifica cada archivo del paquete");
    const man = JSON.parse(files["manifest.json"].toString("utf8")), hist = man.evidencias.find(e => e.nombre === "History" && !e.datos_de_ejemplo);
    const raw = fs.readFileSync(path.join(EV, "History"));
    ok(hist && hist.archivos[0].sha256 === sha256(raw) && hist.archivos[0].md5 === md5(raw), "el manifiesto registra SHA-256 y MD5 correctos de la evidencia");
    ok(!/<script/i.test(files["informe.html"].toString("utf8")), "el informe HTML no contiene scripts");

    console.log("Vista hostil (recursión infinita) y cancelación");
    await page.click('.src[data-src="t:infinita"]');
    await page.waitForSelector("#busy.cancelable", {timeout: 15000}); await page.click("#btnCancelQ");
    await page.waitForFunction(() => !document.body.classList.contains("busy") && document.querySelector('.src[data-src="s:resumen"].on'), null, {timeout: 60000});
    await click('.src[data-src="s:integridad"]');
    ok((await gridText()).includes("Hueco de 20 id en visits"), "tras cancelar, el caso se reconstruye con las evidencias abiertas");

    console.log("Carpeta de un usuario: Safari, sesión de Firefox, extensiones y perfiles");
    await page.setInputFiles("#folder", path.join(EV, "usuario"));
    await page.waitForFunction(() => !document.body.classList.contains("busy"), null, {timeout: 60000}); await sleep(2500);
    ok(pageErrors.length === 0, "la carpeta se abre sin errores " + JSON.stringify(pageErrors));
    await click('.src[data-src="s:perfiles"]');
    const prof = await gridText();
    for (const t of ["Google Chrome", "Firefox", "Safari", "x1y2.default-release"]) ok(prof.includes(t), "detecta el perfil: " + t);
    ok(/\bana\b/.test(prof), "identifica al usuario por la ruta");
    await click('.src[data-src="s:integridad"]');
    ok((await gridText()).includes("Historial borrado en Safari"), "detecta el tombstone de Safari como borrado de historial");
    await click('.src[data-src="s:timeline"]');
    await page.fill("#q", "safari3.example.com"); await page.press("#q", "Enter"); await sleep(1200);
    ok((await gridText()).includes("Visita (Safari)"), "las visitas de Safari llegan a la línea de tiempo");
    await page.fill("#q", "wetransfer"); await page.press("#q", "Enter"); await sleep(1200);
    ok((await gridText()).includes("Pestaña cerrada (Firefox)"), "lee sessionstore.jsonlz4 y muestra la pestaña cerrada");
    await page.fill("#q", ""); await page.press("#q", "Enter"); await sleep(600);
    await click('.src[data-src="p:chrome_ext"]');
    const ext = await gridText();
    ok(ext.includes("Ayudante de compras") && ext.includes("<all_urls>"), "lee el manifiesto de la extensión, su nombre traducido y sus permisos sensibles");
    await click('.src[data-src="p:ff_addons"]');
    ok((await gridText()).includes("Grabador de pestañas"), "lee los complementos de Firefox (extensions.json)");

    console.log("Modo archivo local (doble clic)");
    const p2 = await ctx.newPage(), e2 = []; p2.on("pageerror", e => e2.push(String(e)));
    await p2.goto("file://" + path.join(APP, "navestigio.html").replace(/\\/g, "/")); await p2.waitForFunction(() => document.querySelectorAll(".db").length >= 3, null, {timeout: 30000});
    ok(e2.length === 0, "abre sin errores desde file://");

    ok(cspErrors.length === 0, "sin violaciones de CSP " + JSON.stringify(cspErrors.slice(0, 3)));
    ok(external.length === 0, "ninguna petición sale de 127.0.0.1 " + JSON.stringify(external.slice(0, 3)));
  } catch (e) { console.error(e); fails++; }
  finally { await browser.close(); srv.kill(); }
  console.log(fails ? `\n${fails} pruebas fallaron` : "\nTodas las pruebas pasaron");
  process.exit(fails ? 1 : 0);
})();
