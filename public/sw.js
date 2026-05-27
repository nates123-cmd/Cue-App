// Kill-switch service worker. The previous SW precached `./` + `./index.html`
// indefinitely with a never-bumped cache name, which meant deploys never
// reached users until they manually cleared site data. On activation this
// version clears every cache, unregisters itself, and reloads all open clients
// so they fetch fresh content from the network.
//
// Browsers check sw.js for byte-level changes on every page load — bumping the
// banner below is enough to guarantee re-installation.
// VERSION: 2026-05-27-kill-switch
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.map((k) => caches.delete(k)))
    await self.registration.unregister()
    const clients = await self.clients.matchAll({ type: 'window' })
    clients.forEach((c) => { try { c.navigate(c.url) } catch (_) {} })
  })())
})

// No fetch handler — let the browser do its default network behavior, so
// content updates land immediately.
