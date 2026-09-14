{{- define "iaxti.nombre" -}}
{{- printf "%s" (default "iaxti" .Release.Name) | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "iaxti.etiquetas" -}}
app.kubernetes.io/name: iaxti
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "iaxti.imagen" -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
