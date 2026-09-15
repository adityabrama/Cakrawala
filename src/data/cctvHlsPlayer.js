/**
 * @module cctvHlsPlayer
 *
 * Plays a CCTV HLS playlist in a <video> element. hls.js is loaded lazily the
 * first time an HLS camera opens, so startup never pays for it. Browsers without
 * Media Source Extensions fall back to native HLS playback.
 */

/** Fatal network errors get this many reload attempts before the player gives up. */
const MAX_NETWORK_RECOVERIES = 3;

/** First retry delay; each later attempt doubles it (2 s, 4 s, 8 s). */
const RETRY_BASE_DELAY_MS = 2000;

/** Error details that leave hls.js without a manifest, so startLoad() alone cannot recover. */
const MANIFEST_ERROR_DETAILS = new Set(['manifestLoadError', 'manifestLoadTimeOut', 'manifestParsingError']);

/**
 * Attach an HLS playlist to a video element.
 * @param {HTMLVideoElement} video
 * @param {string} playlistUrl Same-origin proxied playlist URL.
 * @param {{loadHls?: () => Promise<{default: any}>, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout}} [options]
 *   Test seams for the hls.js import and the retry timer.
 * @returns {() => void} Detach: stops loading and releases the player.
 */
export function attachHlsVideo(video, playlistUrl, {
  loadHls = () => import('hls.js'),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let hls = null;
  let detached = false;
  let networkRecoveries = 0;
  let retryTimer = null;

  const playNatively = () => {
    if (detached) return;
    video.src = playlistUrl;
  };

  loadHls()
    .then((module) => {
      if (detached) return;
      const Hls = module?.default;
      if (!Hls?.isSupported?.()) {
        playNatively();
        return;
      }
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 10,
        maxMaxBufferLength: 20,
        backBufferLength: 0,
      });
      // A stream that is buffering again has recovered; later outages get a fresh budget.
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        networkRecoveries = 0;
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal || !hls) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < MAX_NETWORK_RECOVERIES) {
          const delayMs = RETRY_BASE_DELAY_MS * 2 ** networkRecoveries;
          networkRecoveries += 1;
          const reloadManifest = MANIFEST_ERROR_DETAILS.has(data.details);
          clearTimer(retryTimer);
          // City stream servers drop connections for a few seconds at a time; back off before retrying.
          retryTimer = setTimer(() => {
            retryTimer = null;
            if (!hls || detached) return;
            if (reloadManifest) hls.loadSource(playlistUrl);
            else hls.startLoad();
          }, delayMs);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          hls.destroy();
          hls = null;
        }
      });
      hls.loadSource(playlistUrl);
      hls.attachMedia(video);
    })
    .catch(playNatively);

  return () => {
    detached = true;
    clearTimer(retryTimer);
    retryTimer = null;
    if (hls) {
      hls.destroy();
      hls = null;
    }
  };
}
