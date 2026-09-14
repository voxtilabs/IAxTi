// Service worker de IAxTi (#78): recibe el push y abre la conversación.
// Mínimo a propósito — no cachea nada: una app que sirve pantallas viejas
// desde el caché es peor que una que carga un segundo más lento.

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let aviso = {};
  try {
    aviso = event.data.json();
  } catch {
    aviso = { title: event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(aviso.title ?? 'IAxTi', {
      body: aviso.body ?? undefined,
      // El tag agrupa por tipo: diez avisos del mismo tipo no son diez
      // notificaciones apiladas en el celular.
      tag: aviso.tag ?? 'iaxti',
      renotify: true,
      data: { link: aviso.link ?? '/bandeja' },
      icon: '/icon-192.png',
      badge: '/badge-72.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destino = new URL(event.notification.data?.link ?? '/bandeja', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientes) => {
      // Si ya hay una pestaña abierta, se reusa: abrir una nueva cada vez
      // deja al vendedor con quince pestañas del mismo sistema.
      for (const cliente of clientes) {
        if (cliente.url.startsWith(self.location.origin) && 'focus' in cliente) {
          cliente.navigate(destino);
          return cliente.focus();
        }
      }
      return self.clients.openWindow(destino);
    }),
  );
});
