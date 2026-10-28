// SPDX-License-Identifier: GPL-3.0-only
/**
 * Permission to skip the confirmation scan.
 *
 * Registered by the service worker only while "Check page for messaging that the GPC or
 * Opt-Out signal was honored" is turned OFF. Its entire job is to tell main-world.js not to
 * read the page's text, for the same reason main-world-trace-all.ts exists: a MAIN-world
 * content script cannot read chrome.storage, and registration is the only channel that
 * carries a setting into the MAIN world at document_start.
 */

import { join } from "./channel.js";

join(document, { slot: "no-confirmation" });
