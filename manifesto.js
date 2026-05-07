// Fit the manifesto headline so it never overflows TARGET_FRAC × 100vh,
// while staying as large as possible. Bounded at TWO measurements
// (not an iterative search) — first a sqrt-based bulk scaling, then
// at most one linear cleanup pass for the rare case sqrt over- or
// under-corrects due to integer line counts.
//
// Why sqrt: total rendered text height scales roughly with the SQUARE
// of font-size (each line is shorter AND there are fewer chars per
// line, which compound). So the right one-shot adjustment to hit a
// target height is `font *= sqrt(target / current)`. A single linear
// cleanup pass nails it afterwards because at that point the line
// count is stable and height is linear in font-size.
//
// Other scripts that cache letter positions (per-letter glitch) listen
// for the `manifesto:fit` event so they can rebuild after the font-
// size changes.
const fitManifestoCopy = (() => {
  const TARGET_FRAC = 0.9; // never more than 90vh
  const SAFETY = 0.985; // 1.5% margin so we never sit exactly at the cap

  function applyScale(copy, ratio) {
    const currentPx = parseFloat(getComputedStyle(copy).fontSize);
    copy.style.fontSize = `${(currentPx * ratio).toFixed(2)}px`;
  }

  function fit() {
    const copy = document.querySelector(".manifesto__copy");
    if (!copy) return;
    // Reset any prior inline override so the CSS clamp's preferred
    // size is what we're measuring against.
    copy.style.fontSize = "";
    const target = window.innerHeight * TARGET_FRAC;

    // Pass 1: bulk correction with sqrt scaling.
    let measured = copy.scrollHeight;
    if (measured > target) {
      applyScale(copy, Math.sqrt(target / measured) * SAFETY);

      // Pass 2: if the sqrt correction landed slightly off (line-break
      // rounding can push us a few pixels over or under target), apply
      // a single linear cleanup. Bounded — no further iterations.
      measured = copy.scrollHeight;
      if (measured > target) {
        applyScale(copy, (target / measured) * SAFETY);
      }
    }

    window.dispatchEvent(new Event("manifesto:fit"));
  }

  fit();
  window.addEventListener("resize", fit);
  window.addEventListener("load", fit);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(fit);
  }
  return fit;
})();

// Mode toggle: swap the page between the default pink/green "art mode"
// and a white/green high-contrast mode. The button's label flips to
// describe the OPPOSITE mode (i.e., what clicking will do next).
(() => {
  const toggle = document.querySelector(".manifesto__mode-toggle");
  if (!toggle) return;
  const body = document.body;
  toggle.addEventListener("click", () => {
    const goingContrast = !body.classList.contains("is-contrast");
    body.classList.toggle("is-contrast", goingContrast);
    toggle.textContent = goingContrast ? "Art mode" : "High contrast";
    toggle.setAttribute("aria-pressed", goingContrast ? "true" : "false");
  });
})();

// Measure the rail's height once layout settles and expose it as
// --rail-h on .manifesto so the spread can size itself to
// (100vh - --rail-h), pushing the rail flush to the bottom of the
// first viewport on initial load. The robot's vertical anchor is
// handled purely in CSS (position: absolute; bottom: 0 within the
// spread), so no JS-side robot positioning is needed.
(() => {
  const align = () => {
    const manifesto = document.querySelector(".manifesto");
    const rail = document.querySelector(".manifesto__rail");
    if (!rail || !manifesto) return;
    const railHeight = rail.getBoundingClientRect().height;
    if (railHeight > 0) {
      manifesto.style.setProperty("--rail-h", `${railHeight}px`);
    }
  };

  align();
  window.addEventListener("load", align);
  window.addEventListener("resize", align);
  // Run once more after fonts settle so any line-height shifts in the
  // rail don't throw off the height measurement.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(align);
  }
})();

// Ghost clips drifting between "fear" and "utopia" — full 2D motion
// + touch/mouse drag to relocate.
//
// Each ghost is a particle with position (x, y), velocity (vx, vy), and
// rotation. On every rAF tick we integrate position by velocity, then:
//   • If the particle hits a wall, reverse the perpendicular velocity
//     component AND add a small random kick to the parallel component.
//     This gives the ping-pong feel while preventing trajectories from
//     becoming periodic / boring.
//   • Periodically (every ~1.8–6.3s, per-ghost) rotate the velocity
//     vector by a random small angle so the ghost can switch direction
//     mid-flight, not just at walls.
//   • Speed is clamped to a target band so bounce-jitter doesn't slowly
//     accelerate or stall a ghost.
// Rotation is a slow per-ghost sine wave (each with its own phase &
// frequency) — bounded ~±2.8° so ghosts stay legible.
//
// Drag: each <img> has pointer-events: auto + touch-action: none. On
// pointerdown we mark the ghost as `grabbed` and remember the cursor's
// offset within the ghost. On pointermove we slide the ghost so that
// offset stays under the cursor. On pointerup we release and reset
// the velocity to a fresh random direction so the ghost drifts away
// from its new spot. While `grabbed`, the physics tick skips the
// integrate / bounce / nudge steps for that ghost.
(() => {
  const ghosts = Array.from(document.querySelectorAll(".venn__ghost"));
  if (!ghosts.length) return;
  const venn = document.querySelector(".venn");
  if (!venn) return;

  const reducedMQ = window.matchMedia("(prefers-reduced-motion: reduce)");

  const SPEED_MIN = 50; // px/s — clamp lower bound so ghosts never stall
  const SPEED_MAX = 130; // px/s — clamp upper bound so they never get too zippy

  // Per-ghost mutable state.
  const state = ghosts.map(() => ({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    rotPhase: Math.random() * Math.PI * 2,
    rotFreq: 0.25 + Math.random() * 0.55, // rad/s sway frequency
    rotAmp: 1.2 + Math.random() * 1.6, // ±1.2°–±2.8° amplitude
    nextNudge: 0,
    grabbed: false,
    grabDx: 0, // pointer offset within the ghost on grab (in venn coords)
    grabDy: 0,
  }));

  function applyTransform(i, rotDeg) {
    const s = state[i];
    ghosts[i].style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0) rotate(${(rotDeg || 0).toFixed(2)}deg)`;
  }

  function randomVelocity() {
    const speed = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
    const angle = Math.random() * Math.PI * 2;
    return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
  }

  function seed() {
    ghosts.forEach((ghost, i) => {
      const sizeRem = 8 + Math.random() * 10; // 8–18rem
      const aspect = 0.6 + Math.random() * 0.6; // 0.6–1.2
      ghost.style.setProperty("--ghost-w", `${sizeRem.toFixed(2)}rem`);
      ghost.style.setProperty("--ghost-aspect", aspect.toFixed(2));

      const v = randomVelocity();
      state[i].vx = v.vx;
      state[i].vy = v.vy;
      state[i].nextNudge =
        performance.now() + 1800 + Math.random() * 4500;
    });
  }

  function placeRandomly() {
    const r = venn.getBoundingClientRect();
    ghosts.forEach((ghost, i) => {
      const w = ghost.offsetWidth;
      const h = ghost.offsetHeight;
      state[i].x = Math.random() * Math.max(0, r.width - w);
      state[i].y = Math.random() * Math.max(0, r.height - h);
      applyTransform(i, 0);
    });
  }

  seed();
  // Wait one frame so --ghost-w applies before we measure offsetWidth.
  requestAnimationFrame(placeRandomly);

  // ---- Drag ------------------------------------------------------------
  // Use Pointer Events so mouse, touch, and pen are all handled by one
  // path. Pointer capture keeps the move/up events flowing to the same
  // element even if the cursor leaves the image while dragging.
  ghosts.forEach((ghost, i) => {
    const onDown = (e) => {
      // Only handle the primary button / single touch.
      if (e.button !== undefined && e.button !== 0) return;
      const r = venn.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      state[i].grabbed = true;
      state[i].grabDx = px - state[i].x;
      state[i].grabDy = py - state[i].y;
      ghost.classList.add("is-grabbed");
      try {
        ghost.setPointerCapture(e.pointerId);
      } catch {
        /* setPointerCapture can throw if pointerId is gone — ignore. */
      }
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!state[i].grabbed) return;
      const r = venn.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const w = ghost.offsetWidth;
      const h = ghost.offsetHeight;
      const maxX = Math.max(0, r.width - w);
      const maxY = Math.max(0, r.height - h);
      // Clamp so the dragged ghost stays inside the venn box.
      state[i].x = Math.max(0, Math.min(maxX, px - state[i].grabDx));
      state[i].y = Math.max(0, Math.min(maxY, py - state[i].grabDy));
      // Apply immediately (don't wait for next physics tick) so the
      // drag feels stuck to the finger / cursor.
      applyTransform(i, 0);
    };

    const onUp = (e) => {
      if (!state[i].grabbed) return;
      state[i].grabbed = false;
      ghost.classList.remove("is-grabbed");
      // Re-randomize velocity so the ghost drifts away from its new
      // home in a fresh direction (rather than continuing whatever
      // pre-grab trajectory it had).
      const v = randomVelocity();
      state[i].vx = v.vx;
      state[i].vy = v.vy;
      try {
        ghost.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    ghost.addEventListener("pointerdown", onDown);
    ghost.addEventListener("pointermove", onMove);
    ghost.addEventListener("pointerup", onUp);
    ghost.addEventListener("pointercancel", onUp);
    ghost.addEventListener("lostpointercapture", onUp);
    // Suppress the browser's native image drag-and-drop ghost so it
    // doesn't fight our custom drag.
    ghost.addEventListener("dragstart", (e) => e.preventDefault());
  });

  if (reducedMQ.matches) return;

  // ---- Physics loop ---------------------------------------------------
  let bounds = venn.getBoundingClientRect();
  const onResize = () => {
    bounds = venn.getBoundingClientRect();
  };
  window.addEventListener("resize", onResize);

  let lastT = performance.now();
  function tick(t) {
    // Cap dt so a backgrounded tab returning doesn't teleport ghosts.
    const dt = Math.min(64, t - lastT) / 1000;
    lastT = t;

    for (let i = 0; i < state.length; i++) {
      const s = state[i];
      const ghost = ghosts[i];

      // Skip physics for grabbed ghosts — pointermove is driving the
      // transform directly.
      if (s.grabbed) continue;

      const w = ghost.offsetWidth;
      const h = ghost.offsetHeight;
      const maxX = Math.max(0, bounds.width - w);
      const maxY = Math.max(0, bounds.height - h);

      // Integrate
      s.x += s.vx * dt;
      s.y += s.vy * dt;

      // Bounce: reverse the perpendicular component, kick the
      // parallel one, so the post-bounce trajectory isn't a perfect
      // mirror of the pre-bounce one — produces the random
      // direction-switching feel.
      if (s.x < 0) {
        s.x = 0;
        s.vx = Math.abs(s.vx) * (0.85 + Math.random() * 0.3);
        s.vy += (Math.random() - 0.5) * 35;
      } else if (s.x > maxX) {
        s.x = maxX;
        s.vx = -Math.abs(s.vx) * (0.85 + Math.random() * 0.3);
        s.vy += (Math.random() - 0.5) * 35;
      }

      if (s.y < 0) {
        s.y = 0;
        s.vy = Math.abs(s.vy) * (0.85 + Math.random() * 0.3);
        s.vx += (Math.random() - 0.5) * 35;
      } else if (s.y > maxY) {
        s.y = maxY;
        s.vy = -Math.abs(s.vy) * (0.85 + Math.random() * 0.3);
        s.vx += (Math.random() - 0.5) * 35;
      }

      // Clamp speed to the target band.
      const sp = Math.hypot(s.vx, s.vy);
      if (sp > SPEED_MAX) {
        s.vx = (s.vx / sp) * SPEED_MAX;
        s.vy = (s.vy / sp) * SPEED_MAX;
      } else if (sp < SPEED_MIN && sp > 0) {
        s.vx = (s.vx / sp) * SPEED_MIN;
        s.vy = (s.vy / sp) * SPEED_MIN;
      }

      // Periodic mid-flight direction switch: rotate velocity by a
      // random small angle (±~25°). This is what gives "more random,
      // switching directions" beyond just edge-driven bounces.
      if (t > s.nextNudge) {
        const ang = (Math.random() - 0.5) * 0.9; // ±0.45 rad ≈ ±26°
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        const nvx = s.vx * c - s.vy * sn;
        const nvy = s.vx * sn + s.vy * c;
        s.vx = nvx;
        s.vy = nvy;
        s.nextNudge = t + 1800 + Math.random() * 4500;
      }

      // Slow rotation sway via per-ghost sine.
      const rot = Math.sin(s.rotPhase + (t / 1000) * s.rotFreq) * s.rotAmp;
      applyTransform(i, rot);
    }

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();

// Cursor-magnet for the manifesto inline image chips. When the cursor
// enters a chip's "field of influence", the chip drifts away from the
// cursor — the closer you get, the harder it pushes back. This composes
// with the existing CSS jitter animation via the --push-x / --push-y
// custom properties referenced inside the @keyframes.

(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;

  const chips = document.querySelectorAll(".manifesto__chip");
  if (chips.length === 0) return;

  const FIELD_PX = 220; // radius of magnet influence
  const STRENGTH_PX = 30; // max displacement at point-blank range
  const PIXEL_PX = 170; // radius at which the chip starts pixelating
  const FREEZE_AT = 0.15; // pixelize value that freezes the magnet

  let cursor = null;
  let rafId = null;

  function updateChips() {
    rafId = null;
    if (!cursor) return;

    for (const chip of chips) {
      const rect = chip.getBoundingClientRect();
      // Live (post-transform) centre — used for the magnet vector.
      const cxLive = rect.left + rect.width / 2;
      const cyLive = rect.top + rect.height / 2;
      const dxLive = cursor.x - cxLive;
      const dyLive = cursor.y - cyLive;
      const distLive = Math.hypot(dxLive, dyLive);

      // Static (pre-magnet) centre — subtract the chip's current
      // --push-x / --push-y. This is the chip's natural footprint
      // before the magnet displacement.
      const styles = getComputedStyle(chip);
      const pushX = parseFloat(styles.getPropertyValue("--push-x")) || 0;
      const pushY = parseFloat(styles.getPropertyValue("--push-y")) || 0;
      const cxStatic = cxLive - pushX;
      const cyStatic = cyLive - pushY;
      const distStatic = Math.hypot(
        cursor.x - cxStatic,
        cursor.y - cyStatic,
      );

      // Pixelize fires off whichever is CLOSER — the visible (live)
      // chip or its natural footprint. So whether the user follows
      // the chip with their cursor or just hovers over where the
      // chip "should be", the disintegrate triggers.
      const closer = Math.min(distLive, distStatic);
      let pixelize = 0;
      if (closer < PIXEL_PX) pixelize = 1 - closer / PIXEL_PX;
      chip.style.setProperty("--pixelize", pixelize.toFixed(3));

      // Magnet: push only while pixelize hasn't really started yet.
      // Once the chip is meaningfully disintegrating (>FREEZE_AT) we
      // freeze the magnet so the chip stops fleeing — otherwise it
      // would slide out from under the cursor mid-fade and the
      // disintegrate visual would never complete.
      if (pixelize >= FREEZE_AT) {
        // Frozen — don't change push values; let them coast / settle.
      } else if (distLive < FIELD_PX) {
        const falloff = (1 - distLive / FIELD_PX) ** 2;
        const len = Math.max(distLive, 0.001);
        const pushPx = (-dxLive / len) * falloff * STRENGTH_PX;
        const pushPy = (-dyLive / len) * falloff * STRENGTH_PX;
        chip.style.setProperty("--push-x", `${pushPx.toFixed(2)}px`);
        chip.style.setProperty("--push-y", `${pushPy.toFixed(2)}px`);
      } else {
        chip.style.setProperty("--push-x", "0px");
        chip.style.setProperty("--push-y", "0px");
      }
    }
  }

  window.addEventListener(
    "pointermove",
    (e) => {
      cursor = { x: e.clientX, y: e.clientY };
      if (rafId === null) {
        rafId = requestAnimationFrame(updateChips);
      }
    },
    { passive: true },
  );

  // When the cursor leaves the window entirely, snap chips back to rest.
  window.addEventListener(
    "pointerleave",
    () => {
      cursor = null;
      for (const chip of chips) {
        chip.style.setProperty("--push-x", "0px");
        chip.style.setProperty("--push-y", "0px");
        chip.style.setProperty("--pixelize", "0");
      }
    },
    { passive: true },
  );
})();

// Cursor-glitch for the manifesto headline — PER LETTER. Walk every
// text node inside the headline, wrap each word in a no-break wrapper
// and each character inside the word in its own <span>. On every
// pointer move, set a 0..1 --glitch value on each letter based on its
// distance from the cursor. The CSS does the heavy lifting: aggressive
// chromatic RGB split, stepped jitter (translate / rotate / skew),
// blur + contrast pump, and a hard fade-to-0 at cursor centre so
// letters near the cursor look like they're disintegrating into pixels
// and disappearing.
(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;

  const copy = document.querySelector(".manifesto__copy");
  if (!copy) return;

  // Walk every text node inside the headline (this skips the inline
  // image chips). For each one we replace it with a fragment that
  // wraps each whitespace-delimited word in a non-breaking
  // .manifesto__word-wrap and each character inside that word in a
  // .manifesto__letter. Whitespace runs are kept as plain text nodes
  // so line wrapping still happens at word boundaries (and never
  // mid-word).
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  function makeLetter(ch) {
    const el = document.createElement("span");
    el.className = "manifesto__letter";
    el.textContent = ch;
    // Per-letter random seeds → each letter glitches in a different
    // direction / amount so the whole headline doesn't move as a
    // single sheet.
    el.style.setProperty("--glitch-dx", (Math.random() * 2 - 1).toFixed(2));
    el.style.setProperty("--glitch-dy", (Math.random() * 2 - 1).toFixed(2));
    el.style.setProperty("--glitch-dr", (Math.random() * 2 - 1).toFixed(2));
    return el;
  }

  textNodes.forEach((node) => {
    const text = node.nodeValue;
    if (!text || !text.trim()) return;
    const frag = document.createDocumentFragment();
    const parts = text.split(/(\s+)/);
    parts.forEach((part) => {
      if (!part) return;
      if (/^\s+$/.test(part)) {
        frag.appendChild(document.createTextNode(part));
      } else {
        const wordEl = document.createElement("span");
        wordEl.className = "manifesto__word-wrap";
        // Array.from iterates by code point (handles surrogate pairs).
        for (const ch of Array.from(part)) {
          wordEl.appendChild(makeLetter(ch));
        }
        frag.appendChild(wordEl);
      }
    });
    node.parentNode.replaceChild(frag, node);
  });

  const letters = Array.from(copy.querySelectorAll(".manifesto__letter"));
  if (letters.length === 0) return;

  const FIELD_PX = 140; // glitch radius around the cursor

  // Cache resting centres of each letter. We DON'T read
  // getBoundingClientRect inside the rAF loop because letters carry
  // CSS transforms while glitched — measuring then would feedback
  // into the distance calc and cause oscillation. Recompute the cache
  // on resize, page load, and after fonts settle.
  let cache = [];
  let cursor = null;
  let rafId = null;

  function rebuildCache() {
    for (const l of letters) l.style.setProperty("--cursor-glitch", "0");
    cache = letters.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        el,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
      };
    });
  }

  function tick() {
    rafId = null;
    if (!cursor) return;
    for (const { el, cx, cy } of cache) {
      const dx = cursor.x - cx;
      const dy = cursor.y - cy;
      const d = Math.hypot(dx, dy);
      let g = 0;
      if (d < FIELD_PX) g = 1 - d / FIELD_PX;
      el.style.setProperty("--cursor-glitch", g.toFixed(3));
    }
  }

  rebuildCache();
  window.addEventListener("load", rebuildCache);
  window.addEventListener("resize", rebuildCache);
  // The fit-to-90vh script changes font-size after measuring, which
  // shifts every letter's position — listen so the cache stays accurate.
  window.addEventListener("manifesto:fit", rebuildCache);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(rebuildCache);
  }

  window.addEventListener(
    "pointermove",
    (e) => {
      cursor = { x: e.clientX, y: e.clientY };
      if (rafId === null) rafId = requestAnimationFrame(tick);
    },
    { passive: true },
  );

  window.addEventListener(
    "pointerleave",
    () => {
      cursor = null;
      for (const l of letters) l.style.setProperty("--cursor-glitch", "0");
    },
    { passive: true },
  );
})();

// Ambient random glitch. Independently of the cursor, periodically
// poke random letters with a brief --noise-glitch spike. Most ticks
// pick 1–3 isolated letters; ~15% of the time it spawns a "burst" —
// a run of contiguous letters glitching simultaneously, which reads
// like a horizontal VHS tracking tear across the headline. Cursor
// glitch and ambient glitch compose via CSS `max()` so neither
// stomps the other.
(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;

  const copy = document.querySelector(".manifesto__copy");
  if (!copy) return;

  // The cursor IIFE above wraps letters synchronously when this script
  // loads, so by the time this IIFE runs, .manifesto__letter spans
  // already exist in the DOM.
  const letters = copy.querySelectorAll(".manifesto__letter");
  if (letters.length === 0) return;

  function spawnGlitch(letter) {
    if (!letter) return;
    const intensity = 0.55 + Math.random() * 0.45;
    letter.style.setProperty("--noise-glitch", intensity.toFixed(3));
    const hold = 50 + Math.random() * 200;
    setTimeout(() => {
      letter.style.setProperty("--noise-glitch", "0");
    }, hold);
  }

  function loop() {
    // Every tick is a "burst" of contiguous letters now — same overall
    // cadence as before, but each glitch event grips a bigger chunk of
    // the headline so it reads as a real horizontal tear rather than a
    // single twitching pixel.
    const start = Math.floor(Math.random() * letters.length);
    const len = 2 + Math.floor(Math.random() * 7); // 2–8 contiguous letters
    for (let i = 0; i < len; i++) spawnGlitch(letters[start + i]);
    setTimeout(loop, 900 + Math.random() * 1800);
  }

  loop();
})();
