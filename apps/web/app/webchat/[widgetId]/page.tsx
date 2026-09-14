import { WebchatChat } from '../../../components/webchat-chat';
import { publicConfig } from '../../../lib/config';

export const dynamic = 'force-dynamic';

/** La página del IFRAME del widget (#46): sin shell, sin sesión — pública. */
export default async function PaginaWebchat({
  params,
  searchParams,
}: {
  params: Promise<{ widgetId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { widgetId } = await params;
  const { page } = await searchParams;
  return <WebchatChat apiUrl={publicConfig().apiUrl} widgetId={widgetId} page={page ?? ''} />;
}
