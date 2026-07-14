/* =============================================================================
 *  weapon.js  —  The shotgun. A self-contained view-model + feedback module.
 *
 *  Owns its own animation state (recoil, walk-bob, muzzle flash) and a
 *  procedurally-synthesized blast (WebAudio — no asset files). It draws into
 *  the same low-res buffer as the walls so it upscales with matching chunky
 *  pixels. The engine knows nothing about it; app.js drives it:
 *      shotgun.fire()                  on the spacebar edge
 *      shotgun.update(dt, moving)      each frame
 *      shotgun.render(ctx, W, H)       after the scene is blitted
 *
 *  Hung off a global (Weapon) so it loads with a plain <script> tag.
 * ===========================================================================*/
const Weapon = (function () {
  "use strict";

  // --- Procedural blast (WebAudio) ------------------------------------------
  // Lazily created so the AudioContext starts inside a user gesture (the shot).
  let actx = null;
  function audio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
    }
    if (actx.state === "suspended") actx.resume();
    return actx;
  }

  function boom() {
    const ac = audio();
    if (!ac) return;
    const now = ac.currentTime;

    // Body of the blast: a short white-noise burst, low-passed with a falling
    // cutoff so it opens bright and closes dark — the classic "crack → thud".
    const dur = 0.32;
    const buf = ac.createBuffer(1, (ac.sampleRate * dur) | 0, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    const src = ac.createBufferSource(); src.buffer = buf;
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(3200, now);
    lp.frequency.exponentialRampToValueAtTime(360, now + 0.26);

    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.7, now + 0.004);   // sharp attack
    g.gain.exponentialRampToValueAtTime(0.0006, now + dur);  // long decay

    src.connect(lp); lp.connect(g); g.connect(ac.destination);
    src.start(now); src.stop(now + dur);

    // Low-end thump for weight: a quick pitch-dropping sine.
    const osc = ac.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(46, now + 0.16);
    const g2 = ac.createGain();
    g2.gain.setValueAtTime(0.8, now);
    g2.gain.exponentialRampToValueAtTime(0.001, now + 0.19);
    osc.connect(g2); g2.connect(ac.destination);
    osc.start(now); osc.stop(now + 0.2);
  }

  // --- Muzzle flame ----------------------------------------------------------
  // A tall red flame with a white-hot core and flickering tongues, erupting
  // upward from the bore. m is intensity 1→0; u is the resolution scale.
  function drawFlame(ctx, x, y, m, u) {
    const R = (18 + 44 * m) * u;
    ctx.save();
    ctx.translate(x, y);

    // outer flame tongues, fanned upward, jittering each frame
    for (let i = 0; i < 7; i++) {
      const t = i / 6 - 0.5;
      const bx = t * R * 0.7;
      const tipx = t * R * 1.05 + (Math.random() - 0.5) * R * 0.3;
      const tipy = -R * (1.0 + 0.6 * Math.random());
      ctx.beginPath();
      ctx.moveTo(bx - R * 0.14, R * 0.15);
      ctx.lineTo(bx + R * 0.14, R * 0.15);
      ctx.lineTo(tipx, tipy);
      ctx.closePath();
      ctx.fillStyle = (i % 2)
        ? "rgba(255,55,20," + (0.8 * m) + ")"
        : "rgba(255,130,30," + (0.8 * m) + ")";
      ctx.fill();
    }

    // white-hot core, stretched vertically into a teardrop
    ctx.save();
    ctx.scale(1, 1.3);
    const g = ctx.createRadialGradient(0, -R * 0.1, 0, 0, -R * 0.1, R);
    g.addColorStop(0.00, "rgba(255,255,245," + m + ")");
    g.addColorStop(0.25, "rgba(255,220,120," + m + ")");
    g.addColorStop(0.55, "rgba(255,90,30," + (0.9 * m) + ")");
    g.addColorStop(1.00, "rgba(200,20,10,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, -R * 0.1, R, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  // --- Shotgun instance ------------------------------------------------------
  function createShotgun() {
    const FIRE_TIME = 0.42;   // recoil animation length (s)
    const COOLDOWN  = 0.55;   // pump-action minimum interval (s)

    let anim = 0;       // counts down over the recoil animation
    let cooldown = 0;   // counts down; can't fire until it hits 0
    let muzzle = 0;     // muzzle-flash intensity, 1 → 0
    let bobPhase = 0;   // walk-bob phase accumulator

    function fire() {
      if (cooldown > 0) return false;
      cooldown = COOLDOWN;
      anim = FIRE_TIME;
      muzzle = 1;
      boom();
      return true;
    }

    function update(dt, moving) {
      if (cooldown > 0) cooldown = Math.max(0, cooldown - dt);
      if (anim > 0)     anim     = Math.max(0, anim - dt);
      if (muzzle > 0)   muzzle   = Math.max(0, muzzle - dt * 9);  // ~0.11s flash
      if (moving)       bobPhase += dt * 8;                       // walk cadence
    }

    // Draw the view-model looking straight down the barrel: the breech fills
    // the foreground and the barrel foreshortens up to a muzzle near screen
    // centre — dark and near-silhouette but for a bright specular sight-rib
    // running up its length. Firing erupts a tall red flame from the bore.
    // Render height is a fixed 300; we scale by u = H/300 for any resolution.
    function render(ctx, W, H) {
      const u = H / 300;
      const kick = anim > 0 ? anim / FIRE_TIME : 0;   // 1 at shot → 0 at rest
      const GUN = 0.25;                               // overall view-model scale
      const bobX = Math.sin(bobPhase) * 3 * GUN * u;
      const bobY = Math.abs(Math.sin(bobPhase)) * 2.5 * GUN * u;
      const cx = W / 2 + bobX;

      // Perspective anchors. The base sits at the screen bottom and the barrel
      // rises GUN_H toward the muzzle, which stays below the horizon (H/2).
      // Recoil tips the muzzle up and drops the breech back.
      const GUN_H = 160 * GUN * u;                     // total rifle height (~40px)
      const nearY   = 300 * u + kick * 18 * GUN * u + bobY;
      const muzzleY = nearY - GUN_H - kick * 8 * GUN * u;
      const HALF_NEAR = 95 * GUN * u;   // base half-width (full base ~48px)
      const HALF_FAR  = 22 * GUN * u;   // barrel half-width at the muzzle
      const span = Math.max(1, nearY - muzzleY);

      const halfAt = y => {
        const t = Math.max(0, Math.min(1, (y - muzzleY) / span));  // 0 far → 1 near
        return HALF_FAR + (HALF_NEAR - HALF_FAR) * t;
      };
      const quad = (y0, y1, f0, f1, fill) => {
        const w0 = halfAt(y0) * f0, w1 = halfAt(y1) * f1;
        ctx.beginPath();
        ctx.moveTo(cx - w0, y0); ctx.lineTo(cx + w0, y0);
        ctx.lineTo(cx + w1, y1); ctx.lineTo(cx - w1, y1);
        ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
      };

      // Warm reddish muzzle light washing over the whole view.
      if (muzzle > 0.01) {
        ctx.fillStyle = "rgba(255,120,60," + (muzzle * 0.14).toFixed(3) + ")";
        ctx.fillRect(0, 0, W, H);
      }

      // --- barrel: near-black base, then a rounded-metal sheen (clipped) ---
      quad(muzzleY, nearY, 1, 1, "#141619");
      ctx.save();
      const wF = halfAt(muzzleY), wN = halfAt(nearY);
      ctx.beginPath();
      ctx.moveTo(cx - wF, muzzleY); ctx.lineTo(cx + wF, muzzleY);
      ctx.lineTo(cx + wN, nearY);   ctx.lineTo(cx - wN, nearY);
      ctx.closePath(); ctx.clip();
      const sheen = ctx.createLinearGradient(cx - HALF_NEAR, 0, cx + HALF_NEAR, 0);
      sheen.addColorStop(0.00, "#0d0e10");
      sheen.addColorStop(0.34, "#3a4048");
      sheen.addColorStop(0.50, "#22262b");
      sheen.addColorStop(0.68, "#14161a");
      sheen.addColorStop(1.00, "#0b0c0d");
      ctx.fillStyle = sheen;
      ctx.fillRect(cx - HALF_NEAR, muzzleY - 2, HALF_NEAR * 2, span + 4);
      ctx.restore();

      // --- bright sight-rib running up the top of the barrel ---
      const ribTop = muzzleY + span * 0.08;
      const ribBot = nearY   - span * 0.06;
      quad(ribTop, ribBot, 0.16, 0.22, "#8a929c");   // rib body
      quad(ribTop, ribBot, 0.05, 0.08, "#dfe6ec");   // hot specular core

      // --- pump grip (wood) with the light band seen in the reference ---
      const gy0 = muzzleY + span * 0.56;
      const gy1 = muzzleY + span * 0.72;
      quad(gy0, gy1, 1.16, 1.30, "#241809");
      quad(gy0 + (gy1 - gy0) * 0.30, gy0 + (gy1 - gy0) * 0.55, 1.18, 1.24, "#7a5326");

      // --- receiver / body at the very bottom ---
      const ry0 = muzzleY + span * 0.82;
      quad(ry0, nearY, 1.12, 1.06, "#171a1e");
      quad(ry0, ry0 + 3 * u, 1.12, 1.12, "#3a3f46");   // top edge catches light

      // --- muzzle flash: tall red flame from the bore ---
      if (muzzle > 0.01) drawFlame(ctx, cx, muzzleY, muzzle, u * GUN);
    }

    return { fire, update, render };
  }

  return { createShotgun };
})();
