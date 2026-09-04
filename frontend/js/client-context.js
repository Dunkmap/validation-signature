/* Everything the browser can say about itself.

   locationStatus MUST be exactly one of these four. Salesforce rejects anything
   else on write-back and fails the whole record - after the signature is already
   taken. Do not invent new words. */
export const LOCATION_STATUS = {
  GRANTED: 'Granted',
  DENIED: 'Denied',
  UNAVAILABLE: 'Unavailable',
  NOT_REQUESTED: 'Not requested',
};

export function browserFacts() {
  const ua = navigator.userAgent;
  return {
    userAgent: ua,
    language: navigator.language || 'Unknown',
    platform: navigator.platform || 'Unknown',
    screen: `${screen.width}x${screen.height}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown',
    browser: browserName(ua),
    os: osName(ua),
    deviceType: /Mobi|Android|iPhone|iPad/i.test(ua) ? 'Mobile' : 'Desktop',
  };
}

function browserName(ua) {
  // Order matters: Edge and Opera both claim to be Chrome, Chrome claims Safari.
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Unknown';
}

function osName(ua) {
  if (/Windows NT 10/.test(ua)) return 'Windows';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}

/* Ask for location. Never rejects - a refusal is a legitimate outcome that must
   still be recorded, so it resolves with a status instead of throwing. */
export function requestLocation({ timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ locationStatus: LOCATION_STATUS.UNAVAILABLE });
      return;
    }
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    navigator.geolocation.getCurrentPosition(
      (pos) => done({
        locationStatus: LOCATION_STATUS.GRANTED,
        latitude: round6(pos.coords.latitude),
        longitude: round6(pos.coords.longitude),
        accuracy: Math.round(pos.coords.accuracy),
      }),
      (err) => done({
        locationStatus: err.code === err.PERMISSION_DENIED
          ? LOCATION_STATUS.DENIED
          : LOCATION_STATUS.UNAVAILABLE,
      }),
      { enableHighAccuracy: false, timeout, maximumAge: 300000 },
    );

    // Some browsers hang forever on the prompt rather than firing the error path.
    setTimeout(() => done({ locationStatus: LOCATION_STATUS.UNAVAILABLE }), timeout + 500);
  });
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }
