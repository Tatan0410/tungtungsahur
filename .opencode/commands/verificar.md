---
description: Verificar los cambios actuales (pruebas + seguridad)
---

Ejecuta la suite completa con `npm test` (o `cmd /c npm test` si el shell lo
requiere) y revisa `git diff` de los cambios actuales. Si el diff toca
autenticación, autorización, subidas de archivos, SQL, dependencias o
cabeceras HTTP/CORS, aplica la skill reviewing-security. Reporta: pruebas
n/n (verde/rojo), hallazgos solo con ruta input→impacto, archivos
modificados y pendientes.
