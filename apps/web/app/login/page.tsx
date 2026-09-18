import { LoginCard } from '@iaxti/ui/react';
import { publicConfig } from '../../lib/config';
import { IAXTI_LOCKUP_SVG } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return <LoginCard config={publicConfig()} marcaSvg={IAXTI_LOCKUP_SVG} />;
}
