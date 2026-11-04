<p align="center"><img src="app/navestigio_logo.svg" alt="Navestigio · forense de navegadores" width="420"></p>

# Navestigio · forense de navegadores

Navestigio revisa bases SQLite de navegadores (History, Login Data, Web Data, Cookies, places.sqlite) y convierte **todas** las columnas de fecha a GMT-5 (o a otra zona) de una sola vez. Su nombre une *navegador* y *vestigio* (del latín *vestigium*, huella): sigue las huellas que deja quien navega.

Todo ocurre dentro del navegador: la evidencia no se sube a ningún servidor, no se modifica y no hace falta conexión a internet. La página trae una política de seguridad (CSP) que le impide enviar datos a cualquier dirección.

## Descarga

Descarga `navestigio-<versión>.zip` desde la sección **Releases** del repositorio y descomprímelo en una carpeta propia (no directamente en Descargas). Cada release publica también el SHA-256 del zip; en Windows puedes comprobarlo con:

```
certutil -hashfile navestigio-3.1.1.zip SHA256
```

## Cómo usarla

Ejecuta `iniciar_navestigio.bat`. Si tienes Python, lo sirve en http://127.0.0.1:8765 con `servir_navestigio.py` (así se ve el favicon) y abre el navegador; deja esa ventana abierta mientras trabajas. Sin Python, abre el HTML directamente. También se puede abrir con doble clic en Chrome, Edge o Firefox. Los hallazgos, reglas y anchos se guardan por dirección: los de 127.0.0.1 son distintos de los del archivo abierto con doble clic. No necesita Python ni conexión a internet. Los archivos se procesan dentro del navegador, aplica el `-wal` y calcula los SHA-256. Para revisar una carpeta de perfil completa, usa "Abrir carpeta de perfil…".

## Instalar como aplicación (ícono en la barra de tareas)

Navestigio se puede instalar como aplicación web (PWA) en Chrome o Edge:

1. Ejecuta `iniciar_navestigio.bat` para abrir http://127.0.0.1:8765.
2. Pulsa **Instalar app** en la barra superior, o el ícono de instalar al final de la barra de direcciones.
3. Navestigio se abre en su propia ventana. Clic derecho sobre su ícono en la barra de tareas › **Anclar a la barra de tareas**.

Después basta con un clic en ese ícono. La aplicación guarda una copia de sí misma, así que abre aunque `servir_navestigio.py` no esté corriendo. Cuando lo vuelves a ejecutar, toma la versión más reciente. La evidencia se sigue procesando solo dentro del navegador.

Para desinstalarla: en la ventana de Navestigio, menú ⋯ › Desinstalar.

## Análisis del caso (versión HTML)

- **Línea de tiempo unificada** junta en una sola tabla en hora local las visitas, descargas, búsquedas, credenciales, autocompletar, cookies, atajos de la barra de direcciones y el historial de Firefox de todas las bases abiertas.
- **Filtro por fechas**: escribe "Desde/Hasta" en la hora local elegida y la columna de fecha. El filtro se convierte al formato de cada tabla (WebKit, Unix…) y se mantiene al cambiar de tabla.
- **Hallazgos**: marca una fila con ☆ y haz doble clic para agregarle una nota. Todas quedan en "Hallazgos marcados" con su artefacto y su SHA-256. Se guardan por evidencia (según su SHA-256): solo aparecen los de las evidencias abiertas, así que no se mezclan casos. Con `iniciar_navestigio.bat` se recuerdan en ese navegador; abierto con doble clic solo duran mientras la pestaña esté abierta, porque Chrome y Edge comparten el almacenamiento entre todos los HTML locales. **Borrar hallazgos** los elimina del navegador al cerrar un caso; exporta antes el ZIP si los necesitas.
- **Alertas**: etiquetan las filas por categoría y marcan las descargas con advertencia de peligro. Con "Solo filas con alerta" ves solo esas filas, y las palabras se editan en "Reglas de alerta". Los CSV incluyen una columna `alertas`. Categorías predeterminadas:
  - nube/transferencia, correo personal, antiforense/evasión, herramientas de ataque, pegado de texto, mensajería web, ejecutable/comprimido;
  - **Malware/spyware/adware** (familias conocidas, activadores, cracks, warez);
  - **Material ilegal** (sitios .onion/dark web, piratería, drogas, armas, carding, documentos o billetes falsos);
  - **Contenido sexual** (sitios pornográficos y para adultos);
  - **Discriminatorio/difamatorio** (discurso de odio, supremacismo, difamación, calumnia).

  **Criterio de coincidencia:** cada término se busca como palabra completa ("porn" ya no coincide dentro de "pornhub" ni dentro de un código). Antes de buscar, las URL se decodifican y se descartan los bloques codificados largos (tokens SAML, enlaces seguros de Teams/Outlook, base64, hashes), donde las letras forman palabras por casualidad. En las reglas, `palabra*` es un prefijo (`homofob*`), `.exe` es una extensión y `pornhub.com` es un dominio con sus subdominios. Al pasar el mouse sobre una etiqueta se ve el término que coincidió, y el detalle de la fila también lo muestra.

  Son coincidencias por palabra clave: sirven para priorizar la revisión, no prueban por sí solas una infracción. Agrega los términos de la política de uso aceptable de tu compañía en "Reglas de alerta". Si ya tenías reglas guardadas, las categorías nuevas se agregan solas al final.

- **Ver alrededor de un momento**: en el detalle de cualquier fila con fecha (doble clic), "Ver en la línea de tiempo" muestra lo que pasó ± 5 min, ± 15 min, ± 1 hora o ± 1 día alrededor de ese momento.
- **Origen de cada fila**: la línea de tiempo trae tres columnas de procedencia. `fuente` dice si el evento es un registro vigente, un registro recuperado de espacio libre o del `-wal`, o un indicador de integridad. `confianza` (alta, media o baja) dice qué tan sólido es el dato. `base_tiempo` dice de dónde sale la fecha. Así un registro borrado nunca se confunde con una visita confirmada.

## Indicadores de integridad

Navestigio mide hechos de la estructura de cada base que pueden indicar borrado o manipulación, aunque no se recupere ningún registro. Los muestra en "Indicadores de integridad", en el resumen y en el ZIP:

| Indicador | Qué mide |
| --- | --- |
| Faltan los registros más recientes | `sqlite_sequence` registra más inserciones que el id más alto que queda. La expiración automática borra lo más antiguo, no lo más reciente. |
| Hueco de id | Rango de id que ya no existe en visits, downloads o el historial de Firefox, con la fecha del registro anterior y del siguiente. |
| Primeros id que ya no existen | Habitual por la expiración del historial (Chrome conserva unos 90 días). |
| Retrocesos de fecha | Al avanzar el id, la fecha retrocede más de 60 s. Se excluyen las visitas sincronizadas de Chrome. |
| Cookies creadas después de su último uso | La fecha de creación es posterior a la del último acceso. |
| Estructura SQLite dañada | `PRAGMA integrity_check` no devuelve `ok`. |
| `-wal`, `-journal` y páginas libres | Informativos: dónde puede haber datos recientes o borrados. |

Cada indicador separa tres cosas. La **prioridad** dice dónde mirar primero. La **confianza** dice qué tan sólido es el hecho medido. La **interpretación** dice con qué es consistente el hecho, por ejemplo "consistente con un borrado de la actividad más reciente". Ninguno afirma lo que hizo el usuario. Lo mismo vale para las alertas: son una prioridad de revisión, no una prueba de conducta.

El resumen incluye además **Alcance del análisis**, con lo que se revisó y lo que no: valores cifrados que se cuentan pero no se descifran, `-journal` no aplicado, caché, almacenamiento web, sesiones, Safari y memoria. Un resultado limpio solo vale para lo que se revisó.

## Interpretación de URLs y cookies

La columna `interpretacion` (en la línea de tiempo, las vistas de historial y las de cookies) describe lo que contiene el valor, sin afirmar qué hizo el usuario:

- **Búsquedas en la URL**: Google, Bing, DuckDuckGo, Yahoo, YouTube, Yandex, Baidu, Ecosia, Brave, Amazon, Facebook, X, Wikipedia y Mercado Libre. Por ejemplo, "Búsqueda en Google: «como borrar historial»", aunque la búsqueda no esté en `keyword_search_terms`.
- **Campañas y parámetros**: `utm_source`, `utm_campaign` y los parámetros de la URL que no son ruido de seguimiento.
- **Cookies de Google Analytics** (`_ga`, `_ga_*`, `__utma`, `__utmb`, `__utmz`): id de visitante, primera visita, sesiones y origen de la visita. **BIG-IP** (`BIGipServer*`): la IP y el puerto internos del servidor. **Quantcast** (`__qca`) y cualquier valor con una fecha Unix.

Las fechas de la interpretación van en UTC para que no dependan de la zona elegida. En Chrome y Edge el valor de la mayoría de cookies está cifrado; esas filas dicen "valor cifrado: no se descifra".

## Recuperación de registros borrados

Al abrir una base SQLite, Navestigio busca URLs en cuatro lugares:

- las páginas libres (freelist);
- el espacio no asignado de cada página y los freeblocks (celdas borradas);
- las versiones anteriores de páginas que el `-wal` reemplazó;
- todos los frames del `-wal`.

Cuando reconoce un registro completo de la tabla `urls` de Chrome, recupera el título, el número de visitas y la fecha de la última visita. Si no, lo marca como "fragmento". Se descarta todo lo que sigue existiendo en la base actual. Los resultados aparecen en "Análisis del caso › Registros recuperados (borrados)" con su origen, página y desplazamiento. Los que tienen fecha entran en la línea de tiempo como "URL recuperada (borrada)".

## Resumen del caso

Muestra:

- indicadores: visitas, dominios, descargas, búsquedas, alertas, hallazgos y URLs recuperadas;
- el primer y el último uso del navegador;
- gráficos de actividad por día y por hora en la zona horaria elegida;
- los sitios más visitados;
- **alertas por categoría**: cuántos eventos tiene cada categoría y una tarjeta por categoría con sus sitios principales.

Al hacer clic en un día, un dominio, una categoría o un sitio de una categoría, se abre la línea de tiempo filtrada. En la barra de filtros, "Solo filas con alerta de…" permite elegir una sola categoría.

## Artefactos soportados

- **SQLite:** History, Login Data, Web Data, Cookies, Shortcuts, Top Sites, Favicons (con miniaturas de los íconos), places.sqlite de Firefox y Colecciones de Edge (`collectionsSQLite`).
- **JSON:** Bookmarks (marcadores y carpetas), Preferences y Secure Preferences (cuentas, extensiones, preferencias clave) y Local State (perfiles, cuenta de cada perfil, clave de cifrado). Cada JSON incluye además la tabla `json_completo` con todas sus claves.
- Con "Abrir carpeta de perfil…" se cargan todos a la vez.

## Identidad

- `navestigio_logo.svg`: el logotipo en vector, una lupa sobre un rastro de puntos que representa la línea de tiempo. `navestigio_logo.png` es la misma imagen en PNG.
- `navestigio_favicon.svg`: el favicon, que ya va incluido dentro de `navestigio.html`.

## Columnas visibles y modo captura (versión HTML)

- **Columnas visibles** permite marcar o desmarcar columnas. También puedes pasar el mouse por un encabezado y pulsar ✕. Con "Ocultar valores crudos de fecha" quedan solo las fechas convertidas. Lo que elijas se recuerda para cada tabla en ese navegador.
- **Exportar** (en CSV, JSONL, bodyfile o l2t CSV) exporta solo las columnas visibles. **Exportar todo (ZIP)** siempre exporta todas las columnas.
- **Ancho de columnas:** arrastra el borde derecho de cualquier encabezado, también en modo captura. El texto se ajusta al ancho de la celda. Con doble clic en el borde vuelve al ancho automático. "Ajustar texto a la celda" (en Columnas visibles) ajusta todas las columnas a la vez, y "Restablecer anchos" las devuelve a su tamaño original. Los anchos se recuerdan para cada tabla.
- **Modo captura** oculta los menús y deja la tabla con una cabecera de referencia: evidencia, SHA-256, zona horaria, filtro y fecha de generación. Los textos largos se ajustan para que se vean completos en el pantallazo. Pulsa Esc para salir.

## Cómo abrir artefactos

- Usa **Abrir archivos…** o **Abrir carpeta de perfil…**, o arrastra los archivos a la ventana.

Incluye los archivos `-wal` / `-journal` junto a la base, por ejemplo `History` + `History-wal`. Esos archivos guardan registros recientes que no aparecen si solo se abre la base principal. Si abres la carpeta de perfil, se toman solos.

Funciona con History, Login Data, Web Data, Cookies, Favicons, Top Sites y Shortcuts de Chrome, Edge, Brave y Opera, y con `places.sqlite` de Firefox. También puedes abrir cualquier otra base SQLite.

## Protección de la evidencia

- La herramienta calcula el SHA-256 del original y de sus -wal/-journal.
- Todo se lee de una copia en memoria, abierta en modo solo lectura. El original nunca se modifica y nada se envía a ningún servidor.

## Conversión de fechas

La herramienta detecta cada columna de fecha por su cuenta y la muestra en dos columnas. La primera, en verde y con el sufijo `(GMT-5)`, tiene la fecha convertida. La segunda, justo al lado, conserva el valor crudo.

| Formato | Dónde aparece |
|---|---|
| WebKit/Chrome: µs desde 1601-01-01 | History, Login Data, Cookies y la mayoría de bases Chromium |
| Unix en segundos | Web Data (`autofill`, `credit_cards`, `autofill_profiles`) |
| Unix en ms o µs (PRTime) | Firefox (`moz_places`, `moz_historyvisits`) |
| Cocoa/Mac: segundos desde 2001 | `History.db` de Safari |

Si alguna columna se detecta mal, pulsa **Columnas de fecha** y elige el formato correcto, o "no es fecha". El cambio se aplica a la vista y a las exportaciones.

La zona horaria se cambia en la barra superior y por defecto es GMT-5 (Colombia). Hay desfases fijos, incluidos los de media hora o 45 minutos (GMT+5:30, GMT+5:45), y zonas con horario de verano como `America/New_York` o `Europe/Madrid`: en estas, cada fecha usa el desfase vigente en ese momento, también en la línea de tiempo y en los gráficos del resumen. Las fechas salen en formato `dd/mm/aaaa HH:MM:SS`, igual que en el script original.

El botón **Convertir valores** abre una calculadora para timestamps sueltos. 

## Vistas de análisis (★)

Si la base tiene las tablas necesarias, la herramienta crea estas vistas ya unidas:

- **Línea de tiempo de navegación** une visits con urls y decodifica el tipo de transición (TYPED, LINK, RELOAD…).
- **Descargas con cadena de redirecciones** une downloads con downloads_url_chains y decodifica el estado.
- **Términos buscados** une keyword_search_terms con urls.
- **Credenciales guardadas** (Login Data), **Autocompletar** (Web Data), **Cookies** e **Historial de Firefox**.

Las tablas `urls`, `downloads` y las demás de interés aparecen en negrita en la sección "Tablas clave".

## Búsqueda, SQL y exportación

- **Buscar** filtra por texto en todas las columnas. Para ordenar, haz clic en un encabezado. Para ver el detalle completo de una fila, haz doble clic en ella.
- **SQL** acepta consultas propias de tipo `SELECT` o `WITH`, en solo lectura. Las fechas del resultado también se convierten.
- **Exportar** descarga la tabla o vista actual con el filtro aplicado, en el formato que elijas al lado del botón:
  - **CSV**: UTF-8 con BOM y `;` como separador, para que Excel en español lo abra bien. Por seguridad, las celdas de texto que empiezan por `=`, `+`, `-` o `@` llevan un apóstrofo inicial: así un título de página malicioso no se ejecuta como fórmula al abrir el CSV. Los números no se modifican.
  - **JSONL**: un objeto JSON por fila, con `timestamp_utc` y todas las columnas (crudas y convertidas). Sirve para Timesketch, `jq` o cualquier script.
  - **bodyfile**: el formato de `mactime` (The Sleuth Kit), con la fecha en segundos Unix.
  - **l2t CSV**: las 17 columnas de log2timeline/Plaso, con la fecha en la zona horaria elegida.
- **Exportar todo (ZIP)** es el paquete de entrega. Trae todas las tablas y vistas ya convertidas, y además:
  - `informe.html`: informe autónomo (sin scripts) con evidencias y sus hashes, indicadores de integridad, hallazgos con sus notas, alertas por categoría y alcance del análisis. Se puede imprimir a PDF desde el navegador.
  - `manifest.json`: la cadena de custodia en formato de máquina. Incluye el SHA-256 y el MD5 de cada evidencia, el `-wal` aplicado, la versión y la huella de compilación de Navestigio, la versión de SQLite, la zona horaria y su regla, el hash de las reglas de alerta, los indicadores y el SHA-256 de cada archivo exportado.
  - `SHA256SUMS.txt`: el SHA-256 de cada archivo del paquete. Otro perito lo comprueba con `sha256sum -c SHA256SUMS.txt` (Linux o macOS) o `certutil -hashfile <archivo> SHA256` (Windows).
  - `LEEME_cadena_custodia.txt`: lo mismo en texto legible.
  - Desde "Análisis del caso", la línea de tiempo también en JSONL, bodyfile y l2t CSV.

  La **huella de compilación** es el SHA-256 de `src/`, `vendor/SHA256SUMS` y la versión. Quien regenere la app con `python build.py` desde el mismo código obtiene la misma huella, así que el manifiesto dice exactamente con qué código se hizo el análisis.

## Notas

- Todas las consultas SQLite corren en un Web Worker, fuera de la página. Si una consulta tarda más de un segundo aparece el botón **Cancelar**: detiene el motor, lo reinicia y vuelve a abrir las evidencias desde los archivos originales, sin perder los hallazgos. Así una base malformada o una vista maliciosa no pueden colgar la herramienta.
- Las vistas (`CREATE VIEW`) que traiga una base aparecen con la marca «(vista)». Al abrir la evidencia no se ejecutan ni se cuentan sus filas; si abres una y no termina, usa **Cancelar**.

- `password_value` y `encrypted_value` están cifrados con DPAPI/AES y se muestran en hexadecimal. Para descifrarlos haría falta la clave del perfil del usuario, y eso queda fuera del alcance de esta herramienta.
- Si el navegador está abierto, la base puede estar bloqueada. Trabaja sobre la copia adquirida de la evidencia.

## Estructura del repositorio

| Ruta | Contenido |
|---|---|
| `app/` | La aplicación lista para usar: `navestigio.html`, el servidor local, el lanzador `.bat`, el service worker y los íconos. |
| `src/` | El código fuente: `navestigio.template.html` (HTML y CSS), `app.js` (interfaz), `worker.js` (motor SQLite en un Web Worker) y `common.js` (fechas y reglas de alerta, compartido por ambos). |
| `vendor/` | sql.js 1.15.2 (SQLite compilado a WebAssembly) y las fuentes, con sus licencias y `SHA256SUMS`. |
| `build.py` | Genera `app/navestigio.html` a partir de `src/` y `vendor/`. |
| `docs/` | La página del proyecto para GitHub Pages (`index.html` y `assets/`), sin scripts ni recursos externos. `assets/vista-previa.png` es la imagen para redes sociales. |
| `tests/` | Pruebas automatizadas: `fixtures.py` genera evidencias sintéticas (con borrados conocidos y archivos malformados) y `smoke.cjs` las prueba en Chromium. |
| `.github/workflows/` | Ejecuta las pruebas en cada cambio. |

`app/navestigio.html` es un único archivo de unos 1,3 MB porque incrusta sql.js, las fuentes y el código de `src/` para funcionar sin internet y con doble clic. Para comprobar que se construyó con los componentes oficiales, o para regenerarlo después de editar `src/`:

```
python build.py                 # verifica vendor/SHA256SUMS y genera app/navestigio.html
python build.py --verificar-npm # además descarga sql.js de npm y lo compara byte a byte
python build.py --zip           # además arma dist/navestigio-<versión>.zip y su .sha256
```

Solo usa la biblioteca estándar de Python 3.8 o superior.

## Pruebas

Cada cambio en GitHub ejecuta `.github/workflows/pruebas.yml`, que:

1. compara sql.js de `vendor/` byte a byte con el paquete oficial de npm;
2. regenera la app y falla si `app/navestigio.html` no coincide con `src/` (nadie puede publicar una app distinta del código fuente);
3. abre en Chromium evidencias sintéticas y comprueba que detecta los borrados conocidos, interpreta búsquedas, sobrevive a archivos malformados y a una vista con recursión infinita, que el ZIP se verifica con `SHA256SUMS.txt` y que ninguna petición sale de 127.0.0.1.

Para ejecutarlas en tu equipo (requiere Node.js 20 o superior):

```
npm ci --ignore-scripts
npx playwright install chromium
npm test
```

Node.js y Playwright solo se usan para las pruebas; la aplicación no los necesita.

## Seguridad

Si encuentras una vulnerabilidad, sigue las instrucciones de [SECURITY.md](SECURITY.md) en lugar de abrir un issue público.

## Licencia

© 2026 Oscar Stiven Garay Acosta. Navestigio se distribuye bajo la licencia MIT ([LICENSE](LICENSE)). Los componentes de terceros y sus licencias están en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
