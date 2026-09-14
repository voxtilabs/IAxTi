-- Cuota mensual de la API por tenant (#25): el tope vive en el PLAN y el
-- SuperAdmin puede subirlo por tenant (settings.api.requestsMonthOverride)
-- sin desplegar. NULL pasa a un tope real: la API nunca queda infinita.
UPDATE plan_limits SET api_requests_month = 10000  WHERE plan = 'base'   AND api_requests_month IS NULL;
UPDATE plan_limits SET api_requests_month = 50000  WHERE plan = 'crece'  AND api_requests_month IS NULL;
UPDATE plan_limits SET api_requests_month = 200000 WHERE plan = 'equipo' AND api_requests_month IS NULL;
