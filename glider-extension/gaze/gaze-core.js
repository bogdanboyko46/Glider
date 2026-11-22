/*
 * gaze-core.js — pure math for webcam gaze tracking (no DOM, no Chrome APIs).
 * Loaded as a classic script in both the camera iframe and the content script,
 * and require()-able from Node for tests.
 *
 *   extractFeatures  MediaPipe face landmarks -> feature vector (63 numbers; 0-43 as always, 44-62 listed at F)
 *   poseFromMatrix   MediaPipe face matrix -> head yaw, pitch, roll and position
 *   Ridge            calibrated regression: features -> screen (x, y); the gaze model of every kind
 *                    (kind 'A': the 25-input ridge; 'B', 'C', 'E': head-frame models, see "head-frame models")
 *   fitCalibration   calibration dots and their camera frames -> model (chosen by a shoot-out), accuracy, training set
 *   CalibrationRun   the calibration procedure as a clock-driven state machine (which dot, when to sample, what to re-show)
 *   reviewDots       which dots of a first round deserve a second showing
 *   accuracyGrade    accuracy -> what the "Calibration done" card may claim
 *   refitModel       the same kind of model again on more rows (click refinement)
 *   trackingParams   accuracy -> the noise figures the tracker runs with
 *   headMoved        has the head left the place it was calibrated in? (HEAD_GATE holds the limits)
 *   OneEuro          jitter filter for the on-screen gaze dot
 *   FixationDetector online dispersion-based fixation detection
 *   LineHMM          "line locking": decodes which text line is being read
 *   mergeLineRects   Range.getClientRects() -> one rect per visual line
 *   summarizeBaseline  one read of the baseline passage -> reading pace + tau
 *   tauFromCv        the reader's own variability -> personal struggle threshold
 *   struggleDecision observed vs. baseline-expected times + tau -> struggling or not
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- features
  // MediaPipe Face Landmarker indices (478-point mesh with irises).
  const EYE_A = { c1: 33, c2: 133, up: 159, lo: 145 };   // corners run image-left -> image-right
  const EYE_B = { c1: 362, c2: 263, up: 386, lo: 374 };
  const IRIS_1 = 468, IRIS_2 = 473;
  const BLEND_KEYS = [
    'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookUpLeft', 'eyeLookUpRight',
    'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
  ];

  function pt(lm, i, vw, vh) { return [lm[i].x * vw, lm[i].y * vh]; }
  function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  function eyeFeat(lm, eye, iris, vw, vh) {
    const c1 = pt(lm, eye.c1, vw, vh), c2 = pt(lm, eye.c2, vw, vh);
    const up = pt(lm, eye.up, vw, vh), lo = pt(lm, eye.lo, vw, vh);
    const w = dist(c1, c2) || 1e-6;
    const ux = [(c2[0] - c1[0]) / w, (c2[1] - c1[1]) / w];   // along the eye
    const px = [-ux[1], ux[0]];                               // perpendicular (vertical-ish)
    const m = mid(c1, c2), lm2 = mid(up, lo);
    const rx = iris[0] - m[0], ry = iris[1] - m[1];
    const lx = iris[0] - lm2[0], ly = iris[1] - lm2[1];
    return {
      u: (rx * ux[0] + ry * ux[1]) / w,      // horizontal iris position in the eye
      v: (rx * px[0] + ry * px[1]) / w,      // vertical iris position vs. corners
      vl: (lx * px[0] + ly * px[1]) / w,     // vertical iris position vs. lids
      open: dist(up, lo) / w,                // lid opening (lids follow vertical gaze)
      center: m,
    };
  }

  // ------------------------------------------------------ head pose, head frame
  // Resting positions (cm) of the landmarks used below, in the head's own frame: +x to the person's
  // left (the camera's right), +y up, +z out of the face. Copied from MediaPipe's canonical face
  // model, mediapipe/modules/face_geometry/data/canonical_face_model.obj, Apache License 2.0,
  // Copyright The MediaPipe Authors:
  // https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model.obj
  const CANON = {
    33: [-4.445859, 2.663991, 3.173422], 133: [-1.856432, 2.585245, 3.757904], 159: [-3.177186, 2.964136, 3.876973], 145: [-3.177186, 2.294265, 3.775704],
    362: [1.856432, 2.585245, 3.757904], 263: [4.445859, 2.663991, 3.173422], 386: [3.177186, 2.964136, 3.876973], 374: [3.177186, 2.294265, 3.775704],
    168: [0, 3.271027, 5.236015],
  };
  const NOSE_BRIDGE = 168;
  const IRIS_Z = (CANON[159][2] + CANON[145][2]) / 2;      // the iris sits about level with the lids
  const EYE_W = Math.hypot(CANON[133][0] - CANON[33][0], CANON[133][1] - CANON[33][1], CANON[133][2] - CANON[33][2]);   // corner to corner
  // Assumptions about the eye, not measurements of this reader's:
  const EYE_R = 1.05;                                      // cm from the eye's centre of rotation to the iris centre
  const EYE_MID = [0, (CANON[159][1] + CANON[145][1]) / 2, IRIS_Z - EYE_R];   // midway between the two centres of rotation

  // The feature vector: 0-43 as they have always been, then (appended in step 2):
  const F = {
    // 44-51 are read by no model: on the synthetic camera they did not improve anything (tests/bench/RESULTS.md).
    // They stay in the vector so that a recording from a real camera can settle the question.
    IRIS5: 44,     // 44-47  A.u, A.v, B.u, B.v again, from the mean of the five iris points instead of the centre point
    RIGID: 48,     // 48-51  the same iris points against rigid points (inner eye corners and nose bridge): A.u, A.v, B.u, B.v
    POSE_OK: 52,   // 1 when the face matrix was a usable rigid transform, else 0 (and 53-58 are 0)
    POSE: 53,      // 53-55  head yaw, pitch, roll in units of 0.1 rad; 56-58  head x, y, z in units of 3 cm
    HEAD_IRIS: 59, // 59-62  A.u, A.v, B.u, B.v in the head's own frame (the head rotation taken out)
  };
  const FEATURE_COUNT = 63, BASE_FEATURE_COUNT = 44;
  const ANGLE_UNIT = 0.1, LENGTH_UNIT = 3;

  /** R = Ry(yaw) Rx(pitch) Rz(roll), rows; maps the head frame to the camera frame. */
  function rotation(yaw, pitch, roll) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    return [
      [cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp],
      [cp * sr, cp * cr, -sp],
      [-sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp],
    ];
  }

  /**
   * Head pose from MediaPipe's face matrix (16 numbers, column-major: the canonical face in the
   * camera's frame, cm, camera at the origin looking along -z, +x to its right, +y up).
   * yaw: the face turns towards the camera's right; pitch: it tips down; roll: in the image plane.
   * @returns {{ok:boolean, yaw, pitch, roll, tx, ty, tz, R}}  angles in rad, translation in cm; all 0 when not ok
   */
  function poseFromMatrix(M) {
    const bad = { ok: false, yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: 0, R: null };
    if (!M || M.length !== 16) return bad;
    for (let i = 0; i < 16; i++) if (!Number.isFinite(M[i])) return bad;
    const n0 = Math.hypot(M[0], M[1], M[2]), n1 = Math.hypot(M[4], M[5], M[6]), n2 = Math.hypot(M[8], M[9], M[10]);
    if (!(n0 > 0.5 && n0 < 2 && n1 > 0.5 && n1 < 2 && n2 > 0.5 && n2 < 2)) return bad;      // a rotation, perhaps with a scale
    if (Math.abs(M[15] - 1) > 0.05 || Math.abs(M[3]) + Math.abs(M[7]) + Math.abs(M[11]) > 0.05) return bad;
    if (!(M[14] < -5 && M[14] > -500)) return bad;                                             // a face in front of the camera
    const R = [[M[0] / n0, M[4] / n1, M[8] / n2], [M[1] / n0, M[5] / n1, M[9] / n2], [M[2] / n0, M[6] / n1, M[10] / n2]];
    const dot = (a, b) => R[0][a] * R[0][b] + R[1][a] * R[1][b] + R[2][a] * R[2][b];
    if (Math.abs(dot(0, 1)) > 0.1 || Math.abs(dot(0, 2)) > 0.1 || Math.abs(dot(1, 2)) > 0.1) return bad;
    const det = R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
    if (!(det > 0.5) || !(R[2][2] > 0.3)) return bad;                                          // not mirrored, and facing the camera
    return {
      ok: true, R, tx: M[12], ty: M[13], tz: M[14],
      yaw: Math.atan2(R[0][2], R[2][2]), pitch: -Math.asin(Math.max(-1, Math.min(1, R[1][2]))), roll: Math.atan2(R[1][0], R[1][1]),
    };
  }

  /**
   * Where the iris sits in the head's own frame, from the image and the head rotation. The eye
   * corners rest at known places in the head (CANON) and the iris at a known depth, so their
   * picture can be turned back to "head facing the camera" before the offset is measured: a head
   * turn then no longer slides the iris against the corners (parallax).
   * @returns {{u, v}} like eyeFeat's u and v (v grows downwards), or null when the rotation is too oblique
   */
  function headFrameIris(iris, c1, c2, eye, pose) {
    const h1 = CANON[eye.c1], h2 = CANON[eye.c2], R0 = pose.R;
    // A face off to one side is seen from that side, as if it had turned the other way: the
    // rotation that matters is the one against the line of sight to this eye, not against the
    // camera's axis. V turns the camera's axis onto that line; the eye is seen with V' R.
    const hm = [(h1[0] + h2[0]) / 2, (h1[1] + h2[1]) / 2, (h1[2] + h2[2]) / 2];
    const lx = -(R0[0][0] * hm[0] + R0[0][1] * hm[1] + R0[0][2] * hm[2] + pose.tx), ly = -(R0[1][0] * hm[0] + R0[1][1] * hm[1] + R0[1][2] * hm[2] + pose.ty), lz = -(R0[2][0] * hm[0] + R0[2][1] * hm[1] + R0[2][2] * hm[2] + pose.tz);
    const ln = Math.hypot(lx, ly, lz) || 1;
    const V = rotation(Math.atan2(lx, lz), -Math.asin(Math.max(-1, Math.min(1, ly / ln))), 0);
    const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => V[0][i] * R0[0][j] + V[1][i] * R0[1][j] + V[2][i] * R0[2][j]));
    const q0 = R[0], q1 = [-R[1][0], -R[1][1], -R[1][2]];       // image x and y (y runs down) of the head's axes
    const dh = [h2[0] - h1[0], h2[1] - h1[1], h2[2] - h1[2]];
    const proj = Math.hypot(q0[0] * dh[0] + q0[1] * dh[1] + q0[2] * dh[2], q1[0] * dh[0] + q1[1] * dh[1] + q1[2] * dh[2]);
    const det = q0[0] * q1[1] - q0[1] * q1[0];
    if (!(proj > 0.5) || Math.abs(det) < 0.3) return null;
    const s = (dist(c1, c2) || 1e-6) / proj;                    // image px per cm of this face
    const dz = IRIS_Z - (h1[2] + h2[2]) / 2, m = mid(c1, c2);
    const bx = (iris[0] - m[0]) / s - q0[2] * dz, by = (iris[1] - m[1]) / s - q1[2] * dz;
    const a = (bx * q1[1] - q0[1] * by) / det, b = (q0[0] * by - bx * q1[0]) / det;   // cm in the head frame, from the corners' midpoint
    return { u: a / EYE_W, v: -b / EYE_W };
  }

  /**
   * @param lm          landmarks[0] from FaceLandmarker (478 {x,y,z}, normalized)
   * @param blend       faceBlendshapes[0].categories (may be undefined)
   * @param matrixData  facialTransformationMatrixes[0].data (16 numbers, may be undefined)
   * @param vw, vh      video size in px (to undo aspect-ratio squash)
   * @returns {{f:number[], head:{cx:number,cy:number,s:number}, blink:boolean, lids:{l:number,r:number,open:number}}}
   *          f has FEATURE_COUNT numbers: 0-43 as before step 2, then the additions listed at F.
   *          blink is the fixed rule (either eye's blink score over 0.45, or the lids nearly shut);
   *          lids are the numbers behind it (the two blink scores and the mean lid opening), for BlinkDetector.
   */
  function extractFeatures(lm, blend, matrixData, vw, vh) {
    const i1 = pt(lm, IRIS_1, vw, vh), i2 = pt(lm, IRIS_2, vw, vh);
    const mA = mid(pt(lm, EYE_A.c1, vw, vh), pt(lm, EYE_A.c2, vw, vh));
    const mB = mid(pt(lm, EYE_B.c1, vw, vh), pt(lm, EYE_B.c2, vw, vh));
    // Pair irises to eyes by proximity (robust to index-convention differences).
    const straight = dist(i1, mA) + dist(i2, mB) <= dist(i1, mB) + dist(i2, mA);
    const A = eyeFeat(lm, EYE_A, straight ? i1 : i2, vw, vh);
    const B = eyeFeat(lm, EYE_B, straight ? i2 : i1, vw, vh);
    // The iris as the mean of its five points (centre and four on the rim), when the mesh has them.
    const iris5 = (c) => {
      if (!lm[c + 4]) return pt(lm, c, vw, vh);
      let x = 0, y = 0;
      for (let k = 0; k < 5; k++) { x += lm[c + k].x; y += lm[c + k].y; }
      return [x * vw / 5, y * vh / 5];
    };
    const iA = iris5(straight ? IRIS_1 : IRIS_2), iB = iris5(straight ? IRIS_2 : IRIS_1);

    const bs = {};
    if (blend) for (const c of blend) bs[c.categoryName] = c.score;
    const blink = (bs.eyeBlinkLeft || 0) > 0.45 || (bs.eyeBlinkRight || 0) > 0.45 ||
      (A.open + B.open) / 2 < 0.12;

    const um = (A.u + B.u) / 2, vm = (A.v + B.v) / 2, vlm = (A.vl + B.vl) / 2, om = (A.open + B.open) / 2;
    const headC = mid(A.center, B.center);
    const head = { cx: headC[0] / vw, cy: headC[1] / vh, s: dist(A.center, B.center) / vw };

    const f = [
      A.u, A.v, A.vl, A.open, B.u, B.v, B.vl, B.open,
      um, vm, vlm, om, um * um, vm * vm, um * vm, vlm * vlm, um * vlm,
    ];
    for (const k of BLEND_KEYS) f.push(bs[k] || 0);
    const M = matrixData && matrixData.length === 16 ? matrixData : new Array(16).fill(0);
    for (let i = 0; i < 16; i++) f.push(M[i]);
    f.push(head.cx, head.cy, head.s);

    // ---- 44 onwards (step 2). Nothing above this line changed.
    const A5 = eyeFeat(lm, EYE_A, iA, vw, vh), B5 = eyeFeat(lm, EYE_B, iB, vw, vh);
    f.push(A5.u, A5.v, B5.u, B5.v);
    // Against points that do not move with the lids: the two inner eye corners and the nose bridge.
    const k1 = pt(lm, EYE_A.c2, vw, vh), k2 = pt(lm, EYE_B.c1, vw, vh), nb = pt(lm, NOSE_BRIDGE, vw, vh);
    const kd = dist(k1, k2) || 1e-6, kx = [(k2[0] - k1[0]) / kd, (k2[1] - k1[1]) / kd], ky = [-kx[1], kx[0]];
    const ko = [(k1[0] + k2[0] + nb[0]) / 3, (k1[1] + k2[1] + nb[1]) / 3];
    for (const i of [iA, iB]) { const dx = i[0] - ko[0], dy = i[1] - ko[1]; f.push((dx * kx[0] + dy * kx[1]) / kd, (dx * ky[0] + dy * ky[1]) / kd); }
    // Head pose in fixed physical units, so that a model can weigh it without knowing how much
    // (or how little) the head happened to move during calibration.
    const pose = poseFromMatrix(matrixData);
    f.push(pose.ok ? 1 : 0, pose.yaw / ANGLE_UNIT, pose.pitch / ANGLE_UNIT, pose.roll / ANGLE_UNIT, pose.tx / LENGTH_UNIT, pose.ty / LENGTH_UNIT, pose.tz / LENGTH_UNIT);
    // The iris in the head's frame; without a pose, the plain corner-relative offsets.
    // (From the iris centre point, like features 0-7: the mean of five points showed no gain.)
    const hA = pose.ok && headFrameIris(straight ? i1 : i2, pt(lm, EYE_A.c1, vw, vh), pt(lm, EYE_A.c2, vw, vh), EYE_A, pose);
    const hB = pose.ok && headFrameIris(straight ? i2 : i1, pt(lm, EYE_B.c1, vw, vh), pt(lm, EYE_B.c2, vw, vh), EYE_B, pose);
    if (hA && hB) f.push(hA.u, hA.v, hB.u, hB.v); else f.push(A.u, A.v, B.u, B.v);
    return { f, head, blink, lids: { l: bs.eyeBlinkLeft || 0, r: bs.eyeBlinkRight || 0, open: om } };
  }

  // ------------------------------------------------------------------- blinks
  /**
   * Which frames to leave out because the eyes are closing, closed or opening.
   *
   * The fixed rule (extractFeatures: either eye's blink score over 0.45) also fires when somebody
   * simply looks down: the lids come down with the eyes and the blink score rises with them, so the
   * bottom lines of a screen can lose every frame. This detector measures against where the lids
   * have been lately (the median of the last `memory` frames, about 1.5 s: a blink is over in a
   * third of that, a look down is not) and wants both eyes:
   *   - both blink scores at least `rise` above that level (and over `score`), or
   *   - the lid opening under `openShare` of its recent level, or
   *   - the lids closing fast (`closing`, in eye widths per second),
   * and it leaves out `pad` more frames after a blink. Eyes held shut are always a blink (`shut`, `slit`).
   * push() is for a live stream (it cannot take back the frames just before a blink); markBlinks()
   * goes over a recorded stream and pads both sides.
   */
  class BlinkDetector {
    constructor(o = {}) {
      this.o = { score: 0.45, rise: 0.25, shut: 0.85, openShare: 0.5, slit: 0.04, closing: 2.5, pad: 2, memory: 45, ...o };
      this.s = []; this.op = []; this.prev = null; this.hold = 0;
    }
    reset() { this.s = []; this.op = []; this.prev = null; this.hold = 0; }
    /** Is the eye shut or shutting in this frame, before any padding? lids: {l, r, open}; t in ms. */
    raw(lids, t) {
      const o = this.o, both = Math.min(lids.l, lids.r), med = (a) => { const b = a.slice().sort((p, q) => p - q); return b[b.length >> 1]; };
      const enough = this.s.length >= 8, baseS = enough ? med(this.s) : 0, baseO = enough ? med(this.op) : null;
      let blink = both > o.shut || lids.open < o.slit || both > Math.max(o.score, baseS + o.rise);
      if (!blink && baseO !== null && lids.open < o.openShare * baseO) blink = true;
      if (!blink && this.prev && t - this.prev.t > 0 && t - this.prev.t < 120 && (lids.open - this.prev.open) / ((t - this.prev.t) / 1000) < -o.closing) blink = true;
      this.s.push(Math.max(lids.l, lids.r)); this.op.push(lids.open);
      if (this.s.length > o.memory) { this.s.shift(); this.op.shift(); }
      this.prev = { t, open: lids.open };
      return blink;
    }
    /** Leave this frame out? (a blink, or one of the `pad` frames after it) */
    push(lids, t) {
      if (this.raw(lids, t)) { this.hold = this.o.pad; return true; }
      if (this.hold > 0) { this.hold--; return true; }
      return false;
    }
  }
  /**
   * The same over a recorded stream: [{t, face, blink, lids}] -> one boolean per frame, true = leave out.
   * `pad` frames before and after every blink go too. Frames without lids keep their own blink flag.
   */
  function markBlinks(frames, o = {}) {
    const det = new BlinkDetector(o), pad = det.o.pad;
    const raw = frames.map((fr) => (fr.face === false ? false : fr.lids ? det.raw(fr.lids, fr.t) : !!fr.blink));
    return raw.map((_, i) => { for (let k = Math.max(0, i - pad); k <= Math.min(raw.length - 1, i + pad); k++) if (raw[k]) return true; return false; });
  }

  // ------------------------------------------------------------------- ridge
  function solve(A, b) {
    // Gaussian elimination with partial pivoting. A: d×d (array of Float64Array), b: d. Mutates copies.
    const d = b.length;
    const M = A.map((r) => Float64Array.from(r));
    const y = Float64Array.from(b);
    for (let c = 0; c < d; c++) {
      let p = c;
      for (let r = c + 1; r < d; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (p !== c) { [M[p], M[c]] = [M[c], M[p]]; [y[p], y[c]] = [y[c], y[p]]; }
      const piv = M[c][c] || 1e-12;
      for (let r = c + 1; r < d; r++) {
        const k = M[r][c] / piv;
        if (k === 0) continue;
        for (let j = c; j < d; j++) M[r][j] -= k * M[c][j];
        y[r] -= k * y[c];
      }
    }
    const w = new Float64Array(d);
    for (let r = d - 1; r >= 0; r--) {
      let s = y[r];
      for (let j = r + 1; j < d; j++) s -= M[r][j] * w[j];
      w[r] = s / (M[r][r] || 1e-12);
    }
    return w;
  }

  // Penalty grids. v1 models (before the Gram matrix was divided by the frame count) used the first;
  // the second is for the normalised fit, where one value means the same at 300 frames and at 600.
  const LAMBDAS_V1 = [0.03, 0.1, 0.3, 1, 3, 10, 30, 100];
  const LAMBDAS = [1e-5, 3e-5, 1e-4, 3e-4, 1e-3, 3e-3, 0.01, 0.03, 0.1, 0.3, 1, 3];
  const MODEL_VERSION = 2;

  class Ridge {
    constructor() { this.ready = false; }

    /**
     * @param X       n × D features
     * @param Y       n × 2 targets (screen x, y)
     * @param groups  n group ids (calibration point) for leave-one-point-out CV; optional
     * @param lambdas candidate penalties (picked by CV when ≥4 groups); default: the grid that fits opts.norm
     * @param opts    {norm, perAxis, zClamp, sdFloor, fixed, fixedPenalty, drop, bounds, lambdaXY}; see Ridge.DEFAULTS
     */
    fit(X, Y, groups, lambdas, opts) {
      const o = Object.assign({}, Ridge.DEFAULTS, opts || {});
      if (!lambdas) lambdas = o.norm ? LAMBDAS : LAMBDAS_V1;
      const n = X.length, D = X[0].length;
      const mean = new Float64Array(D), sd = new Float64Array(D);
      for (const r of X) for (let j = 0; j < D; j++) mean[j] += r[j] / n;
      for (const r of X) for (let j = 0; j < D; j++) sd[j] += (r[j] - mean[j]) ** 2 / n;
      const fixedSet = o.fixed ? new Set(o.fixed) : null, dropSet = o.drop ? new Set(o.drop) : null;
      const keep = [];
      for (let j = 0; j < D; j++) {
        sd[j] = Math.sqrt(sd[j]);
        if (dropSet && dropSet.has(j)) continue;
        // Fixed-scale inputs (head pose, in physical units) are centred but never divided by how
        // much they happened to vary in this calibration.
        if (fixedSet && fixedSet.has(j)) { sd[j] = 1; keep.push(j); continue; }
        if (sd[j] > 1e-9) {
          // An input that hardly varied must not be blown up into a full-size one.
          if (o.sdFloor && sd[j] < o.sdFloor[j]) sd[j] = o.sdFloor[j];
          keep.push(j);
        }
      }
      const d = keep.length;
      const isFixed = keep.map((j) => !!(fixedSet && fixedSet.has(j)));
      const Z = X.map((r) => { const z = new Float64Array(d); for (let k = 0; k < d; k++) z[k] = (r[keep[k]] - mean[keep[k]]) / sd[keep[k]]; return z; });
      const yMean = [0, 0];
      for (const t of Y) { yMean[0] += t[0] / n; yMean[1] += t[1] / n; }

      // Per-group Gram matrices so CV folds are cheap: G_fold = G_all − G_group.
      const gid = groups || X.map((_, i) => i % 5);
      const ids = [...new Set(gid)];
      const zero = () => Array.from({ length: d }, () => new Float64Array(d));
      const G = new Map(), B = new Map(), members = new Map();
      for (const g of ids) { G.set(g, zero()); B.set(g, [new Float64Array(d), new Float64Array(d)]); members.set(g, []); }
      const Gall = zero(), Ball = [new Float64Array(d), new Float64Array(d)];
      for (let i = 0; i < n; i++) {
        const z = Z[i], g = G.get(gid[i]), b = B.get(gid[i]);
        members.get(gid[i]).push(i);
        const ty0 = Y[i][0] - yMean[0], ty1 = Y[i][1] - yMean[1];
        for (let a = 0; a < d; a++) {
          const za = z[a];
          b[0][a] += za * ty0; b[1][a] += za * ty1;
          for (let c = a; c < d; c++) g[a][c] += za * z[c];
        }
      }
      for (const g of ids) {
        const m = G.get(g);
        for (let a = 0; a < d; a++) for (let c = a; c < d; c++) { m[c][a] = m[a][c]; Gall[a][c] += m[a][c]; if (c !== a) Gall[c][a] += m[a][c]; }
        const b = B.get(g);
        for (let a = 0; a < d; a++) { Ball[0][a] += b[0][a]; Ball[1][a] += b[1][a]; }
      }
      // norm: the penalty is per frame (the Gram matrix divided by the frame count), so one value
      // means the same for 300 frames and for 600. Fixed-scale inputs carry at least fixedPenalty.
      const withPenalty = (Gm, lam, m) => Gm.map((r, i) => {
        const c = Float64Array.from(r), s = o.norm ? m : 1;
        c[i] += (isFixed[i] ? Math.max(lam, o.fixedPenalty) : lam) * s;
        return c;
      });
      const fitW = (Gm, Bm, lx, ly, m) => {
        const A = withPenalty(Gm, lx, m);
        return [solve(A, Bm[0]), lx === ly ? solve(A, Bm[1]) : solve(withPenalty(Gm, ly, m), Bm[1])];
      };
      const predZ = (z, wx, wy) => { let px = yMean[0], py = yMean[1]; for (let a = 0; a < d; a++) { px += z[a] * wx[a]; py += z[a] * wy[a]; } return [px, py]; };

      const mid = lambdas[Math.floor(lambdas.length / 2)];
      let lamX = mid, lamY = mid, cvErr = null, cv = null, cvDots = null;
      if (o.lambdaXY) { lamX = o.lambdaXY[0]; lamY = o.lambdaXY[1]; }
      else if (ids.length >= 4) {
        const folds = ids.map((g) => ({
          g, m: n - members.get(g).length,
          Gf: Gall.map((r, a) => r.map((v, c) => v - G.get(g)[a][c])),
          Bf: [0, 1].map((k) => Ball[k].map((v, a) => v - B.get(g)[k][a])),
        }));
        let bestErr = Infinity, bestX = Infinity, bestY = Infinity, joint = mid;
        for (const lam of lambdas) {
          let se = 0, sx = 0, sy = 0, cnt = 0;
          for (const f of folds) {
            const [wx, wy] = fitW(f.Gf, f.Bf, lam, lam, f.m);
            for (const i of members.get(f.g)) {
              const p = predZ(Z[i], wx, wy), ex = (p[0] - Y[i][0]) ** 2, ey = (p[1] - Y[i][1]) ** 2;
              se += ex + ey; sx += ex; sy += ey; cnt++;
            }
          }
          const err = Math.sqrt(se / cnt);
          if (err < bestErr) { bestErr = err; joint = lam; }
          if (sx < bestX) { bestX = sx; lamX = lam; }
          if (sy < bestY) { bestY = sy; lamY = lam; }
        }
        // One penalty for both axes (v1), or each axis its own: x and y have different signal and noise.
        if (o.perAxis) cvErr = Math.sqrt((bestX + bestY) / n);
        else { lamX = lamY = joint; cvErr = bestErr; }
        // The same held-out predictions, dot by dot: how far each unseen dot's mean lands from the dot
        // (bias) and how much its frames scatter. eff is the figure the calibration card uses.
        let bx = 0, by = 0, sdx = 0, sdy = 0, k = 0;
        cvDots = [];
        for (const f of folds) {
          const idx = members.get(f.g); if (!idx.length) continue;
          const [wx, wy] = fitW(f.Gf, f.Bf, lamX, lamY, f.m);
          const e = idx.map((i) => { const p = predZ(Z[i], wx, wy); return [p[0] - Y[i][0], p[1] - Y[i][1]]; });
          const mx = e.reduce((a, q) => a + q[0], 0) / e.length, my = e.reduce((a, q) => a + q[1], 0) / e.length;
          const s1 = Math.sqrt(e.reduce((a, q) => a + (q[0] - mx) ** 2, 0) / e.length), s2 = Math.sqrt(e.reduce((a, q) => a + (q[1] - my) ** 2, 0) / e.length);
          cvDots.push({ g: f.g, n: idx.length, biasX: mx, biasY: my, sdX: s1, sdY: s2 });   // this dot, predicted by a fit that never saw it
          if (idx.length < 5) continue;
          bx += mx * mx; by += my * my;
          sdx += s1; sdy += s2;
          k++;
        }
        if (k) {
          const biasX = Math.sqrt(bx / k), biasY = Math.sqrt(by / k), sdX = sdx / k, sdY = sdy / k;
          const effX = Math.sqrt(biasX ** 2 + sdX ** 2 / 2.5), effY = Math.sqrt(biasY ** 2 + sdY ** 2 / 2.5);
          cv = { biasX, biasY, sdX, sdY, effX, effY, eff: Math.hypot(effX, effY), dots: k };
        }
      }
      const [wx, wy] = fitW(Gall, Ball, lamX, lamY, n);
      Object.assign(this, {
        ready: true, v: MODEL_VERSION, kind: this.kind || 'A', keep, mean: Array.from(mean), sd: Array.from(sd), yMean, wx: Array.from(wx), wy: Array.from(wy),
        lambda: lamX, lambdaXY: [lamX, lamY], norm: !!o.norm, cvErr, cv, n, zc: o.zClamp || 0, bounds: o.bounds || null,
      });
      // Per-dot leave-one-dot-out errors [{g, n, biasX, biasY, sdX, sdY}]; not saved with the model.
      Object.defineProperty(this, 'cvDots', { value: cvDots, enumerable: false, configurable: true, writable: true });
      return this;
    }

    /** Raw camera features (or, for kind 'A', any vector at least as long as the model reads) -> screen [x, y]. */
    predict(f) {
      let x = f, off = null;
      if (this.kind && this.kind !== 'A') { x = mapFeatures(this.kind, f, this.geo); off = poseOffset(f, this.geo); }
      let px = this.yMean[0], py = this.yMean[1];
      const zc = this.zc || 0;
      for (let k = 0; k < this.keep.length; k++) {
        const j = this.keep[k];
        let z = (x[j] - this.mean[j]) / this.sd[j];
        // An input far outside anything seen in calibration says "this is not the calibrated
        // situation", not "the gaze is far away": it is held at the edge of what was seen.
        if (zc) z = z > zc ? zc : z < -zc ? -zc : z;
        px += z * this.wx[k]; py += z * this.wy[k];
      }
      if (off) { px += off[0]; py += off[1]; }
      const b = this.bounds;
      if (b) { px = px < b[0] ? b[0] : px > b[1] ? b[1] : px; py = py < b[2] ? b[2] : py > b[3] ? b[3] : py; }
      return [px, py];
    }

    /** How many numbers of the camera's feature vector this model needs. */
    get inputWidth() { return this.kind && this.kind !== 'A' ? FEATURE_COUNT : Math.max(...this.keep) + 1; }

    toJSON() {
      const { v, kind, keep, mean, sd, yMean, wx, wy, lambda, lambdaXY, norm, cvErr, cv, n, zc, bounds, geo } = this;
      const out = { v, kind, keep, mean, sd, yMean, wx, wy, lambda, lambdaXY, norm, cvErr, cv, n, zc, bounds };
      if (geo) out.geo = geo;
      return out;
    }
    /**
     * Loads models of this version and the ones saved before models had a version (v1: 25 inputs,
     * one penalty on the unnormalised Gram matrix, no clamps). Missing fields get the value that
     * reproduces the old predictions exactly.
     */
    static fromJSON(o) {
      const r = new Ridge();
      Object.assign(r, { v: 1, kind: 'A', norm: false, zc: 0, bounds: null, cv: null, cvErr: null }, o, { ready: true });
      if (!Array.isArray(r.lambdaXY)) r.lambdaXY = [r.lambda, r.lambda];
      if (r.kind !== 'A' && !(r.geo && KINDS[r.kind])) throw new Error('saved gaze model of an unknown kind: ' + r.kind);
      return r;
    }
  }
  // What a bare `new Ridge().fit(X, Y, G)` does. fitCalibration passes its own.
  Ridge.DEFAULTS = { norm: false, perAxis: false, zClamp: 0, sdFloor: null, fixed: null, fixedPenalty: 0.1, drop: null, bounds: null, lambdaXY: null };
  Ridge.LAMBDAS = LAMBDAS; Ridge.LAMBDAS_V1 = LAMBDAS_V1;

  // ------------------------------------------------- head-frame models (B, C, E)
  // Model A reads where the iris sits in the eye and nothing about the head, so any head movement
  // after calibration lands in the gaze estimate at full size. These models split the job in two:
  //   1. Geometry, not learned: the head pose and the eye direction give a gaze ray; where that ray
  //      meets the screen plane moves when the head moves. That movement, in cm, times the screen's
  //      px per cm (estimated from the calibration dots) is added to the prediction (poseOffset).
  //   2. A ridge regression on inputs measured in the head's own frame, for everything else. It
  //      also gets the six pose numbers, in fixed physical units and with a penalty of their own,
  //      so that a calibration in which the head really moved can correct the geometry.
  // What goes in besides the pose: B the head-frame iris offsets and the lid terms of both eyes;
  // C also their squares and products; E also the eight eye-look blendshapes (model A's inputs,
  // with the iris offsets taken in the head frame).
  const POSE_N = 6, POSE_FIXED = [0, 1, 2, 3, 4, 5];
  const KINDS = { B: { width: 14 }, C: { width: 19 }, E: { width: 27 }, D: { width: 25 } };
  const CANDIDATES = ['B', 'C', 'E'];
  // Model A's penalty is chosen among these alone. Left to pick from the whole grid, the leave-one-dot-out
  // score often took the weakest penalty (leaving out a corner dot rewards a fit that extrapolates), and
  // the map then bent between the dots: on four sessions of a real camera, dots the fit had not seen were
  // 133 px off across with the weakest penalty and about 100 px with these.
  const A_LAMBDAS = [3, 10];
  const DRIFT_KEEP = 1.02;           // model D is used unless it is more than this much worse than A on unseen dots
  const SHOOTOUT_MARGIN = 0.05;      // a new model must beat A's leave-one-dot-out error by this share
  // Penalty on the pose weights, per frame, in the pose units squared (0.1 rad, 3 cm, 5 % of the
  // distance). Read it as a threshold: the regression learns a pose effect only as far as the pose
  // varied more than about sqrt(0.1) = 0.3 units (2 degrees, 1 cm) in calibration, independently of
  // where the dot was. Below that, the head following the eyes would be mistaken for a pose effect.
  const POSE_PENALTY = 0.1;
  const DEPTH_UNIT = 0.05;
  const K_EYE = EYE_W / EYE_R;       // iris offset in eye widths -> sine of the eye's angle in the head
  const MAPPED_SD_FLOOR = (() => {
    const r = [1, 1, 1, 1, 1, 1, 0.15, 0.08, 0.15, 0.08, 0.08, 0.15, 0.08, 0.15, 0.01, 0.004, 0.006, 0.004, 0.006];
    for (let i = 0; i < 8; i++) r.push(0.3);
    return r.map((v) => 0.02 * v);
  })();

  const hasPose = (f) => f.length >= FEATURE_COUNT && f[F.POSE_OK] === 1;
  /** Sines of the gaze angle in the head frame, mean of both eyes: [to the head's +x, upwards]. */
  function eyeSines(f) {
    const c = (v) => (v > 0.9 ? 0.9 : v < -0.9 ? -0.9 : v), h = F.HEAD_IRIS;
    return [c(K_EYE * (f[h] + f[h + 2]) / 2), c(-K_EYE * (f[h + 1] + f[h + 3]) / 2)];
  }
  /** Where the gaze ray meets the plane of the camera (z = 0): [x, y] in cm in the camera's frame, or null. */
  function gazeHit(sx, sy, R, t) {
    const sz = Math.sqrt(Math.max(0.05, 1 - sx * sx - sy * sy)), c = EYE_MID;
    const dz = R[2][0] * sx + R[2][1] * sy + R[2][2] * sz;
    const ez = R[2][0] * c[0] + R[2][1] * c[1] + R[2][2] * c[2] + t[2];
    if (!(dz > 0.2) || !(ez < -5)) return null;
    const k = -ez / dz;
    return [
      R[0][0] * c[0] + R[0][1] * c[1] + R[0][2] * c[2] + t[0] + k * (R[0][0] * sx + R[0][1] * sy + R[0][2] * sz),
      R[1][0] * c[0] + R[1][1] * c[1] + R[1][2] * c[2] + t[1] + k * (R[1][0] * sx + R[1][1] * sy + R[1][2] * sz),
    ];
  }
  function framePose(f) {
    const q = F.POSE;
    return { yaw: f[q] * ANGLE_UNIT, pitch: f[q + 1] * ANGLE_UNIT, roll: f[q + 2] * ANGLE_UNIT, t: [f[q + 3] * LENGTH_UNIT, f[q + 4] * LENGTH_UNIT, f[q + 5] * LENGTH_UNIT] };
  }
  /** The gaze ray of this frame on the camera plane, cm (null without a usable pose). */
  function frameHit(f) {
    if (!hasPose(f)) return null;
    const P = framePose(f), e = eyeSines(f);
    return gazeHit(e[0], e[1], rotation(P.yaw, P.pitch, P.roll), P.t);
  }
  const R0 = new WeakMap();
  /**
   * How far the head's movement since calibration has carried the gaze point, in screen px:
   * the same eye direction in the head, cast from the pose now and from the calibration pose.
   */
  // ---- model D: model A with the head's drift taken out by fixed physical gains.
  // Model A's inputs, and on top of its answer the distance the head has carried the gaze point
  // since calibration: a head that slid sideways by 1 cm moves the gaze point 1 cm; a head that
  // turned by an angle moves it by the viewing distance times the tangent. Nothing is learned
  // (two recordings of a real camera: tests on the dumps), so a calibration with the head held
  // still cannot teach it nonsense. The head's place comes from the face in the picture (the
  // distance between the eyes is about IPD_CM), not from the face matrix, whose depth is unreliable.
  const IPD_CM = 6.3;
  function driftRaw(f, geo) {
    const q = F.POSE, s = f[43] || 1e-6;
    return [
      -f[41] / s * IPD_CM - geo.distCm * Math.tan(f[q] * ANGLE_UNIT),
      f[42] * geo.aspect / s * IPD_CM + geo.distCm * Math.tan(f[q + 1] * ANGLE_UNIT),
    ];
  }
  function driftOffset(f, geo) {
    if (!hasPose(f)) return null;
    const r = driftRaw(f, geo), lim = geo.limitCm * geo.pxPerCm;
    const c = (v) => (v > lim ? lim : v < -lim ? -lim : v);
    return [c((r[0] - geo.ref[0]) * geo.pxPerCm), (geo.gy === undefined ? 1 : geo.gy) * c((r[1] - geo.ref[1]) * geo.pxPerCm)];
  }
  /** @param drift {pxPerCm, distCm, aspect}: screen px per cm, viewing distance, camera picture height / width */
  function buildDriftGeo(rows, drift) {
    if (!drift || !(drift.pxPerCm > 0) || !(drift.distCm > 0)) return { fail: 'no screen size to scale the head drift with' };
    const geo = { drift: true, pxPerCm: drift.pxPerCm, distCm: drift.distCm, aspect: drift.aspect > 0 ? drift.aspect : 0.5625, limitCm: 12, width: drift.width || KINDS.D.width, gy: drift.gy === undefined ? 1 : drift.gy, ref: [0, 0] };
    const posed = rows.filter(hasPose);
    if (!rows.length || posed.length < 0.95 * rows.length) return { fail: 'the face matrix was missing or not a rigid transform' };
    for (const f of posed) { const r = driftRaw(f, geo); geo.ref[0] += r[0] / posed.length; geo.ref[1] += r[1] / posed.length; }
    return geo;
  }

  function poseOffset(f, geo) {
    if (geo.drift) return driftOffset(f, geo);
    if (!hasPose(f)) return null;
    let r0 = R0.get(geo);
    if (!r0) { r0 = rotation(geo.yaw, geo.pitch, geo.roll); R0.set(geo, r0); }
    const P = framePose(f), e = eyeSines(f);
    const now = gazeHit(e[0], e[1], rotation(P.yaw, P.pitch, P.roll), P.t), ref = gazeHit(e[0], e[1], r0, geo.t);
    if (!now || !ref) return null;
    const dx = now[0] - ref[0], dy = now[1] - ref[1], Q = geo.Q;
    return [Q[0][0] * dx + Q[0][1] * dy, Q[1][0] * dx + Q[1][1] * dy];
  }
  /** The regression inputs of a head-frame model: 6 pose numbers, then the gaze inputs of that kind. */
  function mapFeatures(kind, f, geo) {
    if (kind === 'D') return f.slice(0, (geo && geo.width) || KINDS.D.width);
    const w = KINDS[kind].width, x = new Array(w).fill(0), h = F.HEAD_IRIS;
    if (hasPose(f)) {
      const P = framePose(f);
      x[0] = (P.yaw - geo.yaw) / ANGLE_UNIT; x[1] = (P.pitch - geo.pitch) / ANGLE_UNIT; x[2] = (P.roll - geo.roll) / ANGLE_UNIT;
      x[3] = (P.t[0] - geo.t[0]) / LENGTH_UNIT; x[4] = (P.t[1] - geo.t[1]) / LENGTH_UNIT; x[5] = (P.t[2] / geo.t[2] - 1) / DEPTH_UNIT;   // depth as a ratio to the calibration depth
    }
    const long = f.length >= FEATURE_COUNT;
    const uA = long ? f[h] : f[0], vA = long ? f[h + 1] : f[1], uB = long ? f[h + 2] : f[4], vB = long ? f[h + 3] : f[5];
    x[6] = uA; x[7] = vA; x[8] = uB; x[9] = vB; x[10] = f[2]; x[11] = f[3]; x[12] = f[6]; x[13] = f[7];
    if (w > 14) {
      const um = (uA + uB) / 2, vm = (vA + vB) / 2, vlm = (f[2] + f[6]) / 2;
      x[14] = um * um; x[15] = vm * vm; x[16] = um * vm; x[17] = vlm * vlm; x[18] = um * vlm;
    }
    if (w > 19) for (let k = 0; k < 8; k++) x[19 + k] = f[17 + k];
    return x;
  }
  /**
   * The geometry a head-frame model needs from a calibration: the mean head pose (the reference)
   * and Q, the 2x2 map from cm on the camera plane to screen px, fitted on the dots. Q doubles
   * as a check of the whole chain (matrix convention, landmark geometry): when the gaze rays do
   * not line up with the dots, there is no geometry to trust and the answer is null.
   */
  function buildGeo(rows, Y, G) {
    const n = rows.length; let ok = 0;
    const m = { yaw: 0, pitch: 0, roll: 0, t: [0, 0, 0] };
    for (const f of rows) {
      if (!hasPose(f)) continue;
      const P = framePose(f); ok++;
      m.yaw += P.yaw; m.pitch += P.pitch; m.roll += P.roll; m.t[0] += P.t[0]; m.t[1] += P.t[1]; m.t[2] += P.t[2];
    }
    if (!n || ok < 0.95 * n) return { fail: 'the face matrix was missing or not a rigid transform' };
    m.yaw /= ok; m.pitch /= ok; m.roll /= ok; m.t = m.t.map((v) => v / ok);
    // dot means of the gaze ray and of the target
    const dots = new Map();
    rows.forEach((f, i) => {
      const hgt = frameHit(f); if (!hgt) return;
      const d = dots.get(G[i]) || dots.set(G[i], { n: 0, hx: 0, hy: 0, x: 0, y: 0 }).get(G[i]);
      d.n++; d.hx += hgt[0]; d.hy += hgt[1]; d.x += Y[i][0]; d.y += Y[i][1];
    });
    const D = [...dots.values()].filter((d) => d.n >= 3).map((d) => ({ hx: d.hx / d.n, hy: d.hy / d.n, x: d.x / d.n, y: d.y / d.n }));
    if (D.length < 6) return { fail: 'too few dots with a gaze ray' };
    const mean = (k) => D.reduce((a, d) => a + d[k], 0) / D.length;
    const mh = [mean('hx'), mean('hy')], my = [mean('x'), mean('y')];
    let sxx = 0, sxy = 0, syy = 0; const b = [[0, 0], [0, 0]], tot = [0, 0];
    for (const d of D) {
      const hx = d.hx - mh[0], hy = d.hy - mh[1], t = [d.x - my[0], d.y - my[1]];
      sxx += hx * hx; sxy += hx * hy; syy += hy * hy;
      for (let a = 0; a < 2; a++) { b[a][0] += hx * t[a]; b[a][1] += hy * t[a]; tot[a] += t[a] * t[a]; }
    }
    const det = sxx * syy - sxy * sxy;
    if (!(det > 1e-9) || !(tot[0] > 0) || !(tot[1] > 0)) return { fail: 'the gaze rays do not spread' };
    const Q = b.map((r) => [(r[0] * syy - r[1] * sxy) / det, (r[1] * sxx - r[0] * sxy) / det]);
    const r2 = [0, 1].map((a) => { let res = 0; for (const d of D) res += (d[a ? 'y' : 'x'] - my[a] - Q[a][0] * (d.hx - mh[0]) - Q[a][1] * (d.hy - mh[1])) ** 2; return 1 - res / tot[a]; });
    const pxPerCm = Math.sqrt(Math.abs(Q[0][0] * Q[1][1] - Q[0][1] * Q[1][0]));
    // The rays must explain the dots, at a believable scale, x mostly from x and y mostly from y.
    if (!(r2[0] > 0.8 && r2[1] > 0.8)) return { fail: 'the gaze rays do not line up with the dots' };
    if (!(pxPerCm > 8 && pxPerCm < 250) || Math.abs(Q[0][1]) > Math.abs(Q[0][0]) || Math.abs(Q[1][0]) > Math.abs(Q[1][1])) return { fail: 'the gaze rays give an impossible screen scale' };
    // A screen hangs below its camera (or the camera sits on top of it): rays that land above the
    // camera or far off to one side mean the pose is not what this geometry takes it to be.
    if (!(mh[1] < 0 && mh[1] > -45 && Math.abs(mh[0]) < 20)) return { fail: 'the gaze rays land where no screen can be' };
    return { ...m, Q, pxPerCm, r2, eyeR: EYE_R, hit: mh };
  }
  /** Fit one head-frame model on raw camera rows; {fail: why} when these rows carry no usable geometry. */
  function fitKind(kind, rows, Y, G, bounds, given, drift) {
    if (!KINDS[kind]) return { fail: 'no such model' };
    if (!rows.length || rows.some((f) => f.length < FEATURE_COUNT)) return { fail: 'the camera rows are too short to carry a head pose' };
    const geo = given ? given.geo : kind === 'D' ? buildDriftGeo(rows, drift) : buildGeo(rows, Y, G);
    if (geo.fail) return geo;
    const X = rows.map((f) => mapFeatures(kind, f, geo));
    const Y2 = rows.map((f, i) => { const o = poseOffset(f, geo); return o ? [Y[i][0] - o[0], Y[i][1] - o[1]] : Y[i]; });
    const m = new Ridge(); m.kind = kind; m.geo = geo;
    // model D is model A's own regression (same inputs, same penalties) on targets with the drift taken out
    if (kind === 'D') return m.fit(X, Y2, G, given ? [given.lambda] : A_LAMBDAS, { bounds });
    m.fit(X, Y2, G, undefined, { norm: true, perAxis: true, zClamp: 4, sdFloor: MAPPED_SD_FLOOR, fixed: POSE_FIXED, fixedPenalty: POSE_PENALTY, bounds, lambdaXY: given ? given.lambdaXY : null });
    return m;
  }
  /**
   * Fit the same kind of model again on more rows (click refinement), keeping its penalties and,
   * for a head-frame model, its geometry. rows are raw camera vectors (or, for an old saved
   * calibration, the 25-wide rows it stored).
   */
  function refitModel(model, rows, Y, G, featureCount = 25) {
    if (model.kind && model.kind !== 'A') { const m = fitKind(model.kind, rows, Y, G, model.bounds, model); return m.fail ? model : m; }
    const nf = Math.min(...rows.map((r) => r.length), featureCount);
    return new Ridge().fit(rows.map((r) => (r.length > nf ? r.slice(0, nf) : r)), Y, G, [model.lambda], { norm: !!model.norm, zClamp: model.zc || 0, bounds: model.bounds || null });
  }

  // ------------------------------------------------------- click refinement gate
  // A click is a free calibration sample only if the eyes were on it. They often are not: people
  // click a button they looked at a moment ago, or one they found by feel. So the frames around a
  // click are used only when the eyes are at rest (a fixation is in progress) and the model
  // already puts them within CLICK_SIGMAS of the click; and they are forgotten after CLICK_TTL_MS,
  // because the posture they were taken in does not last.
  const CLICK_SIGMAS = 2, CLICK_TTL_MS = 60000;
  /**
   * @param click     {x, y} of the click, CSS px
   * @param pred      {x, y} where the model puts the eyes right now (mean of the last frames), or null
   * @param sx, sy    the tracker's error figures (px, 1 sigma)
   * @param fixating  a fixation is in progress and has lasted long enough to count
   */
  function clickUsable({ click, pred, sx, sy, fixating }) {
    if (!fixating || !pred || !click) return false;
    return Math.abs(pred.x - click.x) <= CLICK_SIGMAS * sx && Math.abs(pred.y - click.y) <= CLICK_SIGMAS * sy;
  }
  /** The click samples [{t, ...}] that are still young enough to use. */
  function liveClicks(clicks, now, ttl = CLICK_TTL_MS) { return clicks.filter((c) => now - c.t < ttl); }

  // ----------------------------------------------------------------- 1€ filter
  class OneEuro {
    constructor(minCutoff = 0.6, beta = 0.004, dCutoff = 1.0) { Object.assign(this, { minCutoff, beta, dCutoff }); this.reset(); }
    reset() { this.x = null; this.dx = 0; this.t = null; }
    static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
    filter(v, tMs) {
      if (this.x === null) { this.x = v; this.t = tMs; return v; }
      // Two samples under 5 ms apart (a burst of late frames, or a clock that stepped back) give a
      // meaningless speed: the old 1 ms clamp turned them into a spike. The newcomer is ignored and
      // the clock kept, so the next real frame is measured from the last one that counted.
      if (!(tMs - this.t >= OneEuro.MIN_DT_MS)) return this.x;
      const dt = (tMs - this.t) / 1000; this.t = tMs;
      const dv = (v - this.x) / dt;
      this.dx += OneEuro.alpha(this.dCutoff, dt) * (dv - this.dx);
      const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
      this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
      return this.x;
    }
  }

  OneEuro.MIN_DT_MS = 5;

  // ------------------------------------------------------------- calibration
  // The dots, as fractions of the viewport. Thirteen train the model, in snake order (short eye
  // travel); five more, never on a training dot, score it before they join the training set.
  const CAL_POINTS = [
    [0.06, 0.08], [0.5, 0.08], [0.94, 0.08], [0.72, 0.29], [0.28, 0.29],
    [0.06, 0.5], [0.5, 0.5], [0.94, 0.5], [0.72, 0.71], [0.28, 0.71],
    [0.06, 0.92], [0.5, 0.92], [0.94, 0.92],
  ];
  const VAL_POINTS = [[0.25, 0.22], [0.75, 0.22], [0.5, 0.5], [0.25, 0.78], [0.75, 0.78]];

  /** Drop, per calibration dot, the frames whose prediction error is far from that dot's own median (in place). */
  function trimTrain(model, X, Y, G, heads, more) {
    const med = (a) => { const b = a.slice().sort((p, q) => p - q); return b.length ? b[b.length >> 1] : 0; };
    const byDot = new Map();
    X.forEach((x, i) => { const p = model.predict(x); (byDot.get(G[i]) || byDot.set(G[i], []).get(G[i])).push({ i, ex: p[0] - Y[i][0], ey: p[1] - Y[i][1] }); });
    const drop = new Set();
    for (const rows of byDot.values()) {
      if (rows.length < 8) continue;
      const mx = med(rows.map((r) => r.ex)), my = med(rows.map((r) => r.ey));
      const sx = 1.4826 * med(rows.map((r) => Math.abs(r.ex - mx))) || 1, sy = 1.4826 * med(rows.map((r) => Math.abs(r.ey - my))) || 1;
      for (const r of rows) if (Math.abs(r.ex - mx) > 2.5 * sx || Math.abs(r.ey - my) > 2.5 * sy) drop.add(r.i);
    }
    if (!drop.size || drop.size > 0.3 * X.length) return 0;
    for (const arr of [X, Y, G, heads, more]) { if (!arr) continue; let w = 0; for (let i = 0; i < arr.length; i++) if (!drop.has(i)) arr[w++] = arr[i]; arr.length = w; }
    return drop.size;
  }

  /**
   * How far off the model is on dots it has not been trained on.
   * @param pts       [{x, y, samples:[{f}]}]
   * @param viewport  {w, h} copied into the result (optional)
   */
  function accuracyFrom(model, pts, viewport) {
    return accuracyFromDots(pts.map((p) => ({ n: p.samples.length, ...dotStats(model, p) })), viewport);
  }

  const ACC_MIN_DOTS = 3;   // an accuracy from fewer unseen dots than this is not reported at all
  /**
   * Bias and scatter over dots a model has not seen: [{n, biasX, biasY, sdX, sdY}] (dots with under
   * 5 frames do not count) -> {biasX, biasY, sdX, sdY, effX, effY, eff, dots}, or null without any.
   */
  function summarizeDots(stats) {
    let bx = 0, by = 0, nx = 0, ny = 0, k = 0;
    for (const d of stats) {
      if (!d || d.n < 5 || d.biasX === null || d.biasX === undefined) continue;
      bx += d.biasX ** 2; by += d.biasY ** 2; nx += d.sdX; ny += d.sdY; k++;
    }
    if (!k) return null;
    const biasX = Math.sqrt(bx / k), biasY = Math.sqrt(by / k), sdX = nx / k, sdY = ny / k;
    // A fixation spans ~6 frames, but neighbouring frames share most of their landmark
    // noise, so it holds only about 2.5 independent ones. Bias does not average out at all.
    const effX = Math.sqrt(biasX ** 2 + sdX ** 2 / 2.5), effY = Math.sqrt(biasY ** 2 + sdY ** 2 / 2.5);
    return { biasX, biasY, sdX, sdY, effX, effY, eff: Math.hypot(effX, effY), dots: k };
  }
  /** The accuracy object of a calibration from per-dot held-out errors. Throws under ACC_MIN_DOTS dots. */
  function accuracyFromDots(stats, viewport) {
    const s = summarizeDots(stats);
    if (!s || s.dots < ACC_MIN_DOTS) throw new Error('lost the face during validation');
    const out = {
      accuracyX: Math.round(s.biasX), accuracyY: Math.round(s.biasY), precisionX: Math.round(s.sdX), precisionY: Math.round(s.sdY),
      effX: Math.round(s.effX), effY: Math.round(s.effY),
      recommendedLinePitchPx: Math.round(Math.max(36, Math.min(120, 1.5 * s.effY))),
    };
    if (viewport) out.viewport = { w: viewport.w, h: viewport.h };
    return out;
  }

  // Regression hygiene of the calibration fit (step 2a). Each entry is on only if the benchmark kept it.
  const HYGIENE = { norm: false, perAxis: false, zClamp: 0, sdFloor: false, bounds: 0, dropMeans: false };
  // The smallest SD an input is scaled by: 2 % of the range it typically covers when the eyes sweep a
  // screen (iris offsets, lid terms, their products, blendshapes, head matrix, head box).
  const SD_FLOOR = (() => {
    const r = [0.15, 0.08, 0.08, 0.15, 0.15, 0.08, 0.08, 0.15, 0.15, 0.08, 0.08, 0.15, 0.01, 0.004, 0.006, 0.004, 0.006];
    for (let i = 0; i < 8; i++) r.push(0.3);
    for (let i = 0; i < 16; i++) r.push(i >= 12 && i < 15 ? 3 : 0.1);
    r.push(0.05, 0.05, 0.02);
    return r.map((v) => 0.02 * v);
  })();
  // Head-segment frames the still-dot reference puts further from the dot than this share of the
  // viewport's diagonal are dropped (MOVE_TRIM_PX without a viewport), unless that is most of them.
  const MOVE_TRIM_SHARE = 0.12, MOVE_TRIM_PX = 180, MOVE_TRIM_MAX = 0.6;
  const HEAD_MODEL_BOUNDS = 0.15;         // the head-frame models keep their answer within the viewport plus this margin
  const MEAN_FEATURES = [8, 9, 10, 11];   // exact means of 0-7: they add nothing a linear fit does not have

  const CAL_MIN_DOT_FRAMES = 8, CAL_MAX_THIN_DOTS = 2, CAL_MIN_FRAMES = 120;
  // What a calibration point is, by its role: 'cal' and 'val' are the fixation dots with the head
  // kept still (13 + 5); 'move' are the dots of the head-movement segment (watch the dot, turn the
  // head a little); 'pursuit' are stretches of a gliding dot. No role means 'cal'.
  const roleOf = (p) => p.role || 'cal';
  const isCal = (p) => roleOf(p) === 'cal';
  const isVal = (p) => roleOf(p) === 'val';
  const isMove = (p) => roleOf(p) === 'move';
  const isPursuit = (p) => roleOf(p) === 'pursuit';
  const isDot = (p) => isCal(p) || isVal(p);
  /**
   * Why these dots cannot be fitted, as an Error, or null when they can. Called on the 13 training
   * dots alone (to stop early) and on everything before the fit.
   */
  function calibrationProblem(points, allowEmpty = false) {
    const cal = points.filter(isCal), dots = points.filter(isDot);
    if (dots.filter((p) => p.samples.length < CAL_MIN_DOT_FRAMES).length > CAL_MAX_THIN_DOTS) return new Error('your eyes were lost on several dots. Face the camera, add light and try again');
    if (cal.reduce((a, p) => a + p.samples.length, 0) < CAL_MIN_FRAMES) return new Error('not enough face frames — improve lighting and face the camera');
    // A dot nobody looked at is a hole in the map: the model would be guessing there.
    if (!allowEmpty && dots.some((p) => !p.samples.length)) return new Error('your eyes were lost on one of the dots. Face the camera, add light and try again');
    return null;
  }

  function dotStats(model, p) {
    const n = p.samples.length;
    if (!n) return { biasX: null, biasY: null, sdX: null, sdY: null };
    const preds = p.samples.map((s) => model.predict(s.f));
    const mx = preds.reduce((a, q) => a + q[0], 0) / n, my = preds.reduce((a, q) => a + q[1], 0) / n;
    return {
      biasX: mx - p.x, biasY: my - p.y,
      sdX: Math.sqrt(preds.reduce((a, q) => a + (q[0] - mx) ** 2, 0) / n), sdY: Math.sqrt(preds.reduce((a, q) => a + (q[1] - my) ** 2, 0) / n),
    };
  }

  /**
   * The whole dot calibration, from the frames collected on each dot to the model in use.
   *
   * Model A, the 25-input ridge the tracker has always used, is always fitted: on the 13 training
   * dots, stray frames trimmed (eyes still arriving, glances away, half blinks) and fitted again.
   * The 5 validation dots stay out of the fit: they are what the accuracy is measured on. (Until
   * step 3 they were folded into the training set afterwards; the benchmark shows no gain from
   * that, and it left no dot the shipped model had not seen. opts.fold brings it back.) Dots of
   * the head-movement segment never reach model A: it knows nothing about the head, and frames
   * taken while the head moves only blur it (tests/bench/RESULTS.md, step 2).
   *
   * When the camera rows carry a usable head pose, the head-frame models (B, C, E) are fitted on
   * the same trimmed rows plus the head-movement dots. Every model is then scored on dots it has
   * not seen: leave-one-dot-out for the dots it trained on, and plainly for model A on the
   * head-movement dots. The best head-frame model replaces A only if it beats A by SHOOTOUT_MARGIN.
   *
   * The accuracy reported is the error of the model that ships on the validation dots, which it
   * was not trained on (never from fewer than 3 of them). With opts.fold there is no such dot, and
   * the figure is the model's leave-one-dot-out error over all 18 still dots (score 'lodo'), or,
   * as until step 3, that of a 13-dot fit on the validation dots (score 'val').
   *
   * @param points [{x, y, g, role:'cal'|'val'|'move'|'pursuit', samples:[{f, head:{cx,cy,s}, t}]}]  x, y in CSS px; g = dot id
   * @param opts   {featureCount=25, trim=true, viewport={w,h}, model='auto'|'A'|'B'|'C'|'E', trainWidth, hygiene, columns,
   *               fold=false, score='val'|'lodo', moveTrim=true}
   *               moveTrim: drop head-segment frames in which the eyes were not on the dot (see below; false: keep all)
   *               model: 'auto' runs the shoot-out, 'A' is the old path, a letter forces that model
   *               when it can be fitted. trainWidth cuts the stored rows (default: the whole camera vector).
   *               fold: the validation dots join the training set. score: see above; default 'val'
   *               without fold, 'lodo' with it.
   *               For experiments (tests/bench): hygiene switches the step 2a options of model A on,
   *               columns makes model A read exactly these numbers of the camera vector.
   * @returns {{model:Ridge, kind:string, shootout:object, train:{X,Y,G}, extra:{X,Y,G}|null, accuracy:object, calibHead:object, perDot:object[]}}
   *          accuracy.model is the kind too. train.X are the raw camera rows the model in use was fitted
   *          on: model.predict and refitModel take them. extra: rows collected but not used by that model
   *          (the head-movement dots when model A is in use). calibHead: {cx, cy, s} and, when the camera
   *          gave a head pose, {pose:true, yaw, pitch, roll (rad), tx, ty, tz (cm)}: the mean over the still dots.
   * @throws Error with a message fit for the reader when the dots cannot be fitted
   */
  function fitCalibration(points, opts = {}) {
    const cols = Array.isArray(opts.columns) && opts.columns.length ? opts.columns : null;
    const featureCount = cols ? Math.max(...cols) + 1 : opts.featureCount || 25, trim = opts.trim !== false, want = opts.model || 'auto';
    const fold = opts.fold === true, score = opts.score || (fold ? 'lodo' : 'val');
    const hyg = { ...HYGIENE, ...(opts.hygiene || {}) }, vp = opts.viewport;
    const bounds = (m) => (m && vp ? [-m * vp.w, (1 + m) * vp.w, -m * vp.h, (1 + m) * vp.h] : null);
    const ridgeOpts = {
      norm: hyg.norm, perAxis: hyg.perAxis, zClamp: hyg.zClamp, sdFloor: hyg.sdFloor ? SD_FLOOR : null, bounds: bounds(hyg.bounds),
      drop: cols ? Array.from({ length: featureCount }, (_, i) => i).filter((i) => !cols.includes(i)) : hyg.dropMeans ? MEAN_FEATURES : null,
    };
    const calPts = points.filter(isCal), valPts = points.filter(isVal), movePts = points.filter(isMove), purPts = points.filter(isPursuit);
    const problem = calibrationProblem(points, !!opts.allowEmpty);   // allowEmpty: tests/bench only, to measure what an empty dot used to cost
    if (problem) throw problem;
    const rows = [], X = [], Y = [], G = [], heads = [];   // rows: what the camera sent; X: what model A reads of it
    // (a sample may carry a target of its own, {x, y}: frames of a gliding dot)
    const add = (pts) => { for (const p of pts) for (const s of p.samples) { rows.push(s.f); X.push(s.f.slice(0, featureCount)); Y.push([s.x === undefined ? p.x : s.x, s.y === undefined ? p.y : s.y]); G.push(p.g); heads.push(s.head); } };
    const aLambdas = hyg.norm ? undefined : opts.lambdas || A_LAMBDAS;
    const fit = () => {
      let m = new Ridge().fit(X, Y, G, aLambdas, ridgeOpts);
      // Second pass without the stray frames.
      if (trim) { trimTrain(m, X, Y, G, heads, rows); m = new Ridge().fit(X, Y, G, aLambdas, ridgeOpts); }
      return m;
    };
    add(calPts);
    const first = fit();
    const calOnly = { rows: rows.slice(), Y: Y.slice(), G: G.slice() };
    if (fold) add(valPts);
    add(purPts);
    let model = fold || purPts.length ? fit() : first, kind = 'A', scored = first;
    // the head-movement dots: for the head-frame models only
    const mv = { rows: [], Y: [], G: [] };
    for (const p of movePts) for (const s of p.samples) { mv.rows.push(s.f); mv.Y.push([p.x, p.y]); mv.G.push(p.g); }
    // Were the eyes on the dot during the head segment? A head-frame model fitted on the still dots
    // alone says where it has them in each of those frames; a frame it puts far from the dot (the
    // reader was looking at something else: the instruction, the keyboard) would teach the model a
    // head effect that is not there. Those frames go, for every model's fit and score alike.
    const moveTrim = { frames: mv.rows.length, dropped: 0, limit: null, note: null };
    let moveKept = null;
    if (mv.rows.length && opts.moveTrim !== false && want !== 'A') {
      let ref = null;
      for (const k of ['E', 'B']) { const m = fitKind(k, rows, Y, G, bounds(HEAD_MODEL_BOUNDS)); if (!m.fail) { ref = m; break; } }
      if (!ref) moveTrim.note = 'no head-frame model could be fitted on the still dots';
      else {
        const limit = moveTrim.limit = Math.round(vp ? MOVE_TRIM_SHARE * Math.hypot(vp.w, vp.h) : MOVE_TRIM_PX);
        const off = mv.rows.map((f, i) => { const q = ref.predict(f); return Math.hypot(q[0] - mv.Y[i][0], q[1] - mv.Y[i][1]) > limit; });
        const n = off.filter(Boolean).length;
        // Most of the segment off its dots is not a glance away: the reference itself does not fit a
        // moving head (a camera whose pose means something else). Then everything stays, and the
        // shoot-out judges the head-frame models on these dots as they are.
        if (n > MOVE_TRIM_MAX * off.length) moveTrim.note = 'more than ' + Math.round(100 * MOVE_TRIM_MAX) + ' % of the frames were off their dot: nothing dropped';
        else if (n) {
          moveTrim.dropped = n;
          moveKept = new Map();
          let i = 0;
          for (const p of movePts) { const keep = p.samples.filter(() => !off[i++]); moveKept.set(p, keep.length >= CAL_MIN_DOT_FRAMES ? keep : []); }
          mv.rows.length = 0; mv.Y.length = 0; mv.G.length = 0;
          for (const p of movePts) for (const s of moveKept.get(p)) { mv.rows.push(s.f); mv.Y.push([p.x, p.y]); mv.G.push(p.g); }
        }
      }
    }
    const asScored = (p) => (moveKept && moveKept.has(p) ? { ...p, samples: moveKept.get(p) } : p);
    const trained = new Set(G), dots = points.filter((p) => !isPursuit(p)).map(asScored);
    // Every dot as a model that has not seen it predicts it.
    const unseen = (m, p) => {
      const cv = trained.has(p.g) || (m.kind !== 'A' && isMove(p)) ? (m.cvDots || []).find((d) => d.g === p.g) : null;
      return cv || { g: p.g, n: p.samples.length, ...dotStats(m, p) };
    };
    const effOf = (m) => { const s = summarizeDots(dots.map((p) => unseen(m, p))); return s ? s.eff : null; };

    // ---- shoot-out: error on unseen dots (the card's own figure, bias and scatter), the same dots for every model
    const eff = { A: effOf(model) }, fitted = {};
    let note = 'model A asked for';
    if (want !== 'A') {
      for (const k of (want === 'auto' ? CANDIDATES : [want])) {
        const m = fitKind(k, rows.concat(mv.rows), Y.concat(mv.Y), G.concat(mv.G), bounds(HEAD_MODEL_BOUNDS));
        if (m.fail) note = 'A kept: ' + m.fail; else { fitted[k] = m; eff[k] = effOf(m); }
      }
      let pick = null;
      if (want === 'auto') {
        const best = Object.keys(fitted).filter((k) => eff[k] !== null).sort((p, q) => eff[p] - eff[q])[0];
        if (best) {
          if (eff.A !== null && eff[best] < (1 - SHOOTOUT_MARGIN) * eff.A) pick = best;
          // ...and it must not lose to A on the validation dots, which no model was fitted on. A head-frame
          // model can win the leave-one-dot-out score by reading the head's slow drift during the dots as a
          // cause (real camera: C "beat A by 35 %" and was 140 px off down the screen on every later dot).
          if (pick && !fold) {
            const onVal = (m) => summarizeDots(valPts.map((p) => ({ n: p.samples.length, ...dotStats(m, p) })));
            const va = onVal(model), vb = onVal(fitted[best]);
            if (va && vb && va.dots >= ACC_MIN_DOTS && vb.eff > va.eff) { pick = null; note = `A kept: model ${best} won on the training dots but was worse on the validation dots (${Math.round(vb.eff)} px against ${Math.round(va.eff)} px)`; }
          }
          else note = `A kept: the best other model (${best}) did not beat it by ${Math.round(100 * SHOOTOUT_MARGIN)} %`;
        }
      } else if (fitted[want]) pick = want;
      if (pick && score === 'val' && fold) {
        // The older figure: the chosen kind fitted on the training dots alone, scored on the validation dots.
        const m13 = fitKind(pick, calOnly.rows, calOnly.Y, calOnly.G, bounds(HEAD_MODEL_BOUNDS));
        if (!m13.fail) scored = m13;
        else { note = `A kept: model ${pick} could not be fitted on the training dots alone (${m13.fail})`; pick = null; }
      }
      if (pick) { model = fitted[pick]; kind = pick; note = want === 'auto' ? `${pick} beat A by ${Math.round(100 * (1 - eff[pick] / eff.A))} %` : `model ${pick} asked for`; }
    }
    // Model D (A with the head's drift taken out): only when the caller knows the screen's size, and
    // only when no learned head-frame model won. It needs no margin over A: its gains are physical,
    // so it is kept unless these dots say it is worse.
    if (kind === 'A' && opts.drift && (want === 'auto' || want === 'D')) {
      const m = fitKind('D', rows, Y, G, bounds(HEAD_MODEL_BOUNDS), null, { ...opts.drift, width: featureCount });
      if (m.fail) note += '; D not fitted: ' + m.fail;
      else {
        eff.D = effOf(m);
        const vEff = (mm) => { const q = fold ? null : summarizeDots(valPts.map((p) => ({ n: p.samples.length, ...dotStats(mm, p) }))); return q && q.dots >= ACC_MIN_DOTS ? q.eff : null; };
        const va = vEff(model), vd = vEff(m), valOk = va === null || vd === null || vd <= va * DRIFT_KEEP;
        if (want === 'D' || (eff.D !== null && eff.A !== null && eff.D <= eff.A * DRIFT_KEEP && valOk)) { model = m; kind = 'D'; note = want === 'D' ? 'model D asked for' : `D (head drift taken out) in use: ${Math.round(eff.D)} px against ${Math.round(eff.A)} px for A`; }
        else note += `; D not used: ${eff.D === null ? 'no score' : Math.round(eff.D) + ' px'} against ${eff.A === null ? '?' : Math.round(eff.A) + ' px'} for A`;
      }
    }
    // ---- accuracy: of the model that ships, on dots it has not seen
    const held = new Map();
    let accuracy;
    if (score === 'val') {
      const m = fold ? scored : model;
      for (const p of valPts) held.set(p, { n: p.samples.length, ...dotStats(m, p) });
      accuracy = accuracyFromDots(valPts.map((p) => held.get(p)), vp);
      accuracy.source = 'val';
    } else {
      for (const p of points.filter(isDot)) held.set(p, unseen(model, p));
      accuracy = accuracyFromDots([...held.values()], vp);
      accuracy.source = 'lodo';
    }
    accuracy.dots = [...held.values()].filter((d) => d.n >= 5 && d.biasX !== null).length;
    accuracy.model = kind;

    const headFrame = kind !== 'A';
    const kept = new Map();
    for (const g of (headFrame ? G.concat(mv.G) : G)) kept.set(g, (kept.get(g) || 0) + 1);
    const perDot = points.map((p) => {
      // Dots the accuracy counts: the error of a fit that had not seen them. Others: what is left after fitting.
      const st = held.get(p) || dotStats(model, p);
      return {
        g: p.g, role: roleOf(p), x: p.x, y: p.y, n: p.samples.length, kept: kept.get(p.g) || 0, heldOut: held.has(p),
        biasX: st.biasX, biasY: st.biasY, sdX: st.sdX, sdY: st.sdY,
      };
    });
    const mean = (k) => heads.reduce((a, h) => a + h[k], 0) / heads.length;
    const calibHead = { cx: mean('cx'), cy: mean('cy'), s: mean('s') };
    // The pose the still dots were looked at in: what the head gate measures against.
    const posed = rows.map(poseOf).filter(Boolean);
    if (posed.length && posed.length >= 0.95 * rows.length) {
      calibHead.pose = true;
      for (const k of ['yaw', 'pitch', 'roll', 'tx', 'ty', 'tz']) calibHead[k] = posed.reduce((a, q) => a + q[k], 0) / posed.length;
    }
    const tw = opts.trainWidth, cut = (R) => (tw ? R.map((r) => r.slice(0, tw)) : R);
    const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
    return {
      model, kind, accuracy, calibHead, perDot,
      train: headFrame ? { X: cut(rows.concat(mv.rows)), Y: Y.concat(mv.Y), G: G.concat(mv.G) } : { X: cut(rows), Y, G },
      extra: !headFrame && mv.rows.length ? { X: cut(mv.rows), Y: mv.Y, G: mv.G } : null,
      shootout: {
        asked: want, chosen: kind, note, margin: SHOOTOUT_MARGIN, eff: Object.fromEntries(Object.entries(eff).map(([k, v]) => [k, round1(v)])), pxPerCm: model.geo ? round1(model.geo.pxPerCm) : null,
        dots: dots.length, moveDots: movePts.length, moveTrim,
      },
    };
  }

  // ------------------------------------------------------- calibration procedure
  const RESHOW_FACTOR = 2.5;
  /**
   * After the first round of dots: which ones deserve a second showing? A dot with too few frames
   * (a blink, the face lost), or one whose leave-one-dot-out residual (how far a fit on the other
   * dots puts it from where it was shown) is over RESHOW_FACTOR times the median: the eyes were
   * probably somewhere else.
   * @param points the dots so far ('cal' and 'val' count)
   * @param opts   {featureCount=25, max=3}  max: how many may be shown again
   * @returns {{dots:[{g, n, resid, why:null|'frames'|'residual'}], median, reshow:number[], flagged:number}}
   */
  function reviewDots(points, opts = {}) {
    const featureCount = opts.featureCount || 25, max = opts.max === undefined ? 3 : opts.max;
    const pts = points.filter(isDot);
    const out = pts.map((p) => ({ g: p.g, n: p.samples.length, resid: null, why: null }));
    const X = [], Y = [], G = [];
    for (const p of pts) for (const s of p.samples) { X.push(s.f.slice(0, featureCount)); Y.push([p.x, p.y]); G.push(p.g); }
    let median = null;
    if (new Set(G).size >= 6 && X.length >= 60) {
      const m = new Ridge().fit(X, Y, G);
      for (const d of m.cvDots || []) { const o = out.find((q) => q.g === d.g); if (o) o.resid = Math.hypot(d.biasX, d.biasY); }
      const r = out.filter((o) => o.resid !== null && o.n >= CAL_MIN_DOT_FRAMES).map((o) => o.resid).sort((a, b) => a - b);
      if (r.length) median = r[r.length >> 1];
    }
    for (const o of out) {
      if (o.n < CAL_MIN_DOT_FRAMES) o.why = 'frames';
      else if (median !== null && o.resid !== null && o.resid > RESHOW_FACTOR * median) o.why = 'residual';
    }
    const flagged = out.filter((o) => o.why).sort((a, b) => (a.why === b.why ? (b.resid || 0) - (a.resid || 0) : a.why === 'frames' ? -1 : 1));
    return { dots: out, median, reshow: flagged.slice(0, max).map((o) => o.g), flagged: flagged.length };
  }

  /**
   * A dot was shown twice: which showing goes into the fit? The one a fit on all the other dots
   * agrees with better; a showing with too few frames loses to one with enough.
   * @returns {'first'|'second'}
   */
  function betterShowing(points, first, second, opts = {}) {
    const ok = (p) => p.samples.length >= CAL_MIN_DOT_FRAMES;
    if (!ok(second)) return ok(first) || first.samples.length >= second.samples.length ? 'first' : 'second';
    if (!ok(first)) return 'second';
    const featureCount = opts.featureCount || 25, X = [], Y = [], G = [];
    for (const p of points.filter(isDot)) { if (p.g === first.g) continue; for (const s of p.samples) { X.push(s.f.slice(0, featureCount)); Y.push([p.x, p.y]); G.push(p.g); } }
    if (new Set(G).size < 6 || X.length < 60) return 'second';
    const m = new Ridge().fit(X, Y, G), a = dotStats(m, first), b = dotStats(m, second);
    return Math.hypot(b.biasX, b.biasY) <= Math.hypot(a.biasX, a.biasY) ? 'second' : 'first';
  }

  const STILL_F = [8, 9, 10];        // mean iris offset across and down, and against the lids
  const STILL_FLOOR = [5e-4, 5e-4, 5e-4];
  /**
   * Have the eyes arrived and stopped? The last `windowMs` of frames are still when neither half
   * of the window sits apart from the other by more than the frame noise explains, and nothing in
   * it jumps. sigma: the frame noise of each of STILL_F (see StreamNoise), or null while unknown.
   * @param frames [{t, face, blink, f}] in time order
   */
  function streamStill(frames, now, sigma, windowMs = 300, strict = 3) {
    if (!sigma) return false;
    const w = [];
    for (let i = frames.length - 1; i >= 0 && frames[i].t > now - windowMs; i--) { const fr = frames[i]; if (fr.face && !fr.blink && fr.f) w.push(fr); }
    if (w.length < 4 || now - w[w.length - 1].t < 0.5 * windowMs) return false;   // w runs newest to oldest
    const h = w.length >> 1;
    for (let k = 0; k < STILL_F.length; k++) {
      const j = STILL_F[k], s = Math.max(sigma[k], STILL_FLOOR[k]);
      let a = 0, b = 0, lo = Infinity, hi = -Infinity;
      for (let i = 0; i < w.length; i++) { const v = w[i].f[j]; if (i < h) a += v; else b += v; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (Math.abs(a / h - b / (w.length - h)) > strict * s * Math.sqrt(4 / w.length)) return false;
      if (hi - lo > (strict + 5) * s) return false;
    }
    return true;
  }
  /**
   * Have the eyes left where they were when the dot appeared? Nobody reacts within the first
   * `headMs`, so those frames are the place the eyes came from; the last `windowMs` are compared with them.
   */
  function streamMoved(frames, tShow, now, sigma, windowMs = 300, headMs = 180) {
    if (!sigma) return false;
    const ok = (fr) => fr.face && !fr.blink && fr.f;
    const a = frames.filter((fr) => ok(fr) && fr.t <= tShow + headMs), b = frames.filter((fr) => ok(fr) && fr.t > now - windowMs && fr.t > tShow + headMs);
    if (a.length < 2 || b.length < 3) return false;
    for (let k = 0; k < STILL_F.length; k++) {
      const j = STILL_F[k], s = Math.max(sigma[k], STILL_FLOOR[k]);
      const ma = a.reduce((q, fr) => q + fr.f[j], 0) / a.length, mb = b.reduce((q, fr) => q + fr.f[j], 0) / b.length;
      if (Math.abs(ma - mb) > 4 * s * Math.sqrt(1 / a.length + 1 / b.length)) return true;
    }
    return false;
  }
  /** Frame-to-frame noise of the STILL_F features, from the median step between neighbouring frames (saccades do not move a median). */
  class StreamNoise {
    constructor() { this.d = STILL_F.map(() => []); this.prev = null; }
    push(fr) {
      if (!fr.face || fr.blink || !fr.f) { this.prev = null; return; }
      if (this.prev && fr.t - this.prev.t < 120) STILL_F.forEach((j, k) => { const a = this.d[k]; a.push(Math.abs(fr.f[j] - this.prev.f[j])); if (a.length > 240) a.shift(); });
      this.prev = fr;
    }
    get sigma() {
      if (this.d[0].length < 10) return null;
      return this.d.map((a) => { const s = a.slice().sort((p, q) => p - q); return 1.4826 * s[s.length >> 1] / Math.SQRT2; });
    }
  }

  const HEAD_POINTS = [[0.5, 0.5], [0.24, 0.32], [0.76, 0.68]];
  const HEAD_TEXT = 'Keep watching the dot and slowly turn your head a little: left, right, up, down.';
  /**
   * The calibration procedure, without a screen: which dot to show now, when its frames count,
   * which dots to show again, and the extra segments. The reader (gaze-reader.js) and the benchmark
   * (tests/bench) both drive it the same way:
   *
   *   const run = new CalibrationRun({ viewport: {w, h} });
   *   on every camera frame:      run.push({face, blink, f, head}, t)
   *   on every tick of the clock: const v = run.update(now)   -> what to show (throws when it cannot go on)
   *   when v.done:                const fit = run.result()    -> fitCalibration's result (throws like it)
   *
   * A dot: the stream is watched from the moment the dot is shown. Sampling starts once
   * settleMs - dropMs have passed AND the eyes have moved away from where they were (streamMoved;
   * or noMoveMs more have passed without that: they were there already) AND have stopped
   * (streamStill); or stillMaxMs later at the latest. The first dropMs of it are thrown away; the
   * next sampleMs are the dot's frames. If the eyes jump while the dot is being sampled (they
   * arrive late, or glance away) the sampling starts over, until stillMaxMs is used up.
   * With the defaults a dot takes 2 s when the eyes arrive in time, as it always did.
   * After the 13 + 5 dots, reviewDots picks up to `reshow` of them for a second showing.
   * Then the head segment (`head`): three dots, 2 s each.
   * headPause (the reader sets it): before the head segment the run WAITS. update() returns a view with
   * wait:true and text HEAD_TEXT, nothing is sampled, and the driver calls run.resume(now) when the
   * reader has read the instruction and said so (a key, a button). The head dots then carry no text,
   * and the first of them gets headFirstMs before its frames count (the eyes come back from the card).
   * Without headPause the text is on screen while the first head dot is already being sampled: anyone
   * who reads it has frames of the top of the screen labelled as the dot (tests/bench/RESULTS.md,
   * "Sign-off"). That mode is kept for the benchmark's comparison only.
   *
   * view: {done, stepId, seg:'dots'|'reshow'|'head'|'pursuit', x, y, glide, sampling, sampleMs, text, progress}
   *   stepId changes when a new target begins; glide: the dot may travel to x, y with its usual
   *   animation (false: put it exactly there, it is being moved frame by frame).
   * run.events: 'caldot' details, in order ({i, g, role, seg, x, y, tShow, tSampleStart, tSampleEnd, frames, settled});
   *   the driver may drain the array. run.raw: the same per dot with every frame from tShow on (untrimmed).
   */
  class CalibrationRun {
    constructor(o = {}) {
      // blinks: 'lids' (frames carry lids: BlinkDetector decides, with two frames either side of a blink left out) or 'flag' (the frame's own blink flag)
      this.o = { blinks: 'lids', viewport: { w: 1280, h: 720 }, settleMs: 750, sampleMs: 700, dropMs: 200, still: true, stillMaxMs: 1500, noMoveMs: 400, restart: true, reshow: 3, head: true, headStepMs: 2000, headSettleMs: 700, headPause: false, headFirstMs: 1000, fit: {}, ...o };
      const vp = this.o.viewport, dot = (p, g, role, seg) => ({ kind: 'dot', seg, role, g, x: p[0] * vp.w, y: p[1] * vp.h });
      this.queue = CAL_POINTS.map((p, i) => dot(p, i, 'cal', 'dots')).concat(VAL_POINTS.map((p, i) => dot(p, 100 + i, 'val', 'dots')));
      this.headSteps = this.o.head ? HEAD_POINTS.map((p, i) => dot(p, 200 + i, 'move', 'head')) : [];
      this.total = this.queue.length + this.headSteps.length;
      this.stage = 'dots'; this.cur = null; this.done = false; this.stepId = 0; this.count = 0;
      this.points = []; this.raw = []; this.events = []; this.noise = new StreamNoise(); this.review = null; this.reshown = [];
      this.blinker = new BlinkDetector();
      this.t0 = null; this.tEnd = null;
      this.waiting = false; this.tWait = null; this.pausedMs = 0; this.afterPause = false;
    }

    /** The reader has read the head-turn instruction (headPause): go on with the head segment. */
    resume(now) {
      if (!this.waiting) return;
      this.waiting = false; this.afterPause = true;
      if (this.tWait !== null && now > this.tWait) this.pausedMs += now - this.tWait;
      this.tWait = null;
    }

    push(fr, t) {
      const lids = fr.face && fr.lids && this.o.blinks === 'lids' ? fr.lids : undefined;
      // (the live verdict steers the stillness test; which frames a dot keeps is settled afterwards, in _finish)
      const rec = { t, face: !!fr.face, blink: lids ? this.blinker.push(lids, t) : !!fr.blink, f: fr.face ? fr.f : undefined, head: fr.face ? fr.head : undefined };
      if (lids) rec.lids = lids;
      this.noise.push(rec);
      if (this.cur) this.cur.frames.push(rec);
    }

    update(now) {
      if (this.t0 === null) this.t0 = now;
      for (let guard = 0; guard < 8 && !this.done; guard++) {
        if (this.waiting) {
          if (this.tWait === null) this.tWait = now;
          const h = this.queue[0];
          return { done: false, wait: true, stepId: this.stepId, seg: 'head', x: h.x, y: h.y, glide: true, sampling: false, sampleMs: 0, text: HEAD_TEXT, progress: Math.min(1, this.count / Math.max(1, this.total)) };
        }
        if (!this.cur) {
          if (!this.queue.length) { this._nextStage(now); continue; }
          const s = this.queue.shift(), o = this.o, head = s.seg === 'head';
          const first = head && this.afterPause; this.afterPause = false;
          this.cur = {
            ...s, i: this.count++, tShow: now, tSampleStart: null, tSampleEnd: null, settled: false, frames: [],
            waitMs: head ? (first ? Math.max(o.headSettleMs, o.headFirstMs) : o.headSettleMs) : Math.max(0, o.settleMs - o.dropMs), dropMs: head ? 0 : o.dropMs,
            sampleMs: head ? Math.max(200, o.headStepMs - o.headSettleMs) : o.sampleMs, still: !head && o.still,
          };
          this.stepId++;
        }
        const c = this.cur;
        const tMin = c.tShow + c.waitMs, tMax = tMin + this.o.stillMaxMs;
        if (c.tSampleStart === null) {
          if (now < tMin) break;
          const sg = c.still ? this.noise.sigma : null;
          const still = !c.still || (streamStill(c.frames, now, sg) && (now >= tMin + this.o.noMoveMs || streamMoved(c.frames, c.tShow, now, sg)));
          if (!still && now < tMax) break;
          c.settled = still; c.tSampleStart = now; c.tSampleEnd = now + c.dropMs + c.sampleMs;
          break;
        }
        if (now < c.tSampleEnd) {
          // A jump while sampling: these are not frames of one fixation. Start over while there is time.
          if (c.still && this.o.restart && now < tMax && now > c.tSampleStart + 150 && this.noise.sigma && !streamStill(c.frames, now, this.noise.sigma, 300, 8)) { c.tSampleStart = null; c.restarts = (c.restarts || 0) + 1; }
          break;
        }
        this._finish(c);
      }
      const c = this.cur;
      if (this.done || !c) return { done: this.done, stepId: this.stepId, seg: this.stage, progress: 1, sampling: false, text: null };
      return {
        done: false, stepId: this.stepId, seg: c.seg, x: c.x, y: c.y, glide: true, sampling: c.tSampleStart !== null, sampleMs: c.dropMs + c.sampleMs,
        text: c.seg === 'head' && !this.o.headPause ? HEAD_TEXT : null, progress: Math.min(1, c.i / Math.max(1, this.total)),
      };
    }

    _finish(c) {
      const from = c.tSampleStart + c.dropMs;
      const out = markBlinks(c.frames, this.o.blinks === 'lids' ? {} : { pad: 0 });
      let samples = c.frames.filter((fr, i) => fr.face && !out[i] && fr.t >= from && fr.t <= c.tSampleEnd).map((fr) => ({ f: fr.f, head: fr.head, t: fr.t }));
      // Safety net for a real camera: when the blink rule leaves a dot too thin although the face was there, keep every
      // frame whose eyes were not plainly shut. Some eyes (and any look down the screen) score as half a blink all the
      // time; the fit trims stray frames afterwards, and a thin dot would fail the whole calibration.
      let lenient = false;
      if (samples.length < CAL_MIN_DOT_FRAMES) {
        const open = c.frames.filter((fr) => fr.face && fr.f && fr.t >= from && fr.t <= c.tSampleEnd && !(fr.lids ? (Math.min(fr.lids.l, fr.lids.r) > 0.85 || fr.lids.open < 0.04) : fr.blink));
        if (open.length >= CAL_MIN_DOT_FRAMES) { samples = open.map((fr) => ({ f: fr.f, head: fr.head, t: fr.t })); lenient = true; }
      }
      const point = { x: c.x, y: c.y, g: c.g, role: c.role, samples };
      const info = { i: c.i, g: c.g, role: c.role, seg: c.seg, x: c.x, y: c.y, tShow: c.tShow, tSampleStart: from, tSampleEnd: c.tSampleEnd, frames: samples.length, settled: c.settled, restarts: c.restarts || 0, lenient };
      this.events.push(info);
      this.raw.push({ ...info, stream: c.frames });
      if (c.seg === 'reshow') {
        const at = this.points.findIndex((p) => p.g === c.g), which = betterShowing(this.points, this.points[at], point, this.o.fit);
        if (which === 'second') this.points[at] = point;
        this.reshown.push({ g: c.g, used: which });
      } else this.points.push(point);
      this.cur = null;
      // The 13 training dots are in and more of them are thin than a second showing can rescue: stop now, not five dots later.
      if (c.seg === 'dots' && c.role === 'cal' && this.queue.length && this.queue[0].role !== 'cal' && this.points.filter((p) => p.samples.length < CAL_MIN_DOT_FRAMES).length > this.o.reshow + CAL_MAX_THIN_DOTS) {
        throw new Error('your eyes were lost on several dots. Face the camera, add light and try again');
      }
    }

    _nextStage(now) {
      if (this.stage === 'dots') {
        this.stage = 'reshow';
        if (this.o.reshow > 0) {
          this.review = reviewDots(this.points, { ...this.o.fit, max: this.o.reshow });
          // More thin dots than can be shown again: nothing to rescue here. Say so now.
          this.queue = this.review.reshow.map((g) => { const p = this.points.find((q) => q.g === g); return { kind: 'dot', seg: 'reshow', role: p.role, g, x: p.x, y: p.y }; });
          this.total += this.queue.length;
        }
      } else if (this.stage === 'reshow') {
        this.stage = 'head';
        // Without enough dots there will be no fit: do not ask for six more seconds first.
        const problem = calibrationProblem(this.points, !!this.o.fit.allowEmpty);
        if (problem) throw problem;
        this.queue = this.headSteps;
        if (this.o.headPause && this.queue.length) { this.waiting = true; this.stepId++; }
      } else { this.done = true; this.tEnd = now; }
    }

    /** The fit, with what the procedure did: {…fitCalibration, procedure:{ms, reshown, flagged, unsettled}}. */
    result() {
      if (!this.done) throw new Error('the calibration has not finished');
      const fit = fitCalibration(this.points, { viewport: this.o.viewport, ...this.o.fit });
      fit.procedure = {
        ms: Math.round(this.tEnd - this.t0), pausedMs: Math.round(this.pausedMs), dots: this.events.length, reshown: this.reshown, flagged: this.review ? this.review.flagged : 0,
        unsettled: this.events.filter((e) => e.seg !== 'head' && !e.settled).length,
      };
      return fit;
    }
  }

  const TYPICAL_LINE_PITCH = 32;   // px between lines of body text as Glider spaces it (16 to 18 px type)
  /**
   * What the "Calibration done" card may say. "Line by line" is claimed only when the vertical
   * error is under half a typical line pitch; otherwise the band of lines the error spans.
   * @returns {{level:1|2|3, title, text, lineByLine:boolean, bandLines:number}}
   */
  function accuracyGrade(acc, pitch = TYPICAL_LINE_PITCH) {
    const effY = Math.max(0, Number(acc && acc.effY) || 0);
    const bandLines = Math.max(3, Math.round(2 * effY / pitch) + 1);
    if (effY < pitch / 2) return { level: 3, title: 'Great', text: 'Glider can follow you line by line.', lineByLine: true, bandLines: 1 };
    if (bandLines <= 5) return { level: 2, title: 'Good', text: `Glider can follow the paragraph you are reading, to within a band of about ${bandLines} lines.`, lineByLine: false, bandLines };
    return { level: 1, title: 'Rough', text: 'Glider can only tell which paragraph you are on. A brighter room and a still head will help.', lineByLine: false, bandLines };
  }

  // ------------------------------------------------- validation pass and health (step 4)
  // After the fit the reader shows five more dots, on places no earlier dot used, and runs the
  // model in use on them. What the "Calibration done" card says comes from that measurement.
  const CHECK_POINTS = [[0.4, 0.4], [0.84, 0.3], [0.6, 0.62], [0.16, 0.66], [0.5, 0.2]];
  // Screen px per degree of gaze, for the "approximately N degrees" on the card: a 14 inch laptop
  // screen of 1536 x 864 CSS px at 60 cm (the benchmark's profile). Nobody measured the reader's
  // screen or distance, so the figure is shown as approximate.
  const APPROX_PX_PER_DEG = 52;
  const GRADE_TEXT = {
    good: 'it can follow which line you are on',
    fair: (n) => `it follows the paragraph and a band of about ${n} lines`,
    poor: 'it can only tell roughly which part of the page you are looking at',
  };
  /**
   * The grade of a vertical error, by the rule of accuracyGrade: "good" only under half a line
   * of ordinary text, "fair" up to a band of five lines, "poor" beyond.
   * @returns {{grade:'good'|'fair'|'poor', level:1|2|3, title, text, message, lineByLine, bandLines}}
   */
  function validationGrade(effY, pitch = TYPICAL_LINE_PITCH) {
    const e = Number(effY), bandLines = Math.max(3, Math.round(2 * Math.max(0, e) / pitch) + 1);
    const grade = !Number.isFinite(e) ? 'poor' : e < pitch / 2 ? 'good' : bandLines <= 5 ? 'fair' : 'poor';
    const text = grade === 'fair' ? GRADE_TEXT.fair(bandLines) : GRADE_TEXT[grade];
    return { grade, level: grade === 'good' ? 3 : grade === 'fair' ? 2 : 1, title: 'Tracking is ' + grade, text, message: `Tracking is ${grade}: ${text}`, lineByLine: grade === 'good', bandLines: grade === 'good' ? 1 : bandLines };
  }
  /**
   * The check shows each dot for a fixed time; it does not wait for the eyes as the calibration does.
   * Somebody who reaches a dot late would have the frames of the way there counted as tracker error.
   * So the frames before the eyes arrive are left out: where the outputs settle is taken from the
   * last third of the dot's frames (median, and scatter from the median deviation), and everything
   * up to the last pair of neighbouring frames far from there (4 scatters on either axis) goes,
   * looking only in the first 60 % of the frames. Later strays stay in: they are the tracker's scatter.
   * On the benchmark's people this changes nothing when the eyes are on time and brings the check
   * back to the truth when 30 % of the dots are reached late (tests/bench/check-card.mjs).
   * @param P  [[x, y], ...] in time order   @returns the frames that count
   */
  function arrivalTrim(P) {
    const n = P.length;
    if (n < 9) return P;
    const med = (a) => { const b = a.slice().sort((p, q) => p - q); return b[b.length >> 1]; };
    const tail = P.slice(Math.floor(2 * n / 3)), cx = med(tail.map((p) => p[0])), cy = med(tail.map((p) => p[1]));
    const sx = Math.max(4, 1.4826 * med(tail.map((p) => Math.abs(p[0] - cx)))), sy = Math.max(4, 1.4826 * med(tail.map((p) => Math.abs(p[1] - cy))));
    const far = (p) => Math.abs(p[0] - cx) > 4 * sx || Math.abs(p[1] - cy) > 4 * sy;
    let cut = -1;
    for (let i = 0; i + 1 < Math.floor(0.6 * n); i++) if (far(P[i]) && far(P[i + 1])) cut = i + 1;
    return cut < 0 ? P : P.slice(cut + 1);
  }
  /**
   * The result of the validation pass.
   * @param dots  [{x, y, preds:[[x, y], ...]}]: per dot, the model's output on every frame of its window, in time
   *              order (frames before the eyes arrive are left out here: arrivalTrim; o.arrival false keeps them)
   * @param o     {pitch, pxPerDeg, fallback}: fallback is the calibration's own accuracy ({effX, effY}),
   *              graded instead when the pass could not be measured (fewer than 3 dots with 5 frames)
   * @returns {{ok, source:'validation'|'calibration'|'none', dots, frames, errPx, errDeg, pxPerDeg, effX, effY, biasX, biasY, sdX, sdY,
   *            perDot:[{x, y, n, dx, dy, err}], grade, level, title, text, message, lineByLine, bandLines, reason?}}
   *   errPx: the median distance, over all frames, between the model's output and the dot (the "typical error").
   *   effX / effY: the per-fixation error, computed as the calibration computes its own (summarizeDots).
   */
  function validationResult(dots, o = {}) {
    const pxPerDeg = o.pxPerDeg || APPROX_PX_PER_DEG, med = (a) => { const b = a.slice().sort((p, q) => p - q); return b.length ? (b.length % 2 ? b[b.length >> 1] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : NaN; };
    const perDot = [], stats = [], all = [];
    for (const d of dots || []) {
      const got = (d.preds || []).filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      const P = o.arrival === false ? got : arrivalTrim(got), n = P.length;
      if (!n) { perDot.push({ x: d.x, y: d.y, n: 0, late: got.length, dx: null, dy: null, err: null }); continue; }
      const mx = P.reduce((a, p) => a + p[0], 0) / n, my = P.reduce((a, p) => a + p[1], 0) / n;
      const errs = P.map((p) => Math.hypot(p[0] - d.x, p[1] - d.y));
      if (n >= 5) { all.push(...errs); stats.push({ n, biasX: mx - d.x, biasY: my - d.y, sdX: Math.sqrt(P.reduce((a, p) => a + (p[0] - mx) ** 2, 0) / n), sdY: Math.sqrt(P.reduce((a, p) => a + (p[1] - my) ** 2, 0) / n) }); }
      perDot.push({ x: d.x, y: d.y, n, late: got.length - n, dx: Math.round(mx - d.x), dy: Math.round(my - d.y), err: Math.round(med(errs)) });
    }
    const s = summarizeDots(stats), r1 = (v) => Math.round(v * 10) / 10;
    const base = { dots: s ? s.dots : 0, frames: all.length, pxPerDeg, perDot };
    if (s && s.dots >= ACC_MIN_DOTS) {
      const errPx = med(all);
      return { ok: true, source: 'validation', ...base, errPx: Math.round(errPx), errDeg: r1(errPx / pxPerDeg), effX: Math.round(s.effX), effY: Math.round(s.effY), biasX: Math.round(s.biasX), biasY: Math.round(s.biasY), sdX: Math.round(s.sdX), sdY: Math.round(s.sdY), ...validationGrade(s.effY, o.pitch) };
    }
    const reason = o.reason || 'the camera lost your eyes on the check dots';
    const fb = o.fallback && Number.isFinite(Number(o.fallback.effY)) ? o.fallback : null;
    if (!fb) return { ok: false, source: 'none', ...base, errPx: null, errDeg: null, effX: null, effY: null, reason, ...validationGrade(NaN, o.pitch) };
    const errPx = Math.hypot(Number(fb.effX) || 0, Number(fb.effY));
    return { ok: false, source: 'calibration', ...base, errPx: Math.round(errPx), errDeg: r1(errPx / pxPerDeg), effX: Math.round(Number(fb.effX) || 0), effY: Math.round(Number(fb.effY)), reason, ...validationGrade(fb.effY, o.pitch) };
  }

  // What the picture must give for the tracker to have a chance. FACE_MIN_W is the face's width as
  // a share of the picture's: at 60 cm a 65-degree webcam shows a face at about 19 %, so the limit
  // sits a little under the "about 20 %" it stands for, or the normal seat would be warned about.
  const QUALITY = { minFps: 20, faceMinW: 0.17, offX: 0.25, cyMin: 0.2, cyMax: 0.78, lostShare: 0.1, blinkShare: 0.25, headMove: 0.03, sizeChange: 0.08 };
  /** Face width from the eye distance (both as shares of the picture width), for a camera frame that sends no width. */
  const faceWidthFromEyes = (s) => 2.3 * s;
  /**
   * The live quality gate: what is wrong with the picture right now.
   * @param h {fps, faceW, cx, cy}  (fps 0 or missing: not known yet; faceW: face width / picture width; cx, cy: middle of the eyes)
   * @returns [{id:'fps'|'small'|'offcentre', short, text}]  short goes on the camera widget, text into a card or a toast
   */
  function cameraQuality(h = {}) {
    const out = [];
    if (h.fps > 0 && h.fps < QUALITY.minFps) out.push({ id: 'fps', short: `Slow camera (${Math.round(h.fps)} fps): more light helps`, text: `The camera gives only ${Math.round(h.fps)} pictures a second. More light helps: face a window or a lamp.` });
    if (h.faceW > 0 && h.faceW < QUALITY.faceMinW) out.push({ id: 'small', short: 'Sit closer', text: 'Your face is small in the picture. Sit closer to the screen.' });
    if ((Number.isFinite(h.cx) && Math.abs(h.cx - 0.5) > QUALITY.offX) || (Number.isFinite(h.cy) && (h.cy < QUALITY.cyMin || h.cy > QUALITY.cyMax))) out.push({ id: 'offcentre', short: 'Move to the middle of the picture', text: 'Your face is near the edge of the picture. Move, or tilt the screen, until it is in the middle of the camera box.' });
    return out;
  }
  /**
   * What the camera saw over a calibration, from CalibrationRun's raw record (run.raw: per dot, every frame).
   * Head movement is measured over the eye dots only (the head segment asks for movement).
   * @returns {{frames, fps, lostShare, blinkShare, headMove, sizeChange, cx, cy, s, unsettled}}
   */
  function calibrationHealth(raw) {
    const med = (a) => { const b = a.slice().sort((p, q) => p - q); return b.length ? b[b.length >> 1] : NaN; };
    let frames = 0, lost = 0, blink = 0, ms = 0, unsettled = 0;
    const cx = [], cy = [], ss = [];
    for (const d of raw || []) {
      const st = d.stream || [];
      if (d.seg !== 'head' && d.settled === false) unsettled++;
      for (let i = 0; i < st.length; i++) {
        const fr = st[i];
        frames++;
        if (i && st[i].t - st[i - 1].t < 1000) ms += st[i].t - st[i - 1].t;
        if (!fr.face) { lost++; continue; }
        if (fr.blink) blink++;
        if (d.seg !== 'head' && fr.head) { cx.push(fr.head.cx); cy.push(fr.head.cy); ss.push(fr.head.s); }
      }
    }
    const mx = med(cx), my = med(cy), msz = med(ss), q = (a, p) => { const b = a.slice().sort((u, v) => u - v); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : NaN; };
    // The 95th percentile of the distance from the usual place: one stray frame is not a moved head.
    const headMove = cx.length ? q(cx.map((v, i) => Math.hypot(v - mx, cy[i] - my)), 0.95) : NaN;
    const sizeChange = ss.length && msz > 0 ? q(ss.map((v) => Math.abs(v / msz - 1)), 0.95) : NaN;
    return { frames, fps: ms > 0 ? Math.round(10 * 1000 * (frames - (raw || []).length) / ms) / 10 : 0, lostShare: frames ? lost / frames : 0, blinkShare: frames - lost > 0 ? blink / (frames - lost) : 0, headMove, sizeChange, cx: mx, cy: my, s: msz, unsettled };
  }
  /**
   * Advice for a poor result, chosen from what was measured.
   * @param h  calibrationHealth() plus {faceW} when the camera frame reports the face width
   * @returns [{id, text}], most likely cause first; a general line when nothing measurable was wrong
   */
  function trackingAdvice(h = {}) {
    const out = [], pct = (v) => Math.round(100 * v);
    const faceW = h.faceW > 0 ? h.faceW : h.s > 0 ? faceWidthFromEyes(h.s) : 0;
    for (const w of cameraQuality({ fps: h.fps, faceW, cx: h.cx, cy: h.cy })) out.push({ id: w.id, text: w.text });
    if (h.lostShare > QUALITY.lostShare) out.push({ id: 'lost', text: `The camera lost your face in ${pct(h.lostShare)} % of the pictures. Face the screen and put more light on your face.` });
    if (h.blinkShare > QUALITY.blinkShare) out.push({ id: 'blinks', text: `${pct(h.blinkShare)} % of the pictures were thrown away as blinks. If your eyes were open, the camera sees your lids too low: raise the screen or sit a little lower, and move a lamp that reflects in glasses.` });
    if (h.headMove > QUALITY.headMove || h.sizeChange > QUALITY.sizeChange) out.push({ id: 'moved', text: 'Your head moved while the dots were shown. Keep it still and follow the dot with your eyes only, until the screen asks for a head turn.' });
    if (!out.length) out.push({ id: 'general', text: 'Nothing was clearly wrong with the picture. Try once more with more light on your face and the screen at eye height.' });
    return out;
  }

  /** The noise figures the tracker runs with, from a calibration's accuracy: line-decoder sigmas and the fixation dispersion limit. */
  function trackingParams(acc) {
    return {
      sx: Math.max(25, acc.effX), sy: Math.max(18, acc.effY),
      // The detector compares the x range plus the y range of a window with this limit, so it has to
      // cover the frame scatter of both axes. (Until step 3 it was 2.2 x the larger scatter alone:
      // at ordinary noise that broke fixations up and left 4 frames in 10 outside any fixation.)
      dispersion: Math.max(60, Math.min(220, DISPERSION_K * (acc.precisionX + acc.precisionY))),
    };
  }
  const DISPERSION_K = 2.5;

  // ------------------------------------------------------------------ head gate
  // How far the head may be from where it was calibrated before tracking pauses. Model A knows
  // nothing about the head, so every movement lands in the gaze estimate; the head-frame models
  // compensate inside their gate. Each limit is where the benchmark's fixation error reaches twice
  // its value in the calibration posture (tests/bench/RESULTS.md, step 3d; the sweep is
  // `node tests/bench/gaze-bench.mjs --gate-sweep`), capped at 8 degrees, 8 cm and 12 cm of depth.
  // Synthetic camera: the limits are as good as its assumptions.
  //   yawDeg, pitchDeg, rollDeg   head rotation against the calibration pose
  //   xCm, yCm, zCm               sideways, up or down, towards or away from the screen
  //   box, size                   for a camera that gives no head pose: movement of the middle of the eyes as
  //                               a share of the picture, and change of the eye distance (about xCm and zCm)
  //
  // Model A's limits are NOT where its error doubles (0.9 degrees of yaw, 1.0 of pitch, 1.3 cm sideways,
  // 1.1 cm up or down, 0.02 of the picture: the figures of step 3d). A reader who sits exactly as
  // calibrated does not hold the head that still: with the head following the eyes a fifth of the way
  // (`--model A --set headFollow=0.2`) those limits paused 54 % of the frames of somebody who had not
  // moved, and 37 % with one degree of head wander. A pause for a reader who did nothing wrong is worse
  // than a larger error, so the limits below are the tightest tried that pause nobody sitting still
  // under either assumption (0 % gated) and still pause a real change of posture: a 5 degree head turn
  // (84 to 98 % of its frames) and a 3 cm lean (the sideways run of HEAD-SHIFT). Inside them model A
  // tracks with whatever error the movement brings; a 2 cm drift costs about 83 px against 42 px still
  // (RESULTS.md, "Sign-off").
  const HEAD_GATE = {
    A: { yawDeg: 3, pitchDeg: 2.5, rollDeg: 5, xCm: 2.5, yCm: 2, zCm: 6, box: 0.035, size: 0.1 },
    H: { yawDeg: 8, pitchDeg: 4.6, rollDeg: 8, xCm: 8, yCm: 4.6, zCm: 12, box: 0.08, size: 0.15 },
  };
  // Model A now takes the wide gate as well. Its own limits paused the whole of two ordinary reading tasks on a real
  // camera for a 3 degree change of head tilt (lab, 2026-11-21) while the estimate was still within a line; the line
  // decoder no longer needs the absolute height, so a pause is kept for a real change of posture only.
  const headGate = () => HEAD_GATE.H;   // model D follows the head too: the wide gate
  /** Head pose of a camera row: {yaw, pitch, roll} in rad, {tx, ty, tz} in cm; null without one. */
  function poseOf(f) {
    if (!f || !hasPose(f)) return null;
    const P = framePose(f);
    return { yaw: P.yaw, pitch: P.pitch, roll: P.roll, tx: P.t[0], ty: P.t[1], tz: P.t[2] };
  }
  /**
   * How far the head is from the calibration posture.
   * @param h   {cx, cy, s} of this frame   @param h0  calibHead of the calibration   @param f  this frame's camera row (optional)
   * @returns {{pose:boolean, yawDeg, pitchDeg, rollDeg, xCm, yCm, zCm}} (absolute values; null without a pose on both sides) and {box, size}
   */
  function headOffset(h, h0, f) {
    const out = { pose: false, yawDeg: null, pitchDeg: null, rollDeg: null, xCm: null, yCm: null, zCm: null, box: Math.hypot(h.cx - h0.cx, h.cy - h0.cy), size: Math.abs(h.s / h0.s - 1) };
    const P = h0.pose ? poseOf(f) : null;
    if (P) {
      const R2D = 180 / Math.PI;
      Object.assign(out, {
        pose: true, yawDeg: R2D * Math.abs(P.yaw - h0.yaw), pitchDeg: R2D * Math.abs(P.pitch - h0.pitch), rollDeg: R2D * Math.abs(P.roll - h0.roll),
        xCm: Math.abs(P.tx - h0.tx), yCm: Math.abs(P.ty - h0.ty), zCm: Math.abs(P.tz - h0.tz),
      });
    }
    return out;
  }
  /**
   * Has the head left the place it was calibrated in?
   * @param h, h0  {cx, cy, s} as extractFeatures reports them; h0 is the calibration's calibHead
   * @param f      this frame's camera row: with a head pose in it and in h0, rotation and cm are checked
   * @param kind   the gaze model in use ('A', or a head-frame model): picks the limits
   */
  function headMoved(h, h0, f, kind) {
    const g = headGate(kind), d = headOffset(h, h0, f);
    if (d.pose) return d.yawDeg > g.yawDeg || d.pitchDeg > g.pitchDeg || d.rollDeg > g.rollDeg || d.xCm > g.xCm || d.yCm > g.yCm || d.zCm > g.zCm;
    return d.box > g.box || d.size > g.size;
  }
  /**
   * Is the head, over a short run of frames, where a saved calibration was made? Used before a
   * saved calibration is put back in use. frames: [{face, blink, f, head}].
   * @returns {{ok:boolean, frames:number, moved:number}}  ok needs at least 5 face frames, most of them inside the gate
   */
  function headWithinGate(frames, h0, kind) {
    const face = frames.filter((fr) => fr && fr.face !== false && fr.head);
    const moved = face.filter((fr) => headMoved(fr.head, h0, fr.f, kind)).length;
    return { ok: face.length >= 5 && moved <= 0.5 * face.length, frames: face.length, moved };
  }
  // ---------------------------------------------------------- fixation detect
  /**
   * Online dispersion-threshold (I-DT) detector. Long fixations are emitted in
   * chunks of `maxDur` ms so downstream logic stays real-time.
   */
  class FixationDetector {
    constructor({ dispersion = 90, minDur = 120, maxDur = 350, maxGap = 160 } = {}) {
      Object.assign(this, { dispersion, minDur, maxDur, maxGap });
      this.win = null; this.hist = [];
    }
    reset() { this.win = null; this.hist = []; }
    _emit() {
      const w = this.win;
      if (!w || w.t1 - w.t0 < this.minDur) return null;
      return { x: w.sx / w.n, y: w.sy / w.n, t: w.t0, dur: w.t1 - w.t0, n: w.n };
    }
    _start(t, x, y) { this.win = { t0: t, t1: t, since: t, n: 1, sx: x, sy: y, minX: x, maxX: x, minY: y, maxY: y }; }
    /** The fixation in progress at time t, or null: {x, y, dur, n}. Long enough to count once dur >= minDur. */
    current(t) {
      const w = this.win;
      if (!w || t - w.t1 > this.maxGap) return null;
      return { x: w.sx / w.n, y: w.sy / w.n, dur: w.t1 - w.since, n: w.n };   // since: a long fixation is emitted in chunks, but it is one fixation
    }
    /** @returns completed fixation or null */
    push(t, x, y) {
      // median-of-3 pre-filter knocks out single-frame spikes
      this.hist.push([x, y]); if (this.hist.length > 3) this.hist.shift();
      if (this.hist.length === 3) {
        const xs = this.hist.map((p) => p[0]).sort((a, b) => a - b);
        const ys = this.hist.map((p) => p[1]).sort((a, b) => a - b);
        x = xs[1]; y = ys[1];
      }
      let out = null;
      const w = this.win;
      if (!w || t - w.t1 > this.maxGap) { out = this._emit(); this._start(t, x, y); return out; }
      const minX = Math.min(w.minX, x), maxX = Math.max(w.maxX, x);
      const minY = Math.min(w.minY, y), maxY = Math.max(w.maxY, y);
      if ((maxX - minX) + (maxY - minY) > this.dispersion) {
        out = this._emit(); this._start(t, x, y); return out;
      }
      Object.assign(w, { minX, maxX, minY, maxY, t1: t, n: w.n + 1, sx: w.sx + x, sy: w.sy + y });
      if (w.t1 - w.t0 >= this.maxDur) {
        out = this._emit();
        const cx = w.sx / w.n, cy = w.sy / w.n;
        this.win = { t0: t, t1: t, since: w.since, n: 1, sx: cx, sy: cy, minX: Math.min(cx, x), maxX: Math.max(cx, x), minY: Math.min(cy, y), maxY: Math.max(cy, y) };
      }
      return out;
    }
  }

  // ------------------------------------------------------------ line locking
  /**
   * Which line of a paragraph is being read, from the return sweeps and not from the height of the gaze.
   *
   * A webcam's up-and-down estimate is steady from one moment to the next (a few px) but its absolute
   * value is not to be trusted: on a real camera it sat one to three lines off after an ordinary change
   * of posture, it was squeezed towards the bottom of the screen, and it slid by about a line along each
   * line read (lab recordings of 2026-11-21). The jump back to the left margin survives all of that. So:
   *   - a return sweep (a leftward jump of more than SWEEP of the paragraph's width) starts a new line;
   *   - how many lines it moved is read from the height at the START of the new line against the height
   *     at the start of the line before (the same place across the page, so the slide along the line
   *     cancels), with a strong expectation of one line down; after going back the reader is
   *     expected to pick up below the furthest line read;
   *   - a hop into another line without a full sweep (back into the middle of the line above) is taken
   *     from a sudden change of height together with a leftward step;
   *   - otherwise the line stays between sweeps. Only the first line of a visit, which had no sweep to go by, is
   *     corrected when the gaze sits more than JUMP lines from where it began for JUMP_N fixations in a
   *     row. (Applied to every line this rule did harm: the height slides too far along a line.)
   *   - the first fixation in a paragraph takes the nearest line (less the offset learned so far), or
   *     the first line when the reader came in from above.
   * The name is kept from the hidden Markov model this replaced (it decoded the height directly and was
   * on the right line 36 to 55 % of the reading time on those recordings, against 92 to 100 % for this).
   */
  const LINE_START_N = 3, LINE_STEP_SIGMA = 0.8, LINE_SWEEP = 0.4, LINE_JUMP = 1.6, LINE_JUMP_N = 3;
  const LINE_STEP_PRIOR = new Map([[1, 0.75], [0, 0.1], [-1, 0.08], [2, 0.05], [-2, 0.02]]), LINE_STEP_OTHER = 0.004;
  const LINE_REFINE_N = 10, LINE_PAIR = 0.25;                // a line's own number is settled over its first fixations, paired within a quarter of the width
  const LINE_RESUME_PRIOR = 0.6;                             // after going back: picking up below the furthest line read
  // A hop: a jump to another line that is not a full sweep (back into the middle of the line above, say).
  // It needs a leftward step of HOP_BACK of the width together with a sudden change of height of HOP lines;
  // the slide of the height along a line is gradual and does not look like that.
  const LINE_HOP = 0.7, LINE_HOP_BACK = 0.15, LINE_HOP_SIGMA = 0.5;
  const LINE_HOP_PRIOR = new Map([[0, 0.3], [-1, 0.3], [1, 0.2], [-2, 0.1], [2, 0.1]]);
  const LINE_CONF_SETTLED = 0.9, LINE_CONF_STARTING = 0.5;   // the reader counts a backtrack only above 0.55
  class LineHMM {
    /** @param drift shared {y:number}: the gaze height at the start of the current line less that line's middle; pass the same object to every paragraph's decoder */
    constructor(drift = { y: 0 }) { this.drift = drift; this.reset(); }
    reset() { this.line = -1; this.run = null; this.prevX = null; this.prevY = null; this.off = 0; this.maxLine = -1; }

    /**
     * @param lines  [{top,bottom,left,right}] viewport coords, in reading order
     * @param fx,fy  fixation centroid
     * @param sx,sy  tracker error (px, 1σ) horizontally / vertically (not used: kept for the callers)
     * @param enteredFromAbove  hint used only when (re)initializing
     * @returns {{line:number, conf:number, returnSweep:boolean}}
     */
    update(lines, fx, fy, sx, sy, enteredFromAbove = false) {
      const n = lines.length;
      if (!n) return { line: -1, conf: 0, returnSweep: false };
      const mid = (j) => (lines[j].top + lines[j].bottom) / 2;
      const pitch = Math.max(1, n > 1 ? (mid(n - 1) - mid(0)) / (n - 1) : lines[0].bottom - lines[0].top);
      const width = Math.max(1, Math.max(...lines.map((l) => l.right)) - Math.min(...lines.map((l) => l.left)));
      const clampLine = (j) => Math.max(0, Math.min(n - 1, j));
      const begin = (base, hop) => { this.run = { ys: [fy], y: fy, pts: [], base, hop: !!hop, done: false, was: hop ? this.run : null }; this.off = 0; };
      let returnSweep = false;
      if (this.line < 0 || this.line >= n || !this.run) {
        let best = 0;
        if (!enteredFromAbove) for (let j = 1; j < n; j++) if (Math.abs(mid(j) - (fy - this.drift.y)) < Math.abs(mid(best) - (fy - this.drift.y))) best = j;
        this.line = best; begin(null);
      } else {
        const dx = fx - this.prevX;
        returnSweep = dx < -LINE_SWEEP * width;
        if (returnSweep) begin({ line: this.line, y: this.run.y, pts: this.run.pts, max: this.maxLine });
        else if (this.run.ys.length >= LINE_START_N && dx < -LINE_HOP_BACK * width && Math.abs(fy - this.prevY) > LINE_HOP * pitch) begin({ line: this.line, y: this.prevY, max: this.maxLine }, true);
        else if (this.run.ys.length < LINE_START_N) {
          this.run.ys.push(fy);
          const s = [...this.run.ys].sort((a, b) => a - b);
          this.run.y = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
        }
        const run = this.run;
        if (run.pts.length < LINE_REFINE_N) run.pts.push([fx, fy]);
        if (run.base && !run.done) {
          // Which line this is, from the height where it begins against the height where the line before
          // began (a hop: against the height just before it). After a sweep one line down is the strong
          // expectation, and after going back so is picking up below the furthest line read.
          // After a sweep the two lines are compared place by place across the page (each fixation against
          // the one nearest to it across the line before), so the slide of the height along a line cancels
          // and every further fixation sharpens the answer; without a neighbour, start against start.
          let d = (run.y - run.base.y) / pitch;
          if (!run.hop && run.base.pts && run.base.pts.length) {
            const ds = [];
            for (const [x, y] of run.pts) {
              let near = null;
              for (const q of run.base.pts) if (Math.abs(q[0] - x) <= LINE_PAIR * width && (!near || Math.abs(q[0] - x) < Math.abs(near[0] - x))) near = q;
              if (near) ds.push(y - near[1]);
            }
            if (ds.length) { ds.sort((a, b) => a - b); d = (ds.length % 2 ? ds[(ds.length - 1) / 2] : (ds[ds.length / 2 - 1] + ds[ds.length / 2]) / 2) / pitch; }
          }
          let pick = run.base.line, bestP = -1;
          for (let j = 0; j < n; j++) {
            const k = j - run.base.line;
            let p = run.hop ? LINE_HOP_PRIOR.get(k) || 0 : LINE_STEP_PRIOR.has(k) ? LINE_STEP_PRIOR.get(k) : LINE_STEP_OTHER;
            if (!run.hop && run.base.line < run.base.max && j === run.base.max + 1) p = Math.max(p, LINE_RESUME_PRIOR);
            const q = p * Math.exp(-0.5 * ((d - k) / (run.hop ? LINE_HOP_SIGMA : LINE_STEP_SIGMA)) ** 2);
            if (q > bestP) { bestP = q; pick = j; }
          }
          this.line = pick;
          if (run.hop ? run.ys.length >= LINE_START_N : run.pts.length >= LINE_REFINE_N) {
            run.done = true;
            if (run.hop && pick === run.base.line && run.was) this.run = run.was;   // not a change of line after all: the line's own start stays the reference
          }
        } else if (!run.base && run.ys.length >= LINE_START_N) {
          const dv = (fy - run.y) / pitch;
          if (Math.abs(dv) > LINE_JUMP) {
            if (++this.off >= LINE_JUMP_N) { this.line = clampLine(this.line + Math.round(dv)); begin(null); }
          } else this.off = 0;
        }
      }
      this.prevX = fx; this.prevY = fy;
      if (this.line > this.maxLine && (!this.run.base || this.run.ys.length >= LINE_START_N)) this.maxLine = this.line;
      this.drift.y = this.run.y - mid(this.line);
      return { line: this.line, conf: this.run.ys.length >= LINE_START_N ? LINE_CONF_SETTLED : LINE_CONF_STARTING, returnSweep };
    }
  }

  /** Collapse Range.getClientRects() fragments into one rect per visual line. */
  function mergeLineRects(rects) {
    const rs = Array.from(rects).filter((r) => r.width > 1 && r.height > 1)
      .map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }))
      .sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const r of rs) {
      const cy = (r.top + r.bottom) / 2;
      const h = r.bottom - r.top;
      const L = lines.find((l) => Math.abs((l.top + l.bottom) / 2 - cy) < 0.5 * Math.min(h, l.bottom - l.top));
      if (L) { L.top = Math.min(L.top, r.top); L.bottom = Math.max(L.bottom, r.bottom); L.left = Math.min(L.left, r.left); L.right = Math.max(L.right, r.right); }
      else lines.push({ ...r });
    }
    return lines.sort((a, b) => a.top - b.top);
  }

  // ------------------------------------------------- reading baseline and tau
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const TAU_MIN = 1.6, TAU_MAX = 3.0, TAU_DEFAULT = 2.0;

  /**
   * Personal struggle threshold from the reader's own line-to-line variability
   * during the baseline passage. A steady reader gets a tight threshold (help
   * arrives sooner); an erratic one gets a loose threshold, so their normal
   * variation is not mistaken for trouble.
   * @param cv coefficient of variation of per-line ms-per-word
   */
  function tauFromCv(cv) {
    if (!Number.isFinite(cv) || cv < 0) cv = 0;
    return clamp(TAU_MIN + (TAU_MAX - TAU_MIN) * (cv / 0.6), TAU_MIN, TAU_MAX);
  }

  /**
   * Turn one read of the baseline passage into the reader's baseline.
   * @param lines       [{words, dwellMs}] per visual line, from gaze
   * @param clockMs     wall-clock time the passage was on screen
   * @param totalWords  words in the passage
   * @param regressions confident jumps back to an earlier line
   */
  function summarizeBaseline({ lines = [], clockMs = 0, totalWords = 0, regressions = 0 }) {
    const seen = lines.filter((l) => l.dwellMs > 0 && l.words > 0);
    const gazeMs = seen.reduce((a, l) => a + l.dwellMs, 0);
    const gazeWords = seen.reduce((a, l) => a + l.words, 0);
    const covered = lines.length ? seen.length / lines.length : 0;
    const gazeOk = covered >= 0.6 && clockMs > 0 && gazeMs >= 0.5 * clockMs && gazeMs <= 1.3 * clockMs && gazeWords > 0;
    const source = gazeOk ? 'gaze' : 'clock';
    const ms = gazeOk ? gazeMs : clockMs;
    const words = gazeOk ? gazeWords : totalWords;
    const wpm = clamp(ms > 0 ? words / (ms / 60000) : 0, 40, 600);

    // Very short lines (the tail of a paragraph) give wild ms-per-word values.
    const rates = seen.filter((l) => l.words >= 3).map((l) => l.dwellMs / l.words);
    let cv = 0;
    if (rates.length >= 3) {
      const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
      const sd = Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length);
      cv = mean > 0 ? sd / mean : 0;
    }
    return {
      wpm, msPerWord: 60000 / wpm, cv, regressionRate: lines.length ? regressions / lines.length : 0,
      tau: tauFromCv(cv), words: totalWords, lines: lines.length, ms: Math.round(ms), source,
    };
  }

  /**
   * Is the reader struggling right now? Times are compared with what this
   * reader's baseline pace predicts; tau is how many times slower counts.
   * @returns {{reason: null|'stuck-line'|'rereading'|'slow-paragraph', severity: number, ratio: number}}
   */
  function struggleDecision({ onLineMs = 0, expLineMs = 0, paraMs = 0, expParaMs = 0, finished = false, backtracks = 0, tau = TAU_DEFAULT, regressionRate = 0 }) {
    const lineRatio = expLineMs > 0 ? onLineMs / expLineMs : 0;
    const paraRatio = !finished && expParaMs > 0 ? paraMs / expParaMs : 0;
    const ratio = Math.max(lineRatio, paraRatio);
    const needBack = regressionRate > 0.35 ? 3 : 2;   // habitual re-readers need one more jump back
    let reason = null, severity = 0;
    if (onLineMs > Math.max(2000, tau * expLineMs)) {
      reason = 'stuck-line';
      severity = Math.min(1, onLineMs / (3 * tau * Math.max(expLineMs, 600)));
    } else if (backtracks >= needBack) {
      reason = 'rereading';
      severity = Math.min(1, backtracks / (needBack + 2));
    } else if (!finished && paraMs > Math.max(4000, 1.1 * tau * expParaMs)) {
      reason = 'slow-paragraph';
      severity = Math.min(1, paraMs / (2.5 * tau * Math.max(expParaMs, 1)));
    }
    return { reason, severity, ratio };
  }

  const api = {
    extractFeatures, Ridge, OneEuro, FixationDetector, LineHMM, mergeLineRects, solve,
    poseFromMatrix, rotation, frameHit, mapFeatures, poseOffset, buildGeo, fitKind, refitModel, MODEL_KINDS: ['A'].concat(CANDIDATES),
    FEATURE_COUNT, BASE_FEATURE_COUNT, FEATURE_INDEX: F,
    fitCalibration, calibrationProblem, trimTrain, accuracyFrom, accuracyFromDots, summarizeDots, trackingParams, CAL_POINTS, VAL_POINTS,
    CalibrationRun, reviewDots, betterShowing, streamStill, streamMoved, StreamNoise, accuracyGrade, HEAD_POINTS, HEAD_TEXT, TYPICAL_LINE_PITCH,
    headMoved, headOffset, headWithinGate, headGate, HEAD_GATE, poseOf, BlinkDetector, markBlinks,
    CHECK_POINTS, APPROX_PX_PER_DEG, validationGrade, validationResult, arrivalTrim, cameraQuality, calibrationHealth, trackingAdvice, faceWidthFromEyes, QUALITY,
    clickUsable, liveClicks, CLICK_SIGMAS, CLICK_TTL_MS,
    tauFromCv, summarizeBaseline, struggleDecision, TAU_MIN, TAU_MAX, TAU_DEFAULT,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GazeCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
