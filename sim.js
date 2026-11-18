// AR Hoops — physics sim (no dependencies, testable in Node)
// World: metres, y up. Hoop local frame: origin on the floor under the backboard,
// local +z points toward the player, backboard face at local z = 0.

export const G = 9.81;
export const BALL_R = 0.12;

export function makeHoop(rimH = 1.6) {
  const R = 0.23;               // rim radius (real hoop ~0.23)
  return {
    x: 0, z: 0, floorY: 0, yaw: 0,
    rimH, R, tube: 0.012,
    rimZ: 0.15 + R,             // rim centre in front of the board
    boardW: 1.0, boardH: 0.66, boardT: 0.03,
    boardBottom: rimH - 0.14,
    poleZ: -0.32, poleR: 0.05,
  };
}

// --- frame helpers (yaw-only rotation) ---
function toLocal(h, p) {
  const dx = p.x - h.x, dz = p.z - h.z, c = Math.cos(h.yaw), s = Math.sin(h.yaw);
  return { x: c * dx - s * dz, y: p.y - h.floorY, z: s * dx + c * dz };
}
function toLocalVec(h, v) {
  const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
  return { x: c * v.x - s * v.z, y: v.y, z: s * v.x + c * v.z };
}
function toWorld(h, l) {
  const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
  return { x: h.x + c * l.x + s * l.z, y: l.y + h.floorY, z: h.z - s * l.x + c * l.z };
}
function toWorldVec(h, l) {
  const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
  return { x: c * l.x + s * l.z, y: l.y, z: -s * l.x + c * l.z };
}
export const frames = { toLocal, toLocalVec, toWorld, toWorldVec };

// Point the hoop so its front (local +z) faces a world position.
export function faceToward(h, px, pz) {
  // local +z in world is (sin yaw, cos yaw)
  h.yaw = Math.atan2(px - h.x, pz - h.z);
}

export function rimCentreWorld(h) {
  return toWorld(h, { x: 0, y: h.rimH, z: h.rimZ });
}

export function makeBall(pos, vel) {
  return {
    p: { ...pos }, v: { ...vel },
    age: 0, touchedRim: false, touchedBoard: false,
    scored: false, done: false, rest: 0,
  };
}

// Launch velocity from a swipe.
// camFwd: camera forward (world, unit). power 0..1 (swipe length). side -1..1 (swipe sideways).
// Aim assist nudges the horizontal direction toward the rim when roughly aimed at it.
export function throwVelocity(camPos, camFwd, power, side, hoop, assist = 0.45) {
  let yaw = Math.atan2(camFwd.x, camFwd.z);
  yaw -= side * 0.35;                         // up to ~20 degrees left/right
  if (hoop) {
    const rc = rimCentreWorld(hoop);
    const target = Math.atan2(rc.x - camPos.x, rc.z - camPos.z);
    let d = target - yaw;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    if (Math.abs(d) < 0.3) yaw += d * assist;
  }
  // Launch angle: 52 deg, tilted a little by where the phone points (look up = loftier).
  const pitch = Math.asin(Math.max(-1, Math.min(1, camFwd.y)));
  const ang = Math.max(0.6, Math.min(1.15, 0.9 + pitch * 0.35));
  let speed = 2.4 + Math.max(0, Math.min(1, power)) * 6.0;   // 2.4..8.4 m/s
  // Power assist: if close to the speed that drops it through the rim, pull toward it.
  if (hoop && assist > 0) {
    const rc = rimCentreWorld(hoop);
    const D = Math.hypot(rc.x - camPos.x, rc.z - camPos.z);
    const dy = rc.y + 0.03 - (camPos.y - 0.12);
    const den = 2 * Math.cos(ang) ** 2 * (D * Math.tan(ang) - dy);
    if (den > 0) {
      const ideal = Math.sqrt(G * D * D / den);
      const err = (speed - ideal) / ideal;
      if (Math.abs(err) < 0.16) speed += (ideal - speed) * assist;
    }
  }
  const hs = Math.cos(ang) * speed;
  return { x: Math.sin(yaw) * hs, y: Math.sin(ang) * speed, z: Math.cos(yaw) * hs };
}

// Advance one ball by dt. Returns array of events {type, strength, swish}.
export function stepBall(b, h, dt) {
  const ev = [];
  if (b.done) return ev;
  const n = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h_dt = dt / n;
  for (let i = 0; i < n; i++) subStep(b, h, h_dt, ev);
  b.age += dt;
  if (b.age > 7 || b.rest > 0.6) b.done = true;
  return ev;
}

function subStep(b, h, dt, ev) {
  const r = BALL_R;
  const prevLocal = h ? toLocal(h, b.p) : null;

  b.v.y -= G * dt;
  b.v.x *= 1 - 0.05 * dt; b.v.z *= 1 - 0.05 * dt;  // air drag (tiny)
  b.p.x += b.v.x * dt; b.p.y += b.v.y * dt; b.p.z += b.v.z * dt;

  const floorY = h ? h.floorY : 0;
  if (b.p.y - r < floorY) {
    b.p.y = floorY + r;
    if (b.v.y < 0) {
      const imp = -b.v.y;
      b.v.y = imp > 0.4 ? imp * 0.7 : 0;
      b.v.x *= 0.86; b.v.z *= 0.86;
      if (imp > 0.6) ev.push({ type: 'bounce', strength: Math.min(1, imp / 6) });
    }
    if (Math.abs(b.v.y) < 0.05) {
      b.v.x *= 1 - 2.5 * dt; b.v.z *= 1 - 2.5 * dt;   // rolling friction
      if (Math.hypot(b.v.x, b.v.z) < 0.08) b.rest += dt;
    }
  }
  if (!h) return;

  let l = toLocal(h, b.p);
  let lv = toLocalVec(h, b.v);
  let changed = false;

  // Backboard (box)
  {
    const hx = h.boardW / 2;
    const cx = Math.max(-hx, Math.min(hx, l.x));
    const cy = Math.max(h.boardBottom, Math.min(h.boardBottom + h.boardH, l.y));
    const cz = Math.max(-h.boardT, Math.min(0, l.z));
    let dx = l.x - cx, dy = l.y - cy, dz = l.z - cz;
    const d = Math.hypot(dx, dy, dz);
    if (d < r) {
      let nx, ny, nz;
      if (d > 1e-6) { nx = dx / d; ny = dy / d; nz = dz / d; } else { nx = 0; ny = 0; nz = 1; }
      l.x = cx + nx * r; l.y = cy + ny * r; l.z = cz + nz * r;
      const vn = lv.x * nx + lv.y * ny + lv.z * nz;
      if (vn < 0) {
        lv.x -= 1.6 * vn * nx; lv.y -= 1.6 * vn * ny; lv.z -= 1.6 * vn * nz;
        lv.x *= 0.92; lv.y *= 0.92;
        if (-vn > 0.4) ev.push({ type: 'board', strength: Math.min(1, -vn / 6) });
      }
      b.touchedBoard = true; changed = true;
    }
  }

  // Rim (torus)
  {
    const dx = l.x, dz = l.z - h.rimZ;
    const hl = Math.hypot(dx, dz);
    const ux = hl > 1e-6 ? dx / hl : 0, uz = hl > 1e-6 ? dz / hl : 1;
    const qx = ux * h.R, qy = h.rimH, qz = h.rimZ + uz * h.R;
    const ex = l.x - qx, ey = l.y - qy, ez = l.z - qz;
    const d = Math.hypot(ex, ey, ez);
    const minD = r + h.tube;
    if (d < minD && d > 1e-6) {
      const nx = ex / d, ny = ey / d, nz = ez / d;
      l.x = qx + nx * minD; l.y = qy + ny * minD; l.z = qz + nz * minD;
      const vn = lv.x * nx + lv.y * ny + lv.z * nz;
      if (vn < 0) {
        lv.x -= 1.5 * vn * nx; lv.y -= 1.5 * vn * ny; lv.z -= 1.5 * vn * nz;
        lv.x *= 0.9; lv.y *= 0.9; lv.z *= 0.9;
        if (-vn > 0.3) ev.push({ type: 'rim', strength: Math.min(1, -vn / 5) });
      }
      b.touchedRim = true; changed = true;
    }
  }

  // Pole (vertical cylinder behind the board) + arm is hidden behind board
  {
    const dx = l.x, dz = l.z - h.poleZ;
    const d = Math.hypot(dx, dz);
    const minD = r + h.poleR;
    if (l.y < h.boardBottom + 0.1 && d < minD && d > 1e-6) {
      const nx = dx / d, nz = dz / d;
      l.x = nx * minD; l.z = h.poleZ + nz * minD;
      const vn = lv.x * nx + lv.z * nz;
      if (vn < 0) {
        lv.x -= 1.5 * vn * nx; lv.z -= 1.5 * vn * nz;
        if (-vn > 0.4) ev.push({ type: 'pole', strength: Math.min(1, -vn / 5) });
      }
      changed = true;
    }
  }

  // Net drag: just under the rim, inside the cylinder
  {
    const dx = l.x, dz = l.z - h.rimZ;
    const hl = Math.hypot(dx, dz);
    if (l.y < h.rimH && l.y > h.rimH - 0.42 && hl < h.R) {
      const k = 1 - 6 * dt;
      lv.x *= k; lv.z *= k;
      if (lv.y < -1.5) lv.y *= 1 - 3 * dt;
      // gently centre in the net
      lv.x -= dx * 8 * dt; lv.z -= dz * 8 * dt;
      changed = true;
    }
  }

  // Score: centre passes down through the rim plane inside the ring
  if (!b.scored && prevLocal.y > h.rimH && l.y <= h.rimH && lv.y < 0) {
    const hl = Math.hypot(l.x, l.z - h.rimZ);
    if (hl < h.R) {
      b.scored = true;
      ev.push({ type: 'score', swish: !b.touchedRim && !b.touchedBoard, bank: b.touchedBoard && !b.touchedRim });
    }
  }

  if (changed) {
    const p = toWorld(h, l), v = toWorldVec(h, lv);
    b.p.x = p.x; b.p.y = p.y; b.p.z = p.z;
    b.v.x = v.x; b.v.y = v.y; b.v.z = v.z;
  }
}
