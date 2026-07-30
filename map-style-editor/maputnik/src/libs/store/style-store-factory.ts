/// <reference types="vite/client" />
import { IStyleStore, OnStyleChangedCallback } from "../definitions";
import { getStyleUrlFromAddressbarAndRemoveItIfNeeded, loadStyleUrl } from "../urlopen";
import { ApiStyleStore } from "./apistore";
import { StyleStore } from "./stylestore";

export async function createStyleStore(onStyleChanged: OnStyleChangedCallback): Promise<IStyleStore> {
  const styleUrl = getStyleUrlFromAddressbarAndRemoveItIfNeeded();
  const isRepositoryLibertyStyle = styleUrl
    && new URL(styleUrl, window.location.href).origin === window.location.origin
    && new URL(styleUrl, window.location.href).pathname === "/maputnik/styles/liberty.json";
  const hasStoredStyle = window.localStorage.getItem("maputnik:latest_style") !== null;
  const useStyleUrl = styleUrl
    && ((isRepositoryLibertyStyle && !hasStoredStyle)
      || window.confirm("Load style from URL: " + styleUrl + " and discard current changes?"));
  let styleStore: IStyleStore;
  if (import.meta.env.MODE === 'desktop' && !useStyleUrl) {
    const apiStyleStore = new ApiStyleStore({
      onLocalStyleChange: mapStyle => onStyleChanged(mapStyle, {save: false}),
    });
    try {
      await apiStyleStore.init();
      styleStore = apiStyleStore;
    } catch {
      styleStore = new StyleStore();
    }
  } else {
    styleStore = new StyleStore();
  }
  const styleToLoad = useStyleUrl ? await loadStyleUrl(styleUrl) : await styleStore.getLatestStyle();
  onStyleChanged(styleToLoad, {initialLoad: true, save: false});
  return styleStore;
}

export type { IStyleStore };
