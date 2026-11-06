"""Genera evidencias de prueba (sintéticas) para tests/smoke.cjs.

Uso: python tests/fixtures.py <carpeta>

Crea bases con indicadores de borrado conocidos y archivos malformados, para comprobar que
Navestigio detecta lo que debe y que una evidencia hostil no rompe la aplicación.
"""
import json
import os
import shutil
import sqlite3
import struct
import sys

NAMES = ["History", "Cookies", "recursiva.sqlite", "basura.sqlite", "truncada.sqlite", "ConWal", "ConWal-wal", "Preferences"]
T0 = 1767000000  # 29/12/2025 09:20:00 UTC


def webkit(unix_s):
    return int((unix_s + 11644473600) * 1_000_000)


def history(path):
    c = sqlite3.connect(path)
    c.executescript("""
        CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL,
                          typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL);
        CREATE TABLE visits(id INTEGER PRIMARY KEY AUTOINCREMENT, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, from_visit INTEGER,
                            transition INTEGER DEFAULT 0 NOT NULL, segment_id INTEGER, visit_duration INTEGER DEFAULT 0 NOT NULL,
                            originator_cache_guid TEXT DEFAULT '');""")
    for i in range(1, 101):
        url = "https://www.google.com/search?q=como+borrar+historial&oq=como" if i == 30 else f"https://sitio{i}.example.com/p"
        c.execute("INSERT INTO urls(url, title, visit_count, last_visit_time) VALUES(?,?,1,?)", (url, f"Sitio {i}", webkit(T0 + i * 600)))
        c.execute("INSERT INTO visits(url, visit_time, transition) VALUES(?,?,805306368)", (i, webkit(T0 + i * 600)))
    c.execute("DELETE FROM visits WHERE id BETWEEN 40 AND 59")          # hueco de 20 id
    c.execute("DELETE FROM visits WHERE id > 95")                       # faltan los 5 más recientes
    c.execute("DELETE FROM urls WHERE id > 95")
    c.execute("UPDATE visits SET visit_time = ? WHERE id = 70", (webkit(T0 + 60 * 600 - 7200),))  # retroceso de fecha
    c.commit()
    c.close()


def cookies(path):
    c = sqlite3.connect(path)
    c.execute("""CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, path TEXT,
                 expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, last_access_utc INTEGER NOT NULL, encrypted_value BLOB DEFAULT '')""")
    for i in range(10):
        cr = webkit(T0 + i * 100)
        la = cr + 5_000_000 if i < 8 else cr - 3_600_000_000              # 2 cookies usadas antes de crearse
        c.execute("INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?,?)", (cr, f".s{i}.com", "sid", "", "/", 0, 1, 1, la, b"v10xxxxxxxx"))
    c.execute("INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?,?)",
              (webkit(T0), ".tienda.com", "_ga", "GA1.2.987654321.1767000000", "/", 0, 1, 0, webkit(T0 + 500), b""))
    c.commit()
    c.close()


def recursive_view(path):
    c = sqlite3.connect(path)
    c.executescript("""CREATE TABLE t(x);
        CREATE VIEW infinita AS WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r;""")
    c.commit()
    c.close()


def malformed(folder, history_path):
    with open(history_path, "rb") as f:
        good = f.read()
    # cabecera SQLite válida seguida de basura
    with open(os.path.join(folder, "basura.sqlite"), "wb") as f:
        f.write(b"SQLite format 3\x00" + bytes((i * 37) & 255 for i in range(8192)))
    # base truncada: solo las dos primeras páginas
    with open(os.path.join(folder, "truncada.sqlite"), "wb") as f:
        f.write(good[:8192])
    # base con un -wal que declara un tamaño de página imposible
    with open(os.path.join(folder, "ConWal"), "wb") as f:
        f.write(good)
    with open(os.path.join(folder, "ConWal-wal"), "wb") as f:
        f.write(struct.pack(">IIIIIIII", 0x377F0682, 3007000, 3, 0, 1, 2, 0, 0) + b"\x00" * 64)
    # JSON con nombre de artefacto pero contenido inválido
    with open(os.path.join(folder, "Preferences"), "w", encoding="utf-8") as f:
        f.write('{"extensions": {"settings": ')


def cocoa(unix_s):
    return float(unix_s - 978307200)


def safari(path):
    """History.db de Safari con un borrado registrado (tombstone) y visitas en fecha Cocoa."""
    c = sqlite3.connect(path)
    c.executescript("""
        CREATE TABLE history_items(id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, domain_expansion TEXT NULL,
                                   visit_count INTEGER NOT NULL, daily_visit_counts BLOB NOT NULL, weekly_visit_counts BLOB NULL,
                                   autocomplete_triggers BLOB NULL, should_recompute_derived_visit_counts INTEGER NOT NULL,
                                   visit_count_score INTEGER NOT NULL, status_code INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE history_visits(id INTEGER PRIMARY KEY AUTOINCREMENT, history_item INTEGER NOT NULL, visit_time REAL NOT NULL,
                                    title TEXT NULL, load_successful BOOLEAN NOT NULL DEFAULT 1, http_non_get BOOLEAN NOT NULL DEFAULT 0,
                                    synthesized BOOLEAN NOT NULL DEFAULT 0, redirect_source INTEGER NULL, redirect_destination INTEGER NULL,
                                    origin INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, attributes INTEGER NOT NULL DEFAULT 0,
                                    score INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE history_tombstones(id INTEGER PRIMARY KEY AUTOINCREMENT, start_time REAL NOT NULL, end_time REAL NOT NULL,
                                        url TEXT, generation INTEGER NOT NULL DEFAULT 0);""")
    for i in range(1, 11):
        c.execute("INSERT INTO history_items(url, visit_count, daily_visit_counts, should_recompute_derived_visit_counts, visit_count_score) VALUES(?,1,x'',0,0)",
                  (f"https://safari{i}.example.com/",))
        c.execute("INSERT INTO history_visits(history_item, visit_time, title) VALUES(?,?,?)", (i, cocoa(T0 + i * 300), f"Página Safari {i}"))
    c.execute("INSERT INTO history_tombstones(start_time, end_time, url) VALUES(?,?,NULL)", (cocoa(T0 + 3600), cocoa(T0 + 7200)))
    c.commit()
    c.close()


def mozlz4(data):
    """mozLz4 válido con un solo bloque LZ4 de literales (sin compresión real; basta para probar el lector)."""
    n = len(data)
    out = bytearray(b"mozLz40\x00" + struct.pack("<I", n))
    out.append(0xF0)
    rest = n - 15
    while rest >= 255:
        out.append(255)
        rest -= 255
    out.append(rest)
    return bytes(out + data)


def firefox_session(path):
    ms = T0 * 1000
    sess = {"version": ["sessionrestore", 1], "session": {"lastUpdate": ms + 9_000_000, "startTime": ms, "recentCrashes": 0},
            "windows": [{"tabs": [{"entries": [{"url": "https://www.bing.com/search?q=vpn+gratis", "title": "vpn gratis - Buscar"},
                                               {"url": "https://mega.nz/folder/abc", "title": "MEGA"}], "index": 2, "lastAccessed": ms + 8_000_000}],
                         "_closedTabs": [{"state": {"entries": [{"url": "https://wetransfer.com/", "title": "WeTransfer"}], "index": 1, "lastAccessed": ms + 5_000_000},
                                          "closedAt": ms + 6_000_000, "title": "WeTransfer"}]}],
            "_closedWindows": []}
    with open(path, "wb") as f:
        f.write(mozlz4(json.dumps(sess).encode("utf-8")))


def firefox_addons(path):
    ms = T0 * 1000
    data = {"schemaVersion": 36, "addons": [{"id": "grabador@ejemplo", "version": "2.1", "type": "extension", "defaultLocale": {"name": "Grabador de pestañas"},
                                             "installDate": ms + 1_000_000, "updateDate": ms + 1_000_000, "active": True, "userDisabled": False,
                                             "location": "app-profile", "sourceURI": "https://addons.mozilla.org/x.xpi",
                                             "userPermissions": {"permissions": ["tabs", "cookies"], "origins": ["<all_urls>"]}}]}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)


def chrome_extension(folder):
    ext = os.path.join(folder, "Extensions", "abcdefghijklmnopabcdefghijklmnop", "1.0_0")
    os.makedirs(os.path.join(ext, "_locales", "es"), exist_ok=True)
    with open(os.path.join(ext, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"manifest_version": 3, "name": "__MSG_appName__", "version": "1.0", "default_locale": "es", "permissions": ["cookies", "storage"],
                   "host_permissions": ["<all_urls>"], "content_scripts": [{"matches": ["https://*.banco.example/*"], "js": ["c.js"]}]}, f)
    with open(os.path.join(ext, "_locales", "es", "messages.json"), "w", encoding="utf-8") as f:
        json.dump({"appName": {"message": "Ayudante de compras"}}, f)


def user_folder(root):
    """Carpeta de un usuario con Chrome, Firefox y Safari, como la copiaría un analista."""
    if os.path.isdir(root):
        shutil.rmtree(root)
    chrome = os.path.join(root, "Users", "ana", "AppData", "Local", "Google", "Chrome", "User Data", "Default")
    ff = os.path.join(root, "Users", "ana", "AppData", "Roaming", "Mozilla", "Firefox", "Profiles", "x1y2.default-release")
    saf = os.path.join(root, "Users", "ana", "Library", "Safari")
    for d in (os.path.join(chrome, "Network"), ff, saf):
        os.makedirs(d)
    history(os.path.join(chrome, "History"))
    cookies(os.path.join(chrome, "Network", "Cookies"))
    chrome_extension(chrome)
    firefox_session(os.path.join(ff, "sessionstore.jsonlz4"))
    firefox_addons(os.path.join(ff, "extensions.json"))
    safari(os.path.join(saf, "History.db"))


def main():
    folder = sys.argv[1]
    os.makedirs(folder, exist_ok=True)
    for name in NAMES:  # solo borra lo que este script genera
        if os.path.exists(os.path.join(folder, name)):
            os.remove(os.path.join(folder, name))
    history(os.path.join(folder, "History"))
    cookies(os.path.join(folder, "Cookies"))
    recursive_view(os.path.join(folder, "recursiva.sqlite"))
    malformed(folder, os.path.join(folder, "History"))
    user_folder(os.path.join(folder, "usuario"))
    print(f"[+] evidencias de prueba en {folder}")


if __name__ == "__main__":
    main()
