const CACHE_NAME =
  'box-scanner-v18';

const LOCAL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg'
];

const QR_LIBRARY =
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';

const BARCODE_LIBRARY =
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';


/*
  Установка Service Worker.
*/
self.addEventListener(
  'install',
  event => {

    event.waitUntil(
      (async () => {

        const cache =
          await caches.open(
            CACHE_NAME
          );


        /*
          Кэшируем основные файлы приложения.
        */
        await cache.addAll(
          LOCAL_FILES
        );


        /*
          Пытаемся также заранее сохранить
          библиотеку сканера.

          Если CDN временно недоступен,
          установка приложения всё равно продолжится.
        */
        try {
          await cache.add(
            QR_LIBRARY
          );
        } catch (e) {}

        try {
  await cache.add(
    BARCODE_LIBRARY
  );
} catch (e) {}


        self.skipWaiting();

      })()
    );
  }
);


/*
  Удаляем старые версии кэша.
*/
self.addEventListener(
  'activate',
  event => {

    event.waitUntil(
      (async () => {

        const keys =
          await caches.keys();


        await Promise.all(
          keys.map(key => {

            if (
              key !== CACHE_NAME
            ) {
              return caches.delete(
                key
              );
            }

          })
        );


        await self.clients.claim();

      })()
    );
  }
);


/*
  Работа с запросами.
*/
self.addEventListener(
  'fetch',
  event => {

    const request =
      event.request;


    if (
      request.method !== 'GET'
    ) {
      return;
    }


    const url =
      new URL(
        request.url
      );


    /*
      Google Apps Script НЕ кэшируем.

      Данные приложения сами сохраняются
      в localStorage внутри index.html.
    */
    if (
      url.hostname ===
        'script.google.com' ||

      url.hostname.endsWith(
        '.googleusercontent.com'
      )
    ) {
      return;
    }


    /*
      Для переходов по страницам:
      сначала пытаемся получить свежую
      версию из сети.

      Если сети нет —
      отдаём index.html из кэша.
    */
    if (
      request.mode === 'navigate'
    ) {

      event.respondWith(
        (async () => {

          try {

            const response =
              await fetch(request);


            const cache =
              await caches.open(
                CACHE_NAME
              );


            cache.put(
              './index.html',
              response.clone()
            );


            return response;

          } catch (e) {

            return (
              await caches.match(
                './index.html'
              )
            ) || (
              await caches.match(
                './'
              )
            );
          }

        })()
      );

      return;
    }


    /*
      Для остальных файлов:
      сначала кэш,
      потом интернет.
    */
    event.respondWith(
      (async () => {

        const cached =
          await caches.match(
            request
          );


        if (cached) {
          return cached;
        }


        try {

          const response =
            await fetch(request);


          /*
            Кэшируем:
            - собственные файлы
            - html5-qrcode с unpkg
          */
         if (
  url.origin ===
    self.location.origin ||

  url.hostname ===
    'unpkg.com' ||

  url.hostname ===
    'cdn.jsdelivr.net'
) {

            const cache =
              await caches.open(
                CACHE_NAME
              );


            cache.put(
              request,
              response.clone()
            );
          }


          return response;

        } catch (e) {

          return new Response(
            '',
            {
              status: 503,
              statusText: 'Offline'
            }
          );
        }

      })()
    );
  }
);

// =========================================================
// ФОНОВАЯ СИНХРОНИЗАЦИЯ (Background Sync)
// Страница кладёт действия в IndexedDB и регистрирует sync 'send-queue'.
// Когда появляется сеть, браузер будит этот воркер даже при закрытой странице.
// =========================================================

const SYNC_DB_NAME = 'scanner-sync';

function openSyncDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SYNC_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRun(store, txMode, fn) {
  return openSyncDb().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction(store, txMode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => { d.close(); resolve(req ? req.result : undefined); };
    tx.onerror = () => { d.close(); reject(tx.error); };
    tx.onabort = () => { d.close(); reject(tx.error); };
  }));
}

const queueGetAll = () => idbRun('queue', 'readonly', s => s.getAll());
const queueDelete = id => idbRun('queue', 'readwrite', s => s.delete(id));
const kvGet = key => idbRun('kv', 'readonly', s => s.get(key)).then(r => (r ? r.value : null));

self.addEventListener('sync', event => {
  if (event.tag === 'send-queue') event.waitUntil(sendQueue());
});

async function sendQueue() {
  const apiUrl = await kvGet('apiUrl');
  const pin = await kvGet('pin');
  if (!apiUrl || !pin) return;

  const items = (await queueGetAll()).sort((a, b) => a.createdAt - b.createdAt);

  for (const item of items) {
    const url = apiUrl +
      '?action=' + encodeURIComponent(item.action) +
      '&code=' + encodeURIComponent(item.code) +
      '&key=' + encodeURIComponent(pin);

    // Нет сети — fetch бросит ошибку, промис отклонится,
    // и браузер сам повторит sync позже.
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    const res = await response.json();
    if (res.error === 'auth') return; // неверный ПИН — пусть разбирается страница

    // ok или отклонено сервером — в обоих случаях повторять бессмысленно
    await queueDelete(item.id);
  }

  // Сообщаем открытым страницам, что очередь изменилась
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage({ type: 'queue-updated' }));
}
