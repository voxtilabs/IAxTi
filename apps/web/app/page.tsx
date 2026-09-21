import { AppShell } from '../components/app-shell';
import { navDesdeLaApi } from '../lib/nav';
import { PuestaEnMarcha } from '../components/puesta-en-marcha';
import { internalApiUrl, publicConfig } from '../lib/config';
import { MARCA_LOCKUP_SVG } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';


export default async function Home() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} nav={nav}>
      <PuestaEnMarcha />
    </AppShell>
  );
}
