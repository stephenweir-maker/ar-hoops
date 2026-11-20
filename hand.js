// AR Hoops — hand throw: camera frame grabber (WebGL) + throw-gesture detector (pure, testable)

// ---------------------------------------------------------------------------
// Throw detector. Feed it hand landmarks (MediaPipe, normalised 0..1, y down)
// once per detection. It works out when you "throw" toward the camera's view:
// the hand rests briefly (wind-up), then moves fast upward and/or away
// (getting smaller in the picture). Fast throws often blur the hand out of
// the picture, so a hand that vanishes mid-throw also counts as a release.
// ---------------------------------------------------------------------------
export function makeHandTracker() {
  return {
    hist: [], stillSince: null, armed: false, launch: null,
    lastSeen: -1, cooldownUntil: 0, flipVotes: 0, flipY: false,
    pos: null,       // last palm position {x,y} (flip applied), for drawing the held ball
  };
}

const PALM = [0, 5, 9, 13, 17];

export function updateHand(st, t, lm) {
  if (!lm) {
    // Hand gone. If it vanished while moving into a throw, release it.
    if (st.launch && st.launch.f > 0.9 && t - st.lastSeen < 0.3) {
      const L = st.launch; st.launch = null; st.armed = false; st.stillSince = null;
      st.cooldownUntil = t + 0.6; st.hist.length = 0;
      return { event: 'throw', power: clampPower(L.f + 0.4), side: clampSide(L.vx), via: 'vanish' };
    }
    if (t - st.lastSeen > 0.3) { st.armed = false; st.stillSince = null; st.launch = null; st.hist.length = 0; st.pos = null; }
    return { event: 'none' };
  }

  let cx = 0, cy = 0;
  for (const i of PALM) { cx += lm[i].x; cy += lm[i].y; }
  cx /= PALM.length; cy /= PALM.length;
  const size = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 1e-3;
  // fingers above wrist = upright picture. Picture may come through upside down.
  const upright = lm[12].y < lm[0].y;
  if (st.flipY) cy = 1 - cy;
  st.lastSeen = t;
  st.pos = { x: cx, y: cy };

  st.hist.push({ t, cx, cy, size });
  while (st.hist.length && st.hist[0].t < t - 0.4) st.hist.shift();

  // velocity over the last ~0.12 s
  let ref = st.hist[0];
  for (const h of st.hist) { if (h.t <= t - 0.1) ref = h; }
  const dt = t - ref.t;
  let vx = 0, vup = 0, grow = 0;
  if (dt > 0.03) {
    vx = (cx - ref.cx) / dt;
    vup = -(cy - ref.cy) / dt;
    grow = (size - ref.size) / ref.size / dt;
  }
  const speed = Math.hypot(vx, vup);
  const still = speed < 0.9 && Math.abs(grow) < 1.5;

  if (still) {
    // learn picture orientation only while the hand is held still
    // (raw landmarks: fingers above wrist most of the time = picture is the right way up)
    st.flipVotes = Math.max(-20, Math.min(20, st.flipVotes + (upright ? 1 : -1)));
    const want = st.flipVotes <= -6 ? true : st.flipVotes >= 6 ? false : st.flipY;
    if (want !== st.flipY) { st.flipY = want; st.hist.length = 0; st.stillSince = null; return { event: 'seen', x: cx, y: 1 - cy }; }
    if (st.stillSince == null) st.stillSince = t;
  } else st.stillSince = null;

  if (!st.armed && st.stillSince != null && t - st.stillSince > 0.12 && t > st.cooldownUntil) st.armed = true;

  // thrust: upward in the picture, plus moving away (hand shrinking)
  const f = vup + Math.max(0, -grow) * 0.5;
  if (st.armed) {
    if (f > 0.7 && vup > 0.2) {
      if (!st.launch) st.launch = { f, vx, t0: t };
      else if (f > st.launch.f) { st.launch.f = f; st.launch.vx = vx; }
    }
    const L = st.launch;
    // release at the peak of the swing: speed has dropped off, or ~0.2 s into it
    if (L && L.f > 1.6 && (f < L.f * 0.8 || t - L.t0 > 0.2)) {
      st.armed = false; st.launch = null; st.stillSince = null;
      st.cooldownUntil = t + 0.6; st.hist.length = 0;
      return { event: 'throw', power: clampPower(L.f), side: clampSide(L.vx), via: 'motion' };
    }
    // drifted back to still without throwing: cancel partial launch
    if (still) st.launch = null;
  }
  return { event: st.armed ? 'hold' : 'seen', x: cx, y: cy };
}

function clampPower(f) { return Math.max(0, Math.min(1, (f - 1.0) / 3.5)); }
function clampSide(vx) { return Math.max(-1, Math.min(1, vx / 2.2)); }

// ---------------------------------------------------------------------------
// Camera grabber: copies the WebXR camera texture into a small picture we can
// hand to the hand tracker. Uses its own tiny WebGL program on three's context;
// call renderer.resetState() afterwards.
// ---------------------------------------------------------------------------
export class CameraGrabber {
  constructor(gl, maxSide = 256) {
    this.gl = gl; this.maxSide = maxSide; this.w = 0; this.h = 0;
    const vs = `#version 300 es
      out vec2 uv;
      void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
    const fs = `#version 300 es
      precision mediump float; uniform sampler2D tex; in vec2 uv; out vec4 o;
      void main(){ o = vec4(texture(tex, uv).rgb, 1.0); }`;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p; this.loc = gl.getUniformLocation(p, 'tex');
    this.vao = gl.createVertexArray();
    this.fbo = gl.createFramebuffer(); this.tex = gl.createTexture();
  }
  _size(cw, ch) {
    const a = cw / ch; let w, h;
    if (a >= 1) { w = this.maxSide; h = Math.round(this.maxSide / a); } else { h = this.maxSide; w = Math.round(this.maxSide * a); }
    if (w === this.w && h === this.h) return;
    const gl = this.gl; this.w = w; this.h = h;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    this.buf = new Uint8Array(w * h * 4);
    this.img = new ImageData(w, h);
  }
  // camTex: WebGLTexture from XRWebGLBinding.getCameraImage(). Returns ImageData (top row first).
  grab(camTex, camW, camH) {
    const gl = this.gl;
    this._size(camW, camH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.useProgram(this.prog); gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, camTex); gl.uniform1i(this.loc, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, this.buf);
    gl.bindVertexArray(null); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // Rows come out in texture order (row 0 = texture's first row = top of a normally stored
    // image). If the camera picture is stored the other way up, the tracker's auto-flip fixes it.
    this.img.data.set(this.buf);
    return this.img;
  }
}
