-- Índices UNIQUE que existían en el schema de Postgres (supabase/schema.sql)
-- y a mano en dev.db (idx_nota_item_unique), pero faltaban en las migraciones
-- SQLite: una BD nueva creada desde las migraciones quedaba inconsistente con
-- producción.
--
-- 1. idx_nota_item_unique — un solo item por (calificación, tipo, título).
--    En producción, los duplicados reventaban con un 500 crudo (UNIQUE
--    violation); ahora el backend los pre-valida con 409/400 amigables.
--
-- 2. columnas_unicas — una sola columna por (curso, materia, período, año,
--    tipo, título). El POST /columna usaba ON CONFLICT DO NOTHING y mentía
--    con un 200 "agregada" aunque el duplicado se ignorara en silencio.

CREATE UNIQUE INDEX IF NOT EXISTS "idx_nota_item_unique" ON "notas_items"("calificacionId", "tipo", "descripcion");

CREATE UNIQUE INDEX IF NOT EXISTS "columnas_unicas" ON "columnas"("curso", "materiaId", "periodo", "anio", "tipo", "titulo");
