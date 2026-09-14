import { MARCA_LOCKUP_SVG } from '@iaxti/ui/react';
import { AdminShell } from '../components/admin-shell';
import { publicConfig } from '../lib/config';

export const dynamic = 'force-dynamic';

export default function Home() {
  return <AdminShell config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} />;
}
