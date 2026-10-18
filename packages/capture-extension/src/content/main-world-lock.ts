// SPDX-License-Identifier: GPL-3.0-only
/**
 * Permission to lock the signal.
 *
 * Registered by the service worker only while "Send GPC" and "Lock the GPC page property"
 * are both on, after main-world-assert.js in the same registration. Its entire job is to
 * tell main-world.js to take the property back from an extension that replaced it and make
 * it non-configurable, through the join in channel.ts.
 */

import { join } from "./channel.js";

join(document, { slot: "lock" });
