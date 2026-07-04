self.addEventListener("push", event => {
  let data = { title: "Saved!", body: "" }
  try { data = event.data.json() } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/badge-96.png"
    })
  )
})

self.addEventListener("notificationclick", event => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin))
      return existing ? existing.focus() : self.clients.openWindow("/")
    })
  )
})
