export const GOOGLE_OPERATIONS: string[];
export function googleRoutes(document: { paths?: Record<string, Record<string, { operationId?: string }>> }): Record<string, { path: string; method: string }>;
export function googleRoutesSource(document: Parameters<typeof googleRoutes>[0]): string;
