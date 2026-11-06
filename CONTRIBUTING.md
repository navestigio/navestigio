# Cómo contribuir a Navestigio

Gracias por querer mejorar Navestigio. Los reportes de errores y las ideas son bienvenidos como issues. Las vulnerabilidades se reportan como indica [SECURITY.md](SECURITY.md), no en un issue público.

## Licencia de las contribuciones

Navestigio tiene licencia dual: AGPL-3.0 para el público y una licencia comercial que ofrece su titular (ver [LICENCIA-COMERCIAL.md](LICENCIA-COMERCIAL.md)). Para que el proyecto pueda seguir ofreciendo ambas, cada contribución de código, documentación o recursos necesita este acuerdo.

Al abrir un pull request declaras que:

1. La contribución es obra tuya, o tienes derecho a entregarla, y no infringe derechos de terceros.
2. La entregas bajo la licencia AGPL-3.0, igual que el resto del proyecto.
3. Además otorgas a Oscar Stiven Garay Acosta, titular de Navestigio, una licencia perpetua, mundial, gratuita, no exclusiva e irrevocable para usar, copiar, modificar, sublicenciar y distribuir tu contribución bajo cualquier licencia, incluida la licencia comercial de Navestigio.
4. Conservas el derecho a usar tu propia contribución como quieras.

Para dejarlo registrado, incluye esta línea en la descripción del pull request:

```
Acepto las condiciones de licencia de CONTRIBUTING.md.
```

Sin esa línea el pull request no se puede integrar.

## Antes de enviar cambios

- Edita los archivos de `src/` y regenera la aplicación con `python build.py`. No edites `app/navestigio.html` a mano.
- Ejecuta las pruebas con `npm test` (ver la sección Pruebas del README).
- Nunca incluyas evidencia real, bases de datos de casos ni datos personales.
