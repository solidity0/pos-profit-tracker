// Copyright (c) 2026 Triumph Enterprise. All rights reserved. See LICENSE.
// Ledger service worker: lets the app open without internet.
// Pages are fetched fresh when online (so updates arrive straight away) and served from the
// cache when offline. Libraries (Firebase SDK, jsPDF, fonts) are versioned URLs, so they're
// served from the cache once downloaded. Firestore and sign-in traffic is never touched; the
// Firebase SDK keeps its own offline copy of the records.
const CACHE = 'ledger-v1';
const APP_FILES = ['./', 'index.html', 'app.css', 'app.js', 'terms.html', 'privacy.html', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const LIBRARIES = [
  'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];
const LIBRARY_HOSTS = ['www.gstatic.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event)=>{
  event.waitUntil((async ()=>{
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_FILES);
    // Best effort: the page also caches these as it loads them.
    await Promise.allSettled(LIBRARIES.map(url => cache.add(new Request(url, { mode: 'cors' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event)=>{
  event.waitUntil((async ()=>{
    for(const key of await caches.keys()) if(key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

function cacheable(res){ return res && (res.ok || res.type === 'opaque'); }

self.addEventListener('fetch', (event)=>{
  const req = event.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);

  if(url.origin === self.location.origin){
    // Network first, cache as fallback (ignoring ?query so ?emulator=1 etc. still open).
    event.respondWith((async ()=>{
      const cache = await caches.open(CACHE);
      try{
        const res = await fetch(req);
        if(res.ok) cache.put(req.mode === 'navigate' ? new Request(url.pathname) : req, res.clone());
        return res;
      }catch(err){
        const hit = await cache.match(req, { ignoreSearch: true })
          || (req.mode === 'navigate' && (await cache.match('index.html') || await cache.match('./')));
        if(hit) return hit;
        throw err;
      }
    })());
    return;
  }

  if(LIBRARY_HOSTS.includes(url.hostname)){
    // Cache first: these URLs carry a version, so a cached copy never goes stale.
    event.respondWith((async ()=>{
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if(hit) return hit;
      const res = await fetch(req);
      if(cacheable(res)) cache.put(req, res.clone());
      return res;
    })());
  }
});
