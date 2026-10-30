// SPDX-License-Identifier: GPL-3.0-only
/**
 * Kept, empty, for a registration an earlier version left.
 *
 * Up to 1.0.3 the worker registered this script while sending was on, to give main-world.js
 * permission to define the property. main-world.js now defines it on its own and takes
 * sending off from main-world-deny.js instead. A registration persists across an update, and
 * until the new worker replaces it, the browser still loads the scripts it names: the file
 * stays so that load does not fail, and it claims nothing.
 */

export {};
