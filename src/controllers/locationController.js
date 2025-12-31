import https from 'node:https';
import { URL } from 'node:url';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const cache = new Map();

const requestJson = (url, options = {}) => new Promise((resolve, reject) => {
  try {
    const u = new URL(url);
    const method = String(options?.method || 'GET').toUpperCase();
    const headers = options?.headers || {};
    const body = options?.body;

    const req = https.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        headers,
      },
      (resp) => {
        let body = '';
        resp.on('data', (chunk) => {
          body += chunk;
        });
        resp.on('end', () => {
          const status = resp.statusCode || 0;
          const ok = status >= 200 && status < 300;
          if (!ok) {
            return resolve({ ok: false, status, json: null });
          }
          try {
            const json = body ? JSON.parse(body) : null;
            return resolve({ ok: true, status, json });
          } catch {
            return resolve({ ok: false, status, json: null });
          }
        });
      }
    );

    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  } catch (e) {
    reject(e);
  }
});

const getCache = (key) => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
};

export const nearby = async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng ?? req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ message: 'lat/lng requeridos' });
    }

    const radius = clamp(Number(req.query.radius ?? 800) || 800, 50, 3000);
    const limit = clamp(Number(req.query.limit ?? 10) || 10, 1, 20);

    const cacheKey = `nearby:${radius}:${limit}:${lat.toFixed(5)}:${lng.toFixed(5)}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const query = `
[out:json][timeout:15];
(
  node(around:${radius},${lat},${lng})[name][amenity];
  node(around:${radius},${lat},${lng})[name][shop];
  node(around:${radius},${lat},${lng})[name][tourism];
  way(around:${radius},${lat},${lng})[name][amenity];
  way(around:${radius},${lat},${lng})[name][shop];
  way(around:${radius},${lat},${lng})[name][tourism];
  relation(around:${radius},${lat},${lng})[name][amenity];
  relation(around:${radius},${lat},${lng})[name][shop];
  relation(around:${radius},${lat},${lng})[name][tourism];
);
out center tags 50;
`;

    const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    const upstream = await requestJson(overpassUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': buildUserAgent(),
      }
    });

    if (!upstream.ok) {
      return res.status(502).json({ message: 'Nearby upstream failed', status: upstream.status, body: upstream.json });
    }

    const elements = upstream.json?.elements;
    const normalized = (Array.isArray(elements) ? elements : [])
      .map((el) => {
        const name = el?.tags?.name;
        if (!name) return null;

        const elLat = Number(el?.lat ?? el?.center?.lat);
        const elLng = Number(el?.lon ?? el?.center?.lon);
        if (!Number.isFinite(elLat) || !Number.isFinite(elLng)) return null;

        const kind = el?.tags?.amenity || el?.tags?.shop || el?.tags?.tourism || null;
        const distanceM = haversineM(lat, lng, elLat, elLng);

        return {
          id: `${el?.type || 'x'}:${el?.id || ''}`,
          name: String(name),
          lat: elLat,
          lng: elLng,
          kind,
          distanceM: Math.round(distanceM),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, limit);

    setCache(cacheKey, normalized, 5 * 60 * 1000);
    return res.json(normalized);
  } catch (error) {
    console.error('location nearby error:', error);
    return res.status(500).json({ message: 'Error del servidor' });
  }
};

const setCache = (key, value, ttlMs) => {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
};

const buildUserAgent = () => {
  const fromEnv = String(process.env.NOMINATIM_USER_AGENT || '').trim();
  if (fromEnv) return fromEnv;
  return 'stylex/1.0 (location proxy)';
};

const haversineM = (lat1, lon1, lat2, lon2) => {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

export const geocode = async (req, res) => {
  try {
    const qRaw = String(req.query.q || '').trim();
    if (!qRaw) return res.status(400).json({ message: 'q requerido' });

    const q = qRaw.slice(0, 200);
    const limit = clamp(Number(req.query.limit ?? 1) || 1, 1, 5);
    const country = String(req.query.country || '').trim().toLowerCase();

    const cacheKey = `geocode:${country}:${limit}:${q}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const params = new URLSearchParams();
    params.set('format', 'jsonv2');
    params.set('q', q);
    params.set('limit', String(limit));
    params.set('addressdetails', '1');
    if (country) params.set('countrycodes', country);

    const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
    const upstream = await requestJson(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': buildUserAgent(),
      }
    });

    if (!upstream.ok) {
      return res.status(502).json({ message: 'Geocoding upstream failed', status: upstream.status, body: upstream.json });
    }

    const data = upstream.json;
    const normalized = (Array.isArray(data) ? data : []).map((item) => {
      const lat = item?.lat != null ? Number(item.lat) : null;
      const lng = item?.lon != null ? Number(item.lon) : null;
      return {
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        displayName: item?.display_name || null,
        address: item?.address || null,
      };
    }).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng));

    setCache(cacheKey, normalized, 6 * 60 * 60 * 1000);
    return res.json(normalized);
  } catch (error) {
    console.error('location geocode error:', error);
    return res.status(500).json({ message: 'Error del servidor' });
  }
};

export const reverse = async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng ?? req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ message: 'lat/lng requeridos' });
    }

    const zoom = clamp(Number(req.query.zoom ?? 18) || 18, 3, 18);

    const cacheKey = `reverse:${zoom}:${lat.toFixed(6)}:${lng.toFixed(6)}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const params = new URLSearchParams();
    params.set('format', 'jsonv2');
    params.set('lat', String(lat));
    params.set('lon', String(lng));
    params.set('zoom', String(zoom));
    params.set('addressdetails', '1');

    const url = `https://nominatim.openstreetmap.org/reverse?${params.toString()}`;
    const upstream = await requestJson(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': buildUserAgent(),
      }
    });

    if (!upstream.ok) {
      return res.status(502).json({ message: 'Reverse geocoding upstream failed', status: upstream.status, body: upstream.json });
    }

    const data = upstream.json;
    const out = {
      lat,
      lng,
      displayName: data?.display_name || null,
      address: data?.address || null,
      raw: data || null,
    };

    setCache(cacheKey, out, 24 * 60 * 60 * 1000);
    return res.json(out);
  } catch (error) {
    console.error('location reverse error:', error);
    return res.status(500).json({ message: 'Error del servidor' });
  }
};
