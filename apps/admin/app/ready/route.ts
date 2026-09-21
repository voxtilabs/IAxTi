import { frontendReadiness } from '@iaxti/telemetry';

export const dynamic = 'force-dynamic';

export function GET() {
  return frontendReadiness('admin');
}
