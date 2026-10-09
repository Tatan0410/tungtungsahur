-- Publicación de boletines: nadie ve su boletín hasta que el admin lo
-- publica para (anio, periodo) — global (curso = '') o por curso específico.
-- UNIQUE evita dobles publicaciones del mismo alcance.
CREATE TABLE IF NOT EXISTS "boletines_publicados" (
    "id" TEXT PRIMARY KEY,
    "anio" INTEGER NOT NULL,
    "periodo" INTEGER NOT NULL,
    "curso" TEXT NOT NULL DEFAULT '',
    "generadopor" TEXT,
    "generadoen" TEXT NOT NULL,
    CONSTRAINT "boletines_unicos" UNIQUE ("anio", "periodo", "curso")
);

-- Configuración institucional (clave/valor). Hoy guarda la FIRMA VIRTUAL
-- del rector (data URL base64 de una imagen PNG/JPG subida desde el panel);
-- el boletín es 100% digital, la firma es una imagen, no papel.
CREATE TABLE IF NOT EXISTS "config_institucion" (
    "clave" TEXT PRIMARY KEY,
    "valor" TEXT
);

-- Auditoría de impresión masiva de boletines (datos de menores: quién
-- imprimió, qué curso, qué período, cuándo)
CREATE TABLE IF NOT EXISTS "boletines_impresiones_log" (
    "id" TEXT PRIMARY KEY,
    "usuarioId" TEXT NOT NULL,
    "curso" TEXT NOT NULL,
    "periodo" INTEGER NOT NULL,
    "anio" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL DEFAULT 0,
    "fecha" TEXT NOT NULL
);
