// Test-only colour maths for the alert palette gate (tests/modules/platform/alert-palette.test.mjs).
// Pure functions, no dependencies: hex parsing, WCAG contrast, CIEDE2000 (Sharma 2005 reference form),
// and the Machado, Oliveira & Fernandes 2009 protanopia / deuteranopia matrices at severity 1.0
// (applied to linear sRGB, as the paper specifies).

export function hexToRgb(hex) {
  const h = String(hex).trim().replace('#', '');
  const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(f)) throw new Error(`bad hex: ${hex}`);
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
}

const _lin = c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const _gam = l => { const c = Math.min(1, Math.max(0, l)); return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055); };

export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(_lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio (1..21). */
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function _toLab(hex) {
  const [r, g, b] = hexToRgb(hex).map(_lin);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 colour difference between two hex colours. */
export function deltaE2000(hexA, hexB) {
  const [L1, a1, b1] = _toLab(hexA), [L2, a2, b2] = _toLab(hexB);
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (b, a) => { if (b === 0 && a === 0) return 0; const h = deg(Math.atan2(b, a)); return h < 0 ? h + 360 : h; };
  const h1p = hp(b1, a1p), h2p = hp(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbp /= 2;
    else hbp = (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.2 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

/** Machado 2009, severity 1.0, applied in linear sRGB. */
export const MACHADO_PROTAN = [
  [0.152286, 1.052583, -0.204868],
  [0.114503, 0.786281, 0.099216],
  [-0.003882, -0.048116, 1.051998],
];
export const MACHADO_DEUTAN = [
  [0.367322, 0.860646, -0.227968],
  [0.280085, 0.672501, 0.047413],
  [-0.011820, 0.042940, 0.968881],
];

export function simulate(hex, matrix) {
  const lin = hexToRgb(hex).map(_lin);
  const out = matrix.map(row => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]).map(_gam).map(Math.round);
  return '#' + out.map(v => v.toString(16).padStart(2, '0')).join('');
}

/** ΔE2000 between two colours as seen through a CVD matrix. */
export function deltaECvd(a, b, matrix) {
  return deltaE2000(simulate(a, matrix), simulate(b, matrix));
}
