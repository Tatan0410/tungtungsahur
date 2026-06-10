-- CreateTable
CREATE TABLE "usuarios" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "correo" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "rol" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "documento" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "estudiantes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "usuarioId" TEXT NOT NULL,
    "documento" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "sede" TEXT NOT NULL,
    "jornada" TEXT NOT NULL,
    "grado" INTEGER NOT NULL,
    "curso" TEXT NOT NULL,
    "mesa" INTEGER,
    CONSTRAINT "estudiantes_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "docentes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "usuarioId" TEXT NOT NULL,
    CONSTRAINT "docentes_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "materias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nombre" TEXT NOT NULL,
    "grado" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "docente_materias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "docenteId" TEXT NOT NULL,
    "materiaId" TEXT NOT NULL,
    "curso" TEXT NOT NULL,
    CONSTRAINT "docente_materias_docenteId_fkey" FOREIGN KEY ("docenteId") REFERENCES "docentes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "docente_materias_materiaId_fkey" FOREIGN KEY ("materiaId") REFERENCES "materias" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notas_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "calificacionId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "valor" REAL NOT NULL,
    "descripcion" TEXT,
    "creadoEn" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notas_items_calificacionId_fkey" FOREIGN KEY ("calificacionId") REFERENCES "calificaciones" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "calificaciones" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "estudianteId" TEXT NOT NULL,
    "materiaId" TEXT NOT NULL,
    "docenteId" TEXT NOT NULL,
    "periodo" INTEGER NOT NULL,
    "anio" INTEGER NOT NULL,
    "definitiva" REAL,
    "creadoEn" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadoEn" DATETIME NOT NULL,
    CONSTRAINT "calificaciones_estudianteId_fkey" FOREIGN KEY ("estudianteId") REFERENCES "estudiantes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "calificaciones_materiaId_fkey" FOREIGN KEY ("materiaId") REFERENCES "materias" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "calificaciones_docenteId_fkey" FOREIGN KEY ("docenteId") REFERENCES "docentes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "consultas_estudiantes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "estudianteId" TEXT NOT NULL,
    "periodo" INTEGER NOT NULL,
    "anio" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "consultas_estudiantes_estudianteId_fkey" FOREIGN KEY ("estudianteId") REFERENCES "estudiantes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "informes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "estudianteId" TEXT NOT NULL,
    "periodo" INTEGER NOT NULL,
    "anio" INTEGER NOT NULL,
    "rutaPdf" TEXT NOT NULL,
    "generadoEn" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disponible" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "informes_estudianteId_fkey" FOREIGN KEY ("estudianteId") REFERENCES "estudiantes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_correo_key" ON "usuarios"("correo");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_documento_key" ON "usuarios"("documento");

-- CreateIndex
CREATE UNIQUE INDEX "estudiantes_usuarioId_key" ON "estudiantes"("usuarioId");

-- CreateIndex
CREATE UNIQUE INDEX "estudiantes_documento_key" ON "estudiantes"("documento");

-- CreateIndex
CREATE UNIQUE INDEX "estudiantes_codigo_key" ON "estudiantes"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "docentes_usuarioId_key" ON "docentes"("usuarioId");

-- CreateIndex
CREATE UNIQUE INDEX "docente_materias_docenteId_materiaId_curso_key" ON "docente_materias"("docenteId", "materiaId", "curso");

-- CreateIndex
CREATE UNIQUE INDEX "calificaciones_estudianteId_materiaId_periodo_anio_key" ON "calificaciones"("estudianteId", "materiaId", "periodo", "anio");

-- CreateIndex
CREATE UNIQUE INDEX "consultas_estudiantes_estudianteId_periodo_anio_key" ON "consultas_estudiantes"("estudianteId", "periodo", "anio");

-- CreateIndex
CREATE UNIQUE INDEX "informes_estudianteId_periodo_anio_key" ON "informes"("estudianteId", "periodo", "anio");
