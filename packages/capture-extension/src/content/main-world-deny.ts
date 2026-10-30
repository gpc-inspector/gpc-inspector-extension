// SPDX-License-Identifier: GPL-3.0-only
/**
 * Sending is off.
 *
 * Registered by the service worker only while "Send GPC" is off, and unregistered the
 * moment it is turned on. Its entire job is to tell main-world.js, through the join in
 * channel.ts, to remove the property it defined at document_start, so the page reads what
 * the browser gives it.
 *
 * It exists because a MAIN-world content script cannot read chrome.storage and cannot be
 * told a setting asynchronously: navigator.globalPrivacyControl has to be settled before
 * the page's first script runs. Registration is the only channel that carries a decision
 * into the MAIN world at document_start.
 */

import { join } from "./channel.js";

join(document, { slot: "deny" });
