import { useEffect } from "react";

const CODING_SETTINGS = {
  title: "Coding... · Pixel Forge (alpha)",
  favicon: "/favicon/coding-alpha.png",
};
const DEFAULT_SETTINGS = {
  title: "Pixel Forge (alpha)",
  favicon: "/favicon/alpha.png",
};

const useBrowserTabIndicator = (isCoding: boolean) => {
  useEffect(() => {
    const settings = isCoding ? CODING_SETTINGS : DEFAULT_SETTINGS;

    // Set favicon
    const faviconEl = document.querySelector(
      "link[rel='icon']"
    ) as HTMLLinkElement | null;
    if (faviconEl) {
      faviconEl.href = settings.favicon;
    }

    // Set title
    document.title = settings.title;
  }, [isCoding]);
};

export default useBrowserTabIndicator;
