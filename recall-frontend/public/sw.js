self.addEventListener("push", event => {
  let data = { title: "Saved!", body: "" }
  try { data = event.data.json() } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon.svg",
      badge: "/icon.svg"
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
