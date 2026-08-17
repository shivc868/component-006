import "./style.css";
import "./demo.css"; // showcase page styles only — do NOT copy into your project
import "lenis/dist/lenis.css";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

// registering twice is harmless — safe even if the host site registers too
gsap.registerPlugin(ScrollTrigger);

const SMOOTH_SCROLL = true;

if (SMOOTH_SCROLL && !window.lenis) {
  const lenis = new Lenis({ autoRaf: false, anchors: true });
  window.lenis = lenis; // expose so other scripts (or a second copy) reuse it
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}

const CONFIG = {
  HF_MIN: 0.2,
  HF_MAX: 0.5,
  SWELL: 1.4,
  ASPECT: 1, // 1:1 — held exactly, on every screen
  MAX_W: 0.8,
  PARALLAX: 7,
  OVERSCAN: 1.18,
  SCROLL_VH: 2, // pinned scroll distance, in viewport heights — lower = faster
  HOLD: 0.08, // scroll parked on the opening and closing frames, each end (<0.5)
  HINT_FADE: 0.12, // slice of the drift over which the scroll hint fades out
  VEIL_MAX: 0.5, // how far an image at the corners sinks toward the ground colour
  Z_BASE: 1000, // depth sort range
  SCAN_STEPS: 40, // coarse steps used to find the *nearest* tangent neighbour
  SOLVE_STEPS: 14, // bisection steps after that; lands well inside a pixel
  LUT_STEPS: 256, // hf() lookup resolution — the solver calls it a lot
};

(function mfaDrift() {
  const root = document.querySelector(".mfa-drift");
  if (!root) return;

  const stage = root.querySelector("[data-mfa-stage]");
  const cards = [...root.querySelectorAll("[data-mfa-card]")];
  if (!stage || cards.length === 0) return;

  const hint = root.querySelector("[data-mfa-hint]");
  const n = cards.length;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const { HF_MIN, HF_MAX } = CONFIG;

  const lut = new Float32Array(CONFIG.LUT_STEPS + 1);
  for (let i = 0; i <= CONFIG.LUT_STEPS; i++) {
    const u = i / CONFIG.LUT_STEPS;
    lut[i] = lerp(
      HF_MIN,
      HF_MAX,
      Math.pow(Math.sin(u * Math.PI), CONFIG.SWELL),
    );
  }

  const hfAt = (u) => {
    if (u <= 0 || u >= 1) return HF_MIN; // outside the frame: corner size
    const t = u * CONFIG.LUT_STEPS;
    const i = t | 0;
    return lut[i] + (lut[i + 1] - lut[i]) * (t - i);
  };

  let warned = false;

  const buildGeo = (W, H, aspect, k) => {
    const minH = H * HF_MIN * k;
    const minW = minH * aspect;
    // how far an image centre travels, in px, on each axis
    const DX = W - minW;
    const DY = H - minH;
    if (DX <= 0 || DY <= 0) return null;

    const gapFor = (a, b) =>
      Math.min(
        (H * k * (a + b)) / (2 * DY), // their heights clear vertically
        (H * k * aspect * (a + b)) / (2 * DX), // their widths clear horizontally
      );

    const MIN_GAP = gapFor(HF_MIN, HF_MIN);
    const MAX_GAP = gapFor(HF_MAX, HF_MAX);
    const ENTER = -MIN_GAP;
    const EXIT = 1 + MIN_GAP;

    const behind = (uh) => {
      const sh = hfAt(uh);
      const needed = (ul) => gapFor(sh, hfAt(ul));
      const step = MAX_GAP / CONFIG.SCAN_STEPS;
      const floor = uh - MAX_GAP; // no gap exceeds this, so the walk terminates
      let hi = uh; // too close -> overlapping
      let lo = uh - step;
      while (lo > floor && uh - lo < needed(lo)) {
        hi = lo;
        lo -= step;
      }
      for (let k = 0; k < CONFIG.SOLVE_STEPS; k++) {
        const mid = (lo + hi) / 2;
        if (uh - mid >= needed(mid)) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };

    /** Mirror of behind(): where the image *ahead* of one at ul sits. */
    const ahead = (ul) => {
      const sl = hfAt(ul);
      const needed = (uh) => gapFor(hfAt(uh), sl);
      const step = MAX_GAP / CONFIG.SCAN_STEPS;
      const ceil = ul + MAX_GAP; // no gap exceeds this, so the walk terminates
      let lo = ul; // too close -> overlapping
      let hi = ul + step;
      while (hi < ceil && hi - ul < needed(hi)) {
        lo = hi;
        hi += step;
      }
      for (let k = 0; k < CONFIG.SOLVE_STEPS; k++) {
        const mid = (lo + hi) / 2;
        if (mid - ul >= needed(mid)) hi = mid;
        else lo = mid;
      }
      return (lo + hi) / 2;
    };

    // The run is framed on the images themselves: it opens with the first one
    // centred at full size and closes with the last one in that same spot.
    // Image i trails the head by i gaps, so the closing head position is the
    // centre stepped forward n-1 times.
    let HEAD_START = 0.5;
    let HEAD_END = 0.5;
    for (let i = 1; i < n; i++) HEAD_END = ahead(HEAD_END);

    // a lone image has no chain to frame; sweep it corner to corner instead
    if (n === 1) {
      HEAD_START = ENTER;
      HEAD_END = EXIT;
    }

    if (!warned) {
      let span = 1;
      let u = EXIT;
      while (u > ENTER && span < 200) {
        u = behind(u);
        span++;
      }
      if (span > n) {
        warned = true;
        console.warn(
          `[mfa-drift] needs at least ${span} images to reach both corners, found ${n}.`,
        );
      }
    }

    return {
      behind,
      ENTER,
      EXIT,
      HEAD_START,
      HEAD_END,
      startX: minW / 2,
      startY: H - minH / 2,
      endX: W - minW / 2,
      endY: minH / 2,
    };
  };

  let geo = null;

  const measure = () => {
    const r = stage.getBoundingClientRect();
    const aspect = CONFIG.ASPECT;
    const wanted = r.height * HF_MAX * aspect; // centre width at full size
    const k = wanted > 0 ? Math.min(1, (r.width * CONFIG.MAX_W) / wanted) : 1;

    const baseH = r.height * HF_MAX * k;
    for (const card of cards) {
      card.style.width = baseH * aspect + "px";
      card.style.height = baseH + "px";
    }

    geo = buildGeo(r.width, r.height, aspect, k);
  };

  const items = cards.map((card) => ({
    card,
    img: card.querySelector(".mfa-drift__img"),
    veil: (v) => card.style.setProperty("--mfa-veil", v.toFixed(3)),
    shown: null, // last visibility written, so we only touch the DOM on change
  }));

  gsap.set(cards, { xPercent: -50, yPercent: -50 });
  gsap.set(
    items.map((it) => it.img),
    { scale: CONFIG.OVERSCAN },
  );

  const setShown = (item, show) => {
    if (show === item.shown) return;
    item.shown = show;
    item.card.style.visibility = show ? "visible" : "hidden";
  };

  /** Places one image at path position u. */
  const place = (i, u) => {
    const item = items[i];
    const show = u > geo.ENTER && u < geo.EXIT;
    setShown(item, show);
    if (!show) return;

    const hf = hfAt(u);
    const swell = (hf - HF_MIN) / (HF_MAX - HF_MIN); // 0 at corners, 1 at centre

    gsap.set(item.card, {
      x: lerp(geo.startX, geo.endX, u),
      y: lerp(geo.startY, geo.endY, u),
      scale: hf / HF_MAX, // elements are centre-sized, so this only shrinks
      zIndex: Math.round(swell * CONFIG.Z_BASE),
    });

    if (item.img) {
      const lag = Math.max(-1, Math.min(1, (u - 0.5) * 2)) * CONFIG.PARALLAX;
      gsap.set(item.img, { xPercent: -lag, yPercent: lag });
    }

    item.veil((1 - swell) * CONFIG.VEIL_MAX);
  };

  // scroll -> drift, with the ends parked so the opening and closing frames
  // hold on their centred image instead of flicking straight into the run
  const driftAt = (progress) =>
    clamp01((progress - CONFIG.HOLD) / (1 - 2 * CONFIG.HOLD));

  const render = (progress) => {
    if (!geo) return;
    const t = driftAt(progress);
    let u = lerp(geo.HEAD_START, geo.HEAD_END, t);
    for (let i = 0; i < n; i++) {
      place(i, u);
      u = geo.behind(u);
    }
    if (hint) {
      gsap.set(hint, { opacity: 1 - clamp01(t / CONFIG.HINT_FADE) });
    }
  };

  const mm = gsap.matchMedia();

  mm.add(
    {
      motion: "(prefers-reduced-motion: no-preference)",
      still: "(prefers-reduced-motion: reduce)",
    },
    (ctx) => {
      measure();

      if (ctx.conditions.still) {
        const draw = () => {
          measure();
          render(0.6); // mid-pass, where the run is at full count
        };
        draw();
        window.addEventListener("resize", draw);
        window.addEventListener("load", draw, { once: true });
        return () => {
          window.removeEventListener("resize", draw);
          window.removeEventListener("load", draw);
        };
      }

      const st = ScrollTrigger.create({
        trigger: root,
        start: "top top",
        end: () => "+=" + window.innerHeight * CONFIG.SCROLL_VH,
        pin: root.querySelector(".mfa-drift__pin"),
        pinSpacing: true,
        anticipatePin: 1,
        scrub: true,
        invalidateOnRefresh: true,
        onUpdate: (self) => render(self.progress),
        onRefresh: (self) => {
          measure();
          render(self.progress);
        },
      });

      render(st.progress);
      return () => st.kill();
    },
  );

  window.addEventListener("load", () => ScrollTrigger.refresh(), {
    once: true,
  });
})();
