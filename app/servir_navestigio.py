#!/usr/bin/env python3
"""Navestigio por localhost.

Sirve navestigio.html en http://127.0.0.1:8765 para que el navegador muestre el
favicon, se pueda instalar como aplicacion (boton "Instalar app" o el icono de
instalar en la barra de direcciones de Chrome/Edge) y la pagina tenga un origen propio (las preferencias, hallazgos y
reglas se guardan por origen). Solo escucha en el propio equipo.

Uso:
    python servir_navestigio.py            # abre http://127.0.0.1:8765
    python servir_navestigio.py --port 9000 --no-browser

La evidencia NO se sube a este servidor: los archivos se procesan dentro del
navegador, igual que al abrir navestigio.html con doble clic.
"""
import argparse
import http.server
import os
import sys
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = {
    "/": ("navestigio.html", "text/html; charset=utf-8"),
    "/index.html": ("navestigio.html", "text/html; charset=utf-8"),
    "/navestigio.html": ("navestigio.html", "text/html; charset=utf-8"),
    "/favicon.svg": ("navestigio_favicon.svg", "image/svg+xml"),
    "/favicon.ico": ("navestigio_favicon.svg", "image/svg+xml"),
    "/navestigio_logo.png": ("navestigio_logo.png", "image/png"),
    "/navestigio_logo.svg": ("navestigio_logo.svg", "image/svg+xml"),
    # Aplicación instalable (PWA): ícono en la barra de tareas y ventana propia.
    "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
    "/sw.js": ("sw.js", "text/javascript; charset=utf-8"),
    "/icon-192.png": ("icon-192.png", "image/png"),
    "/icon-512.png": ("icon-512.png", "image/png"),
    "/icon-maskable-512.png": ("icon-maskable-512.png", "image/png"),
}


# Misma politica que la etiqueta <meta> de navestigio.html, mas frame-ancestors (que solo funciona como encabezado).
# connect-src 'none': la pagina no puede enviar datos a ningun servidor, tampoco a este.
CSP = ("default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; "
       "img-src 'self' data: blob:; font-src data:; connect-src 'none'; manifest-src 'self'; worker-src 'self' blob:; "
       "base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'")
# El service worker necesita pedir al propio servidor los archivos que guarda para abrir sin conexion.
CSP_SW = "default-src 'none'; connect-src 'self'"


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "Navestigio"
    sys_version = ""

    def _allowed_host(self):
        # Evita DNS rebinding: solo se responde si el navegador pidio 127.0.0.1 o localhost en este puerto.
        port = self.server.server_address[1]
        return self.headers.get("Host", "") in (f"127.0.0.1:{port}", f"localhost:{port}")

    def _serve(self, body):
        if not self._allowed_host():
            self.send_error(400, "Host no permitido")
            return
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        entry = FILES.get(path)
        if not entry or not os.path.isfile(os.path.join(HERE, entry[0])):
            self.send_error(404, "No encontrado")
            return
        with open(os.path.join(HERE, entry[0]), "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", entry[1])
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", CSP_SW if path == "/sw.js" else CSP)
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("X-Navestigio", "1")  # el service worker solo guarda respuestas con esta marca
        self.end_headers()
        if body:
            self.wfile.write(data)

    def do_GET(self):
        self._serve(True)

    def do_HEAD(self):
        self._serve(False)

    def log_message(self, fmt, *args):
        pass


def main():
    ap = argparse.ArgumentParser(description="Sirve Navestigio en 127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    if not os.path.isfile(os.path.join(HERE, "navestigio.html")):
        sys.exit("No encuentro navestigio.html junto a este script.")
    try:
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    except OSError:
        sys.exit(f"El puerto {a.port} esta ocupado. Cierra la otra ventana de Navestigio o usa --port 9000.")
    url = f"http://127.0.0.1:{a.port}/"
    print(f"Navestigio disponible en {url}")
    print("Deja esta ventana abierta mientras trabajas. Ctrl+C para cerrar.")
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nNavestigio cerrado.")


if __name__ == "__main__":
    main()
