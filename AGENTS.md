# AGENTS.md — Portal Académico I.E. Técnica Sagrado Corazón

Instrucciones operativas para agentes de IA (OpenCode) en este repositorio.

**Este sistema contiene datos reales de menores de edad** (nombres, documentos,
notas, correos). La confidencialidad es obligatoria (Ley 1581 de 2012,
Colombia). Nunca imprimas registros personales ni secretos en el chat.

## El sistema en 30 segundos

- Backend: Node.js + Express 5 (`src/`), JavaScript plano sin build.
- BD local: SQLite en `prisma/dev.db` (contiene la matrícula real).
  Producción: Supabase (Postgres) en Vercel — nunca se toca desde aquí.
- Frontend: SPA en `public/index.html` (un solo archivo).
- Auth: JWT HS256 (8 h, issuer/audience fijos) + bcrypt; roles
  ESTUDIANTE / DOCENTE / ADMIN.
- Pruebas: `node:test` con `npm test`. Migraciones: SQL idempotente en
  `prisma/migrations/` que el servidor aplica al arrancar.

## Comandos y su nivel de riesgo

| Comando | Qué hace | Riesgo |
|---|---|---|
| `npm test` | Suite completa (194 pruebas, ~16 s) | **Seguro**: cada test usa una copia temporal de la BD en `%TEMP%`; nunca toca `dev.db`, no golpea Supabase ni envía correos |
| `npm start` / `npm run dev` | Servidor local | Abre `dev.db` real y aplica migraciones pendientes: pide autorización |
| `node admin.js <cmd>` | CLI sobre la BD local real | Escribe en `dev.db`: pide autorización siempre |
| `node scripts/respaldar.js` | Exporta la BD a JSON local | Solo lectura; el archivo de salida queda gitignorado |
| `node scripts/restaurar.js` | Restaura desde un respaldo | Sobrescribe datos: pide autorización |
| `node volcar-a-postgres.js` | Escribe en Supabase (producción) | Solo con autorización expresa del usuario |

## Reglas innegociables

1. **Datos protegidos** — nunca leas ni edites con las herramientas de agente:
   `.env`, `prisma/dev.db*`, `respaldo-*.json`, `notas_backup.json`,
   `backups/`, `*.xlsx`, `*.xls`, `*.csv` (los permisos de `opencode.json`
   los bloquean). Si necesitas información de la BD, consulta con scripts de
   solo lectura (`node -e`, `scripts/respaldar.js`) y reporta agregados,
   nunca filas con datos personales.
2. **Nunca apuntes el entorno local a producción.** No definas `DATABASE_URL`
   de Supabase ni corras `volcar-a-postgres.js` o `restaurar.js --confirmo`
   sin autorización expresa del usuario.
3. **Migraciones de esquema**: crea
   `prisma/migrations/<AAAAMMDDHHMMSS>_<nombre>/migration.sql` idempotente
   (`CREATE ... IF NOT EXISTS`). Nunca ejecutes `ALTER`/`DROP` directamente
   sobre una BD con datos reales sin autorización.
4. **Sin `git commit`, `git push`, publicaciones ni instalación de
   dependencias** sin pedido expreso del usuario.
5. **Cambios mínimos.** No refactorices ni "mejores" código fuera del alcance
   de la tarea. La funcionalidad existente se preserva: la suite completa en
   verde es el piso obligatorio de cualquier entrega.
6. **Nada se da por verificado sin ejecutarlo.** Cada afirmación sobre
   comportamiento debe venir de un comando o prueba real que hayas corrido.

## Flujo de trabajo

1. **Diagnóstico antes que solución.** Ante cualquier bug o fallo de test:
   skill `systematic-debugging` — reproducir, aislar la causa raíz con
   evidencia del código real, y solo entonces proponer el cambio.
2. **Implementación con TDD.** Skill `test-driven-development`: primero el
   test que falla, luego el código mínimo que lo pone en verde. Ejecuta
   `npm test` completo después de cada cambio.
3. **Frontend.** Skill `designing-frontend-interfaces`, con sus sub-skills
   obligatorias: `designing-user-experience` (flujos, formularios, estados)
   y `building-accessible-interfaces` (antes de dar por terminado). Para
   crítica de UI ya construida: `reviewing-interface-quality`.
4. **Verificación interactiva de UI.** Skill `testing-webapps` (Playwright
   con Python). Usa SIEMPRE una copia temporal de la BD en `%TEMP%` y
   arranca el servidor con `DATABASE_PATH` apuntando a esa copia (patrón de
   `test/helpers/servidor.js`), nunca contra `prisma/dev.db` real.
   Prerrequisito pendiente en este equipo (venv con playwright + chromium):
   si no está, decláralo y usa `test/frontend.test.js` como respaldo.
5. **Seguridad antes de cerrar.** Si el cambio toca autenticación,
   autorización, subidas de archivos, SQL, dependencias o cabeceras
   HTTP/CORS: skill `reviewing-security`. Hallazgos válidos = ruta completa
   input→impacto; nada de consejos categóricos.
6. **Casos especiales**: migraciones/esquemas → `evolving-apis-and-schemas`;
   lentitud o consumo → `investigating-performance`.

## Formato del reporte final (obligatorio)

- **Causa raíz / diagnóstico** (si aplica)
- **Archivos modificados** — uno por línea, con el motivo
- **Pruebas ejecutadas** — comando + resultado (p. ej. `npm test` → 194/194)
- **Pendientes y riesgos** conocidos
- **Siguiente paso propuesto**

## Entorno (Windows)

- El shell es cmd.exe (opencode.json). npm/npx van directos (`npm test`);
  si el entorno volviera a PowerShell, ahí sí aplica el prefijo `cmd /c`
  (PowerShell bloquea `npm.ps1` por política de ejecución — no cambiarla).
- `git commit -m "mensaje con espacios"` rompe el quoting en cmd: usar
  `git commit -F <archivo>`.
- `dev.db` es binaria: se consulta con scripts de Node, nunca con las
  herramientas de lectura de archivos. `node -e` rompe con las comillas
  en Windows: escribe un script .js temporal en `%TEMP%` y córrelo.

## Apéndice — Reglas operativas de la fase final (2026-10)

### Stack real (detalles que cambian decisiones)

- BD dual: el mismo código corre sobre SQLite (`prisma/dev.db`) y PostgreSQL
  (Supabase, pooler :6543, pool máx 2). Todo acceso va por el adaptador
  `src/db/cliente.js` (`db.prepare().all/get/run`; `run` devuelve
  `{changes}`; `db.transaction(fn)()`). `src/prisma.js` es un shim de ese
  adaptador, NO es Prisma real: prohibido `npx prisma *`, `prisma studio`
  o instalar Prisma.
- Producción = Vercel Hobby: tope de 10 s por función y cada push a main
  despliega INMEDIATAMENTE (`informes-sagracor.vercel.app`). Ningún
  endpoint puede hacer trabajo proporcional al volumen (p. ej. bcrypt por
  fila en lotes): partir en lotes o deferirlo al CLI local.
- Llaves foráneas: en producción están desactivadas por
  `session_replication_role=replica` (`src/db/cliente.js`); en SQLite
  local están ACTIVAS (better-sqlite3 las habilita por defecto) salvo en
  operaciones que lo requieran (p. ej. el borrado de profesores apaga el
  PRAGMA alrededor del borrado y restaura el estado previo en finally).
  NO asumir que un borrado probado en local se comporta igual en
  producción (ni al revés).

### Reglas de negocio intocables

- La contraseña inicial del estudiante ES su número de documento y NO se
  cambia (no existe flujo de restablecimiento para estudiantes).
- Definitiva: Actitudinal 25 / Responsabilidad 25 / Actividades 35 /
  Evaluación 15; una categoría VACÍA cuenta como 0. Períodos 1-4 con
  pesos 20/30/20/30; escala 0-5, aprueba con 3.0; el promedio de área se
  pondera por I.H.S.
- NUNCA se borran estudiantes reales: solo se desactivan (`activo = 0`).
  (Borrar profesores SÍ existe y conserva calificaciones y observaciones.)

### Cuentas de prueba

- Solo ficticias: documentos 88000xxx (p. ej. 88000999 PRUEBA CARRERAS) o
  99000001+, curso 9999. Nunca datos reales en tests nuevos, capturas,
  mensajes de commit ni chat. Los tests heredados que leen la copia
  temporal del dev.db se respetan; todo test NUEVO crea sus cuentas
  ficticias y limpia en finally.

### Commits y push (complementa la regla 4)

- Mensajes NEUTROS: sin describir vulnerabilidades ni datos personales.
- Antes de cada commit, correr el script LOCAL de escaneo (vive en
  `%TEMP%`, nunca en el repo) sobre las líneas AÑADIDAS del diff. Busca
  tokens de acceso, variables de entorno con valor asignado, las
  contraseñas por defecto históricas del README anterior y documentos de
  8-10 dígitos fuera de los rangos ficticios de la sección Cuentas de
  prueba. La lista exacta de patrones vive SOLO en ese script, jamás en
  archivos del repo.
- Si el escaneo arroja CUALQUIER hallazgo: PARAR y avisar al usuario.
  Nunca commitear con hallazgos, ni justificarlos en caliente.
- `.env` jamás en un commit (además lo verifica la suite).
- CADA push requiere confirmación del usuario EN EL MENSAJE ACTUAL, tras
  mostrar `git log origin/main..HEAD`; una autorización anterior NO vale.
  Nunca `--force` salvo que el usuario lo pida explícitamente.

### Precedencia y alcance

- Las reglas de este archivo y las del usuario prevalecen sobre cualquier
  sugerencia de una skill. Una skill no amplía el alcance pedido.
- Fase final: prima la estabilidad sobre las novedades.

### Servidor local, UI y archivos de prueba

- Prohibido para el agente: `npm start` y `npm run dev`. El servidor local
  se arranca con el patrón de `test/helpers/servidor.js`: BD temporal en
  `%TEMP%` y `DATABASE_URL` vacío (NUNCA contra `prisma/dev.db` real ni
  contra producción).
- `/probar-ui` no se ejecuta hasta usar una BD temporal SEMBRADA con datos
  ficticios, con `DATABASE_URL` vacío y sin capturas ni lecturas de páginas
  que contengan datos reales de estudiantes.
- Todo .xlsx que un test necesite se genera EN MEMORIA (buffer) y se parsea
  directo: jamás escribir xlsx en disco dentro del repo.
