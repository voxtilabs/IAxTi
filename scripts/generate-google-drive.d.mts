export const DRIVE_OPERATIONS: string[];
export function driveRoutes(document: { paths?: Record<string, Record<string, { operationId?: string }>> }): Record<string, { path: string; method: string }>;
export function driveRoutesSource(document: Parameters<typeof driveRoutes>[0]): string;
