// SPDX-License-Identifier: GPL-3.0-only

/** One Chrome Web Store screenshot (store-shots.mjs). */
export interface StoreShot {
  readonly name: string;
  readonly fixture: string;
  readonly query: string;
  readonly host: "popup" | "panel";
  readonly scrollTo: string | null;
  readonly site: string;
  readonly caption: string;
  readonly chromeStore: boolean;
}

export const SHOTS: readonly StoreShot[];
export const FRAME: {
  readonly width: number;
  readonly height: number;
  readonly caption: number;
  readonly toolbar: number;
  readonly popupWidth: number;
  readonly popupMaxHeight: number;
  readonly panelWidth: number;
  readonly panelHeader: number;
};
export const TILE: { readonly width: number; readonly height: number };
