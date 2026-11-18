// Minimal service worker: it exists so notifications can be shown through a
// ServiceWorkerRegistration, which is the only way Android Chrome allows them.
// No fetch handler on purpose — it must not interfere with app assets or routing.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus()
      }
      return self.clients.openWindow('/')
    })
  )
})
