// Generado desde OpenAPI por scripts/generate-google-drive.mjs. No editar a mano.
export const googleDriveRoutes = {
  "DriveController_estado": {
    "method": "GET",
    "path": "/v1/integraciones/drive"
  },
  "DriveController_iniciar": {
    "method": "POST",
    "path": "/v1/integraciones/drive/iniciar"
  },
  "DriveController_completar": {
    "method": "POST",
    "path": "/v1/integraciones/drive/completar"
  },
  "DriveController_revocar": {
    "method": "POST",
    "path": "/v1/integraciones/drive/revocar"
  },
  "DriveController_selector": {
    "method": "POST",
    "path": "/v1/integraciones/drive/selector"
  },
  "DriveController_seleccionar": {
    "method": "POST",
    "path": "/v1/integraciones/drive/seleccionar"
  },
  "DriveController_permisoIa": {
    "method": "POST",
    "path": "/v1/integraciones/drive/permiso-ia"
  },
  "DriveController_adjuntos": {
    "method": "POST",
    "path": "/v1/integraciones/drive/adjuntos"
  },
  "DriveController_carpeta": {
    "method": "POST",
    "path": "/v1/integraciones/drive/carpeta"
  },
  "DriveController_estadoCarpeta": {
    "method": "POST",
    "path": "/v1/integraciones/drive/carpeta/estado"
  },
  "DriveController_search": {
    "method": "POST",
    "path": "/v1/integraciones/drive/buscar"
  },
  "DriveController_attach": {
    "method": "POST",
    "path": "/v1/integraciones/drive/adjuntar"
  }
} as const;
