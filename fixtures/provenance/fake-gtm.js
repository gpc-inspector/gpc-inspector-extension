// SPDX-License-Identifier: GPL-3.0-only
/**
 * Fake tag-manager container. Served at https://www.googletagmanager.com/gtm.js?id=<ID> by
 * serve.mjs, so its frames look to the extension exactly like a real container's.
 *
 * Reads its own id from document.currentScript and runs the cases assigned to that id.
 * Every insertion carries a data-case attribute naming the case, so the assertion table
 * in README.md can be checked record by record. Each vendor URL has its own path so the
 * records (keyed on URL without query) stay distinct.
 */
(function () {
  var me = document.currentScript;
  var id = (me && /[?&]id=([^&]+)/.exec(me.src) || [])[1] || "GTM-UNKNOWN";
  (window.__fixtureRan = window.__fixtureRan || []).push("gtm.js " + id);

  function el(src, kase) {
    var s = document.createElement("script");
    s.src = src;
    s.setAttribute("data-case", kase);
    return s;
  }
  var META = "https://connect.facebook.net/fixture/";
  var head = document.head;
  var body = document.body || document.documentElement;

  if (id === "GTM-FIX1") {
    // --- every wrapped insertion method, one vendor path each ---
    head.appendChild(el(META + "appendChild.js", "appendChild"));
    head.insertBefore(el(META + "insertBefore.js", "insertBefore"), head.firstChild);
    var placeholder = document.createElement("meta");
    head.appendChild(placeholder);
    head.replaceChild(el(META + "replaceChild.js", "replaceChild"), placeholder);
    head.append(el(META + "append.js", "append"));
    head.prepend(el(META + "prepend.js", "prepend"));
    var anchor = document.createElement("meta");
    head.appendChild(anchor);
    anchor.before(el(META + "before.js", "before"));
    anchor.after(el(META + "after.js", "after"));
    var anchor2 = document.createElement("meta");
    head.appendChild(anchor2);
    anchor2.replaceWith(el(META + "replaceWith.js", "replaceWith"));
    head.insertAdjacentElement("beforeend", el(META + "insertAdjacentElement.js", "insertAdjacentElement"));
    var range = document.createRange();
    range.selectNodeContents(head);
    range.collapse(false);
    range.insertNode(el(META + "insertNode.js", "insertNode"));
    var frag = document.createDocumentFragment();
    frag.appendChild(el(META + "fragment.js", "fragment"));
    head.appendChild(frag);

    // --- Custom HTML tag, synchronous: an inline script the container inserts, whose code
    // inserts the vendor. The inline script runs INSIDE this appendChild, so gtm.js is on
    // the stack beneath it. Expected: container GTM-FIX1.
    var inline = document.createElement("script");
    inline.setAttribute("data-case", "custom-html-inline");
    inline.textContent =
      'var s=document.createElement("script");s.src="https://connect.facebook.net/fixture/custom-html-sync.js";' +
      's.setAttribute("data-case","custom-html-sync");document.head.appendChild(s);';
    head.appendChild(inline);

    // --- Custom HTML tag, deferred: the same, but from setTimeout. No container frame,
    // and document.currentScript is null inside the callback. Expected: undetermined.
    var inlineDeferred = document.createElement("script");
    inlineDeferred.setAttribute("data-case", "custom-html-inline-deferred");
    inlineDeferred.textContent =
      'setTimeout(function(){var s=document.createElement("script");s.src="https://connect.facebook.net/fixture/custom-html-deferred.js";' +
      's.setAttribute("data-case","custom-html-deferred");document.head.appendChild(s);},40);';
    head.appendChild(inlineDeferred);

    // --- A loader that inserts more later, from its own frames. Expected for the late
    // script: chained to Meta, inheriting container GTM-FIX1 through the loader's record.
    head.appendChild(el(META + "loader.js", "loader"));

    // --- A script that dynamic-imports a module. Expected for the module: no record.
    head.appendChild(el(META + "importer.js", "importer"));

    // --- A child container (a zone, or a pasted second snippet). Expected: the child's
    // loader record names GTM-FIX1 as the inserting container; the graph has FIX1 -> CHILD.
    head.appendChild(el("https://www.googletagmanager.com/gtm.js?id=GTM-FIX1-CHILD", "child-container"));

    // --- A Google-hosted helper with no id, then a vendor inserted from it: the id-less
    // frame case. The helper is a separate file so its frame is innermost. Expected for
    // the vendor: container, resolved through the next container frame beneath the
    // helper (this file), i.e. GTM-FIX1.
    var helper = document.createElement("script");
    helper.src = "https://www.googletagmanager.com/helper/postscribe.js";
    helper.setAttribute("data-case", "helper");
    head.appendChild(helper);

    // --- Requests that never touch the DOM: a pixel, a fetch, an XHR and a beacon from the
    // container's own frames. Expected: request records under GTM-FIX1.
    var px = new Image();
    px.src = "https://connect.facebook.net/fixture/pixel-from-fix1.gif";
    fetch("https://connect.facebook.net/fixture/fetch-from-fix1.json").catch(function () {});
    try {
      var x = new XMLHttpRequest();
      x.open("GET", "https://connect.facebook.net/fixture/xhr-from-fix1.json");
      x.send();
    } catch (e) {}
    try {
      navigator.sendBeacon("https://connect.facebook.net/fixture/beacon-from-fix1", "");
    } catch (e) {}

    // --- An iframe the container builds. Expected: recorded as an iframe insertion under
    // GTM-FIX1; what happens INSIDE it is invisible, because no content script runs in an
    // about:blank frame.
    var friendly = document.createElement("iframe");
    friendly.setAttribute("data-case", "friendly-iframe");
    friendly.style.display = "none";
    body.appendChild(friendly);
    try {
      var d = friendly.contentDocument;
      d.open();
      d.write('<script>var s=document.createElement("script");s.src="https://connect.facebook.net/fixture/in-friendly-iframe.js";document.head.appendChild(s);</script>');
      d.close();
    } catch (e) {
      /* a sandboxed environment may refuse; the case then simply does not run */
    }
  }

  if (id === "GTM-FIX2") {
    // The second, independent root container. Expected: container GTM-FIX2, a second
    // root in the graph, and Criteo carries two loaders (site snippet and FIX2).
    head.appendChild(el("https://static.criteo.net/fixture/from-fix2.js", "fix2"));
  }

  if (id === "GTM-FIX1-CHILD") {
    // The child container inserts its own vendor. Expected: container GTM-FIX1-CHILD,
    // with GTM-FIX1 as its parent in the graph.
    head.appendChild(el("https://sb.scorecardresearch.com/fixture/from-child.js", "child-vendor"));
  }
})();
