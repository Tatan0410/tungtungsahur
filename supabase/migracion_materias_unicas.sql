    -- =====================================================
-- MIGRACIÓN: materias únicas por nombre (sin grado)
-- Pegar en el SQL Editor de Supabase.
-- SECCIÓN 1: idempotente y ADITIVA — se puede ejecutar ya; el código viejo
--   sigue funcionando hasta que despliegues el nuevo.
-- SECCIÓN 2: el índice UNIQUE sobre nombre_norm — ejecutarla DESPUÉS de
--   correr scripts/fusionar-materias.js --aplicar (antes habría duplicados).
-- =====================================================

-- ─────────────────────────────────────────────────────
-- SECCIÓN 1 — aditiva e idempotente
-- ─────────────────────────────────────────────────────

-- 1.1 Columna nombre_norm (la llena el código y el script de fusión)
ALTER TABLE materias ADD COLUMN IF NOT EXISTS nombre_norm TEXT;

-- 1.2 Llenado inicial aproximado (lower no quita acentos; el script de
--     fusión re-normaliza con la versión completa)
UPDATE materias SET nombre_norm = LOWER(nombre) WHERE nombre_norm IS NULL;

-- 1.3 grado deja de ser obligatorio (deja de usarse, no se borra)
ALTER TABLE materias ALTER COLUMN grado DROP NOT NULL;

-- ─────────────────────────────────────────────────────
-- SECCIÓN 2 — UNIQUE sobre nombre_norm (SOLO DESPUÉS DE FUSIONAR)
-- ⚠️  No ejecutar antes de scripts/fusionar-materias.js --aplicar:
--     las materias duplicadas (Matemáticas 9/10/11…) harían fallar este paso.
-- ─────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS materias_nombre_norm_key ON materias (nombre_norm);
