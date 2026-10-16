import { bearer, createTransport, inputText, invalidInput, invalidResponse, record, text,
  GoogleIntegrationError, type GoogleRequestOptions, type GoogleTransportOptions } from './http';

const ENDPOINT = 'https://www.googleapis.com/calendar/v3';
export interface GoogleBusyInterval { start: string; end: string }
export interface GoogleFreebusyInput extends GoogleRequestOptions {
  accessToken: string; calendarIds: readonly string[]; timeMin: string; timeMax: string; timeZone?: string;
}
export interface GoogleWatchInput extends GoogleRequestOptions {
  accessToken: string; calendarId: string; channelId: string; channelToken: string;
  address: string; expiration: number;
}
export interface GoogleWatchChannel { id: string; resourceId: string; expiration: number }
export interface GoogleCalendarClient {
  freebusy(input: GoogleFreebusyInput): Promise<Record<string, GoogleBusyInterval[]>>;
  watch(input: GoogleWatchInput): Promise<GoogleWatchChannel>;
  stop(input: { accessToken: string; channelId: string; resourceId: string } & GoogleRequestOptions): Promise<void>;
}

function instant(value: string): number {
  // RFC3339 con zona explícita; Date.parse de una fecha local sería ambiguo.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  // Date.parse normaliza, por ejemplo, 30 de febrero. Una respuesta imposible
  // debe fallar, no trasladar silenciosamente una ocupación a otro día.
  const local = Date.parse(`${value.slice(0, 19)}Z`);
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 19) !== value.slice(0, 19)) return NaN;
  return Date.parse(value);
}
function channelId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return invalidInput();
  return id;
}

export function createGoogleCalendarClient(options: GoogleTransportOptions = {}): GoogleCalendarClient {
  const request = createTransport(options);
  const post = (path: string, accessToken: string, body: unknown, opt: GoogleRequestOptions) => request(`${ENDPOINT}${path}`, {
    method: 'POST', headers: { Authorization: bearer(accessToken), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, opt);
  return {
    async freebusy(input) {
      if (input.calendarIds.length < 1 || input.calendarIds.length > 50
        || new Set(input.calendarIds).size !== input.calendarIds.length
        || !Number.isFinite(instant(input.timeMin)) || !Number.isFinite(instant(input.timeMax))
        || instant(input.timeMin) >= instant(input.timeMax)) return invalidInput();
      input.calendarIds.forEach((id) => inputText(id, 1024));
      if (input.timeZone !== undefined) {
        try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }); } catch { return invalidInput(); }
      }
      const response = record(await post('/freeBusy', input.accessToken, {
        timeMin: input.timeMin, timeMax: input.timeMax, items: input.calendarIds.map((id) => ({ id })),
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      }, input));
      const calendars = record(response.calendars);
      const result: Record<string, GoogleBusyInterval[]> = Object.create(null) as Record<string, GoogleBusyInterval[]>;
      for (const id of input.calendarIds) {
        // HTTP200 no significa que cada calendario se haya podido consultar.
        const entry = calendars[id];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new GoogleIntegrationError('GOOGLE_FREEBUSY_UNAVAILABLE');
        const item = entry as Record<string, unknown>;
        if ((item.errors !== undefined && (!Array.isArray(item.errors) || item.errors.length > 0)) || !Array.isArray(item.busy)) {
          throw new GoogleIntegrationError('GOOGLE_FREEBUSY_UNAVAILABLE');
        }
        result[id] = item.busy.map((value) => {
          const busy = record(value);
          const start = text(busy.start); const end = text(busy.end);
          if (!Number.isFinite(instant(start)) || !Number.isFinite(instant(end)) || instant(start) >= instant(end)) return invalidResponse();
          return { start, end };
        });
      }
      return result;
    },
    async watch(input) {
      const id = channelId(input.channelId);
      inputText(input.calendarId, 1024); inputText(input.channelToken, 256);
      if (!Number.isSafeInteger(input.expiration) || input.expiration <= 0) return invalidInput();
      let address: URL;
      try { address = new URL(input.address); } catch { return invalidInput(); }
      if (address.protocol !== 'https:' || address.username || address.password || address.hash) return invalidInput();
      const response = record(await post(`/calendars/${encodeURIComponent(input.calendarId)}/events/watch`, input.accessToken, {
        id, type: 'web_hook', address: address.href, token: input.channelToken, expiration: String(input.expiration),
      }, input));
      if (!(typeof response.expiration === 'number' || (typeof response.expiration === 'string' && /^\d+$/.test(response.expiration)))) return invalidResponse();
      const expiration = Number(response.expiration);
      if (response.id !== id || !Number.isSafeInteger(expiration) || expiration <= 0) return invalidResponse();
      return { id, resourceId: text(response.resourceId, 1024), expiration };
    },
    async stop(input) {
      await post('/channels/stop', input.accessToken, { id: channelId(input.channelId), resourceId: inputText(input.resourceId, 1024) }, input);
    },
  };
}
