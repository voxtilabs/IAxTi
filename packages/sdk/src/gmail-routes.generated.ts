// Generado desde OpenAPI por scripts/generate-gmail.mjs. No editar a mano.
export const gmailRoutes = {
  "GmailController_estado": {
    "method": "GET",
    "path": "/v1/integraciones/gmail"
  },
  "GmailController_iniciar": {
    "method": "POST",
    "path": "/v1/integraciones/gmail/iniciar"
  },
  "GmailController_completar": {
    "method": "POST",
    "path": "/v1/integraciones/gmail/completar"
  },
  "GmailController_revocar": {
    "method": "POST",
    "path": "/v1/integraciones/gmail/revocar"
  },
  "GmailController_get_threads": {
    "method": "GET",
    "path": "/v1/integraciones/gmail/hilos"
  }
} as const;
