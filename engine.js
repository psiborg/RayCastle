/* =============================================================================
 *  engine.js  —  Grid raycasting engine (Wolf3D-style DDA).
 *
 *  This module is DOM-free by design: no element lookups, no event listeners,
 *  no HUD. It owns world data, procedural textures, player physics, and the
 *  renderer. The host (app.js) talks to it through three things only:
 *    • an abstract input object passed to  update(dt, input)
 *    • a pixel buffer passed to           renderScene(buf32)
 *    • read-only getters (player, RW, RH, zbuf, facingDegrees)
 *
 *  Everything is hung off a single global namespace, RC, so the files can be
 *  loaded with plain <script> tags in order — no bundler, works over file://.
 * ===========================================================================*/
const RC = (function () {
  "use strict";

  // ===========================================================================
  //  THE MAP
  //  A grid maze. 0 = open floor. 1..N = wall of a given texture id.
  //  Laid out to feel like navigating a techbase: entry room, corridors,
  //  a couple of junctions, and dead-end nooks. 24 x 24.
  // ===========================================================================
  const MAP = [
    [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
    [1,0,0,0,0,0,0,2,2,2,0,0,0,0,3,3,3,0,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,2,0,0,0,0,0,0,3,0,0,0,0,0,0,0,0,1],
    [1,0,0,4,4,0,0,2,0,2,2,2,2,0,3,0,3,3,3,3,0,0,0,1],
    [1,0,0,4,0,0,0,0,0,2,0,0,0,0,0,0,0,0,0,3,0,0,0,1],
    [1,0,0,4,0,2,2,2,0,2,0,3,3,3,3,3,3,3,0,3,0,0,0,1],
    [1,0,0,0,0,2,0,0,0,0,0,3,0,0,0,0,0,3,0,0,0,4,4,1],
    [1,1,1,1,0,2,0,2,2,2,2,2,0,2,2,2,0,3,3,3,0,4,0,1],
    [1,0,0,0,0,0,0,2,0,0,0,0,0,2,0,0,0,0,0,3,0,4,0,1],
    [1,0,2,2,2,2,2,2,0,3,3,3,3,3,0,3,3,3,0,3,0,0,0,1],
    [1,0,2,0,0,0,0,0,0,3,0,0,0,0,0,3,0,0,0,0,0,0,0,1],
    [1,0,2,0,4,4,4,0,0,3,0,5,5,5,5,5,0,0,2,2,2,2,0,1],
    [1,0,0,0,4,0,0,0,0,0,0,5,0,0,0,5,0,0,2,0,0,0,0,1],
    [1,0,2,2,2,0,2,2,2,2,0,5,0,4,0,5,0,0,2,0,3,3,0,1],
    [1,0,2,0,0,0,0,0,0,2,0,5,0,4,0,0,0,0,0,0,3,0,0,1],
    [1,0,2,0,3,3,3,3,0,2,0,5,5,5,5,5,5,0,2,2,2,0,0,1],
    [1,0,0,0,3,0,0,0,0,0,0,0,0,0,0,0,5,0,2,0,0,0,0,1],
    [1,0,2,2,3,0,2,2,2,2,2,2,2,2,0,0,5,0,0,0,4,4,0,1],
    [1,0,0,0,0,0,2,0,0,0,0,0,0,2,0,3,5,3,0,0,0,4,0,1],
    [1,0,3,3,3,3,3,0,4,4,4,0,0,2,0,3,0,3,0,2,0,0,0,1],
    [1,0,3,0,0,0,0,0,4,0,4,0,0,0,0,3,0,0,0,2,0,2,2,1],
    [1,0,3,0,2,2,2,0,4,0,0,0,2,2,2,3,3,3,0,2,0,0,0,1],
    [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
    [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  ];
  const MAP_W = MAP[0].length;
  const MAP_H = MAP.length;

  // Per-tile colours for the minimap. Presentation-ish, but it's keyed to the
  // same tile ids the textures use, so it lives with the world data. Index by
  // tile id; 0 (floor) is never drawn.
  const TILE_COLORS = ["#000", "#6c675d", "#8a5a38", "#556b47", "#d4a017", "#a01e1e"];

  // ===========================================================================
  //  TEXTURES — generated procedurally so the engine has zero external deps.
  //  Each is a 64x64 offscreen canvas; we read its pixels into a flat Uint32
  //  array once, then sample columns during the raycast. (The canvas element
  //  here is used purely as a pixel buffer — never inserted into the DOM — so
  //  this stays a fair engine-side asset concern.)
  // ===========================================================================
  const TEX_SIZE = 64;
  const textures = {};   // id -> { data: Uint32Array, w, h }

  function makeTexture(id, paint) {
    const c = document.createElement("canvas");
    c.width = c.height = TEX_SIZE;
    const g = c.getContext("2d");
    paint(g, TEX_SIZE);
    const img = g.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
    // pack RGBA into Uint32 for fast per-pixel lookup
    const buf = new Uint32Array(TEX_SIZE * TEX_SIZE);
    const d = img.data;
    for (let i = 0; i < buf.length; i++) {
      buf[i] = (255 << 24) | (d[i*4+2] << 16) | (d[i*4+1] << 8) | d[i*4];
    }
    textures[id] = { data: buf, w: TEX_SIZE, h: TEX_SIZE };
  }

  // 1: STEEL TECH PANEL (grey, riveted)
  makeTexture(1, (g, s) => {
    g.fillStyle = "#5a564e"; g.fillRect(0,0,s,s);
    for (let y=0; y<s; y+=16) { g.fillStyle="#3a3730"; g.fillRect(0,y,s,2); }
    for (let x=0; x<s; x+=32) { g.fillStyle="#3a3730"; g.fillRect(x,0,2,s); }
    g.fillStyle = "#6c675d";
    for (let y=8; y<s; y+=16) for (let x=8; x<s; x+=16) { g.fillRect(x-1,y-1,2,2); }
    g.fillStyle = "#25231f"; g.fillRect(0,0,s,1); g.fillRect(0,s-1,s,1);
  });

  // 2: BROWN BRICK
  makeTexture(2, (g, s) => {
    g.fillStyle = "#5a3a24"; g.fillRect(0,0,s,s);
    const bh = 16, bw = 32;
    for (let row=0, y=0; y<s; row++, y+=bh) {
      const off = (row % 2) ? bw/2 : 0;
      for (let x=-bw; x<s; x+=bw) {
        const bx = x + off;
        const shade = 30 + ((x*7 + y*13) % 24);
        g.fillStyle = `rgb(${110+shade},${64+shade/2|0},${36+shade/3|0})`;
        g.fillRect(bx+1, y+1, bw-2, bh-2);
      }
    }
    g.fillStyle = "#2c1a10";               // mortar
    for (let y=0; y<s; y+=bh) g.fillRect(0,y,s,2);
    for (let row=0, y=0; y<s; row++, y+=bh) {
      const off = (row % 2) ? bw/2 : 0;
      for (let x=-bw; x<s+bw; x+=bw) g.fillRect(x+off,y,2,bh);
    }
  });

  // 3: TECHBASE GREEN (panels + light strip)
  makeTexture(3, (g, s) => {
    g.fillStyle = "#3c4a34"; g.fillRect(0,0,s,s);
    g.fillStyle = "#2f3a29";
    for (let y=0; y<s; y+=21) g.fillRect(0,y,s,3);
    g.fillStyle = "#556b47";
    g.fillRect(6,6,s-12,s-12);
    g.fillStyle = "#3c4a34"; g.fillRect(10,10,s-20,s-20);
    g.fillStyle = "#8fd06a";                // glowing light strip
    g.fillRect(s/2-2, 4, 4, s-8);
    g.fillStyle = "rgba(143,208,106,0.35)";
    g.fillRect(s/2-5, 4, 10, s-8);
  });

  // 4: HAZARD (warning stripes)
  makeTexture(4, (g, s) => {
    g.fillStyle = "#1a1712"; g.fillRect(0,0,s,s);
    g.strokeStyle = "#d4a017"; g.lineWidth = 10;
    for (let x=-s; x<s*2; x+=24) {
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + s, s); g.stroke();
    }
    g.fillStyle = "#0d0b08"; g.fillRect(0,0,s,6); g.fillRect(0,s-6,s,6);
  });

  // 5: BLOOD / RED TECH
  makeTexture(5, (g, s) => {
    g.fillStyle = "#3a1414"; g.fillRect(0,0,s,s);
    for (let y=0; y<s; y+=16) { g.fillStyle="#521c1c"; g.fillRect(0,y,s,8); }
    g.fillStyle = "#7a2626";
    for (let y=8; y<s; y+=16) for (let x=8; x<s; x+=16) g.fillRect(x-4,y-4,8,8);
    g.fillStyle = "#a01e1e"; g.fillRect(0,0,4,s); g.fillRect(s-4,0,4,s);
  });

  // ===========================================================================
  //  ENEMY SPRITES — procedural imp frames (RGBA, with alpha) baked once and
  //  shared across engines. Index: 0 alive · 1 hit · 2 falling · 3 corpse.
  // ===========================================================================
  const SPR = 64;
  function makeSprite(paint) {
    const c = document.createElement("canvas");
    c.width = c.height = SPR;
    const g = c.getContext("2d");
    paint(g, SPR);
    const img = g.getImageData(0, 0, SPR, SPR).data;
    const buf = new Uint32Array(SPR * SPR);   // pack real alpha in the high byte
    for (let i = 0; i < buf.length; i++) {
      buf[i] = (img[i*4+3] << 24) | (img[i*4+2] << 16) | (img[i*4+1] << 8) | img[i*4];
    }
    return { data: buf, w: SPR, h: SPR };
  }
  function ell(g, x, y, rx, ry, fill) {
    g.fillStyle = fill; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fill();
  }

  const SKIN = "#7a4a3a", SKIN_D = "#5a3428", SKIN_L = "#9a6450";
  const HORN = "#d8cbb0", CLAW = "#cdbfa0", MOUTH = "#3a0a0a", EYE = "#ffcf3d", GORE = "#8a1414";

  // shared upright body used by the alive + hit frames (lean shifts the pose)
  function impBody(g, cx, footY, headY, lean) {
    g.fillStyle = SKIN_D;                                   // legs
    g.fillRect(cx-9+lean, footY-18, 7, 18);
    g.fillRect(cx+2+lean, footY-18, 7, 18);
    g.fillStyle = "#20140f";                                // feet
    g.fillRect(cx-11+lean, footY-3, 9, 4);
    g.fillRect(cx+2+lean,  footY-3, 9, 4);
    g.fillStyle = SKIN;                                     // arms
    g.fillRect(cx-20+lean, headY+8, 8, 20);
    g.fillRect(cx+12+lean, headY+8, 8, 20);
    g.fillStyle = CLAW;                                     // claws
    for (let i = 0; i < 3; i++) {
      g.fillRect(cx-21+lean+i*3, headY+27, 2, 5);
      g.fillRect(cx+13+lean+i*3, headY+27, 2, 5);
    }
    ell(g, cx+lean, (footY-18+headY+18)/2, 15, 17, SKIN);   // torso
    ell(g, cx+lean, footY-22, 9, 9, SKIN_D);               // belly
    ell(g, cx+lean, headY, 12, 11, SKIN_L);                // head
    g.fillStyle = HORN;                                     // horns
    g.beginPath(); g.moveTo(cx-11+lean, headY-6); g.lineTo(cx-6+lean, headY-16); g.lineTo(cx-4+lean, headY-6); g.fill();
    g.beginPath(); g.moveTo(cx+11+lean, headY-6); g.lineTo(cx+6+lean, headY-16); g.lineTo(cx+4+lean, headY-6); g.fill();
  }

  const enemySprites = [
    // 0: alive — glaring imp
    makeSprite((g) => {
      const cx = SPR/2;
      impBody(g, cx, 60, 16, 0);
      ell(g, cx-5, 15, 3, 3, EYE); ell(g, cx+5, 15, 3, 3, EYE);
      ell(g, cx-5, 15, 1.2, 1.2, "#fff"); ell(g, cx+5, 15, 1.2, 1.2, "#fff");
      g.fillStyle = MOUTH; g.fillRect(cx-5, 21, 10, 3);
    }),
    // 1: hit — recoils, eyes blown wide, blood fleck
    makeSprite((g) => {
      const cx = SPR/2;
      impBody(g, cx, 60, 18, 3);
      ell(g, cx-5+3, 17, 3.4, 3.4, "#fff"); ell(g, cx+5+3, 17, 3.4, 3.4, "#fff");
      ell(g, cx-5+3, 17, 1.4, 1.4, MOUTH);  ell(g, cx+5+3, 17, 1.4, 1.4, MOUTH);
      g.fillStyle = MOUTH; g.fillRect(cx-6+3, 24, 12, 4);
      for (let i = 0; i < 6; i++) { const a = i*1.4; ell(g, cx+Math.cos(a)*20, 24+Math.sin(a)*16, 2, 2, GORE); }
    }),
    // 2: falling — crumpling low and wide
    makeSprite((g) => {
      const cx = SPR/2;
      ell(g, cx, 50, 20, 12, SKIN);
      ell(g, cx, 52, 12, 7, SKIN_D);
      ell(g, cx-10, 44, 8, 7, SKIN_L);
      g.fillStyle = HORN;
      g.beginPath(); g.moveTo(cx-18,42); g.lineTo(cx-22,34); g.lineTo(cx-14,40); g.fill();
      for (let i = 0; i < 8; i++) { const a = i*0.9; ell(g, cx+Math.cos(a)*24, 52+Math.sin(a)*8, 3, 2, GORE); }
    }),
    // 3: corpse — a flat pile in a blood pool
    makeSprite((g) => {
      const cx = SPR/2;
      ell(g, cx, 58, 26, 6, "#5a1a1a");
      ell(g, cx, 55, 20, 6, SKIN_D);
      ell(g, cx-6, 54, 8, 4, SKIN);
      g.fillStyle = HORN; g.fillRect(cx+8, 52, 8, 2);
      g.fillStyle = CLAW; g.fillRect(cx-16, 54, 5, 2);
    }),
  ];

  // ===========================================================================
  //  ENGINE INSTANCE
  //  createEngine() returns one self-contained world. Keeping it a factory
  //  (rather than module-level singletons) means you could run two independent
  //  views later, and keeps all mutable state neatly scoped.
  // ===========================================================================
  function createEngine() {

    // --- PLAYER STATE ---------------------------------------------------------
    //  posX/posY : float position in grid space
    //  dir       : unit direction vector
    //  plane     : camera plane, perpendicular to dir; its length sets the FOV
    //              (0.66 ≈ 66° horizontal FOV, DOOM's default feel)
    const player = {
      posX: 1.5, posY: MAP_H - 1.5,  // start in the open bottom-left corridor
      dirX: 0,   dirY: -1,           // facing "north" (up the map)
      planeX: 0.66, planeY: 0,
    };

    // Fail loud if a future map/spawn edit drops the player inside a wall.
    if (MAP[player.posY | 0][player.posX | 0] !== 0) {
      console.warn("[engine] spawn is inside a wall cell — check player.posX/posY");
    }

    // --- RENDER DIMENSIONS ----------------------------------------------------
    let RW = 0, RH = 0;               // internal render resolution
    let zbuf = new Float32Array(1);   // per-column wall depth (hook for sprites)

    function setResolution(w, h) {
      RW = w | 0; RH = h | 0;
      zbuf = new Float32Array(RW);
    }

    // --- ENTITIES -------------------------------------------------------------
    //  Billboard sprites in world space. Enemies chase the player when they
    //  have line of sight, then run a death state machine when killed.
    //  state: "idle" | "chase" | "hit" | "dying" | "dead"
    const entities = [
      { x: 1.5,  y: 8.5,  hp: 3, state: "idle", t: 0 },
      { x: 4.5,  y: 12.5, hp: 3, state: "idle", t: 0 },
      { x: 12.5, y: 16.5, hp: 3, state: "idle", t: 0 },
      { x: 19.5, y: 22.5, hp: 3, state: "idle", t: 0 },
      { x: 8.5,  y: 2.5,  hp: 3, state: "idle", t: 0 },
    ];
    const ENEMY_SPEED = 1.1;
    const ENEMY_R = 0.3;      // collision radius vs. walls

    // Unobstructed line of sight? Cast at the target and see if a wall is nearer.
    function canSee(ex, ey) {
      let dx = player.posX - ex, dy = player.posY - ey;
      const d = Math.hypot(dx, dy);
      if (d < 0.001) return true;
      dx /= d; dy /= d;
      const wall = castRay(ex, ey, dx, dy, d, false);
      return !wall.hit || wall.dist >= d - 0.02;
    }

    function updateEntities(dt) {
      for (const e of entities) {
        e.t += dt;
        if (e.state === "dead") continue;

        if (e.state === "hit") {                   // brief flinch, then resume
          if (e.t > 0.18) { e.state = "chase"; e.t = 0; }
          continue;
        }
        if (e.state === "dying") {                 // fall, then settle as a corpse
          if (e.t > 0.45) { e.state = "dead"; e.t = 0; }
          continue;
        }

        const dist = Math.hypot(player.posX - e.x, player.posY - e.y);
        if (e.state === "idle") {
          if (dist < 12 && canSee(e.x, e.y)) { e.state = "chase"; e.t = 0; }
          continue;
        }

        // chase: walk toward the player, stopping just short, sliding on walls
        if (dist > 0.9) {
          const dx = (player.posX - e.x) / dist, dy = (player.posY - e.y) / dist;
          const nx = e.x + dx * ENEMY_SPEED * dt;
          const ny = e.y + dy * ENEMY_SPEED * dt;
          if (MAP[e.y | 0][(nx + Math.sign(dx) * ENEMY_R) | 0] === 0) e.x = nx;
          if (MAP[(ny + Math.sign(dy) * ENEMY_R) | 0][e.x | 0] === 0) e.y = ny;
        }
      }
    }

    // Apply damage; returns true if this shot killed it.
    function damage(e, amount) {
      if (e.state === "dead" || e.state === "dying") return false;
      e.hp -= amount;
      e.t = 0;
      if (e.hp <= 0) { e.state = "dying"; return true; }
      e.state = "hit";
      return false;
    }

    // Which sprite frame a given entity should draw right now.
    function frameFor(e) {
      if (e.state === "dead")   return enemySprites[3];
      if (e.state === "dying")  return enemySprites[2];
      if (e.state === "hit")    return enemySprites[1];
      return enemySprites[0];
    }

    // --- MOVEMENT & PHYSICS ---------------------------------------------------
    function rotate(ang) {
      const cos = Math.cos(ang), sin = Math.sin(ang);
      const ndx = player.dirX * cos - player.dirY * sin;
      const ndy = player.dirX * sin + player.dirY * cos;
      player.dirX = ndx; player.dirY = ndy;
      const npx = player.planeX * cos - player.planeY * sin;
      const npy = player.planeX * sin + player.planeY * cos;
      player.planeX = npx; player.planeY = npy;
    }

    // collision-aware translation: check the destination cell per-axis (with a
    // small buffer so you don't clip through corners); slides along walls.
    const BUF = 0.18;
    function tryMove(nx, ny) {
      if (MAP[player.posY | 0][(nx + Math.sign(nx - player.posX) * BUF) | 0] === 0) player.posX = nx;
      if (MAP[(ny + Math.sign(ny - player.posY) * BUF) | 0][player.posX | 0] === 0) player.posY = ny;
    }

    // Sub-stepping cap for impulse moves (the scroll wheel), so a big burst of
    // scroll can't tunnel through a wall in a single frame.
    const DOLLY_STEP = 0.2;

    // input is an abstract intent object built by the host:
    //   { forward, back, strafeLeft, strafeRight, turnLeft, turnRight, run,
    //     mouseDX, dolly }
    //   dolly = signed distance impulse along the view direction (scroll wheel).
    function update(dt, input) {
      const run = input.run ? 1.8 : 1;
      const moveSpeed = 3.0 * run * dt;
      const turnSpeed = 2.4 * dt;

      let fx = 0, fy = 0;
      if (input.forward)     { fx += player.dirX; fy += player.dirY; }
      if (input.back)        { fx -= player.dirX; fy -= player.dirY; }
      if (input.strafeLeft)  { fx += player.dirY; fy -= player.dirX; }
      if (input.strafeRight) { fx -= player.dirY; fy += player.dirX; }

      const len = Math.hypot(fx, fy);
      if (len > 0) tryMove(player.posX + fx/len*moveSpeed, player.posY + fy/len*moveSpeed);

      if (input.turnLeft)  rotate(-turnSpeed);
      if (input.turnRight) rotate( turnSpeed);
      if (input.mouseDX)   rotate(input.mouseDX * 0.0026);

      // Scroll wheel: discrete forward/back impulse along the view direction,
      // collision-checked and sub-stepped so a fast scroll can't clip walls.
      if (input.dolly) {
        let remaining = input.dolly;
        while (Math.abs(remaining) > 1e-4) {
          const s = Math.max(-DOLLY_STEP, Math.min(DOLLY_STEP, remaining));
          tryMove(player.posX + player.dirX * s, player.posY + player.dirY * s);
          remaining -= s;
        }
      }

      updateEntities(dt);
    }

    // --- THE RAYCASTER --------------------------------------------------------
    //  (DDA algorithm — Lode Vandevenne's classic formulation.) For each screen
    //  column we shoot one ray, step through the grid until we hit a wall, then
    //  draw a vertical textured strip whose height is inversely proportional to
    //  the distance. Writes straight into the caller's Uint32 buffer.
    function renderScene(buf32) {
      // --- floor + ceiling as two flat bands with a little vertical gradient ---
      const half = RH >> 1;
      for (let y = 0; y < RH; y++) {
        let r, g, b;
        if (y < half) {                       // ceiling, darker toward the top
          const t = y / half;
          r = (18 + 22*t)|0; g = (16 + 20*t)|0; b = (14 + 18*t)|0;
        } else {                              // floor, lighter toward the bottom
          const t = (y - half) / half;
          r = (30 + 40*t)|0; g = (20 + 26*t)|0; b = (12 + 16*t)|0;
        }
        const px = (255<<24)|(b<<16)|(g<<8)|r;
        const row = y * RW;
        for (let x = 0; x < RW; x++) buf32[row + x] = px;
      }

      // --- walls ---
      for (let x = 0; x < RW; x++) {
        // ray direction for this column: dir + plane * cameraX, cameraX in [-1,1]
        const cameraX = 2 * x / RW - 1;
        const rayDirX = player.dirX + player.planeX * cameraX;
        const rayDirY = player.dirY + player.planeY * cameraX;

        let mapX = player.posX | 0;
        let mapY = player.posY | 0;

        // length of ray from one x/y-side to the next x/y-side
        const deltaDistX = (rayDirX === 0) ? 1e30 : Math.abs(1 / rayDirX);
        const deltaDistY = (rayDirY === 0) ? 1e30 : Math.abs(1 / rayDirY);

        let stepX, stepY, sideDistX, sideDistY;

        if (rayDirX < 0) { stepX = -1; sideDistX = (player.posX - mapX) * deltaDistX; }
        else             { stepX =  1; sideDistX = (mapX + 1 - player.posX) * deltaDistX; }
        if (rayDirY < 0) { stepY = -1; sideDistY = (player.posY - mapY) * deltaDistY; }
        else             { stepY =  1; sideDistY = (mapY + 1 - player.posY) * deltaDistY; }

        // DDA: march to the next grid line until we land in a wall cell
        let hit = 0, side = 0, tile = 1;
        while (hit === 0) {
          if (sideDistX < sideDistY) { sideDistX += deltaDistX; mapX += stepX; side = 0; }
          else                       { sideDistY += deltaDistY; mapY += stepY; side = 1; }
          if (mapX < 0 || mapY < 0 || mapX >= MAP_W || mapY >= MAP_H) { hit = 1; tile = 1; break; }
          tile = MAP[mapY][mapX];
          if (tile > 0) hit = 1;
        }

        // perpendicular distance (avoids the fisheye you'd get from euclidean dist)
        const perpDist = (side === 0)
          ? (sideDistX - deltaDistX)
          : (sideDistY - deltaDistY);
        zbuf[x] = perpDist;

        // strip height on screen
        const lineHeight = (RH / perpDist) | 0;
        let drawStart = (-lineHeight >> 1) + (RH >> 1);
        let drawEnd   = ( lineHeight >> 1) + (RH >> 1);
        if (drawStart < 0) drawStart = 0;
        if (drawEnd >= RH) drawEnd = RH - 1;

        // where exactly the wall was hit, for the texture x-coordinate
        let wallX = (side === 0)
          ? player.posY + perpDist * rayDirY
          : player.posX + perpDist * rayDirX;
        wallX -= Math.floor(wallX);

        const tex = textures[tile] || textures[1];
        let texX = (wallX * tex.w) | 0;
        if ((side === 0 && rayDirX > 0) || (side === 1 && rayDirY < 0)) texX = tex.w - texX - 1;

        // distance + side shading (E/W walls a touch darker → readable corners),
        // plus fog that fades distant walls toward the void colour
        const sideShade = (side === 1) ? 0.72 : 1.0;
        const fog = Math.max(0.15, Math.min(1, 1.9 / (1 + perpDist * perpDist * 0.010)));
        const shade = sideShade * fog;

        // step through the texture vertically
        const texStep = tex.h / lineHeight;
        let texPos = (drawStart - (RH >> 1) + (lineHeight >> 1)) * texStep;

        for (let y = drawStart; y <= drawEnd; y++) {
          let texY = texPos & (tex.h - 1);
          if (texY < 0) texY = 0;
          texPos += texStep;

          const c = tex.data[tex.h * texY + texX];
          let r = (c & 0xFF);
          let g = ((c >> 8) & 0xFF);
          let b = ((c >> 16) & 0xFF);
          r = (r * shade) | 0; g = (g * shade) | 0; b = (b * shade) | 0;
          buf32[y * RW + x] = (255<<24)|(b<<16)|(g<<8)|r;
        }
      }

      renderSprites(buf32);
    }

    // --- SPRITE RENDERER ------------------------------------------------------
    //  Billboards: transform each entity into camera space, then draw it as a
    //  screen-aligned quad. The zbuf written by the wall pass gives per-column
    //  depth, so a sprite column is skipped when a wall is nearer — that's what
    //  lets enemies hide correctly behind corners. Painter's order (far → near)
    //  handles sprite-vs-sprite overlap. Alpha is tested per texel so the
    //  transparent surround doesn't blot out the scene.
    function renderSprites(buf32) {
      // sort a copy far → near
      const order = entities.slice().sort((a, b) => {
        const da = (a.x - player.posX) ** 2 + (a.y - player.posY) ** 2;
        const db = (b.x - player.posX) ** 2 + (b.y - player.posY) ** 2;
        return db - da;
      });

      // inverse of the camera matrix [planeX dirX; planeY dirY]
      const invDet = 1.0 / (player.planeX * player.dirY - player.dirX * player.planeY);

      for (const e of order) {
        const spr = frameFor(e);
        const relX = e.x - player.posX;
        const relY = e.y - player.posY;

        // camera space: transformY is depth into the screen
        const transformX = invDet * (player.dirY * relX - player.dirX * relY);
        const transformY = invDet * (-player.planeY * relX + player.planeX * relY);
        if (transformY <= 0.08) continue;                 // behind the camera

        const spriteScreenX = ((RW / 2) * (1 + transformX / transformY)) | 0;

        // corpses lie on the floor: smaller and dropped toward the bottom
        const flat = (e.state === "dead");
        const hScale = flat ? 0.4 : 1.0;
        const vOffset = flat ? 0.42 : 0.0;                // fraction of a sprite height

        const spriteH = Math.abs((RH / transformY) | 0) * hScale;
        const spriteW = Math.abs((RH / transformY) | 0);
        const moveScreenY = (vOffset * (RH / transformY)) | 0;

        let drawStartY = (-spriteH / 2 + RH / 2 + moveScreenY) | 0;
        let drawEndY   = ( spriteH / 2 + RH / 2 + moveScreenY) | 0;
        let drawStartX = (-spriteW / 2 + spriteScreenX) | 0;
        let drawEndX   = ( spriteW / 2 + spriteScreenX) | 0;
        const y0 = Math.max(0, drawStartY), y1 = Math.min(RH - 1, drawEndY);
        const x0 = Math.max(0, drawStartX), x1 = Math.min(RW - 1, drawEndX);

        // same fog curve as the walls so sprites sit in the same light
        const fog = Math.max(0.15, Math.min(1, 1.9 / (1 + transformY * transformY * 0.010)));
        // white flash on the hit frame
        const flash = (e.state === "hit") ? 0.55 : 0;

        for (let x = x0; x <= x1; x++) {
          if (transformY >= zbuf[x]) continue;            // wall is nearer → occluded
          const texX = (((x - drawStartX) * spr.w) / spriteW) | 0;
          if (texX < 0 || texX >= spr.w) continue;

          for (let y = y0; y <= y1; y++) {
            const texY = (((y - drawStartY) * spr.h) / spriteH) | 0;
            if (texY < 0 || texY >= spr.h) continue;

            const c = spr.data[spr.h * texY + texX];
            const a = (c >>> 24) & 0xFF;
            if (a < 128) continue;                        // transparent texel

            let r = (c & 0xFF), g = ((c >> 8) & 0xFF), b = ((c >> 16) & 0xFF);
            r = (r * fog) | 0; g = (g * fog) | 0; b = (b * fog) | 0;
            if (flash) {
              r = (r + (255 - r) * flash) | 0;
              g = (g + (255 - g) * flash) | 0;
              b = (b + (255 - b) * flash) | 0;
            }
            buf32[y * RW + x] = (255<<24)|(b<<16)|(g<<8)|r;
          }
        }
      }
    }

    // --- READOUTS -------------------------------------------------------------
    // Compass heading in degrees, 0° = north/up, clockwise.
    function facingDegrees() {
      let deg = Math.atan2(player.dirY, player.dirX) * 180 / Math.PI;
      deg = (90 - deg);
      return ((deg % 360) + 360) % 360;
    }

    // Hitscan: cast a single ray from (ox,oy) along the UNIT direction (dx,dy)
    // and return the first thing struck — wall or entity, whichever is nearer.
    // Uses the same DDA as the renderer; distance is true/Euclidean because the
    // direction is unit length. Pass hitEntities=false to trace against walls
    // only (that's what line-of-sight uses, so enemies don't block each other).
    // Returns { hit:false } if nothing is struck within maxDist.
    function castRay(ox, oy, dx, dy, maxDist, hitEntities) {
      const limit = maxDist || 64;

      // --- walls (DDA) ---
      let mapX = ox | 0, mapY = oy | 0;
      const deltaDistX = dx === 0 ? 1e30 : Math.abs(1 / dx);
      const deltaDistY = dy === 0 ? 1e30 : Math.abs(1 / dy);
      let stepX, stepY, sideDistX, sideDistY, side = 0;

      if (dx < 0) { stepX = -1; sideDistX = (ox - mapX) * deltaDistX; }
      else        { stepX =  1; sideDistX = (mapX + 1 - ox) * deltaDistX; }
      if (dy < 0) { stepY = -1; sideDistY = (oy - mapY) * deltaDistY; }
      else        { stepY =  1; sideDistY = (mapY + 1 - oy) * deltaDistY; }

      let wall = null;
      for (;;) {
        if (sideDistX < sideDistY) { sideDistX += deltaDistX; mapX += stepX; side = 0; }
        else                       { sideDistY += deltaDistY; mapY += stepY; side = 1; }
        if (mapX < 0 || mapY < 0 || mapX >= MAP_W || mapY >= MAP_H) break;
        const dist = side === 0 ? sideDistX - deltaDistX : sideDistY - deltaDistY;
        if (dist > limit) break;
        const tile = MAP[mapY][mapX];
        if (tile > 0) {
          wall = { hit: true, dist, x: ox + dx * dist, y: oy + dy * dist, mapX, mapY, side, tile };
          break;
        }
      }

      if (hitEntities === false) return wall || { hit: false };

      // --- entities (ray vs. circle) ---
      // Project each entity onto the ray; if it sits ahead and within its own
      // radius of the line, solve for the near intersection distance.
      const R = 0.42;
      let best = wall;
      for (const e of entities) {
        if (e.state === "dead" || e.state === "dying") continue;   // can't shoot a corpse
        const ex = e.x - ox, ey = e.y - oy;
        const proj = ex * dx + ey * dy;                            // distance along the ray
        if (proj <= 0) continue;                                   // behind the muzzle
        const perp2 = (ex * ex + ey * ey) - proj * proj;           // squared miss distance
        if (perp2 > R * R) continue;                               // ray passes wide
        const back = Math.sqrt(R * R - perp2);
        const d = proj - back;                                     // near surface
        if (d < 0 || d > limit) continue;
        if (!best || d < best.dist) {
          best = { hit: true, dist: d, x: ox + dx * d, y: oy + dy * d, entity: e };
        }
      }

      return best || { hit: false };
    }

    return {
      player,
      setResolution,
      update,
      renderScene,
      facingDegrees,
      castRay,
      damage,
      entities,
      get RW() { return RW; },
      get RH() { return RH; },
      get zbuf() { return zbuf; },   // exposed for future sprite rendering
    };
  }

  // Public namespace
  return { MAP, MAP_W, MAP_H, TILE_COLORS, createEngine };
})();
