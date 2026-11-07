-- Cerrar un día: feriados, vacaciones, el día que no se abre (#1281).
--
-- `availability` guarda el horario por DÍA DE LA SEMANA y no había nada más.
-- El 18 de septiembre de 2026 cae viernes: una barbería que atiende los
-- viernes ofrecía y confirmaba horas para ese día, y el cliente llegaba a la
-- puerta cerrada con una confirmación de WhatsApp en la mano. Con el agente
-- autónomo tomando horas solo (ADR-0029) eso dejó de ser hipotético.
--
-- La única salida hasta hoy era borrar la disponibilidad del día de la semana
-- completo —perdiendo la configuración— y volver a crearla después.
CREATE TABLE IF NOT EXISTS time_off (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- NULL = todo el negocio. Un feriado cierra para todos; las vacaciones de
  -- una persona cierran solo su agenda, y el resto del equipo sigue
  -- atendiendo.
  owner_id    uuid,
  -- Fechas LOCALES del negocio, no instantes: un feriado es un día del
  -- calendario, y a las 23:00 en Chile ya es otro día en UTC. `huecosDelDia`
  -- recibe el día en la zona del negocio y compara contra estas dos directo.
  starts_on   date NOT NULL,
  -- Inclusive: un cierre de un día tiene `starts_on = ends_on`.
  ends_on     date NOT NULL,
  -- Para el dueño, no para el cliente: «vacaciones», «18 de septiembre».
  -- Nunca viaja en un mensaje de WhatsApp.
  motivo      text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT time_off_rango_valido CHECK (ends_on >= starts_on)
);

-- La pregunta que hace `huecosDelDia` en cada corrida: ¿este día, para esta
-- persona o para todo el negocio, está cerrado?
CREATE INDEX IF NOT EXISTS time_off_por_dia
  ON time_off (tenant_id, starts_on, ends_on);

ALTER TABLE time_off ENABLE ROW LEVEL SECURITY;
-- FORCE además de ENABLE: sin esto el dueño de la tabla se salta su propia
-- política, y la aislación entre negocios dejaría de existir justo para la
-- conexión que más filas puede ver.
ALTER TABLE time_off FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'time_off' AND policyname = 'tenant_isolation') THEN
    -- El NULLIF no es decorativo: sin él, `current_setting` devolviendo
    -- cadena vacía revienta al castear a uuid, y el error no habla de
    -- tenants.
    CREATE POLICY tenant_isolation ON time_off
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;
