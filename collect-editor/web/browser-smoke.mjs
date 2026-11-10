/* Headless Chromium smoke test of the static browser build. */
import {chromium} from "playwright";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";

const browser = await chromium.launch({headless: true, args: ["--no-sandbox"]});
const page = await browser.newPage({acceptDownloads: true});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.goto("http://127.0.0.1:4173/", {waitUntil: "networkidle", timeout: 30000});
  await page.waitForSelector("#fileInput", {state: "attached", timeout: 15000});
  await page.waitForFunction(() => Boolean(window.CollectBrowserAPI), null, {timeout: 15000});
  const samplePath = join(tmpdir(), "collect-smoke.webm");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=1.5",
    "-an", "-c:v", "libvpx", "-deadline", "realtime", "-b:v", "160k",
    samplePath
  ]);
  await page.locator("#fileInput").setInputFiles(samplePath);
  console.log("Uploaded FFmpeg-generated video into browser library");
  await page.waitForFunction(
    () => document.getElementById("mediaCount").textContent === "1",
    null, {timeout: 30000}
  );
  await page.locator(".media-item .add-button").click();
  await page.waitForFunction(
    () => document.getElementById("timelineCount").textContent.includes("1 clip"),
    null, {timeout: 10000}
  );

  await page.locator("#exportButton").click();
  await page.locator("#resolution").selectOption("360p");
  await page.locator("#startExport").click();

  const outcome = await Promise.race([
    page.waitForFunction(
      () => !document.getElementById("downloadExport").hidden,
      null, {timeout: 240000}
    ).then(() => "complete"),
    page.waitForFunction(
      () => /error|failed|invalid|unsupported/i.test(document.getElementById("exportMessage")?.textContent || ""),
      null, {timeout: 240000}
    ).then(() => "error")
  ]);
  if (outcome !== "complete") {
    throw Error("Export failed: " + (await page.locator("#exportMessage").textContent()));
  }
  const href = await page.locator("#downloadExport").getAttribute("href");
  if (!href?.startsWith("blob:")) throw Error("Export must produce a local Blob download URL");
  const size = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return (await response.blob()).size;
  }, href);
  if (size < 1000) throw Error("MP4 export is empty");
  console.log("PASS: imported a local clip, edited the timeline and exported MP4 bytes:", size);
} catch (error) {
  console.error("Browser errors:", errors.slice(-15));
  console.error("Export status:", await page.locator("#exportMessage").textContent().catch(() => "unknown"));
  throw error;
} finally {
  await browser.close();
}
