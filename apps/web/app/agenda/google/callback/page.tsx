import type { Metadata } from 'next';
import { AppShell } from '../../../../components/app-shell';
import { GoogleCalendarCallback } from '../../../../components/google-calendar';
import { navDesdeLaApi } from '../../../../lib/nav';
import { internalApiUrl, publicConfig } from '../../../../lib/config';
import { MARCA_LOCKUP_SVG } from '@iaxti/ui/react';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function CallbackGoogle() {
  return <AppShell config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} nav={await navDesdeLaApi(internalApiUrl())}><GoogleCalendarCallback /></AppShell>;
}
