/**
 * @module cctvHls
 *
 * Server-side HLS helpers for the CCTV proxy. Playlists are rewritten so every
 * URI (variant playlists, segments, keys, init maps) routes back through
 * `/api/cctv/hls/:id/r/<ref>`, and every upstream fetch is checked against the
 * camera's registered stream host. Pure functions; the Vite middleware owns
 * fetching and streaming.
 */

export const HLS_PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

/**
 * Encode an absolute upstream URL as a single URL-safe path segment.
 * @param {string} url
 * @returns {string}
 */
export function encodeHlsRef(url) {
  return Buffer.from(String(url), 'utf8').toString('base64url');
}

/**
 * Decode a path segment produced by encodeHlsRef. Only http(s) URLs survive.
 * @param {string} ref
 * @returns {string|null}
 */
export function decodeHlsRef(ref) {
  try {
    const text = Buffer.from(String(ref || ''), 'base64url').toString('utf8');
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * True when a response is an HLS playlist, by content type or by its first line.
 * @param {string} contentType
 * @param {string} bodyStart
 * @returns {boolean}
 */
export function looksLikeHlsPlaylist(contentType, bodyStart) {
  if (String(contentType || '').toLowerCase().includes('mpegurl')) return true;
  return String(bodyStart || '').trimStart().startsWith('#EXTM3U');
}

function resolveUri(uri, base) {
  try {
    const url = new URL(uri, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const URI_ATTRIBUTE = /URI="([^"]*)"/g;

/**
 * Rewrite every URI in an HLS playlist through `toProxyUrl(absoluteUrl)`.
 * Covers bare URI lines (variants, segments) and `URI="..."` attributes on tags
 * such as EXT-X-KEY, EXT-X-MAP and EXT-X-MEDIA.
 * @param {string} text Playlist body.
 * @param {string} playlistUrl Absolute URL the playlist was fetched from (after redirects).
 * @param {(absoluteUrl: string) => string} toProxyUrl
 * @returns {string}
 */
export function rewriteHlsPlaylist(text, playlistUrl, toProxyUrl) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        if (!trimmed.includes('URI="')) return line;
        return line.replace(URI_ATTRIBUTE, (match, uri) => {
          const absolute = resolveUri(uri, playlistUrl);
          return absolute ? `URI="${toProxyUrl(absolute)}"` : match;
        });
      }
      const absolute = resolveUri(trimmed, playlistUrl);
      return absolute ? toProxyUrl(absolute) : line;
    })
    .join('\n');
}

const PRIVATE_IPV4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

/**
 * True for loopback, link-local and private-network hosts, which a camera stream
 * may never reach through the proxy.
 * @param {string} hostname
 * @returns {boolean}
 */
export function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return PRIVATE_IPV4.some((pattern) => pattern.test(host));
  if (host.includes(':')) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  return false;
}

/**
 * The registrable-ish site of a hostname: the last two labels, or the last three
 * under a country second-level domain ("cctv.bengkulukota.go.id" -> "bengkulukota.go.id").
 * @param {string} hostname
 * @returns {string}
 */
export function hlsSiteDomain(hostname) {
  const labels = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const last = labels[labels.length - 1];
  const secondLast = labels[labels.length - 2];
  const countrySecondLevel = last.length === 2 && secondLast.length <= 3;
  return labels.slice(countrySecondLevel ? -3 : -2).join('.');
}

/**
 * May a camera registered at `registeredUrl` fetch `targetUrl`? The same host on
 * any port, or a sibling host on the same site (a city portal redirecting to its
 * own streaming server). Never a private address, never a non-http scheme.
 * @param {string} targetUrl
 * @param {string} registeredUrl
 * @returns {boolean}
 */
export function isAllowedHlsTarget(targetUrl, registeredUrl) {
  let target;
  let registered;
  try {
    target = new URL(targetUrl);
    registered = new URL(registeredUrl);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  if (isPrivateHostname(target.hostname)) return false;
  if (target.hostname === registered.hostname) return true;
  return hlsSiteDomain(target.hostname) === hlsSiteDomain(registered.hostname);
}
