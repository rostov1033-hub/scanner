const CACHE_NAME =
  'box-scanner-v1';

const LOCAL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg'
];

const QR_LIBRARY =
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';


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
              'unpkg.com'
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
