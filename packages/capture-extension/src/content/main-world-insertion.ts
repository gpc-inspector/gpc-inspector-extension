// SPDX-License-Identifier: GPL-3.0-only
/**
 * MAIN-world script-insertion observer (provenance).
 *
 * Registered DYNAMICALLY by the service worker, only while the Observation setting
 * "observe how scripts are loaded" is on, and unregistered the moment it is turned off.
 * Off therefore means the insertion methods are never wrapped, not merely that the
 * wrapper records nothing. That is the same mechanism main-world-deny.js uses to carry
 * a setting into the MAIN world at document_start, where chrome.storage is unreachable.
 *
 * Dynamically registered scripts run after the statically declared ones, so this runs
 * after main-world.js and before any page script, and joins main-world.js to send its
 * records over the same private channel that carries consent calls. Where it could not join
 * (main-world.js did not run), it installs nothing: what it saw would go nowhere.
 */

import type { ObserveDetail } from "./protocol.js";
import { installScriptInsertionObserver } from "../observe/script-insertion.js";
import { installRequestInitiatorObserver } from "../observe/request-initiator.js";
import { isInsideChromeUi } from "../observe/chrome-ui.js";
import { join } from "./channel.js";
import { documentOrigin } from "./document-origin.js";

/**
 * The way out to the bridge, given by main-world.js when this script joins (channel.ts).
 * Records go over main-world.js's private node, never over `document`, where a page script
 * could send records of its own.
 */
let send: ((detail: unknown) => void) | null = null;
join(document, {
  slot: "insertion",
  receive: (s) => {
    send = s;
  },
});

function observe(detail: ObserveDetail): void {
  try {
    send?.(detail);
  } catch {
    /* never break the page */
  }
}

const isTopFrame = (() => {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
})();

let frameOrigin = "";
try {
  // The inherited origin in an about:blank or srcdoc frame, whose address's is opaque.
  frameOrigin = documentOrigin(location.origin, self.origin);
} catch {
  /* an opaque origin reports as empty */
}

// A frame Chrome embeds in one of its own pages (the new-tab page's account bar and
// modules) is not part of any site, and its widgets make Chrome log page messages under
// this extension. Neither observer installs there. See observe/chrome-ui.ts.
let ancestors: ArrayLike<string> | undefined;
try {
  ancestors = location.ancestorOrigins;
} catch {
  ancestors = undefined;
}
const insideChromeUi = isInsideChromeUi(ancestors);
// Nothing to report to, so nothing to wrap.
const joined = (send as unknown) !== null;
const installs = joined && !insideChromeUi;

const observer = installs
  ? installScriptInsertionObserver(
      window,
      document,
      { initialUrl: location.href, frameOrigin, topFrame: isTopFrame },
      {
        onInsertion: (insertion) => observe({ kind: "script-insertion", insertion }),
        onCoverage: (coverage) => observe({ kind: "script-insertion-coverage", coverage, topFrame: isTopFrame }),
      },
    )
  : null;

// The request-initiator observer (pixels, fetch, XHR, beacons) rides the same script and
// the same setting: both answer "who did this", and a reader who turned one off meant both.
const requests = installs
  ? installRequestInitiatorObserver(
      window,
      document,
      { initialUrl: location.href, frameOrigin, topFrame: isTopFrame },
      {
        onRequest: (request) => observe({ kind: "request-initiation", request }),
        onCoverage: (coverage) => observe({ kind: "request-initiation-coverage", coverage, topFrame: isTopFrame }),
      },
    )
  : null;

// Reported as their own capabilities, merged by the worker into the set main-world.js
// reports. Absent entirely when this script is not registered (the setting is off), which
// the popup does not show as a gap; false only when we ran and could not wrap.
if (installs) {
  observe({
    kind: "capabilities",
    capabilities: { scriptInsertion: observer !== null, requestInitiation: requests !== null },
  });
}

if (observer !== null || requests !== null) {
  // Parser-inserted elements exist once parsing has run; the later scans catch elements a
  // late-inserted parser script (document.write) or a slow page adds, on the same
  // cadence main-world.js re-scans the confirmation notice.
  const scan = (): void => {
    observer?.rescan();
    requests?.rescan();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan, { once: true });
  } else {
    scan();
  }
  let scans = 0;
  const timer = setInterval(() => {
    scans++;
    scan();
    if (scans >= 4) clearInterval(timer);
  }, 1500);
  window.addEventListener("pagehide", scan);
}

export {};
