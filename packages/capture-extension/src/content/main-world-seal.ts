// SPDX-License-Identifier: GPL-3.0-only
/**
 * The last of the scripts the service worker registers by setting, always registered, and
 * always after the others in the same registration, so it runs after them.
 *
 * It closes main-world.js's joins (see channel.ts). Without it, a slot whose setting is off
 * would stay open to the page: a page script could claim permission to assert, or the
 * insertion observer's way out to the bridge, and send through it whatever it liked.
 */

import { join } from "./channel.js";

join(document, { slot: "seal" });
