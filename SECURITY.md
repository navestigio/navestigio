# Política de seguridad

Navestigio procesa evidencia forense, así que tomamos en serio cualquier fallo que permita leer, alterar o enviar fuera del equipo los datos de un caso.

## Cómo reportar una vulnerabilidad

No abras un issue público. Usa **Security › Report a vulnerability** en este repositorio (aviso privado de GitHub) e incluye:

- la versión de Navestigio (aparece bajo el logo) y el navegador;
- los pasos para reproducirlo y, si aplica, un archivo de prueba **sin datos reales de ningún caso**;
- el impacto que observaste.

Responderemos en un plazo de 7 días y coordinaremos contigo la publicación del arreglo.

## Alcance

Nos interesan especialmente:

- ejecución de código (XSS) a partir de datos de la evidencia;
- cualquier forma de que la página envíe datos fuera del equipo;
- acceso de otros sitios web o programas al servidor local `servir_navestigio.py`;
- modificación del archivo de evidencia original o resultados alterados en las exportaciones.

Las consultas corren en un Web Worker que se puede cancelar. Si una base malformada aun así congela la página (no solo una consulta), también nos interesa.

## Versiones con soporte

Solo la última versión publicada en Releases recibe correcciones de seguridad.
