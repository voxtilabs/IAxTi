import { LoginCard } from '@iaxti/ui/react';
import { publicConfig } from '../../lib/config';
import { MARCA_LOCKUP_SVG } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return <LoginCard config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} />;
}
