/**
 * Service Worker cho Hệ Thống Hồ Sơ Một Cửa (PWA)
 */

const CACHE_NAME = "hsmc-cache-v1.1.1";
const ASSETS_TO_CACHE = [
  "/",
  "/index.html",
  "/core.js",
  "/charts.js",
  "/app.js",
  "/manifest.json",
  "/icons/icon16.png",
  "/icons/icon48.png",
  "/icons/icon128.png",
  "/icons/icon192.png",
  "/icons/icon512.png"
];

// Cài đặt Service Worker và lưu cache tĩnh
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn("[SW] Cache non-critical fail:", err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Kích hoạt và dọn dẹp cache cũ
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Chiến lược Fetch: Network First cho API, Stale-While-Revalidate cho tài nguyên tĩnh
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Không cache API proxy
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === "basic") {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});

// Nhấn vào thông báo -> mở hoặc focus vào cửa sổ ứng dụng
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      if (clientList.length > 0) {
        let client = clientList[0];
        for (let i = 0; i < clientList.length; i++) {
          if (clientList[i].focused) {
            client = clientList[i];
            break;
          }
        }
        return client.focus();
      }
      return clients.openWindow("/");
    })
  );
});
