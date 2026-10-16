export const GMAIL_OPERATIONS: string[];
export function gmailRoutes(document: { paths?: Record<string, Record<string, { operationId?: string }>> }): Record<string, { path: string; method: string }>;
export function gmailRoutesSource(document: Parameters<typeof gmailRoutes>[0]): string;
