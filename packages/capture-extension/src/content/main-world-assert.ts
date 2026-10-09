// SPDX-License-Identifier: GPL-3.0-only
/**
 * Permission to assert the signal.
 *
 * Registered by the service worker only while "Send GPC when nothing else does" is on, and
 * unregistered the moment it is turned off. Its entire job is to give main-world.js that
 * permission, through the join in channel.ts.
 *
 * It exists because a MAIN-world content script cannot read chrome.storage and cannot be
 * told a setting asynchronously: navigator.globalPrivacyControl has to exist before the
 * page's first script runs. Registration is the only channel that carries a decision into
 * the MAIN world at document_start.
 */

import { join } from "./channel.js";

join(document, { slot: "assert" });
