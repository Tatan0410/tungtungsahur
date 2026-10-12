---
description: Prueba interactiva del portal con Playwright
---

Usa la skill testing-webapps para probar $ARGUMENTS en la SPA
(`public/index.html`). Obligatorio: servidor local contra una COPIA temporal
de la BD en `%TEMP%` (arranca con `DATABASE_PATH` apuntando a la copia,
patrón de `test/helpers/servidor.js`), nunca contra `prisma/dev.db` real.
Prerrequisito pendiente en este equipo: venv de Python con Playwright y
Chromium. Si no está disponible, dilo claramente y usa como respaldo los
tests estáticos de `test/frontend.test.js`.
