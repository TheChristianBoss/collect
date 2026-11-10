import "../static/style.css";
import "../static/timeline-core.js";
import {createBrowserAPI} from "./browser-api.js";

async function boot() {
  globalThis.__COLLECT_DEFER_START__ = true;
  const browser = createBrowserAPI();
  await browser.init();
  globalThis.CollectBrowserAPI = browser;
  // The main UI exports CollectApp; additional tracks depend on that object.
  await import("../static/app.js");
  await import("../static/layers.js");
  globalThis.CollectStart();
}

boot().catch((error) => {
  const notice = document.getElementById("uploadStatus");
  if (notice) {
    notice.textContent = "Browser Edition could not start: " + error.message;
    notice.setAttribute("role", "alert");
  }
  console.error("Collect Browser Edition startup error:", error);
});
