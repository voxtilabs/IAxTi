// Generado desde OpenAPI por scripts/generate-campaigns.mjs. No editar a mano.
export const campaignRoutes = {
  "CampanasController_listar": {
    "method": "GET",
    "path": "/v1/campanas"
  },
  "CampanasController_crear": {
    "method": "POST",
    "path": "/v1/campanas"
  },
  "CampanasController_previa": {
    "method": "GET",
    "path": "/v1/campanas/{id}/vista-previa"
  },
  "CampanasController_enviar": {
    "method": "POST",
    "path": "/v1/campanas/{id}/enviar"
  },
  "CampanasController_resultados": {
    "method": "GET",
    "path": "/v1/campanas/{id}/resultados"
  },
  "CampanasController_segmentos": {
    "method": "GET",
    "path": "/v1/campanas/segmentos"
  },
  "PlantillasController_list": {
    "method": "GET",
    "path": "/v1/plantillas"
  },
  "ChannelsController_list": {
    "method": "GET",
    "path": "/v1/channels"
  },
  "TagsController_list": {
    "method": "GET",
    "path": "/v1/tags"
  },
  "MeController_accesoDeModulos": {
    "method": "GET",
    "path": "/v1/me/modules/acceso"
  }
} as const;
