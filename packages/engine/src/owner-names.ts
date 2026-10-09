// SPDX-License-Identifier: GPL-3.0-only
/**
 * The container owners' cookie names, as the engine asks about them (1.25.0).
 *
 * A cookie written by code inside a tag container resolves to the container's script,
 * because a container runs other companies' code inside itself. It counts only when its
 * name is the container owner's own, and under the owner.
 * Which names are whose is data, and the engine holds none: the list is injected the way
 * the classifier is (see classifier.ts), from @gpc-inspector/lists in the extension and a
 * fake in the tests. NO_OWNERS names nothing, so every container-written cookie is charged
 * to no one, which is what a caller that supplies no list gets.
 */

import type { TagManagerKind } from "@gpc-inspector/schema";
import type { Category, Entity } from "./classifier.js";

export interface OwnerNames {
  /** The owner's entry for a cookie name written inside a manager's container, or null. */
  match(manager: TagManagerKind, cookieName: string): { entity: Entity; category: Category } | null;
}

export const NO_OWNERS: OwnerNames = { match: () => null };
