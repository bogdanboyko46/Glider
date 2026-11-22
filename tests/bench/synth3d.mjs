// A geometric person in front of a laptop webcam, for tests/bench/gaze-bench.mjs.
//
// Everything is in centimetres in the camera's frame: the camera sits at the origin at the top
// centre of the screen and looks along -z (the MediaPipe convention), +x is the camera's right
// (the user's left), +y is up, and the screen is the plane z = 0 hanging below the camera.
//
//   head      MediaPipe's canonical face model (canonical_face_model.obj, cm), scaled per person,
//             rotated and moved as one rigid body about a pivot near the top of the neck
//   eyes      two balls of radius 1.2 cm behind the eye openings, each turned so that its visual
//             axis passes through the on-screen target; the optical axis (where the iris sits)
//             is off the visual axis by a per-person angle kappa
//   lids      the upper and lower lid landmarks follow the vertical eye angle; blinks close them
//   camera    pinhole, 1280x720, horizontal field of view 70 degrees
//   noise     AR(1) in image pixels on the iris, corner and lid landmarks; slow head wander
//
// The landmarks extractFeatures reads (eye corners, lids, iris centres), the iris rings and a
// few rigid anchors are projected; the face matrix and the eyeLook / eyeBlink blendshapes are
// synthesised from the true pose; then the REAL extractFeatures from gaze-core.js turns them
// into the 44-number vector, exactly as frame.js does with MediaPipe's output.
//
// What this is not: MediaPipe. Real landmark errors depend on lighting, glasses, lashes and
// the network's own biases; none of that is here. The noise levels are assumptions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { C, mkRng, clamp } from '../lab/lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D2R = Math.PI / 180;

// The same interface as tests/lab/lib/synth.mjs World: tick(), frame(t, gx, gy), setShift(), .t, .o
export const DEFAULTS3D = {
  seed: 1, fps: 30, drop: 0.02,
  camera: { width: 1280, height: 720 }, hfovDeg: 70,
  viewport: { w: 1536, h: 730 }, screen: { w: 1536, h: 864 }, chromePx: 110, screenDiagIn: 14, bezelCm: 0.8,
  distanceCm: 60,
  noisePx: 0.5,            // iris landmark noise, SD per axis in camera pixels at 1280x720
  cornerNoiseK: 0.5,       // eye-corner noise as a multiple of noisePx
  lidNoiseK: 0.8,          // lid landmark noise as a multiple of noisePx
  noiseTauMs: 48,          // AR(1) memory: lag-1 autocorrelation 0.5 at 30 fps, 0.25 at 15 fps
  eyeNoiseCorr: 0.3,       // share of the iris noise variance common to both eyes
  headWanderCm: 0.15, headWanderDeg: 0.3, headWanderTauMs: 20000,
  headFollow: 0.05,        // the head turns this fraction of the way towards whatever is looked at
  stepEveryMs: 0, stepCm: 1,   // sudden posture shifts: mean interval (0 = never) and size
  blinkEveryMs: 5000, faceLostEveryMs: 0,
  lookErrDeg: 0.2,         // people do not land exactly on a dot: SD per axis, redrawn at every new target
  eyeRadiusCm: 1.2, irisRadiusCm: 0.59,
  matrixNoise: { rotDeg: 0.3, xyCm: 0.08, zCm: 0.5 },   // at noisePx 0.5; scales with noisePx
  blendNoise: 0.02,                                      // at noisePx 0.5; scales with noisePx
  person: null,            // anatomy and seating; null = drawn from the seed
  extraLandmarks: [],      // more canonical vertex numbers to project
  // Added in step 2, for the features from index 44 on. Nothing in features 0-43 reads these
  // landmarks, and their noise has a random stream of its own, so the baseline is untouched.
  anchorNoiseK: 0.5,       // noise on the rigid points (nose bridge and the like) as a multiple of noisePx
  irisRingIndep: 0,        // share of the noise variance of each iris rim point that is its own (0: the rim moves with the centre)
  matrixTranspose: false,  // report the face matrix row-major: the wrong convention, to test that the tracker notices
  // Added at sign-off. The synthetic face matrix carries the true distance. Real MediaPipe works the depth out through a lens it
  // assumes, not the camera's own: measured once on this PC (a scratch copy of tests/gaze-camera-smoke.mjs printing the matrix), a
  // face a fifth of the picture wide came out at tz = -33.9 where this camera gives about -60, a factor near 0.6 to 0.7. 1 keeps the
  // standard benchmark as it was; `--set matrixDepthK=0.68` shows what a real camera's depth does (RESULTS.md, "Sign-off").
  matrixDepthK: 1,
  // Added in step 3. How much of the blink score comes from simply looking down (the lid follows the eye). At 0.25, the
  // standard, the fixed blink rule (0.45) is never reached on the screen; at 0.55 it is, on the bottom rows.
  blinkDownK: 0.25,
};

const EYES = [   // side: +1 = the eye at canonical +x (the user's left eye)
  { name: 'R', side: -1, c1: 33, c2: 133, up: 159, lo: 145, iris: 468 },
  { name: 'L', side: +1, c1: 362, c2: 263, up: 386, lo: 374, iris: 473 },
];
const ANCHORS = [1, 4, 6, 10, 152, 168, 234, 454];   // nose tip, bridge, forehead, chin, temples
const PIVOT = [0, -2, -3];                           // canonical cm: about where the skull turns on the neck

let CANON = null;
/** The 468 canonical face vertices, [[x, y, z], ...] in cm. */
export function loadCanonical(file = path.join(HERE, 'canonical_face_model.obj')) {
  if (CANON && file.endsWith('canonical_face_model.obj')) return CANON;
  const v = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('v ')) { const p = line.trim().split(/\s+/); v.push([+p[1], +p[2], +p[3]]); }
  }
  if (v.length !== 468) throw new Error(`canonical face model: expected 468 vertices, found ${v.length}`);
  CANON = v;
  return v;
}

/** R = Ry(yaw) * Rx(pitch) * Rz(roll), rows. Positive yaw turns the face towards +x, positive pitch towards -y (down). */
function rot(yaw, pitch, roll) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  return [
    [cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp],
    [cp * sr, cp * cr, -sp],
    [-sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp],
  ];
}
const mul = (R, v) => [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];
const mulT = (R, v) => [R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2], R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2], R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2]];

/** Anatomy and seating of one synthetic person. The same seed gives the same person at every noise level. */
export function makePerson(seed, distanceCm = DEFAULTS3D.distanceCm) {
  const r = mkRng(seed * 7919 + 13);
  return {
    scale: clamp(1 + 0.04 * r.g(), 0.9, 1.1),                       // face size against the canonical model
    kappaH: (5 + 1.5 * r.g()) * D2R, kappaV: (1.5 + 1.0 * r.g()) * D2R,
    eyeDepth: 0.1 * r.g(),                                          // eyeball centre further back (+) or forward (-)
    lidUp: clamp(0.75 + 0.07 * r.g(), 0.55, 0.9), lidLo: clamp(0.4 + 0.06 * r.g(), 0.25, 0.55),   // how far each lid follows the eye
    // A laptop screen leans back, so the camera looks up at a face that sits below its axis: the eyes
    // (about 4.5 cm above the pivot) end up some 5 cm below the axis, the face tipped back about 10
    // degrees as the camera sees it. Looking at the screen then takes the eyes 10 to 22 degrees down.
    pos: [1.0 * r.g(), -9.5 + 2.5 * r.g(), -(distanceCm + 3 * r.g())],   // the pivot, camera frame
    yaw: 2 * D2R * r.g(), pitch: (-10 + 3 * r.g()) * D2R, roll: 1.5 * D2R * r.g(),
  };
}

export class Person3D {
  constructor(opts = {}) {
    const o = this.o = { ...DEFAULTS3D, ...opts, matrixNoise: { ...DEFAULTS3D.matrixNoise, ...(opts.matrixNoise || {}) } };
    this.rng = mkRng(o.seed);
    this.rng2 = mkRng(o.seed * 7907 + 101); this.ar2 = {};   // the step 2 noise streams (see DEFAULTS3D)
    this.p = o.person || makePerson(o.seed, o.distanceCm);
    this.cmPerPx = (o.screenDiagIn * 2.54) / Math.hypot(o.screen.w, o.screen.h);
    this.fx = (o.camera.width / 2) / Math.tan(o.hfovDeg / 2 * D2R);   // focal length in pixels (square pixels)
    const canon = loadCanonical(), s = this.p.scale;
    const head = (i) => [s * (canon[i][0] - PIVOT[0]), s * (canon[i][1] - PIVOT[1]), s * (canon[i][2] - PIVOT[2])];
    this.pivotH = [-s * PIVOT[0], -s * PIVOT[1], -s * PIVOT[2]];      // canonical origin, in the head frame
    this.eyes = EYES.map((e) => {
      const c1 = head(e.c1), c2 = head(e.c2), up = head(e.up), lo = head(e.lo);
      // eyeball centre: behind the middle of the eye opening, so that looking straight ahead puts the iris between the lids
      const centre = [(c1[0] + c2[0] + up[0] + lo[0]) / 4, (up[1] + lo[1]) / 2, (up[2] + lo[2]) / 2 - o.eyeRadiusCm - this.p.eyeDepth];
      return { ...e, idx: { c1: e.c1, c2: e.c2, up: e.up, lo: e.lo }, c1, c2, up, lo, centre };
    });
    this.rigid = [...new Set([...ANCHORS, ...o.extraLandmarks])].map((i) => ({ i, h: head(i) }));
    // One landmark array, reused: extractFeatures only reads it. Unprojected vertices share one point.
    const filler = { x: 0.5, y: 0.5, z: 0 };
    this.lm = Array.from({ length: 478 }, () => filler);
    for (const i of [...this.rigid.map((q) => q.i), ...EYES.flatMap((e) => [e.c1, e.c2, e.up, e.lo, e.iris, e.iris + 1, e.iris + 2, e.iris + 3, e.iris + 4])]) this.lm[i] = { x: 0, y: 0, z: 0 };
    this.shift = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
    this.step = [0, 0, 0];
    this.ar = {}; this.lastT = null; this.t = 0;
    this.look = { gx: NaN, gy: NaN, dx: 0, dy: 0 };
    const exp = (mean) => -Math.log(1 - this.rng.u()) * mean;
    this.nextBlink = o.blinkEveryMs > 0 ? exp(o.blinkEveryMs) : Infinity; this.blink = null;
    this.nextLost = o.faceLostEveryMs > 0 ? exp(o.faceLostEveryMs) : Infinity; this.lostEnd = -1;
    this.nextStep = o.stepEveryMs > 0 ? exp(o.stepEveryMs) : Infinity;
    this.last = null;   // what the last frame was made of, for tests
  }

  /** Posture change against the calibration posture: cm (x: towards the camera's right, y: down, z: away from the screen) and radians. */
  setShift(s) { this.shift = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, ...s }; }

  /** Advance the clock by one camera frame and return the new time. */
  tick() {
    const period = 1000 / this.o.fps;
    this.t += Math.max(8, period + this.rng.g() * 2);
    if (this.rng.u() < this.o.drop) this.t += period;
    return this.t;
  }

  /** Stationary AR(1) / Ornstein-Uhlenbeck noise that keeps its statistics at any frame interval. */
  _ar(key, sd, dt, tau) {
    const prev = this.ar[key], g = this.rng.g();
    const phi = Math.exp(-dt / tau);
    const v = prev === undefined ? g : phi * prev + Math.sqrt(1 - phi * phi) * g;   // unit variance
    this.ar[key] = v;
    return v * sd;
  }

  /** _ar on the second random stream. */
  _ar2(key, sd, dt, tau) {
    const prev = this.ar2[key], g = this.rng2.g(), phi = Math.exp(-dt / tau);
    const v = prev === undefined ? g : phi * prev + Math.sqrt(1 - phi * phi) * g;
    this.ar2[key] = v;
    return v * sd;
  }

  /** Screen point (viewport CSS px) -> camera frame, cm. */
  screenPoint(gx, gy) {
    const o = this.o;
    return [-(gx - o.viewport.w / 2) * this.cmPerPx, -(o.bezelCm + (o.chromePx + gy) * this.cmPerPx), 0];
  }

  /** Camera frame, cm -> image pixels. */
  project(p) { const k = this.fx / -p[2]; return [this.o.camera.width / 2 + k * p[0], this.o.camera.height / 2 - k * p[1]]; }

  /**
   * One camera frame while the person looks at viewport point (gx, gy).
   * @returns {{face:boolean, blink:boolean, f?:number[], head?:{cx,cy,s}, fps:number}}
   */
  frame(t, gx, gy) {
    const o = this.o, r = this.rng, P = this.p, W = o.camera.width, H = o.camera.height;
    const dt = this.lastT === null ? 1000 / o.fps : Math.max(1, t - this.lastT); this.lastT = t;
    const L = o.noisePx, k = L / 0.5, tauN = o.noiseTauMs, tauW = o.headWanderTauMs;

    // ---- every random stream advances on every frame, so a seed is the same person at every noise level
    const wx = this._ar('wx', o.headWanderCm, dt, tauW), wy = this._ar('wy', o.headWanderCm, dt, tauW), wz = this._ar('wz', o.headWanderCm, dt, tauW);
    const wyaw = this._ar('wyaw', o.headWanderDeg * D2R, dt, tauW), wpit = this._ar('wpit', o.headWanderDeg * D2R, dt, tauW), wrol = this._ar('wrol', 0.5 * o.headWanderDeg * D2R, dt, tauW);
    if (t >= this.nextStep) { for (let a = 0; a < 3; a++) this.step[a] += o.stepCm * r.g() / Math.sqrt(3); this.nextStep = t - Math.log(1 - r.u()) * o.stepEveryMs; }
    if (t >= this.nextBlink) { this.blink = { t0: t, close: r.U(60, 90), hold: r.U(40, 110), open: r.U(90, 140) }; this.nextBlink = t + 500 - Math.log(1 - r.u()) * o.blinkEveryMs; }
    if (t >= this.nextLost) { this.lostEnd = t + r.U(200, 700); this.nextLost = t + 1000 - Math.log(1 - r.u()) * o.faceLostEveryMs; }
    if (gx !== this.look.gx || gy !== this.look.gy) {
      const sdPx = Math.tan(o.lookErrDeg * D2R) * o.distanceCm / this.cmPerPx;
      this.look = { gx, gy, dx: sdPx * r.g(), dy: sdPx * r.g() };
    }
    const common = [this._ar('icx', 1, dt, tauN), this._ar('icy', 1, dt, tauN)];
    const noise = {};
    for (const e of this.eyes) {
      const q = Math.sqrt(o.eyeNoiseCorr), q1 = Math.sqrt(1 - o.eyeNoiseCorr);
      noise[e.name] = {
        iris: [L * (q * common[0] + q1 * this._ar('ix' + e.name, 1, dt, tauN)), L * (q * common[1] + q1 * this._ar('iy' + e.name, 1, dt, tauN))],
        c1: [this._ar('c1x' + e.name, L * o.cornerNoiseK, dt, tauN), this._ar('c1y' + e.name, L * o.cornerNoiseK, dt, tauN)],
        c2: [this._ar('c2x' + e.name, L * o.cornerNoiseK, dt, tauN), this._ar('c2y' + e.name, L * o.cornerNoiseK, dt, tauN)],
        up: [this._ar('ux' + e.name, L * o.lidNoiseK, dt, tauN), this._ar('uy' + e.name, L * o.lidNoiseK, dt, tauN)],
        lo: [this._ar('lx' + e.name, L * o.lidNoiseK, dt, tauN), this._ar('ly' + e.name, L * o.lidNoiseK, dt, tauN)],
        blend: [0, 1, 2, 3, 4].map((j) => this._ar('b' + j + e.name, o.blendNoise * k, dt, tauN)),
      };
    }
    const mN = o.matrixNoise;
    const mn = { yaw: this._ar('myaw', mN.rotDeg * D2R * k, dt, tauN), pitch: this._ar('mpit', mN.rotDeg * D2R * k, dt, tauN), roll: this._ar('mrol', 0.7 * mN.rotDeg * D2R * k, dt, tauN), x: this._ar('mtx', mN.xyCm * k, dt, tauN), y: this._ar('mty', mN.xyCm * k, dt, tauN), z: this._ar('mtz', mN.zCm * k, dt, tauN) };
    if (t < this.lostEnd) return { face: false, blink: false, fps: o.fps };

    // ---- blink: 0 = open, 1 = shut
    let shut = 0;
    if (this.blink) {
      const b = this.blink, a = t - b.t0;
      if (a < b.close) shut = a / b.close; else if (a < b.close + b.hold) shut = 1; else if (a < b.close + b.hold + b.open) shut = 1 - (a - b.close - b.hold) / b.open; else this.blink = null;
    }

    // ---- head pose
    const pos = [P.pos[0] + this.shift.x + this.step[0] + wx, P.pos[1] - this.shift.y + this.step[1] + wy, P.pos[2] - this.shift.z + this.step[2] + wz];
    const T = this.screenPoint(gx + this.look.dx, gy + this.look.dy);
    const toT = [T[0] - pos[0], T[1] - pos[1], T[2] - pos[2]];
    const yaw = P.yaw + this.shift.yaw + wyaw + o.headFollow * Math.atan2(toT[0], toT[2]);
    const pitch = P.pitch + this.shift.pitch + wpit + o.headFollow * Math.atan2(-toT[1], toT[2]);
    const roll = P.roll + this.shift.roll + wrol;
    const R = rot(yaw, pitch, roll);
    const cam = (h) => { const v = mul(R, h); return [v[0] + pos[0], v[1] + pos[1], v[2] + pos[2]]; };
    const put = (i, px, depth) => { const q = this.lm[i]; q.x = px[0] / W; q.y = px[1] / H; q.z = depth; };
    for (const q of this.rigid) {
      const c = cam(q.h), px = this.project(c), a = L * o.anchorNoiseK;
      put(q.i, [px[0] + this._ar2('ax' + q.i, a, dt, tauN), px[1] + this._ar2('ay' + q.i, a, dt, tauN)], (c[2] - pos[2]) / W);
    }

    // ---- eyes
    const blend = [], truth = { eyes: {} };
    let az = 0, el = 0;
    for (const e of this.eyes) {
      const N = noise[e.name], Ec = cam(e.centre);
      const d = [T[0] - Ec[0], T[1] - Ec[1], T[2] - Ec[2]], dn = Math.hypot(d[0], d[1], d[2]);
      const dh = mulT(R, [d[0] / dn, d[1] / dn, d[2] / dn]);                 // visual axis in the head frame
      const azO = Math.atan2(dh[0], dh[2]) + e.side * P.kappaH, elO = Math.asin(clamp(dh[1], -1, 1)) - P.kappaV;   // optical axis
      const oh = [Math.cos(elO) * Math.sin(azO), Math.sin(elO), Math.cos(elO) * Math.cos(azO)];
      const irisH = [e.centre[0] + o.eyeRadiusCm * oh[0], e.centre[1] + o.eyeRadiusCm * oh[1], e.centre[2] + o.eyeRadiusCm * oh[2]];
      // lids follow the eye up and down; a blink brings the upper lid to the lower one
      const lift = o.eyeRadiusCm * Math.sin(elO);
      const loY = e.lo[1] + P.lidLo * lift;
      let upY = e.up[1] + P.lidUp * lift;
      upY -= shut * Math.max(0, upY - loY - 0.03);
      const upH = [e.up[0], upY, e.up[2]], loH = [e.lo[0], loY, e.lo[2]];
      const add = (px, n, m = 1) => [px[0] + m * n[0], px[1] + m * n[1]];
      const irisPx = add(this.project(cam(irisH)), N.iris, 1 + 3 * shut);     // a closing lid makes the iris estimate worse
      put(e.idx.c1, add(this.project(cam(e.c1)), N.c1), 0); put(e.idx.c2, add(this.project(cam(e.c2)), N.c2), 0);
      put(e.idx.up, add(this.project(cam(upH)), N.up), 0); put(e.idx.lo, add(this.project(cam(loH)), N.lo), 0);
      put(e.iris, irisPx, 0);
      // iris ring: right, top, left, bottom of the iris disc, seen from the camera
      const rt = [Math.cos(azO), 0, -Math.sin(azO)], upv = [oh[1] * rt[2] - oh[2] * rt[1], oh[2] * rt[0] - oh[0] * rt[2], oh[0] * rt[1] - oh[1] * rt[0]];
      [[1, rt, 1], [2, upv, 1], [3, rt, -1], [4, upv, -1]].forEach(([j, ax, sg]) => {
        const h = [irisH[0] + sg * o.irisRadiusCm * ax[0], irisH[1] + sg * o.irisRadiusCm * ax[1], irisH[2] + sg * o.irisRadiusCm * ax[2]];
        const own = Math.sqrt(o.irisRingIndep), shared = Math.sqrt(1 - o.irisRingIndep);
        const nz = [shared * N.iris[0] + own * this._ar2('rx' + j + e.name, L, dt, tauN), shared * N.iris[1] + own * this._ar2('ry' + j + e.name, L, dt, tauN)];
        put(e.iris + j, add(this.project(cam(h)), nz, 1 + 3 * shut), 0);
      });
      // blendshapes, as MediaPipe names them: Left / Right are the user's own
      const sideName = e.side > 0 ? 'Left' : 'Right', c01 = (v) => clamp(v, 0, 1), out = e.side * azO;   // out > 0: away from the nose
      const down = clamp(-elO / 0.5, 0, 1);
      blend.push(
        { categoryName: 'eyeLookDown' + sideName, score: c01(0.05 + Math.max(0, -elO) / 0.5 + N.blend[0]) },
        { categoryName: 'eyeLookUp' + sideName, score: c01(0.05 + Math.max(0, elO) / 0.4 + N.blend[1]) },
        { categoryName: 'eyeLookIn' + sideName, score: c01(0.05 + Math.max(0, -out) / 0.6 + N.blend[2]) },
        { categoryName: 'eyeLookOut' + sideName, score: c01(0.05 + Math.max(0, out) / 0.6 + N.blend[3]) },
        // looking down lowers the lid, which MediaPipe partly reads as a blink
        { categoryName: 'eyeBlink' + sideName, score: c01(0.08 + o.blinkDownK * down + 0.85 * shut + N.blend[4]) },
      );
      truth.eyes[e.name] = { az: azO, el: elO, irisPx };
      az += azO / 2; el += elO / 2;
    }

    // ---- face matrix as MediaPipe reports it: column-major, cm, the canonical-size face it assumes
    const Rm = rot(yaw + mn.yaw, pitch + mn.pitch, roll + mn.roll);
    const org = cam(this.pivotH), s = P.scale;
    const M = [Rm[0][0], Rm[1][0], Rm[2][0], 0, Rm[0][1], Rm[1][1], Rm[2][1], 0, Rm[0][2], Rm[1][2], Rm[2][2], 0, org[0] / s + mn.x, org[1] / s + mn.y, (org[2] / s + mn.z) * o.matrixDepthK, 1];
    if (o.matrixTranspose) { for (const [a, b] of [[1, 4], [2, 8], [6, 9]]) { const v = M[a]; M[a] = M[b]; M[b] = v; } }

    const out = C.extractFeatures(this.lm, blend, M, W, H);
    this.last = { t, pos, yaw, pitch, roll, shut, az, el, target: T, eyes: truth.eyes, matrix: M, blend };
    return { face: true, blink: out.blink, lids: out.lids, f: out.f, head: out.head, fps: o.fps };
  }
}
