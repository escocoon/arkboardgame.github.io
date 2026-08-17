/**
 * The service worker — what makes an installed copy of the game start, and keep working, with no
 * network.
 *
 * It is hand-written and lives in `public/` rather than coming out of a plugin, for the reason
 * `AudioSystem` is hand-written beside a catalog: there is one rule here and it is short, while a
 * build plugin would be a dependency, a second build step and a generated file nobody reads.
 *
 * ⚠️ **The version arrives in the query string, not in this file.** `src/pwa.ts` registers
 * `./sw.js?v=<GAME_VERSION>`, so a released build asks the browser for a URL it has never seen and
 * an update is picked up without this script ever being edited — and `package.json` stays the one
 * place a version is written down, exactly as `src/version.ts` documents. The same value names the
 * cache, so a new build cannot be served the old one's assets.
 *
 * Three rules are load-bearing:
 *
 * - ⚠️ **A navigation is network-first; everything else is cache-first.** `index.html` names the
 *   *hashed* asset filenames Vite emitted for that build, so a stale copy of it asks for chunks
 *   that no longer exist — a white screen with nothing thrown. Serving the document from the
 *   network whenever there is one keeps the page and its assets from ever coming from different
 *   builds; the cached copy is the offline fallback and nothing else. The assets themselves are
 *   content-hashed, so cache-first is safe by construction and is what makes a second visit
 *   instant.
 * - ⚠️ **Only same-origin `GET`s are touched.** The relay lives on another host and is reached by
 *   both socket.io and two plain `fetch`es (`GET /history`, `GET /rooms/open`); a cached room
 *   listing would be a list of rooms that have since filled or started, which
 *   `utils/roomList.ts`'s own header calls worse than no listing at all. Anything cross-origin,
 *   and anything that is not a `GET`, falls straight through to the network.
 * - ⚠️ **`skipWaiting` is deliberately absent.** A new worker taking over mid-session would delete
 *   the cache the running page is still lazily fetching out of — `NetClient` imports
 *   `socket.io-client` dynamically, so a chunk really can be asked for an hour into a match. It
 *   waits for the tab to close instead. `clients.claim()` *is* called, which only ever matters on
 *   the very first install, where there is no older worker to displace and claiming is what makes
 *   the game available offline after one visit rather than two.
 */

const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE = `ark-board-game-${VERSION}`;

/** The shell. Everything else is cached as it is first asked for. */
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

/**
 * ⚠️ The bundle is precached here and **not** left to the ordinary cache-first path, because a
 * worker does not control the page that registered it: every script of the first visit goes
 * straight to the network without passing through this file. `precache.json` is emitted by the
 * build (see vite.config.ts) and lists exactly the JavaScript and CSS of *this* build; the media
 * is deliberately not in it and fills in as the game asks for it.
 */
async function precacheList() {
  try {
    const res = await fetch("./precache.json", { cache: "no-cache" });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const urls = SHELL.concat(await precacheList());
      // One at a time and forgiving: `addAll` rejects the whole install if any single entry
      // 404s, which would leave the game with no worker at all over one missing icon.
      await Promise.all(urls.map((url) => cache.add(url).catch(() => undefined)));
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("ark-board-game-") && n !== CACHE)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

/** The document: the live one whenever there is a network, the last good one when there is not. */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached =
      (await cache.match(request)) ||
      (await cache.match("./index.html")) ||
      (await cache.match("./"));
    if (cached) return cached;
    throw new Error("offline and no cached document");
  }
}

/** A hashed asset: its name is its version, so whatever is cached under it is correct. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  // `basic` excludes opaque cross-origin responses, which cannot be inspected and would fill the
  // cache with things that may have been errors.
  if (response && response.ok && response.type === "basic") {
    cache.put(request, response.clone());
  }
  return response;
}
