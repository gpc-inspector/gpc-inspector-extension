// SPDX-License-Identifier: GPL-3.0-only
/**
 * Permission to trace every read of navigator.globalPrivacyControl.
 *
 * Registered by the service worker only while "Limit GPC read tracing" is turned OFF, and
 * unregistered when it is turned back on. Its entire job is to give main-world.js that
 * permission, for the same reason main-world-deny.ts exists: a MAIN-world content script
 * cannot read chrome.storage, and registration is the only channel that carries a setting
 * into the MAIN world at document_start.
 */

import { join } from "./channel.js";

join(document, { slot: "trace-all" });
