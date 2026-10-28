// Site behaviour: mobile menu, smooth scrolling, and scroll animations.
// Everything degrades gracefully: without JS the page is fully visible and
// scrolls natively; with prefers-reduced-motion only the menu is wired up.
(function () {
  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- mobile menu ---------- */
  var btn = document.querySelector(".menu-btn");
  var nav = document.getElementById("site-nav");
  var header = document.querySelector("header.site");

  function setOpen(open) {
    btn.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("open", open);
    if (open && header) header.classList.remove("tucked");
  }

  if (btn && nav) {
    btn.addEventListener("click", function () {
      setOpen(btn.getAttribute("aria-expanded") !== "true");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
  }

  var lenis = null;   // smooth scroller, created below unless reduced motion is on

  /* ---------- photo dump (home) ----------
     A sideways strip. Trackpad swipes, touch and arrow keys scroll it
     natively; a mouse can drag it (with a little momentum); the round
     buttons step through it. Vertical wheel over the strip still scrolls
     the page, through Lenis so it keeps the same smooth feel. */
  var track = document.querySelector(".dump-track");
  if (track) {
    var items = Array.prototype.slice.call(track.querySelectorAll(".dump-item"));
    var countNow = document.querySelector(".dump-count .now");
    var progress = document.querySelector(".dump-progress span");
    var prevBtn = document.querySelector('.dump-btn[data-dir="-1"]');
    var nextBtn = document.querySelector('.dump-btn[data-dir="1"]');
    var edge = function () { return parseFloat(getComputedStyle(track).paddingLeft) || 0; };

    // which photo sits at the left edge, plus progress and the image drift
    var dumpFrame = 0;
    var updateDump = function () {
      dumpFrame = 0;
      var max = track.scrollWidth - track.clientWidth;
      var x = track.scrollLeft;
      if (progress) progress.style.transform = "scaleX(" + (max > 0 ? x / max : 1) + ")";
      var current = 0;
      for (var i = 0; i < items.length; i++) {
        if (items[i].offsetLeft - edge() <= x + 8) current = i;
      }
      if (max - x < 4) current = items.length - 1;
      if (countNow) countNow.textContent = String(current + 1).padStart(2, "0");
      if (prevBtn) prevBtn.disabled = x < 4;
      if (nextBtn) nextBtn.disabled = max - x < 4;
      if (!reduceMotion) {
        // each photo drifts slightly against the scroll, like a window
        var mid = x + track.clientWidth / 2;
        items.forEach(function (it) {
          var img = it.firstElementChild;
          var c = it.offsetLeft + it.offsetWidth / 2;
          var shift = Math.max(-1, Math.min(1, (c - mid) / track.clientWidth)) * -3;
          img.style.transform = "scale(1.08) translateX(" + shift.toFixed(2) + "%)";
        });
      }
    };
    var requestDump = function () {
      if (!dumpFrame) dumpFrame = requestAnimationFrame(updateDump);
    };
    track.addEventListener("scroll", requestDump, { passive: true });
    window.addEventListener("resize", requestDump);
    items.forEach(function (it) {
      var img = it.firstElementChild;
      if (!img.complete) img.addEventListener("load", requestDump);
    });
    updateDump();

    // arrow buttons and keys step by roughly a screen; snap lines it up
    var step = function (dir) {
      track.scrollBy({ left: dir * track.clientWidth * 0.75, behavior: reduceMotion ? "auto" : "smooth" });
    };
    [prevBtn, nextBtn].forEach(function (b) {
      if (b) b.addEventListener("click", function () { step(+b.getAttribute("data-dir")); });
    });
    track.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        step(e.key === "ArrowRight" ? 1 : -1);
      }
    });

    // wheel: sideways gestures scroll the strip natively; vertical ones
    // go to the page (Lenis ignores this element because of
    // data-lenis-prevent-wheel, so it's forwarded here)
    track.addEventListener("wheel", function (e) {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (lenis) lenis.scrollTo(lenis.targetScroll + dy);
      else window.scrollBy(0, dy);
    }, { passive: false });

    // mouse drag with momentum
    var drag = null;
    track.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      drag = { x: e.clientX, left: track.scrollLeft, v: 0, t: performance.now(), lastX: e.clientX, moved: false };
    });
    window.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) > 4) { drag.moved = true; track.classList.add("dragging"); }
      if (!drag.moved) return;
      var now = performance.now();
      drag.v = (e.clientX - drag.lastX) / Math.max(1, now - drag.t);
      drag.lastX = e.clientX; drag.t = now;
      track.scrollLeft = drag.left - dx;
    });
    window.addEventListener("pointerup", function () {
      if (!drag) return;
      var d = drag;
      drag = null;
      if (!d.moved) return;
      var v = -d.v * 16;   // px per frame
      var glide = function () {
        if (Math.abs(v) < 0.5 || reduceMotion) { track.classList.remove("dragging"); return; }
        track.scrollLeft += v;
        v *= 0.92;
        requestAnimationFrame(glide);
      };
      requestAnimationFrame(glide);
    });
  }

  if (reduceMotion) return;
  root.classList.add("anim");

  /* ---------- smooth scrolling ----------
     Same settings as us.nothing.tech: Lenis with a 1.1s duration and an
     exponential ease-out, smooth on wheel/trackpad, native on touch. */
  if (window.Lenis) {
    lenis = new window.Lenis({
      duration: 1.1,
      easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
      smoothWheel: true,
      syncTouch: false,
      wheelMultiplier: 1,
      touchMultiplier: 1,
      anchors: true
    });
    var raf = function (time) {
      lenis.raf(time);
      requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
  }

  function onScroll(fn) {
    if (lenis) lenis.on("scroll", fn);
    else window.addEventListener("scroll", fn, { passive: true });
  }
  function scrollY() {
    return lenis ? lenis.scroll : window.scrollY;
  }

  /* ---------- page-load intro ---------- */
  function markLoaded() {
    requestAnimationFrame(function () { root.classList.add("loaded"); });
  }
  if (document.readyState === "complete") markLoaded();
  else window.addEventListener("load", markLoaded);
  // never leave the hero hidden if an image is slow
  setTimeout(markLoaded, 1200);

  /* ---------- header hides on scroll down, returns on scroll up ---------- */
  var lastY = 0;
  onScroll(function () {
    var y = scrollY();
    var dy = y - lastY;
    if (Math.abs(dy) < 4) return; // ignore the tail of a scroll, only react to direction
    if (header && !(nav && nav.classList.contains("open"))) {
      header.classList.toggle("tucked", y > 200 && dy > 0);
    }
    lastY = y;
  });

  /* ---------- reveal on scroll ----------
     [data-wipe] elements start fully clipped, and IntersectionObserver
     counts a fully clipped element as not visible, so those are watched
     through their parent instead. */
  var watched = new Map();
  function watch(target, el) {
    if (!watched.has(target)) watched.set(target, []);
    watched.get(target).push(el);
  }
  document.querySelectorAll("[data-reveal], .stats").forEach(function (el) { watch(el, el); });
  document.querySelectorAll("[data-wipe]").forEach(function (el) { watch(el.parentElement, el); });

  function reveal(el) {
    el.classList.add("in");
    if (el.classList.contains("stats")) countUp(el);
    var delay = parseFloat(getComputedStyle(el).getPropertyValue("--d")) || 0;
    setTimeout(function () { el.classList.add("done"); }, (delay + 1.9) * 1000);
  }

  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        watched.get(entry.target).forEach(reveal);
        io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0 });
    watched.forEach(function (_, target) { io.observe(target); });
  } else {
    watched.forEach(function (els) { els.forEach(reveal); });
  }

  /* ---------- stats count up ---------- */
  function countUp(container) {
    container.querySelectorAll("[data-count]").forEach(function (el, i) {
      var to = parseInt(el.getAttribute("data-count"), 10);
      // data-from="current-year" counts down from this year (used for the rookie season)
      var fromAttr = el.getAttribute("data-from") || "0";
      var from = fromAttr === "current-year" ? new Date().getFullYear() : parseInt(fromAttr, 10);
      var dur = 1600;
      var start = null;
      var step = function (t) {
        if (start === null) start = t + i * 120;
        var p = Math.max(0, Math.min(1, (t - start) / dur));
        var eased = 1 - Math.pow(2, -10 * p);
        el.textContent = Math.round(from + (to - from) * (p === 1 ? 1 : eased));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  /* ---------- parallax ----------
     [data-parallax="0.1"] moves its image by that fraction of how far the
     element is from the middle of the screen. */
  var parallax = Array.prototype.slice.call(document.querySelectorAll("[data-parallax]"));
  if (parallax.length) {
    var update = function () {
      var vh = window.innerHeight;
      parallax.forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh) return;
        var speed = parseFloat(el.getAttribute("data-parallax")) || 0.1;
        var offset = (r.top + r.height / 2 - vh / 2) * -speed;
        var img = el.querySelector("img");
        if (img) img.style.translate = "0 " + offset.toFixed(1) + "px";
      });
    };
    onScroll(update);
    window.addEventListener("resize", update);
    update();
  }
})();
