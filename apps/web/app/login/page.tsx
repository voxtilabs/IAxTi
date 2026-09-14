import { LoginCard } from '../../components/login-card';
import { publicConfig } from '../../lib/config';
import { MARCA_LOCKUP_SVG } from '../../lib/marca-svg';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return <LoginCard config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} />;
}
