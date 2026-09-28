# Guía de producción y escala

Cómo pasar el sistema de una laptop a **Supabase + Vercel** y sostener
**~10 000 usuarios concurrentes**. Con lo que ya está y con lo que falta.

> Realidad primero: la app hoy corre sobre **SQLite en archivo local**
> (`better-sqlite3`, síncrono) y **rate limits en memoria**. Eso funciona en
> un servidor único, **no** en serverless. Este documento explica qué
> cambiar y en qué orden.

---

## 0. Estado actual

| Pieza | Hoy | ¿Sirve en producción? |
|---|---|---|
| Frontend | `public/index.html`, `const API = ''` (misma origen) | Sí, estático en Vercel |
| API | Express con `app.listen()` | Sí, en un host Node de proceso largo |
| BD | `prisma/dev.db` (SQLite, WAL) | **No en Vercel**: FS efímero y solo lectura |
| Rate limits | `Map` en memoria | **No multi-réplica**: cada proceso cuenta aparte |
| JWT | HS256, 8 h, sin estado | Sí, es la pieza que permite escalar sin sesión pegada |
| CORS/Proxy | `ALLOWED_ORIGINS`, `TRUST_PROXY=1` (opt-in) | Configurar en cada entorno |
| Correo | Gmail SMTP (`SMTP_*`) | Sí, pero mirar límites de Gmail |

---

## 1. Arquitectura recomendada

```
                        ┌────────────────────────────┐
  usuarios ──HTTPS──►   │ Vercel (CDN)              │  index.html + logo
                        │  rewrites /api/* ───────┐ │  (caché, gratis, global)
                        └─────────────────────────┼─┘
                                                  │
                        ┌─────────────────────────▼─┐
                        │ API Node (Render/Railway) │  Express, estado sin
                        │  TRUST_PROXY=1            │  sesiones (JWT)
                        └───────────────┬───────────┘
                                        │ pool (pgbouncer)
                        ┌───────────────▼───────────┐
                        │ Supabase (Postgres)       │  PITR, backups, réplicas
                        └───────────────────────────┘
```

Por qué **no** Vercel para la API: el FS es efímero (SQLite se borraría),
cada invocación es un contenedor frío y `app.listen()` no encaja con el
modelo serverless. Vercel sí es el lugar correcto para el HTML.

---

## 2. Fase 1 — puesta en línea rápida (1 día)

Sin tocar la base de datos. Alcance: cientos de usuarios concurrentes.

1. **Frontend en Vercel**
   - Proyecto con raíz `public/`.
   - `vercel.json` para que las llamadas a `/api` lleguen a tu API:
     ```json
     {
       "rewrites": [
         { "source": "/api/:path*", "destination": "https://TU-API.onrender.com/api/:path*" }
       ]
     }
     ```
   - Así `const API = ''` sigue funcionando y **no hay CORS**.

2. **API en Render / Railway / Fly.io** (proceso largo, disco persistente)
   - Build: `npm ci` · Start: `npm start`.
   - Disco persistente montado en `prisma/` (o copia la BD con `cp` al
     desplegar; **nunca** sobrescribas `dev.db` en cada deploy).
   - Variables de entorno (nunca en el repo):
     ```
     JWT_SECRET=<96 hex aleatorios>     # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
     ALLOWED_ORIGINS=https://tudominio.vercel.app
     TRUST_PROXY=1                      # obligatorio detrás del proxy del host
     SMTP_HOST=smtp.gmail.com
     SMTP_PORT=465
     SMTP_USER=...
     SMTP_PASS=<contraseña de aplicación de Gmail>
     ```

3. **Antes de abrir al público**
   - Cambiar `Admin2025` y las contraseñas de prueba (ver SECURITY.md §3.10).
   - Verificar `https://tudominio/api/ping` → `200`.
   - Verificar login y recuperación de contraseña con un correo real.

4. **Límites de esta fase**
   - Un solo proceso: el escritor de SQLite serializa los writes.
   - Los límites por IP sólo viven en esa instancia.
   - Backup manual: `sqlite3 prisma/dev.db ".backup backup-$(date +%F).db"`
     programado con cron cada noche.

---

## 3. Fase 2 — Supabase (Postgres)

El objetivo es salir de SQLite. El esquema ya existe en
`prisma/schema.prisma` y la migración inicial en
`prisma/migrations/`.

### 3.1 Crear el proyecto
1. supabase.com → nuevo proyecto → guardar `DATABASE_URL` (modo **pooler**,
   transaction) y la `DB password`.
2. SQL Editor → pegar y ejecutar `prisma/migrations/*/migration.sql`
   (adaptar tipos si Prisma emite `TEXT` para fechas; ver 3.3).

### 3.2 Estrategia de porting

Hay dos caminos; elige uno y hazlo en una rama:

**A. Prisma ORM (recomendado a medio plazo)**
- `npm i @prisma/client` y `npm i -D prisma`, `prisma generate`.
- Reemplazar `src/prisma.js` por el cliente real y traducir las llamadas
  del shim (`usuario.findUnique`, `calificacion.upsert`, etc.) — el shim ya
  tiene exactamente esa forma, por eso es el punto de inyección natural.
- Ventaja: migraciones futuras con `prisma migrate`.

**B. `pg` manteniendo el SQL crudo (menos cambios)**
- Pool con `pg` (`max: 10`, SSL `rejectUnauthorized: false` en Supabase).
- Adaptador mínimo para no tocar 400 call sites:
  ```js
  // convierte ? → $1, $2 … (el contador va aparte del offset del match)
  function placeholders(texto) {
    let n = 0
    return texto.replace(/\?/g, () => '$' + (++n))
  }
  // devuelve un objeto con .get/.all/.run como better-sqlite3, pero async
  prepare(texto) {
    const sql = placeholders(texto)
    return {
      get: async (...p) => (await pool.query(sql, p)).rows[0],
      all: async (...p) => (await pool.query(sql, p)).rows,
      run: async (...p) => (await pool.query(sql, p)),
    }
  }
  ```
  ⚠️ Convierte esto en trabajo de 2 fases: primero hacer `await` en todas
  las llamadas (eslint `no-floating-promises` ayuda), luego cambiar el
  motor. **No** hagas el truco de devolver promesas sin `await`: los
  errores quedan silenciados.

### 3.3 Diferencias SQLite → Postgres a revisar

| SQLite hoy | Postgres |
|---|---|
| `?` | `$1, $2, …` |
| `datetime('now', '-1 hour')` (`auth.js:196,208,246,247`) | `now() - interval '1 hour'` |
| `INSERT OR IGNORE INTO columnas …` (`notas.js:695`) | `INSERT … ON CONFLICT DO NOTHING` |
| `db.pragma('journal_mode = WAL')` (`src/prisma.js:6`) | eliminar (no existe) |
| Conexión extra `new Database(DB_PATH)` en `notas.js:4-8` | usar el mismo pool |
| `TEXT` con UUID | `uuid` (o `text` con check) |
| `SUM()`/`AVG()` sobre `NULL` | mismo comportamiento, revisar `COALESCE` |
| `better-sqlite3` síncrono | **todo pasa a `async`** |

También: índices. Antes de producción, `EXPLAIN ANALYZE` sobre las
consultas de `calificaciones(estudianteId, materiaId, periodo, anio)` y
`observaciones(fecha)`. Si no existen, crearlos.

### 3.4 Rate limits fuera de la memoria
- Mover el contador de login/recuperación a una tabla:
  `rate_limits(clave, ventana_inicio, contador)` con upsert atómico, o
  usar **Upstash Redis** (`@upstash/ratelimit`) si no quieres mantener SQL.
- Mientras vivan en `Map`, con 3 réplicas el límite efectivo es 3×.

---

## 4. Fase 3 — escalar a ~10 000 concurrentes

Definamos la carga: 10 000 **sesiones abiertas** a la vez es muy distinto
de 10 000 **requests/s**. Un colegio real pico (publicación de notas)
genera quizás 500–2 000 req/s durante minutos.

### Cuellos de botella actuales y arreglo

1. **Estático**: Vercel CDN ya lo absorbe. `Cache-Control: public,
   max-age=3600` para `index.html` y `logo.png` con hash en el nombre.
2. **CPU del proceso Node**: las respuestas son JSON pequeños; con 2–4
   réplicas de 2 vCPU aguantas >5 000 req/s. Autoscaling por CPU >60%.
3. **Base de datos (el verdadero límite)**:
   - Supabase con pooler: `max: 20` conexiones por instancia → 3 instancias
     caben en el pool de Supabase; si no, subir el plan o usar
     PgBouncer propio.
   - `reporteCorte` es O(estudiantes × materias) con N+1 queries: cachear
     el resultado por curso+periodo (Redis o tabla materializada) y
     recalcular al guardar notas.
   - Lecturas de reporte → réplica de Supabase o CDN con revalidación.
4. **Memoria de los límites**: a Redis (ver 3.4).
5. **Observabilidad**: `/api/ping` + logs estructurados; alerta si
   `p95 > 500ms` o error rate > 1%.

### Prueba de carga

```bash
# desde otra máquina (o un runner con 2 vCPU)
npx autocannon -c 500 -d 30 https://tudominio/api/ping
npx autocannon -c 200 -d 30 -m POST \
  -H 'content-type=application/json' \
  -b '{"documento":"99999999","password":"Admin2025"}' \
  https://tudominio/api/auth/login
```

Métricas a mirar: `p95`, `errors`, uso de CPU y conexiones DB. Si el p95
se dispara en login, es el bcrypt (cost 10 ≈ 100 ms) — solución: no
subir el cost, dejar que las réplicas lo repartan, y cachear respuestas
de solo lectura.

### Checklist de producción

- [ ] `JWT_SECRET` aleatorio y rotado (nunca el de ejemplo)
- [ ] `ALLOWED_ORIGINS` = dominio real de Vercel
- [ ] `TRUST_PROXY=1` (si no, los límites por IP no aplican)
- [ ] SMTP de aplicación configurado y probado
- [ ] Contraseñas por defecto cambiadas
- [ ] Backups automáticos activos (Supabase PITR) y **restauración probada**
- [ ] HTTPS en todo (Vercel/Render lo ponen)
- [ ] Rate limits en Redis/Postgres si hay más de una réplica
- [ ] `npm audit` revisado antes de cada release
- [ ] Logs sin PII (no imprimir códigos de recuperación en producción)

---

## 5. Resumen de variables de entorno

| Variable | Producción | Notas |
|---|---|---|
| `DATABASE_URL` | cadena Supabase (pooler) | jamás en git |
| `JWT_SECRET` | 96 hex aleatorios | rotar invalida sesiones |
| `ALLOWED_ORIGINS` | `https://tudominio.vercel.app` | vacío ⇒ CORS `*` |
| `TRUST_PROXY` | `1` | `0` solo en local |
| `PORT` | lo que asigne el host | Render usa 10000 |
| `SMTP_HOST/PORT/USER/PASS` | Gmail con contraseña de aplicación | límite ~500/día; para más volumen usar Resend/SendGrid |
