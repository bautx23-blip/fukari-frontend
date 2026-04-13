-- Bot Entrevistador IA — Tablas para conocimiento del bot
-- Ejecutar manualmente en Supabase SQL Editor

-- Eliminar tablas viejas si existen (del módulo anterior)
DROP TABLE IF EXISTS bot_conocimiento CASCADE;
DROP TABLE IF EXISTS bot_entrevistas CASCADE;

-- Tabla de entrevistas por sección
CREATE TABLE bot_entrevistas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seccion text NOT NULL,
  mensajes jsonb NOT NULL DEFAULT '[]'::jsonb,
  estado text NOT NULL DEFAULT 'sin_iniciar' CHECK (estado IN ('sin_iniciar', 'en_progreso', 'completa')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(seccion)
);

-- Tabla de conocimiento extraído
CREATE TABLE bot_conocimiento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seccion text NOT NULL,
  contenido text NOT NULL,
  version integer DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(seccion)
);

-- RLS
ALTER TABLE bot_entrevistas ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_conocimiento ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON bot_entrevistas FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_read" ON bot_entrevistas FOR SELECT TO authenticated USING (true);

CREATE POLICY "service_role_full_access" ON bot_conocimiento FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_read" ON bot_conocimiento FOR SELECT TO authenticated USING (true);

-- Trigger para updated_at automático
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_bot_entrevistas_updated_at
  BEFORE UPDATE ON bot_entrevistas
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_bot_conocimiento_updated_at
  BEFORE UPDATE ON bot_conocimiento
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
