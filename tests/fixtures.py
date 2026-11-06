"""Genera evidencias de prueba (sintéticas) para tests/smoke.cjs.

Uso: python tests/fixtures.py <carpeta>

Crea bases con indicadores de borrado conocidos y archivos malformados, para comprobar que
Navestigio detecta lo que debe y que una evidencia hostil no rompe la aplicación.
"""
import os
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
    print(f"[+] evidencias de prueba en {folder}")


if __name__ == "__main__":
    main()
