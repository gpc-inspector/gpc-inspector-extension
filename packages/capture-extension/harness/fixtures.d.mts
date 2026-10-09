// SPDX-License-Identifier: GPL-3.0-only
import type { ObservationSet } from "@gpc-inspector/schema";

/** Fixture captures for the visual harness, by name; "no-data" yields null. */
export const FIXTURES: Record<string, () => ObservationSet | null>;
