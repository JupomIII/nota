/**
 * One bundle, two devices.
 *
 * The published app runs on the iPad; the same bundle also runs in the laptop's
 * browser, both from GitHub Pages and from the laptop's own server. Anything the
 * reader sees should name the machine they are actually holding.
 */
export type DeviceName = 'iPad' | 'laptop';

export function thisDevice(): DeviceName {
  if (typeof navigator === 'undefined') return 'laptop';
  const ua = navigator.userAgent;
  // iPadOS asks for the desktop site by default and reports a Macintosh UA;
  // the touch points are what still identify the iPad.
  const iPad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
  return iPad ? 'iPad' : 'laptop';
}
