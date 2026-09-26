// Generado por scripts/generar-catalogo-herramientas.mjs desde el OpenAPI
// de la app levantada y el AST de los controladores. NO editar a mano:
// la descripción en español y si la acción es reversible viven en
// `catalogo-curado.ts`, que es lo único que escribe una persona.

export interface OperacionDeLaApi {
  metodo: string;
  /** Tal como la publica el documento, con `{id}`. */
  ruta: string;
  resumen: string;
  /** El que exige `RequirePermission`. `null` = no exige ninguno. */
  permiso: string | null;
  /** El módulo dueño: apagado, la operación no existe para ese tenant. */
  modulo: string | null;
  /** Solo pide sesión, sin tenant ni permiso (`RequireAuth`). */
  soloSesion: boolean;
  /** JSON Schema de los argumentos, sacado de los decoradores del método. */
  argumentos: Record<string, unknown>;
}

export const OPERACIONES_DE_LA_API: Record<string, OperacionDeLaApi> = {
  "AgendaController_agendar": {
    "metodo": "POST",
    "ruta": "/v1/agenda",
    "resumen": "Agenda una cita",
    "permiso": "calendar.book",
    "modulo": "calendar",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "contactId": {
          "type": "string",
          "minLength": 1
        },
        "inicio": {
          "type": "string",
          "minLength": 1
        },
        "fin": {
          "type": "string",
          "minLength": 1
        },
        "ownerId": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "conversationId": {
          "type": "string"
        },
        "confirmada": {
          "type": "boolean"
        }
      },
      "required": [
        "contactId",
        "inicio",
        "fin"
      ],
      "additionalProperties": false
    }
  },
  "AgendaController_borrarDisponibilidad": {
    "metodo": "DELETE",
    "ruta": "/v1/agenda/disponibilidad/{id}",
    "resumen": "Quita una franja horaria",
    "permiso": "calendar.manage_availability",
    "modulo": "calendar",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "ownerId": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "AgendaController_disponibilidad": {
    "metodo": "POST",
    "ruta": "/v1/agenda/disponibilidad",
    "resumen": "Define los horarios que atiende alguien del equipo",
    "permiso": "calendar.manage_availability",
    "modulo": "calendar",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "ownerId": {
          "type": "string"
        },
        "weekday": {
          "type": "number"
        },
        "inicio": {
          "type": "string"
        },
        "fin": {
          "type": "string"
        },
        "duracion": {
          "type": "number"
        },
        "respiro": {
          "type": "number"
        },
        "anticipacionMin": {
          "type": "number"
        }
      },
      "additionalProperties": false
    }
  },
  "AgendaController_estado": {
    "metodo": "POST",
    "ruta": "/v1/agenda/{id}/estado",
    "resumen": "Confirma, marca asistida o no-show, o cancela",
    "permiso": "calendar.book",
    "modulo": "calendar",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "estado": {
          "type": "string"
        },
        "motivo": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "AgendaController_guardarRecordatorios": {
    "metodo": "PUT",
    "ruta": "/v1/agenda/recordatorios",
    "resumen": "Elige la plantilla de cada recordatorio (o la quita)",
    "permiso": "calendar.manage_availability",
    "modulo": "calendar",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "24h": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "2h": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "zona": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "AgendaController_huecos": {
    "metodo": "GET",
    "ruta": "/v1/agenda/huecos",
    "resumen": "Horarios libres de un día, en la hora del negocio",
    "permiso": "calendar.read",
    "modulo": "calendar",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "dia": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "ownerId": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "AgendaController_listar": {
    "metodo": "GET",
    "ruta": "/v1/agenda",
    "resumen": "Citas entre dos fechas",
    "permiso": "calendar.read",
    "modulo": "calendar",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "desde": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "hasta": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "ownerId": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "AgendaController_recordatorios": {
    "metodo": "GET",
    "ruta": "/v1/agenda/recordatorios",
    "resumen": "Qué plantilla sale como recordatorio de cita",
    "permiso": "calendar.manage_availability",
    "modulo": "calendar",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "AgendaController_verDisponibilidad": {
    "metodo": "GET",
    "ruta": "/v1/agenda/disponibilidad",
    "resumen": "Los horarios de atención de alguien del equipo",
    "permiso": "calendar.read",
    "modulo": "calendar",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "ownerId": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "AgenteGeneralController_aplicar": {
    "metodo": "POST",
    "ruta": "/v1/agente-general/aplicar",
    "resumen": "Aplica la acción que el Agente General dejó propuesta",
    "permiso": "agents.use",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "herramienta": {
          "type": "string",
          "minLength": 1
        },
        "argumentos": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {}
        }
      },
      "required": [
        "herramienta"
      ],
      "additionalProperties": false
    }
  },
  "AgenteGeneralController_conversar": {
    "metodo": "POST",
    "ruta": "/v1/agente-general",
    "resumen": "Le habla al Agente General, que configura el negocio conversando",
    "permiso": "agents.use",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "turnos": {
          "type": "array",
          "items": {}
        },
        "pantalla": {}
      },
      "additionalProperties": false
    }
  },
  "AgentsController_configuradorAplicar": {
    "metodo": "POST",
    "ruta": "/v1/agents/configurador/{pid}/aplicar",
    "resumen": "Aplica el diff con los permisos del usuario (user via agent)",
    "permiso": "agents.configure",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "pid": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "pid"
      ],
      "additionalProperties": false
    }
  },
  "AgentsController_configuradorDescartar": {
    "metodo": "POST",
    "ruta": "/v1/agents/configurador/{pid}/descartar",
    "resumen": "Descarta la propuesta",
    "permiso": "agents.configure",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "pid": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "pid"
      ],
      "additionalProperties": false
    }
  },
  "AgentsController_configuradorPendiente": {
    "metodo": "GET",
    "ruta": "/v1/agents/configurador",
    "resumen": "La propuesta pendiente del configurador (si hay)",
    "permiso": "agents.configure",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "AgentsController_configuradorProponer": {
    "metodo": "POST",
    "ruta": "/v1/agents/configurador",
    "resumen": "Arma la propuesta del CRM a partir de la descripción del negocio",
    "permiso": "agents.configure",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "description": {
          "type": "string",
          "minLength": 1
        },
        "vertical": {
          "type": "string"
        }
      },
      "required": [
        "description"
      ],
      "additionalProperties": false
    }
  },
  "AgentsController_configuradorQuien": {
    "metodo": "GET",
    "ruta": "/v1/agents/configurador/quien",
    "resumen": "Qué asistente arma la propuesta de configuración",
    "permiso": "agents.configure",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "AgentsController_create": {
    "metodo": "POST",
    "ruta": "/v1/agents",
    "resumen": "Crea un asistente (proveedor y modelo configurables)",
    "permiso": "agents.configure",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "AgentsController_evals": {
    "metodo": "GET",
    "ruta": "/v1/agents/{id}/evals",
    "resumen": "Las corridas de evaluación del asistente",
    "permiso": "agents.usage.read",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "AgentsController_evaluate": {
    "metodo": "POST",
    "ruta": "/v1/agents/{id}/evaluate",
    "resumen": "Corre el dataset del tenant contra la config actual",
    "permiso": "agents.configure",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "AgentsController_executions": {
    "metodo": "GET",
    "ruta": "/v1/agents/executions",
    "resumen": "Corridas con tokens, costo, latencia y trace",
    "permiso": "agents.usage.read",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "AgentsController_list": {
    "metodo": "GET",
    "ruta": "/v1/agents",
    "resumen": "Asistentes del negocio",
    "permiso": "agents.use",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "AgentsController_objetivo": {
    "metodo": "GET",
    "ruta": "/v1/agents/{id}/objetivo",
    "resumen": "Si el asistente está logrando su objetivo, y cuánto de eso es mérito suyo",
    "permiso": "agents.usage.read",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "AgentsController_objetivos": {
    "metodo": "GET",
    "ruta": "/v1/agents/objetivos",
    "resumen": "Los objetivos que puede tener un asistente, y cuáles puede usar este negocio",
    "permiso": "agents.configure",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "AgentsController_preguntar": {
    "metodo": "POST",
    "ruta": "/v1/agents/{id}/preguntar",
    "resumen": "Le pregunta al asistente del dueño (ejecuta herramientas de lectura)",
    "permiso": "agents.use",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "pregunta": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "id",
        "pregunta"
      ],
      "additionalProperties": false
    }
  },
  "AgentsController_run": {
    "metodo": "POST",
    "ruta": "/v1/agents/{id}/run",
    "resumen": "Corre una tarea del asistente (mismo trace que el request)",
    "permiso": "agents.use",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "task": {
          "type": "string",
          "enum": [
            "clasificar",
            "sugerir",
            "responder",
            "configurar",
            "conocer",
            "resumir",
            "transcribir",
            "analizar",
            "configuracion_conversada"
          ]
        },
        "prompt": {
          "type": "string",
          "minLength": 1
        },
        "context": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "task",
        "prompt"
      ],
      "additionalProperties": false
    }
  },
  "AgentsController_update": {
    "metodo": "PUT",
    "ruta": "/v1/agents/{id}",
    "resumen": "Edita el asistente — cambiar de modelo no es deploy",
    "permiso": "agents.configure",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "AgentsController_usage": {
    "metodo": "GET",
    "ruta": "/v1/agents/usage",
    "resumen": "Consumo de IA: asistencias para el equipo, pesos para el dueño",
    "permiso": "agents.use",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "AnalyticsController_dashboard": {
    "metodo": "GET",
    "ruta": "/v1/analytics/dashboard",
    "resumen": "Las métricas del rango — cada número con su definición",
    "permiso": "analytics.read",
    "modulo": "analytics",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "from": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "to": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "ownerId": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "ApiKeysController_create": {
    "metodo": "POST",
    "ruta": "/v1/apikeys",
    "resumen": "Crea la key — el token se muestra UNA sola vez",
    "permiso": "apikeys.manage",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "scopes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "expiresAt": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "ApiKeysController_list": {
    "metodo": "GET",
    "ruta": "/v1/apikeys",
    "resumen": "Las API keys del tenant (sin el token, obvio)",
    "permiso": "apikeys.manage",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "ApiKeysController_revoke": {
    "metodo": "DELETE",
    "ruta": "/v1/apikeys/{id}",
    "resumen": "Revoca la key — inmediato, sin vuelta atrás",
    "permiso": "apikeys.manage",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "ApiKeysController_scopes": {
    "metodo": "GET",
    "ruta": "/v1/apikeys/scopes",
    "resumen": "El catálogo de permisos disponibles como scopes",
    "permiso": "apikeys.manage",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "ApiUsageController_usage": {
    "metodo": "GET",
    "ruta": "/v1/api-usage",
    "resumen": "El consumo de la API del tenant contra su cuota",
    "permiso": "apikeys.manage",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "AuditController_export": {
    "metodo": "GET",
    "ruta": "/v1/audit/export",
    "resumen": "Exporta el libro del tenant, firmado",
    "permiso": "audit.export",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "AuditController_search": {
    "metodo": "GET",
    "ruta": "/v1/audit",
    "resumen": "El libro del propio tenant, con filtros",
    "permiso": "audit.read",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "AuditController_verify": {
    "metodo": "POST",
    "ruta": "/v1/audit/verify",
    "resumen": "Verifica la cadena de hash del propio tenant",
    "permiso": "audit.read",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "AutomationsController_create": {
    "metodo": "POST",
    "ruta": "/v1/automations",
    "resumen": "Crea una regla (nace apagada: primero la vista previa)",
    "permiso": "automations.manage",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "trigger": {},
        "conditions": {
          "type": "array",
          "items": {}
        },
        "actions": {
          "type": "array",
          "items": {}
        }
      },
      "additionalProperties": false
    }
  },
  "AutomationsController_createSeq": {
    "metodo": "POST",
    "ruta": "/v1/automations/sequences",
    "resumen": "Crea una secuencia (pasos con esperas y condición)",
    "permiso": "automations.manage",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "steps": {
          "type": "array",
          "items": {}
        }
      },
      "additionalProperties": false
    }
  },
  "AutomationsController_enrollConv": {
    "metodo": "POST",
    "ruta": "/v1/automations/sequences/{sid}/enroll",
    "resumen": "Mete la conversación a la secuencia",
    "permiso": "automations.enroll",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "sid": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "conversationId": {
          "type": "string",
          "minLength": 1
        },
        "dealId": {
          "type": "string"
        }
      },
      "required": [
        "sid",
        "conversationId"
      ],
      "additionalProperties": false
    }
  },
  "AutomationsController_enrollments": {
    "metodo": "GET",
    "ruta": "/v1/automations/sequences/enrollments",
    "resumen": "El estado de las secuencias de un contacto (ficha)",
    "permiso": "automations.enroll",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "contactId": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "AutomationsController_list": {
    "metodo": "GET",
    "ruta": "/v1/automations",
    "resumen": "Las reglas del tenant",
    "permiso": "automations.read",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "AutomationsController_preview": {
    "metodo": "GET",
    "ruta": "/v1/automations/{id}/preview",
    "resumen": "\"A quién le aplicaría hoy\" — antes de activar",
    "permiso": "automations.manage",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "AutomationsController_remove": {
    "metodo": "DELETE",
    "ruta": "/v1/automations/{id}",
    "resumen": "Elimina la regla y su historial",
    "permiso": "automations.manage",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "AutomationsController_runs": {
    "metodo": "GET",
    "ruta": "/v1/automations/runs",
    "resumen": "Las últimas corridas del motor",
    "permiso": "automations.read",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "ruleId": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "AutomationsController_seed": {
    "metodo": "POST",
    "ruta": "/v1/automations/seed",
    "resumen": "Las tres reglas iniciales del rubro, listas para activar",
    "permiso": "automations.manage",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "vertical": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "AutomationsController_sequences": {
    "metodo": "GET",
    "ruta": "/v1/automations/sequences",
    "resumen": "Las secuencias disponibles (para iniciar seguimiento)",
    "permiso": "automations.enroll",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "AutomationsController_setActive": {
    "metodo": "POST",
    "ruta": "/v1/automations/{id}/active",
    "resumen": "Enciende o apaga la regla",
    "permiso": "automations.manage",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "active": {
          "type": "boolean"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "AutomationsController_stopSeq": {
    "metodo": "POST",
    "ruta": "/v1/automations/sequences/enrollments/{eid}/stop",
    "resumen": "Detiene la secuencia para esa conversación",
    "permiso": "automations.enroll",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "eid": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "eid"
      ],
      "additionalProperties": false
    }
  },
  "BillingController_billing": {
    "metodo": "GET",
    "ruta": "/v1/billing",
    "resumen": "La suscripción y las facturas del tenant",
    "permiso": "billing.read",
    "modulo": "billing",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "BillingController_cancelar": {
    "metodo": "POST",
    "ruta": "/v1/billing/cancelar",
    "resumen": "Cancela la suscripción y entrega la exportación completa",
    "permiso": "billing.manage",
    "modulo": "billing",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "motivo": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "CampanasController_crear": {
    "metodo": "POST",
    "ruta": "/v1/campanas",
    "resumen": "Crea una campaña en borrador",
    "permiso": "automations.manage",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "templateId": {
          "type": "string",
          "minLength": 1
        },
        "name": {
          "type": "string"
        },
        "filtros": {},
        "valores": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "templateId"
      ],
      "additionalProperties": false
    }
  },
  "CampanasController_enviar": {
    "metodo": "POST",
    "ruta": "/v1/campanas/{id}/enviar",
    "resumen": "Manda la campaña: cada destinatario queda con su resultado",
    "permiso": "automations.manage",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "CampanasController_guardar": {
    "metodo": "POST",
    "ruta": "/v1/campanas/segmentos",
    "resumen": "Guarda un segmento con nombre",
    "permiso": "automations.manage",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "filtros": {}
      },
      "additionalProperties": false
    }
  },
  "CampanasController_listar": {
    "metodo": "GET",
    "ruta": "/v1/campanas",
    "resumen": "Las campañas del negocio, la más reciente primero",
    "permiso": "automations.manage",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "limite": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "CampanasController_previa": {
    "metodo": "GET",
    "ruta": "/v1/campanas/{id}/vista-previa",
    "resumen": "A quién le llegaría esta campaña",
    "permiso": "automations.manage",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "CampanasController_resultados": {
    "metodo": "GET",
    "ruta": "/v1/campanas/{id}/resultados",
    "resumen": "Cómo le fue: enviados, saltados con motivo, entrega y costo",
    "permiso": "automations.manage",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "CampanasController_segmentos": {
    "metodo": "GET",
    "ruta": "/v1/campanas/segmentos",
    "resumen": "Segmentos guardados",
    "permiso": "automations.manage",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "CampanasController_vistaPrevia": {
    "metodo": "POST",
    "ruta": "/v1/campanas/segmentos/vista-previa",
    "resumen": "Cuántos son y quiénes se ven, antes de mandar nada",
    "permiso": "automations.manage",
    "modulo": "automations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "filtros": {}
      },
      "additionalProperties": false
    }
  },
  "CamposController_create": {
    "metodo": "POST",
    "ruta": "/v1/campos",
    "resumen": "Declara un campo personalizado",
    "permiso": "crm.fields.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "entity": {
          "type": "string"
        },
        "label": {
          "type": "string"
        },
        "type": {
          "type": "string"
        },
        "required": {
          "type": "boolean"
        },
        "visibleIa": {
          "type": "boolean"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "additionalProperties": false
    }
  },
  "CamposController_list": {
    "metodo": "GET",
    "ruta": "/v1/campos",
    "resumen": "Campos personalizados declarados",
    "permiso": "crm.contacts.read",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "entidad": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "CamposController_remove": {
    "metodo": "DELETE",
    "ruta": "/v1/campos/{id}",
    "resumen": "Quita la definición de un campo (no borra lo guardado)",
    "permiso": "crm.fields.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "ChannelsController_diagnostico": {
    "metodo": "GET",
    "ruta": "/v1/channels/{id}/diagnostico",
    "resumen": "Por qué este canal no está recibiendo, paso a paso",
    "permiso": "channels.read",
    "modulo": "channels",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "ChannelsController_list": {
    "metodo": "GET",
    "ruta": "/v1/channels",
    "resumen": "Cuentas de canal con sus números y calidad",
    "permiso": "channels.read",
    "modulo": "channels",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "ChannelsController_resume": {
    "metodo": "POST",
    "ruta": "/v1/whatsapp/numbers/{id}/resume",
    "resumen": "Reactiva los envíos del negocio tras una pausa por calidad",
    "permiso": "channels.manage",
    "modulo": "channels",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "ContactoEmpresaController_asignar": {
    "metodo": "PUT",
    "ruta": "/v1/contacts/{id}/empresa",
    "resumen": "Asigna (o quita) la empresa de un contacto",
    "permiso": "crm.contacts.update",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "companyId": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "id",
        "companyId"
      ],
      "additionalProperties": false
    }
  },
  "ContactsController_actividades": {
    "metodo": "GET",
    "ruta": "/v1/contacts/activities",
    "resumen": "Actividades pendientes del negocio, lo vencido primero",
    "permiso": "crm.contacts.read",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "todas": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "incluirHechas": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "ContactsController_actualizar": {
    "metodo": "PATCH",
    "ruta": "/v1/contacts/{id}",
    "resumen": "Corrige el contacto y sus campos propios",
    "permiso": "crm.contacts.update",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "name": {
          "type": [
            "string",
            "null"
          ]
        },
        "email": {
          "type": [
            "string",
            "null"
          ]
        },
        "rut": {
          "type": [
            "string",
            "null"
          ]
        },
        "ownerId": {
          "type": "string"
        },
        "custom": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {}
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "ContactsController_crear": {
    "metodo": "POST",
    "ruta": "/v1/contacts/{id}/activities",
    "resumen": "Crea una actividad (llamada, reunión, tarea, nota)",
    "permiso": "crm.activities.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "type": {
          "type": "string",
          "enum": [
            "llamada",
            "reunion",
            "tarea",
            "nota"
          ]
        },
        "title": {
          "type": "string",
          "minLength": 1
        },
        "body": {
          "type": "string"
        },
        "dueAt": {
          "type": "string"
        },
        "dealId": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "type",
        "title"
      ],
      "additionalProperties": false
    }
  },
  "ContactsController_exportar": {
    "metodo": "GET",
    "ruta": "/v1/contacts/exportar",
    "resumen": "Exporta los contactos a CSV",
    "permiso": "crm.contacts.export",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "ContactsController_exportarTitular": {
    "metodo": "GET",
    "ruta": "/v1/contacts/{id}/titular",
    "resumen": "Todo lo que tenemos de esta persona, para entregárselo",
    "permiso": "crm.titular.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "ContactsController_ficha": {
    "metodo": "GET",
    "ruta": "/v1/contacts/{id}",
    "resumen": "Ficha: contacto, oportunidades y actividades",
    "permiso": "crm.contacts.read",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "ContactsController_importConfirm": {
    "metodo": "POST",
    "ruta": "/v1/contacts/import/confirm",
    "resumen": "Confirma la importación: crea las filas válidas",
    "permiso": "crm.contacts.create",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "csv": {
          "type": "string",
          "minLength": 1
        },
        "mapping": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {
            "type": "string"
          }
        }
      },
      "required": [
        "csv"
      ],
      "additionalProperties": false
    }
  },
  "ContactsController_importPreview": {
    "metodo": "POST",
    "ruta": "/v1/contacts/import/preview",
    "resumen": "Vista previa del CSV: mapeo y validación fila a fila",
    "permiso": "crm.contacts.create",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "csv": {
          "type": "string",
          "minLength": 1
        },
        "mapping": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {
            "type": "string"
          }
        }
      },
      "required": [
        "csv"
      ],
      "additionalProperties": false
    }
  },
  "ContactsController_list": {
    "metodo": "GET",
    "ruta": "/v1/contacts",
    "resumen": "Contactos con búsqueda y cursor",
    "permiso": "crm.contacts.read",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "sort": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "order": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "cursor": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "limit": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "ContactsController_listo": {
    "metodo": "POST",
    "ruta": "/v1/contacts/activities/{activityId}/done",
    "resumen": "Marca la actividad como hecha",
    "permiso": "crm.activities.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "activityId": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "activityId"
      ],
      "additionalProperties": false
    }
  },
  "ContactsController_merge": {
    "metodo": "POST",
    "ruta": "/v1/contacts/{id}/merge",
    "resumen": "Fusiona un duplicado en este contacto",
    "permiso": "crm.contacts.merge",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "duplicateId": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "id",
        "duplicateId"
      ],
      "additionalProperties": false
    }
  },
  "ContactsController_suprimirTitular": {
    "metodo": "POST",
    "ruta": "/v1/contacts/{id}/titular/suprimir",
    "resumen": "Suprime los datos personales por solicitud del titular",
    "permiso": "crm.titular.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "motivo": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "ConversationsController_agentMode": {
    "metodo": "POST",
    "ruta": "/v1/conversations/{id}/agent-mode",
    "resumen": "Piloto automático por conversación — jamás por defecto",
    "permiso": "agents.use",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "mode": {
          "type": "string",
          "enum": [
            "assist",
            "autonomous",
            "off"
          ]
        }
      },
      "required": [
        "id",
        "mode"
      ],
      "additionalProperties": false
    }
  },
  "ConversationsController_analisis": {
    "metodo": "GET",
    "ruta": "/v1/conversations/{id}/analisis",
    "resumen": "Resumen, intención y calificación para la ficha",
    "permiso": "conversations.read",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "ConversationsController_assign": {
    "metodo": "POST",
    "ruta": "/v1/conversations/{id}/assign",
    "resumen": "Asigna o reasigna la conversación, con motivo",
    "permiso": "conversations.assign",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "toOwnerId": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "toOwnerId"
      ],
      "additionalProperties": false
    }
  },
  "ConversationsController_detail": {
    "metodo": "GET",
    "ruta": "/v1/conversations/{id}",
    "resumen": "Conversación con la ficha mínima del contacto",
    "permiso": "conversations.read",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "ConversationsController_dismissSuggestion": {
    "metodo": "POST",
    "ruta": "/v1/conversations/{id}/suggestions/{sid}/dismiss",
    "resumen": "Descarta la sugerencia",
    "permiso": "agents.use",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "sid": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id",
        "sid"
      ],
      "additionalProperties": false
    }
  },
  "ConversationsController_list": {
    "metodo": "GET",
    "ruta": "/v1/conversations",
    "resumen": "Bandeja: lista con filtros, vistas y cursor",
    "permiso": "conversations.read",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "state": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "channel": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "contactId": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "view": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "cursor": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "limit": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "ConversationsController_messages": {
    "metodo": "GET",
    "ruta": "/v1/conversations/{id}/messages",
    "resumen": "Mensajes de la conversación, más nuevos primero",
    "permiso": "conversations.read",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "limit": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "ConversationsController_reply": {
    "metodo": "POST",
    "ruta": "/v1/conversations/{id}/messages",
    "resumen": "Responde en la conversación (la toma si estaba en cola)",
    "permiso": "conversations.reply",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "body": {
          "type": "string"
        },
        "type": {
          "type": "string"
        },
        "adjuntos": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "key": {
                "type": "string"
              },
              "filename": {
                "type": "string"
              },
              "contentType": {
                "type": "string"
              }
            }
          }
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "ConversationsController_retryDelivery": {
    "metodo": "POST",
    "ruta": "/v1/conversations/{id}/messages/{mid}/retry-delivery",
    "resumen": "Recupera el despacho agotado de un mensaje pendiente; no crea otro mensaje",
    "permiso": "conversations.reply",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "mid": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id",
        "mid"
      ],
      "additionalProperties": false
    }
  },
  "ConversationsController_sendSuggestion": {
    "metodo": "POST",
    "ruta": "/v1/conversations/{id}/suggestions/{sid}/send",
    "resumen": "Envía la sugerencia tal cual — un toque",
    "permiso": "conversations.reply",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "sid": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id",
        "sid"
      ],
      "additionalProperties": false
    }
  },
  "ConversationsController_state": {
    "metodo": "POST",
    "ruta": "/v1/conversations/{id}/state",
    "resumen": "Cambia el estado (resolver, posponer, reabrir)",
    "permiso": "conversations.resolve",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "state": {
          "type": "string",
          "minLength": 1
        },
        "snoozedUntil": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "state"
      ],
      "additionalProperties": false
    }
  },
  "ConversationsController_suggestion": {
    "metodo": "GET",
    "ruta": "/v1/conversations/{id}/suggestion",
    "resumen": "La sugerencia vigente del copiloto, o por qué no hay",
    "permiso": "agents.use",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "ConversationsController_suggestionFeedback": {
    "metodo": "POST",
    "ruta": "/v1/conversations/{id}/suggestions/{sid}/feedback",
    "resumen": "Pulgar arriba/abajo con motivo — alimenta la evaluación",
    "permiso": "agents.use",
    "modulo": "agents",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "sid": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "feedback": {
          "type": "string",
          "enum": [
            "up",
            "down"
          ]
        },
        "reason": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "sid",
        "feedback"
      ],
      "additionalProperties": false
    }
  },
  "DealsController_agregarEtapa": {
    "metodo": "POST",
    "ruta": "/v1/pipelines/{id}/etapas",
    "resumen": "Agrega una etapa antes del cierre",
    "permiso": "crm.pipelines.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "name": {
          "type": "string"
        },
        "expectedDays": {
          "type": "number"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "DealsController_borrarEtapa": {
    "metodo": "DELETE",
    "ruta": "/v1/etapas/{id}",
    "resumen": "Borra una etapa vacía",
    "permiso": "crm.pipelines.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "DealsController_create": {
    "metodo": "POST",
    "ruta": "/v1/deals",
    "resumen": "Crea una oportunidad (el copiloto la sugiere, el humano decide)",
    "permiso": "crm.deals.create",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "contactId": {
          "type": "string",
          "minLength": 1
        },
        "title": {
          "type": "string",
          "minLength": 1
        },
        "pipelineId": {
          "type": "string"
        },
        "value": {
          "type": "number"
        }
      },
      "required": [
        "contactId",
        "title"
      ],
      "additionalProperties": false
    }
  },
  "DealsController_editarEtapa": {
    "metodo": "PUT",
    "ruta": "/v1/etapas/{id}",
    "resumen": "Renombra la etapa o ajusta su probabilidad y días",
    "permiso": "crm.pipelines.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "name": {
          "type": "string"
        },
        "probability": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ]
        },
        "expectedDays": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "DealsController_filters": {
    "metodo": "GET",
    "ruta": "/v1/saved-filters",
    "resumen": "Filtros guardados del usuario",
    "permiso": "crm.deals.read",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "view": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "DealsController_list": {
    "metodo": "GET",
    "ruta": "/v1/deals",
    "resumen": "Oportunidades con filtros y cursor",
    "permiso": "crm.deals.read",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "pipelineId": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "stageId": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "status": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "owner": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "tag": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "valueClpMin": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "valueClpMax": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "customKey": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "customValue": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "sort": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "order": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "cursor": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "limit": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "DealsController_lossReasons": {
    "metodo": "GET",
    "ruta": "/v1/loss-reasons",
    "resumen": "Motivos de pérdida configurados",
    "permiso": "crm.deals.read",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "DealsController_move": {
    "metodo": "POST",
    "ruta": "/v1/deals/{id}/stage",
    "resumen": "Mueve la oportunidad de etapa (motivo al retroceder)",
    "permiso": "crm.deals.update",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "stageId": {
          "type": "string",
          "minLength": 1
        },
        "reason": {
          "type": "string"
        },
        "lostReasonId": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "stageId"
      ],
      "additionalProperties": false
    }
  },
  "DealsController_pipelines": {
    "metodo": "GET",
    "ruta": "/v1/pipelines",
    "resumen": "Pipelines del negocio con sus etapas",
    "permiso": "crm.deals.read",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "DealsController_remove": {
    "metodo": "DELETE",
    "ruta": "/v1/saved-filters/{id}",
    "resumen": "Borra un filtro guardado propio",
    "permiso": "crm.deals.read",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "DealsController_renombrarPipeline": {
    "metodo": "PUT",
    "ruta": "/v1/pipelines/{id}",
    "resumen": "Renombra el pipeline",
    "permiso": "crm.pipelines.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "name": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "DealsController_reordenar": {
    "metodo": "PUT",
    "ruta": "/v1/pipelines/{id}/orden",
    "resumen": "Reordena las etapas abiertas",
    "permiso": "crm.pipelines.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "stageIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "DealsController_save": {
    "metodo": "POST",
    "ruta": "/v1/saved-filters",
    "resumen": "Guarda (o actualiza) un filtro con nombre",
    "permiso": "crm.deals.read",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1
        },
        "view": {
          "type": "string"
        },
        "filters": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {}
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false
    }
  },
  "DemoController_noExiste": {
    "metodo": "GET",
    "ruta": "/v1/demo/no-existe/{id}",
    "resumen": "Demostración del formato de error",
    "permiso": null,
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "DemoController_protegido": {
    "metodo": "GET",
    "ruta": "/v1/demo/protegido",
    "resumen": "Demostración de @RequireModule + @RequirePermission",
    "permiso": "audit.read",
    "modulo": "audit",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "EmpresasController_archive": {
    "metodo": "DELETE",
    "ruta": "/v1/empresas/{id}",
    "resumen": "Archiva una empresa (no se borra)",
    "permiso": "crm.companies.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "EmpresasController_create": {
    "metodo": "POST",
    "ruta": "/v1/empresas",
    "resumen": "Crea una empresa",
    "permiso": "crm.companies.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "rut": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "custom": {
          "type": "object",
          "additionalProperties": true
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false
    }
  },
  "EmpresasController_get": {
    "metodo": "GET",
    "ruta": "/v1/empresas/{id}",
    "resumen": "La ficha de una empresa con sus contactos",
    "permiso": "crm.companies.read",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "EmpresasController_list": {
    "metodo": "GET",
    "ruta": "/v1/empresas",
    "resumen": "Lista las empresas del negocio",
    "permiso": "crm.companies.read",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "buscar": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "archivadas": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "EmpresasController_update": {
    "metodo": "PUT",
    "ruta": "/v1/empresas/{id}",
    "resumen": "Edita una empresa",
    "permiso": "crm.companies.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "name": {
          "type": "string"
        },
        "rut": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "custom": {
          "type": "object",
          "additionalProperties": true
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "EquipoController_addNote": {
    "metodo": "POST",
    "ruta": "/v1/conversations/{id}/notes",
    "resumen": "Agrega una nota interna con menciones",
    "permiso": "conversations.notes",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "body": {
          "type": "string",
          "minLength": 1
        },
        "mentions": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "id",
        "body"
      ],
      "additionalProperties": false
    }
  },
  "EquipoController_notes": {
    "metodo": "GET",
    "ruta": "/v1/conversations/{id}/notes",
    "resumen": "Notas internas de la conversación (solo equipo)",
    "permiso": "conversations.notes",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "EquipoController_presignDownload": {
    "metodo": "GET",
    "ruta": "/v1/attachments/url",
    "resumen": "URL prefirmada para bajar un adjunto del tenant",
    "permiso": "conversations.read",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "EquipoController_presignUpload": {
    "metodo": "POST",
    "ruta": "/v1/conversations/{id}/attachments",
    "resumen": "URL prefirmada para subir un adjunto a R2 (por tenant)",
    "permiso": "conversations.reply",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "filename": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "id",
        "filename"
      ],
      "additionalProperties": false
    }
  },
  "EquipoController_search": {
    "metodo": "GET",
    "ruta": "/v1/search",
    "resumen": "Búsqueda de texto completo en mensajes y notas",
    "permiso": "conversations.read",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "limit": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "EquipoUsuariosController_cancelar": {
    "metodo": "DELETE",
    "ruta": "/v1/equipo/invitaciones/{id}",
    "resumen": "Cancela una invitación pendiente",
    "permiso": "users.invite",
    "modulo": "identity",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "EquipoUsuariosController_equipo": {
    "metodo": "GET",
    "ruta": "/v1/equipo",
    "resumen": "Quién tiene acceso al negocio y con qué rol",
    "permiso": "users.read",
    "modulo": "identity",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "EquipoUsuariosController_invitar": {
    "metodo": "POST",
    "ruta": "/v1/equipo/invitaciones",
    "resumen": "Invita a alguien con un rol",
    "permiso": "users.invite",
    "modulo": "identity",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "email": {
          "type": "string",
          "pattern": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
        },
        "rol": {
          "type": "string"
        }
      },
      "required": [
        "email"
      ],
      "additionalProperties": false
    }
  },
  "EquipoUsuariosController_quitar": {
    "metodo": "DELETE",
    "ruta": "/v1/equipo/miembros/{userId}",
    "resumen": "Quita el acceso de una persona (su historial queda)",
    "permiso": "users.manage",
    "modulo": "identity",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "userId": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "userId"
      ],
      "additionalProperties": false
    }
  },
  "HealthController_health": {
    "metodo": "GET",
    "ruta": "/health",
    "resumen": "",
    "permiso": null,
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "HealthController_modules": {
    "metodo": "GET",
    "ruta": "/health/modules",
    "resumen": "",
    "permiso": null,
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "HealthController_ready": {
    "metodo": "GET",
    "ruta": "/ready",
    "resumen": "",
    "permiso": null,
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "InvitacionesController_aceptar": {
    "metodo": "POST",
    "ruta": "/v1/invitaciones/{token}/aceptar",
    "resumen": "Canjea una invitación y entra al negocio",
    "permiso": null,
    "modulo": null,
    "soloSesion": true,
    "argumentos": {
      "type": "object",
      "properties": {
        "token": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "token"
      ],
      "additionalProperties": false
    }
  },
  "KnowledgeController_add": {
    "metodo": "POST",
    "ruta": "/v1/knowledge/sources",
    "resumen": "Agrega una fuente (texto, FAQ, catálogo CSV o URL) y la indexa",
    "permiso": "knowledge.manage",
    "modulo": "knowledge",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "texto",
            "url",
            "faq",
            "catalogo"
          ]
        },
        "name": {
          "type": "string"
        },
        "content": {
          "type": "string"
        },
        "url": {
          "type": "string"
        },
        "validUntil": {
          "type": "string"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    }
  },
  "KnowledgeController_crearDesdePdf": {
    "metodo": "POST",
    "ruta": "/v1/knowledge/sources/pdf",
    "resumen": "Registra e indexa un PDF ya subido",
    "permiso": "knowledge.manage",
    "modulo": "knowledge",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "minLength": 1
        },
        "name": {
          "type": "string"
        },
        "validUntil": {
          "type": "string"
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    }
  },
  "KnowledgeController_destinoDelPdf": {
    "metodo": "POST",
    "ruta": "/v1/knowledge/sources/pdf/destino",
    "resumen": "URL prefirmada para subir un PDF del conocimiento",
    "permiso": "knowledge.manage",
    "modulo": "knowledge",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "minLength": 1
        },
        "sizeBytes": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  "KnowledgeController_products": {
    "metodo": "GET",
    "ruta": "/v1/knowledge/products",
    "resumen": "La tool get_product: precio y stock como campos",
    "permiso": "knowledge.read",
    "modulo": "knowledge",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "KnowledgeController_reindex": {
    "metodo": "POST",
    "ruta": "/v1/knowledge/sources/{id}/reindex",
    "resumen": "Re-indexa la fuente (tras cambiarla)",
    "permiso": "knowledge.manage",
    "modulo": "knowledge",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "KnowledgeController_remove": {
    "metodo": "DELETE",
    "ruta": "/v1/knowledge/sources/{id}",
    "resumen": "Elimina la fuente y todo su índice",
    "permiso": "knowledge.manage",
    "modulo": "knowledge",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "KnowledgeController_search": {
    "metodo": "GET",
    "ruta": "/v1/knowledge/search",
    "resumen": "Prueba qué encontraría la IA (con su cita)",
    "permiso": "knowledge.manage",
    "modulo": "knowledge",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "KnowledgeController_sources": {
    "metodo": "GET",
    "ruta": "/v1/knowledge/sources",
    "resumen": "Las fuentes de conocimiento del negocio",
    "permiso": "knowledge.manage",
    "modulo": "knowledge",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "McpController_rpc": {
    "metodo": "POST",
    "ruta": "/v1/mcp",
    "resumen": "Servidor MCP: las funciones del producto para una IA de afuera",
    "permiso": "agents.use",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "MeController_accesoDeModulos": {
    "metodo": "GET",
    "ruta": "/v1/me/modules/acceso",
    "resumen": "Acceso del tenant a cada módulo según su plan",
    "permiso": "tenant.read",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "MeController_exportacion": {
    "metodo": "GET",
    "ruta": "/v1/me/exportacion",
    "resumen": "Exportación completa de los datos del negocio",
    "permiso": "tenant.settings",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "MeController_me": {
    "metodo": "GET",
    "ruta": "/v1/me",
    "resumen": "Usuario de la sesión y sus negocios",
    "permiso": null,
    "modulo": null,
    "soloSesion": true,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "MeController_modules": {
    "metodo": "GET",
    "ruta": "/v1/me/modules",
    "resumen": "Módulos activos con su navegación y widgets",
    "permiso": null,
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "NotificationsController_clavePush": {
    "metodo": "GET",
    "ruta": "/v1/notifications/push/clave",
    "resumen": "La llave pública VAPID para suscribirse",
    "permiso": "notifications.manage_own",
    "modulo": "notifications",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "NotificationsController_desuscribirPush": {
    "metodo": "DELETE",
    "ruta": "/v1/notifications/push",
    "resumen": "Este navegador deja de recibir push",
    "permiso": "notifications.manage_own",
    "modulo": "notifications",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "endpoint": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "endpoint"
      ],
      "additionalProperties": false
    }
  },
  "NotificationsController_list": {
    "metodo": "GET",
    "ruta": "/v1/notifications",
    "resumen": "Mis avisos, con el contador de no leídos",
    "permiso": "notifications.manage_own",
    "modulo": "notifications",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "NotificationsController_prefs": {
    "metodo": "GET",
    "ruta": "/v1/notifications/preferences",
    "resumen": "Mis preferencias por tipo y canal",
    "permiso": "notifications.manage_own",
    "modulo": "notifications",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "NotificationsController_read": {
    "metodo": "POST",
    "ruta": "/v1/notifications/read",
    "resumen": "Marca leídos (ids concretos, o todos)",
    "permiso": "notifications.manage_own",
    "modulo": "notifications",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "ids": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "additionalProperties": false
    }
  },
  "NotificationsController_setPref": {
    "metodo": "PUT",
    "ruta": "/v1/notifications/preferences",
    "resumen": "Guarda una preferencia (las críticas no se apagan)",
    "permiso": "notifications.manage_own",
    "modulo": "notifications",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "conversacion_sin_dueno",
            "sla_vencido",
            "mencion",
            "tarea_vencida",
            "cuota_ia",
            "calidad_numero",
            "pago_recibido",
            "estado_cuenta"
          ]
        },
        "campana": {
          "type": "boolean"
        },
        "correo": {
          "type": "boolean"
        },
        "push": {
          "type": "boolean"
        },
        "whatsapp": {
          "type": "boolean"
        }
      },
      "required": [
        "type"
      ],
      "additionalProperties": false
    }
  },
  "NotificationsController_suscribirPush": {
    "metodo": "POST",
    "ruta": "/v1/notifications/push",
    "resumen": "Registra este navegador para recibir push",
    "permiso": "notifications.manage_own",
    "modulo": "notifications",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "endpoint": {
          "type": "string",
          "minLength": 1
        },
        "keys": {
          "type": "object",
          "properties": {
            "p256dh": {
              "type": "string",
              "minLength": 1
            },
            "auth": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "p256dh",
            "auth"
          ]
        }
      },
      "required": [
        "endpoint",
        "keys"
      ],
      "additionalProperties": false
    }
  },
  "OnboardingController_estado": {
    "metodo": "GET",
    "ruta": "/v1/onboarding",
    "resumen": "En qué paso va la puesta en marcha y qué falta",
    "permiso": "tenant.settings",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "PaymentsController_addProvider": {
    "metodo": "POST",
    "ruta": "/v1/payments/providers",
    "resumen": "Conecta un proveedor (credenciales POR REFERENCIA)",
    "permiso": "payments.manage_providers",
    "modulo": "payments",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "flow",
            "webpay",
            "mercadopago",
            "simulado"
          ]
        },
        "name": {
          "type": "string"
        },
        "credentialRef": {
          "type": "string"
        },
        "webhookSecretRef": {
          "type": "string"
        },
        "mode": {
          "type": "string"
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    }
  },
  "PaymentsController_cancel": {
    "metodo": "POST",
    "ruta": "/v1/payments/links/{id}/cancel",
    "resumen": "Cancela un link no pagado",
    "permiso": "payments.create_link",
    "modulo": "payments",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "PaymentsController_createLink": {
    "metodo": "POST",
    "ruta": "/v1/payments/links",
    "resumen": "Crea el link (monto de la oportunidad o escrito) y lo manda al chat",
    "permiso": "payments.create_link",
    "modulo": "payments",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "conversationId": {
          "type": "string"
        },
        "dealId": {
          "type": "string"
        },
        "amountClp": {
          "type": "number"
        },
        "concept": {
          "type": "string"
        },
        "providerId": {
          "type": "string"
        },
        "expiresHours": {
          "type": "number"
        }
      },
      "additionalProperties": false
    }
  },
  "PaymentsController_links": {
    "metodo": "GET",
    "ruta": "/v1/payments/links",
    "resumen": "Los links del tenant (filtrables por conversación u oportunidad)",
    "permiso": "payments.read",
    "modulo": "payments",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "conversationId": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "dealId": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "PaymentsController_providers": {
    "metodo": "GET",
    "ruta": "/v1/payments/providers",
    "resumen": "Los proveedores de pago del tenant",
    "permiso": "payments.manage_providers",
    "modulo": "payments",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "PaymentWebhooksController_recibir": {
    "metodo": "POST",
    "ruta": "/webhooks/payments/{providerId}",
    "resumen": "Webhook del proveedor de pagos: firma, cola y 200",
    "permiso": null,
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "providerId": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "providerId"
      ],
      "additionalProperties": false
    }
  },
  "PlantillasController_create": {
    "metodo": "POST",
    "ruta": "/v1/plantillas",
    "resumen": "Crea una plantilla en borrador",
    "permiso": "whatsapp.templates.manage",
    "modulo": "whatsapp",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "PlantillasController_enviar": {
    "metodo": "POST",
    "ruta": "/v1/plantillas/{id}/enviar",
    "resumen": "Envía la plantilla a una conversación (fuera de ventana incluido)",
    "permiso": "conversations.reply",
    "modulo": "whatsapp",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "conversationId": {
          "type": "string",
          "minLength": 1
        },
        "valores": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "id",
        "conversationId"
      ],
      "additionalProperties": false
    }
  },
  "PlantillasController_list": {
    "metodo": "GET",
    "ruta": "/v1/plantillas",
    "resumen": "Plantillas del negocio y su estado",
    "permiso": "conversations.reply",
    "modulo": "whatsapp",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "estado": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "PlantillasController_revision": {
    "metodo": "POST",
    "ruta": "/v1/plantillas/{id}/revision",
    "resumen": "Manda la plantilla a revisión de Meta",
    "permiso": "whatsapp.templates.manage",
    "modulo": "whatsapp",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "PlantillasController_update": {
    "metodo": "PUT",
    "ruta": "/v1/plantillas/{id}",
    "resumen": "Corrige una plantilla en borrador o rechazada",
    "permiso": "whatsapp.templates.manage",
    "modulo": "whatsapp",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "PlatformAuditController_export": {
    "metodo": "GET",
    "ruta": "/v1/platform/audit/export",
    "resumen": "Exporta el libro global (o el de un tenant), firmado",
    "permiso": "platform.audit",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "PlatformAuditController_search": {
    "metodo": "GET",
    "ruta": "/v1/platform/audit",
    "resumen": "El libro de TODOS los tenants, con filtros",
    "permiso": "platform.audit",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "PlatformAuditController_verify": {
    "metodo": "POST",
    "ruta": "/v1/platform/audit/verify",
    "resumen": "Verifica la cadena de hash de un tenant cualquiera",
    "permiso": "platform.audit",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "tenantId": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "required": [
        "tenantId"
      ],
      "additionalProperties": false
    }
  },
  "PlatformController_agenteGeneral": {
    "metodo": "GET",
    "ruta": "/v1/platform/agente-general",
    "resumen": "El Agente General: corridas, costo, errores y su interruptor",
    "permiso": "platform.ai",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "tenantId": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "limite": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "PlatformController_apagarAgente": {
    "metodo": "POST",
    "ruta": "/v1/platform/agente-general/apagar",
    "resumen": "Apaga la configuración por conversación (global o de un negocio)",
    "permiso": "platform.ai",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "tenantId": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "motivo": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "PlatformController_apiQuota": {
    "metodo": "PUT",
    "ruta": "/v1/platform/tenants/{id}/api-quota",
    "resumen": "Override de cuota mensual de API por tenant",
    "permiso": "platform.plans",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "requestsMonth": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "PlatformController_apiUsage": {
    "metodo": "GET",
    "ruta": "/v1/platform/api-usage",
    "resumen": "Consumo de API por tenant (mes en curso)",
    "permiso": "platform.plans",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "PlatformController_createTenant": {
    "metodo": "POST",
    "ruta": "/v1/platform/tenants",
    "resumen": "Crea un tenant (nace en prueba)",
    "permiso": "platform.tenants",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "plan": {
          "type": "string"
        },
        "rubro": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "PlatformController_encenderAgente": {
    "metodo": "POST",
    "ruta": "/v1/platform/agente-general/encender",
    "resumen": "Lo vuelve a encender (global o de un negocio)",
    "permiso": "platform.ai",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "tenantId": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": false
    }
  },
  "PlatformController_endSupport": {
    "metodo": "DELETE",
    "ruta": "/v1/platform/tenants/{id}/support",
    "resumen": "Termina el modo soporte",
    "permiso": "platform.tenants",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "PlatformController_extendTrial": {
    "metodo": "POST",
    "ruta": "/v1/platform/tenants/{id}/extend-trial",
    "resumen": "Extiende la prueba (1 a 90 días)",
    "permiso": "platform.tenants",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "days": {
          "type": "number"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "PlatformController_health": {
    "metodo": "GET",
    "ruta": "/v1/platform/health",
    "resumen": "Salud de todas las dependencias, con umbral y explicación",
    "permiso": "platform.health",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "PlatformController_ia": {
    "metodo": "GET",
    "ruta": "/v1/platform/ia",
    "resumen": "Métricas de IA por día, tenant, modelo, agente o tarea",
    "permiso": "platform.ai",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "groupBy": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "tenantId": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "dias": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "PlatformController_iaEjecuciones": {
    "metodo": "GET",
    "ruta": "/v1/platform/ia/ejecuciones",
    "resumen": "Últimas ejecuciones con su enlace al trace",
    "permiso": "platform.ai",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "tenantId": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "model": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "fallidas": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "PlatformController_iaPrompts": {
    "metodo": "GET",
    "ruta": "/v1/platform/ia/prompts",
    "resumen": "Prompts vivos por agente y su último score",
    "permiso": "platform.ai",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "tenantId": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "PlatformController_modules": {
    "metodo": "GET",
    "ruta": "/v1/platform/modules",
    "resumen": "Los módulos: estado vivo, dependencias y uso",
    "permiso": "platform.modules",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "PlatformController_plans": {
    "metodo": "GET",
    "ruta": "/v1/platform/plans",
    "resumen": "Los planes con límites, precios y módulos",
    "permiso": "platform.plans",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "PlatformController_porBorrar": {
    "metodo": "GET",
    "ruta": "/v1/platform/tenants/por-borrar",
    "resumen": "Tenants suspendidos en cola de borrado (§6)",
    "permiso": "platform.tenants",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "PlatformController_security": {
    "metodo": "GET",
    "ruta": "/v1/platform/security",
    "resumen": "Rechazos, webhooks caídos y números en riesgo",
    "permiso": "platform.security",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "dias": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "PlatformController_setModule": {
    "metodo": "POST",
    "ruta": "/v1/platform/modules/{id}",
    "resumen": "Enciende/apaga/kill-switch — el registry valida dependencias",
    "permiso": "platform.modules",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "action": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "PlatformController_setPlan": {
    "metodo": "POST",
    "ruta": "/v1/platform/tenants/{id}/plan",
    "resumen": "Cambia el plan — límites del plan aplican al tiro",
    "permiso": "platform.tenants",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "plan": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "PlatformController_setState": {
    "metodo": "POST",
    "ruta": "/v1/platform/tenants/{id}/state",
    "resumen": "Suspende o reactiva (máquina de estados §6)",
    "permiso": "platform.tenants",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "action": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "PlatformController_setTenantRetention": {
    "metodo": "PUT",
    "ruta": "/v1/platform/tenants/{id}/retention",
    "resumen": "Override de retención por tenant — validado ≤ plan",
    "permiso": "platform.plans",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "months": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "PlatformController_support": {
    "metodo": "POST",
    "ruta": "/v1/platform/tenants/{id}/support",
    "resumen": "Modo soporte: lectura acotada CON aviso al tenant",
    "permiso": "platform.tenants",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "hours": {
          "type": "number"
        },
        "reason": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "PlatformController_tenantDetail": {
    "metodo": "GET",
    "ruta": "/v1/platform/tenants/{id}",
    "resumen": "El detalle operativo: estado, plan, uso y canales",
    "permiso": "platform.tenants",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "PlatformController_tenantRetention": {
    "metodo": "GET",
    "ruta": "/v1/platform/tenants/{id}/retention",
    "resumen": "La retención del tenant CON el conteo de la próxima purga",
    "permiso": "platform.plans",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "PlatformController_tenants": {
    "metodo": "GET",
    "ruta": "/v1/platform/tenants",
    "resumen": "Tenants de la plataforma (solo lectura)",
    "permiso": "platform.tenants",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "PlatformController_updatePlan": {
    "metodo": "PUT",
    "ruta": "/v1/platform/plans/{plan}",
    "resumen": "Edita el plan — configuración, no código",
    "permiso": "platform.plans",
    "modulo": "platform",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "plan": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "plan"
      ],
      "additionalProperties": false
    }
  },
  "QuickRepliesController_create": {
    "metodo": "POST",
    "ruta": "/v1/quick-replies",
    "resumen": "Crea un atajo (del negocio exige quickreplies.manage)",
    "permiso": "conversations.reply",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "shortcut": {
          "type": "string",
          "minLength": 1
        },
        "body": {
          "type": "string",
          "minLength": 1
        },
        "scope": {
          "type": "string",
          "enum": [
            "negocio",
            "mio"
          ]
        }
      },
      "required": [
        "shortcut",
        "body"
      ],
      "additionalProperties": false
    }
  },
  "QuickRepliesController_list": {
    "metodo": "GET",
    "ruta": "/v1/quick-replies",
    "resumen": "Atajos del negocio y personales",
    "permiso": "conversations.reply",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "QuickRepliesController_remove": {
    "metodo": "DELETE",
    "ruta": "/v1/quick-replies/{id}",
    "resumen": "Borra un atajo (ajeno exige quickreplies.manage)",
    "permiso": "conversations.reply",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "RolesController_assign": {
    "metodo": "POST",
    "ruta": "/v1/roles/assign",
    "resumen": "Asigna el rol a una persona del equipo (uno por tenant)",
    "permiso": "roles.manage",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "userId": {
          "type": "string",
          "minLength": 1
        },
        "roleId": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "userId",
        "roleId"
      ],
      "additionalProperties": false
    }
  },
  "RolesController_catalogo": {
    "metodo": "GET",
    "ruta": "/v1/roles/catalogo",
    "resumen": "El catálogo de permisos con su módulo y estado",
    "permiso": "roles.read",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "RolesController_create": {
    "metodo": "POST",
    "ruta": "/v1/roles",
    "resumen": "Clona un rol base como personalizado",
    "permiso": "roles.manage",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "cloneFrom": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "RolesController_list": {
    "metodo": "GET",
    "ruta": "/v1/roles",
    "resumen": "Los roles del tenant: base (inmutables) y personalizados",
    "permiso": "roles.read",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "RolesController_update": {
    "metodo": "PUT",
    "ruta": "/v1/roles/{id}",
    "resumen": "Edita los permisos de un rol personalizado",
    "permiso": "roles.manage",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "permissions": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "SettingsController_get": {
    "metodo": "GET",
    "ruta": "/v1/settings/bandeja",
    "resumen": "Ajustes de asignación y SLA de la bandeja",
    "permiso": "tenant.settings",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "SettingsController_put": {
    "metodo": "PUT",
    "ruta": "/v1/settings/bandeja",
    "resumen": "Guarda los ajustes de la bandeja",
    "permiso": "tenant.settings",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "SettingsController_retencion": {
    "metodo": "GET",
    "ruta": "/v1/settings/retencion",
    "resumen": "La retención vigente: plan, override y corte",
    "permiso": "tenant.settings",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "SettingsController_setRetencion": {
    "metodo": "PUT",
    "ruta": "/v1/settings/retencion",
    "resumen": "Acorta la retención (jamás más que el plan) — avisa la purga",
    "permiso": "tenant.settings",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "months": {
          "anyOf": [
            {
              "type": "number"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": false
    }
  },
  "SimuladorController_inbound": {
    "metodo": "POST",
    "ruta": "/v1/dev/inbound",
    "resumen": "Simula un mensaje entrante (solo local y staging)",
    "permiso": "conversations.reply",
    "modulo": "conversations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "phone": {
          "type": "string",
          "minLength": 1
        },
        "body": {
          "type": "string"
        },
        "type": {
          "type": "string"
        },
        "channel": {
          "type": "string"
        },
        "providerMessageId": {
          "type": "string"
        }
      },
      "required": [
        "phone"
      ],
      "additionalProperties": false
    }
  },
  "SupportStatusController_status": {
    "metodo": "GET",
    "ruta": "/v1/support-status",
    "resumen": "¿El soporte de IAxTi está mirando esta cuenta?",
    "permiso": "tenant.read",
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "TagsController_agregarEnLote": {
    "metodo": "POST",
    "ruta": "/v1/tags/contactos/agregar",
    "resumen": "Agrega una etiqueta a hasta 100 contactos sin quitar sus etiquetas actuales",
    "permiso": "crm.contacts.create",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "contactIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "tagId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "TagsController_create": {
    "metodo": "POST",
    "ruta": "/v1/tags",
    "resumen": "Crea una etiqueta con su color de rol",
    "permiso": "crm.tags.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "role": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "TagsController_deContacto": {
    "metodo": "GET",
    "ruta": "/v1/tags/contacto/{contactId}",
    "resumen": "Etiquetas de un contacto",
    "permiso": "crm.contacts.read",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "contactId": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "contactId"
      ],
      "additionalProperties": false
    }
  },
  "TagsController_list": {
    "metodo": "GET",
    "ruta": "/v1/tags",
    "resumen": "Etiquetas del negocio",
    "permiso": "crm.contacts.read",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "TagsController_marcar": {
    "metodo": "PUT",
    "ruta": "/v1/tags/contacto/{contactId}",
    "resumen": "Deja al contacto con exactamente estas etiquetas",
    "permiso": "crm.contacts.create",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "contactId": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "tagIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "contactId"
      ],
      "additionalProperties": false
    }
  },
  "TagsController_remove": {
    "metodo": "DELETE",
    "ruta": "/v1/tags/{id}",
    "resumen": "Borra una etiqueta y la quita de todos los contactos",
    "permiso": "crm.tags.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "TagsController_update": {
    "metodo": "PUT",
    "ruta": "/v1/tags/{id}",
    "resumen": "Renombra una etiqueta o le cambia el color",
    "permiso": "crm.tags.manage",
    "modulo": "crm",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "name": {
          "type": "string"
        },
        "role": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "WebchatAdminController_create": {
    "metodo": "POST",
    "ruta": "/v1/webchat/widgets",
    "resumen": "Crea un widget para un dominio",
    "permiso": "webchat.manage",
    "modulo": "webchat",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "allowedDomain": {
          "type": "string",
          "minLength": 1
        },
        "name": {
          "type": "string"
        },
        "welcomeMessage": {
          "type": "string"
        }
      },
      "required": [
        "allowedDomain"
      ],
      "additionalProperties": false
    }
  },
  "WebchatAdminController_list": {
    "metodo": "GET",
    "ruta": "/v1/webchat/widgets",
    "resumen": "Widgets del webchat",
    "permiso": "webchat.manage",
    "modulo": "webchat",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "WebchatAdminController_toggle": {
    "metodo": "POST",
    "ruta": "/v1/webchat/widgets/{id}/toggle",
    "resumen": "Activa o desactiva el widget (el historial queda)",
    "permiso": "webchat.manage",
    "modulo": "webchat",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "active": {
          "type": "boolean"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "WebchatController_config": {
    "metodo": "GET",
    "ruta": "/webchat/{widgetId}/config",
    "resumen": "Configuración pública del widget",
    "permiso": null,
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "widgetId": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "page": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "required": [
        "widgetId"
      ],
      "additionalProperties": false
    }
  },
  "WebchatController_message": {
    "metodo": "POST",
    "ruta": "/webchat/{widgetId}/messages",
    "resumen": "Mensaje del visitante (identidad antes del segundo)",
    "permiso": null,
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "widgetId": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "widgetId"
      ],
      "additionalProperties": false
    }
  },
  "WebchatController_replies": {
    "metodo": "GET",
    "ruta": "/webchat/{widgetId}/messages",
    "resumen": "Respuestas del equipo (sondeo del widget)",
    "permiso": null,
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "widgetId": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "page": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "sessionId": {
          "type": "string",
          "x-iaxti-en": "query"
        },
        "after": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "required": [
        "widgetId"
      ],
      "additionalProperties": false
    }
  },
  "WebchatController_session": {
    "metodo": "POST",
    "ruta": "/webchat/{widgetId}/sessions",
    "resumen": "Abre una sesión de visitante",
    "permiso": null,
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "widgetId": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "page": {
          "type": "string"
        }
      },
      "required": [
        "widgetId"
      ],
      "additionalProperties": false
    }
  },
  "WebhooksController_recibir": {
    "metodo": "POST",
    "ruta": "/webhooks/channels/{accountId}",
    "resumen": "Webhook de canal: firma, cola y 200 al tiro",
    "permiso": null,
    "modulo": null,
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "accountId": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "accountId"
      ],
      "additionalProperties": false
    }
  },
  "WebhooksSalientesController_active": {
    "metodo": "POST",
    "ruta": "/v1/webhooks-salientes/{id}/active",
    "resumen": "Enciende o apaga el webhook (y limpia la falla sostenida)",
    "permiso": "webhooks.manage",
    "modulo": "integrations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        },
        "active": {
          "type": "boolean"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "WebhooksSalientesController_create": {
    "metodo": "POST",
    "ruta": "/v1/webhooks-salientes",
    "resumen": "Crea el webhook — guarda el secreto para verificar la firma",
    "permiso": "webhooks.manage",
    "modulo": "integrations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string"
        },
        "events": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "additionalProperties": false
    }
  },
  "WebhooksSalientesController_deliveries": {
    "metodo": "GET",
    "ruta": "/v1/webhooks-salientes/entregas",
    "resumen": "El panel de entregas: payload, respuesta y estado",
    "permiso": "webhooks.manage",
    "modulo": "integrations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "endpointId": {
          "type": "string",
          "x-iaxti-en": "query"
        }
      },
      "additionalProperties": false
    }
  },
  "WebhooksSalientesController_eventos": {
    "metodo": "GET",
    "ruta": "/v1/webhooks-salientes/eventos",
    "resumen": "El catálogo de eventos suscribibles",
    "permiso": "webhooks.manage",
    "modulo": "integrations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "WebhooksSalientesController_list": {
    "metodo": "GET",
    "ruta": "/v1/webhooks-salientes",
    "resumen": "Los webhooks del tenant (con su secreto de firma)",
    "permiso": "webhooks.manage",
    "modulo": "integrations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "WebhooksSalientesController_remove": {
    "metodo": "DELETE",
    "ruta": "/v1/webhooks-salientes/{id}",
    "resumen": "Elimina el webhook y su historial",
    "permiso": "webhooks.manage",
    "modulo": "integrations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "WebhooksSalientesController_retry": {
    "metodo": "POST",
    "ruta": "/v1/webhooks-salientes/entregas/{id}/retry",
    "resumen": "Reintenta una entrega fallida, a mano",
    "permiso": "webhooks.manage",
    "modulo": "integrations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "WebhooksSalientesController_rotate": {
    "metodo": "POST",
    "ruta": "/v1/webhooks-salientes/{id}/rotate",
    "resumen": "Rota el secreto de firma (el anterior muere al instante)",
    "permiso": "webhooks.manage",
    "modulo": "integrations",
    "soloSesion": false,
    "argumentos": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "x-iaxti-en": "ruta"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  }
};
