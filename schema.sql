-- Esquema multi-cuenta para el SaaS de personal trainers
-- Turso / SQLite. Correr una sola vez con: turso db shell <base> < schema.sql

-- Cada PT suscripto. Todo lo demás cuelga de acá.
CREATE TABLE IF NOT EXISTS cuentas (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  password    TEXT NOT NULL,          -- hash bcrypt, nunca texto plano
  nombre      TEXT NOT NULL,
  rol         TEXT NOT NULL DEFAULT 'pt',      -- pt | admin
  plan        TEXT NOT NULL DEFAULT 'prueba',  -- prueba | activo | pausado
  creada      TEXT NOT NULL
);

-- Alumnos del PT.
CREATE TABLE IF NOT EXISTS clientes (
  id          TEXT PRIMARY KEY,
  cuenta_id   TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  contacto    TEXT,
  inicio      TEXT,                   -- AAAA-MM-DD, arranque del plan actual
  token       TEXT NOT NULL UNIQUE,   -- link de acceso del alumno, sin contraseña
  activo      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_clientes_cuenta ON clientes(cuenta_id);
CREATE INDEX IF NOT EXISTS ix_clientes_token  ON clientes(token);

-- Banco de ejercicios: se carga una vez por cuenta y se reutiliza en todas las rutinas.
CREATE TABLE IF NOT EXISTS ejercicios (
  id          TEXT PRIMARY KEY,
  cuenta_id   TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  grupo       TEXT,
  video_url   TEXT,                   -- link a YouTube/Instagram
  video_file  TEXT                    -- reservado para la fase 2 (archivo propio)
);
CREATE INDEX IF NOT EXISTS ix_ejercicios_cuenta ON ejercicios(cuenta_id);

CREATE TABLE IF NOT EXISTS rutinas (
  id          TEXT PRIMARY KEY,
  cuenta_id   TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  cliente_id  TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  inicio      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rutinas_cliente ON rutinas(cliente_id);

-- Día flexible: orden + nombre libre + día sugerido opcional (no atado al calendario).
CREATE TABLE IF NOT EXISTS rutina_dias (
  id          TEXT PRIMARY KEY,
  cuenta_id   TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  rutina_id   TEXT NOT NULL REFERENCES rutinas(id) ON DELETE CASCADE,
  orden       INTEGER NOT NULL,
  nombre      TEXT,
  dia_sugerido TEXT
);
CREATE INDEX IF NOT EXISTS ix_dias_rutina ON rutina_dias(rutina_id);

-- Conecta un ejercicio del banco con un día concreto.
CREATE TABLE IF NOT EXISTS rutina_items (
  id           TEXT PRIMARY KEY,
  cuenta_id    TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  dia_id       TEXT NOT NULL REFERENCES rutina_dias(id) ON DELETE CASCADE,
  ejercicio_id TEXT NOT NULL REFERENCES ejercicios(id),
  orden        INTEGER NOT NULL DEFAULT 0,
  series       TEXT,
  reps         TEXT,
  nota         TEXT
);
CREATE INDEX IF NOT EXISTS ix_items_dia ON rutina_items(dia_id);

-- Lo que carga el alumno.
CREATE TABLE IF NOT EXISTS series_log (
  id           TEXT PRIMARY KEY,
  cuenta_id    TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  cliente_id   TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  ejercicio_id TEXT NOT NULL REFERENCES ejercicios(id),
  fecha        TEXT NOT NULL,
  kg           REAL,
  reps         INTEGER
);
CREATE INDEX IF NOT EXISTS ix_series_cliente ON series_log(cliente_id, fecha);

CREATE TABLE IF NOT EXISTS seguimiento (
  id          TEXT PRIMARY KEY,
  cuenta_id   TEXT NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  cliente_id  TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  fecha       TEXT NOT NULL,
  peso        REAL,
  nota        TEXT,
  foto_url    TEXT
);
CREATE INDEX IF NOT EXISTS ix_seguimiento_cliente ON seguimiento(cliente_id, fecha);
