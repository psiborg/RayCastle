/* =============================================================================
 *  app.js  —  The DOM host. Owns everything the engine deliberately doesn't:
 *  canvas surfaces, resize, keyboard/mouse capture, pointer lock, the minimap,
 *  HUD readouts, the start/pause overlay, and the main loop. It translates raw
 *  browser input into the engine's abstract intent object and hands the engine
 *  a pixel buffer to draw into.
 *
 *  Depends on engine.js (the global RC) being loaded first.
 * ===========================================================================*/
(function () {
  "use strict";

  const engine = RC.createEngine();
  const shotgun = Weapon.createShotgun();

  // --- DOM references --------------------------------------------------------
  const screen  = document.getElementById("screen");
  const sctx    = screen.getContext("2d", { alpha: false });
  sctx.imageSmoothingEnabled = false;

  const mini    = document.getElementById("minimap");
  const mctx    = mini.getContext("2d");

  const overlay  = document.getElementById("overlay");
  const startBtn = document.getElementById("startBtn");

  const g_fps    = document.getElementById("g-fps");
  const g_x      = document.getElementById("g-x");
  const g_y      = document.getElementById("g-y");
  const g_dir    = document.getElementById("g-dir");
  const g_status = document.getElementById("g-status");

  // --- Render buffer ---------------------------------------------------------
  //  We draw the 3D view into a small internal buffer (DOOM-ish resolution) and
  //  let CSS upscale it with pixelated smoothing — faster, and authentically
  //  chunky. The engine writes into buf32; we blit it with putImageData.
  let frame = null;   // ImageData
  let buf32 = null;   // Uint32 view over frame.data

  function resize() {
    const wrap = document.getElementById("screen-wrap");
    const aspect = wrap.clientWidth / wrap.clientHeight;
    const RH = 300;
    const RW = Math.max(160, Math.round(RH * aspect));

    screen.width = RW;
    screen.height = RH;
    sctx.imageSmoothingEnabled = false;

    engine.setResolution(RW, RH);
    frame = sctx.createImageData(RW, RH);
    buf32 = new Uint32Array(frame.data.buffer);
  }
  window.addEventListener("resize", resize);

  // --- Input capture ---------------------------------------------------------
  const keys = Object.create(null);
  let mouseDX = 0;

  window.addEventListener("keydown", e => {
    keys[e.code] = true;
    if (e.code === "Escape") releasePointer();
    if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Space"].includes(e.code)) e.preventDefault();
    if (e.code === "Space" && !e.repeat && running) shotgun.fire();
  });
  window.addEventListener("keyup", e => { keys[e.code] = false; });

  document.addEventListener("mousemove", e => {
    if (document.pointerLockElement === screen) mouseDX += e.movementX;
  });

  // Scroll wheel = move forward/back. Accumulate here, apply in buildInput.
  // Normalize across deltaMode so line/page-based wheels match pixel wheels.
  let wheelAccum = 0;
  const DOLLY_SENS = 0.004;   // world units moved per pixel of scroll
  screen.addEventListener("wheel", e => {
    if (!running) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? screen.clientHeight : 1;
    wheelAccum += -e.deltaY * unit;   // scroll up (negative deltaY) => forward
    e.preventDefault();
  }, { passive: false });

  // Translate raw keys/mouse into the engine's abstract intent object, then
  // drain the accumulated mouse delta so it isn't applied twice.
  function buildInput() {
    const input = {
      forward:     keys["KeyW"] || keys["ArrowUp"],
      back:        keys["KeyS"] || keys["ArrowDown"],
      strafeLeft:  keys["KeyA"],
      strafeRight: keys["KeyD"],
      turnLeft:    keys["ArrowLeft"],
      turnRight:   keys["ArrowRight"],
      run:         keys["ShiftLeft"] || keys["ShiftRight"],
      mouseDX:     mouseDX,
      dolly:       wheelAccum * DOLLY_SENS,
    };
    mouseDX = 0;
    wheelAccum = 0;
    return input;
  }

  // --- Touch controls --------------------------------------------------------
  // On-screen D-pad + fire, shown only on touch devices via CSS. The D-pad
  // buttons drive the SAME keys[] state the keyboard uses (ArrowUp/Down move,
  // ArrowLeft/Right turn), so buildInput() needs no changes. Fire calls the
  // shotgun directly, exactly like the spacebar. Pointer events unify mouse and
  // touch; setPointerCapture keeps the release firing even if the finger slides
  // off the button, so a key can't get stuck "down".
  (function wireTouch() {
    function hold(el, onDown, onUp) {
      el.addEventListener("pointerdown", e => {
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        onDown();
      });
      const release = () => onUp();
      el.addEventListener("pointerup", release);
      el.addEventListener("pointercancel", release);
      el.addEventListener("lostpointercapture", release);
    }

    document.querySelectorAll("#touch .tbtn").forEach(btn => {
      const code = btn.getAttribute("data-key");
      hold(btn, () => { keys[code] = true; }, () => { keys[code] = false; });
    });

    const fireBtn = document.getElementById("fireBtn");
    if (fireBtn) {
      fireBtn.addEventListener("pointerdown", () => { if (running) shotgun.fire(); });
    }

    // Handedness toggle: flip the D-pad and fire button sides.
    const swapBtn = document.getElementById("swapBtn");
    const touchPane = document.getElementById("touch");
    if (swapBtn && touchPane) {
      swapBtn.addEventListener("click", () => touchPane.classList.toggle("flipped"));
    }
  })();

  // --- Pointer lock ----------------------------------------------------------
  function grabPointer()   { if (screen.requestPointerLock) screen.requestPointerLock(); }
  function releasePointer() {
    if (document.exitPointerLock) document.exitPointerLock();
    if (running) pause();
  }
  screen.addEventListener("click", () => { if (running) grabPointer(); });
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement === screen && !running) start();
  });

  // --- Minimap ---------------------------------------------------------------
  function renderMinimap() {
    const W = mini.width, H = mini.height;
    const cell = W / RC.MAP_W;
    const player = engine.player;

    mctx.clearRect(0, 0, W, H);
    mctx.fillStyle = "rgba(10,8,6,0.55)";
    mctx.fillRect(0, 0, W, H);

    for (let y = 0; y < RC.MAP_H; y++) {
      for (let x = 0; x < RC.MAP_W; x++) {
        const t = RC.MAP[y][x];
        if (t > 0) {
          mctx.fillStyle = RC.TILE_COLORS[t] || "#777";
          mctx.fillRect(x*cell, y*cell, cell+0.5, cell+0.5);
        }
      }
    }
    // player + facing
    const px = player.posX * cell, py = player.posY * cell;
    mctx.strokeStyle = "#ffb300"; mctx.lineWidth = 1.5;
    mctx.beginPath();
    mctx.moveTo(px, py);
    mctx.lineTo(px + player.dirX * cell * 2.4, py + player.dirY * cell * 2.4);
    mctx.stroke();
    mctx.fillStyle = "#fff";
    mctx.beginPath(); mctx.arc(px, py, 2, 0, Math.PI*2); mctx.fill();
  }

  // --- HUD -------------------------------------------------------------------
  let fpsAcc = 0, fpsFrames = 0, fpsTimer = 0;
  function updateHUD(dt) {
    fpsAcc += dt; fpsFrames++; fpsTimer += dt;
    if (fpsTimer >= 0.25) {
      g_fps.textContent = Math.round(fpsFrames / fpsAcc);
      fpsAcc = 0; fpsFrames = 0; fpsTimer = 0;
    }
    g_x.textContent = engine.player.posX.toFixed(1);
    g_y.textContent = engine.player.posY.toFixed(1);
    g_dir.textContent = Math.round(engine.facingDegrees()) + "\u00B0";
  }

  // --- Frame blit ------------------------------------------------------------
  function draw() {
    engine.renderScene(buf32);
    sctx.putImageData(frame, 0, 0);
    shotgun.render(sctx, engine.RW, engine.RH);
    renderMinimap();
  }

  // --- Main loop -------------------------------------------------------------
  let running = false;
  let last = 0;

  function loop(ts) {
    if (!running) return;
    let dt = (ts - last) / 1000;
    last = ts;
    if (dt > 0.05) dt = 0.05;          // clamp big pauses (tab switch)

    const input = buildInput();
    engine.update(dt, input);
    const moving = input.forward || input.back || input.strafeLeft ||
                   input.strafeRight || Math.abs(input.dolly) > 1e-4;
    shotgun.update(dt, moving);
    draw();
    updateHUD(dt);

    requestAnimationFrame(loop);
  }

  function start() {
    overlay.style.display = "none";
    g_status.textContent = "ACTIVE";
    g_status.style.color = "var(--tech)";
    running = true;
    last = performance.now();
    grabPointer();
    requestAnimationFrame(loop);
  }
  function pause() {
    running = false;
    overlay.style.display = "flex";
    overlay.querySelector("h1").innerHTML = 'PA<span>USED</span>';
    startBtn.textContent = "RESUME";
    g_status.textContent = "PAUSED";
    g_status.style.color = "var(--amber)";
  }

  startBtn.addEventListener("click", start);

  // --- Boot ------------------------------------------------------------------
  resize();
  draw();   // paint one frame behind the overlay so it isn't black
})();

// --- PWA: register the service worker ---------------------------------------
// Needs a secure context (https or localhost); silently skipped over file://.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
