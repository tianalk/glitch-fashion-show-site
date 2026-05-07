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

// Robot toggle: hide / show the floating robot. The label flips to
// describe what clicking will do next, mirroring the mode toggle's
// pattern for consistency.
(() => {
  const toggle = document.querySelector(".manifesto__robot-toggle");
  if (!toggle) return;
  const body = document.body;
  toggle.addEventListener("click", () => {
    const hiding = !body.classList.contains("is-robot-hidden");
    body.classList.toggle("is-robot-hidden", hiding);
    toggle.textContent = hiding ? "Show robot" : "Hide robot";
    toggle.setAttribute("aria-pressed", hiding ? "true" : "false");
  });
})();

// Pin the robot's bottom edge exactly to the top edge of the bottom
// rail. Both elements are position: fixed so the math is in viewport
// coordinates: robot's `bottom` (offset from viewport bottom) equals the
// distance from rail.top up to viewport.bottom.
(() => {
  const align = () => {
    const robot = document.querySelector(".manifesto__robot");
    const rail = document.querySelector(".manifesto__rail");
    if (!robot || !rail) return;
    const railTop = rail.getBoundingClientRect().top;
    const viewportH = window.innerHeight;
    const offset = viewportH - railTop;
    if (offset > 0) {
      robot.style.bottom = `${offset}px`;
    }
  };

  align();
  window.addEventListener("load", align);
  window.addEventListener("resize", align);
  // Run once more after fonts settle so any line-height shifts in the
  // rail don't throw off the offset.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(align);
  }
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
  const STRENGTH_PX = 90; // max displacement at point-blank range
  const PIXEL_PX = 110; // radius at which the chip starts pixelating

  let cursor = null;
  let rafId = null;

  function updateChips() {
    rafId = null;
    if (!cursor) return;

    for (const chip of chips) {
      const rect = chip.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = cursor.x - cx;
      const dy = cursor.y - cy;
      const dist = Math.hypot(dx, dy);

      if (dist < FIELD_PX) {
        // Falloff: 1.0 at the chip center, 0.0 at the field edge. Squared
        // for a snappier "push" near the chip and gentler near the edge.
        const falloff = (1 - dist / FIELD_PX) ** 2;
        // Push direction = AWAY from cursor (chip center − cursor).
        const len = Math.max(dist, 0.001);
        const pushX = (-dx / len) * falloff * STRENGTH_PX;
        const pushY = (-dy / len) * falloff * STRENGTH_PX;
        chip.style.setProperty("--push-x", `${pushX.toFixed(2)}px`);
        chip.style.setProperty("--push-y", `${pushY.toFixed(2)}px`);
      } else {
        // Out of range — let the transition return the chip to rest.
        chip.style.setProperty("--push-x", "0px");
        chip.style.setProperty("--push-y", "0px");
      }

      // Pixelate-disappear: ramps up only when the cursor is very
      // close to (or directly over) the chip. Independent of the
      // magnet so a fast cursor that "catches" the chip will still
      // fade it out.
      let pixelize = 0;
      if (dist < PIXEL_PX) pixelize = 1 - dist / PIXEL_PX;
      chip.style.setProperty("--pixelize", pixelize.toFixed(3));
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
