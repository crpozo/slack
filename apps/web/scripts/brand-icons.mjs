#!/usr/bin/env node
// Generates every app icon from the official logo, `apps/web/public/logo.webp`:
//
//   pnpm --filter web icons            (add `--background "#0E0D12"` to change the
//                                       fill behind opaque icons; default white)
//
// Writes:
//   public/icons/icon-192.png, icon-512.png       PWA icons (manifest)
//   public/icons/icon-maskable-512.png             Android adaptive icon (logo in the safe zone)
//   public/icons/apple-touch-icon.png              iOS home screen (opaque: iOS fills transparency black)
//   public/icons/favicon-32.png, favicon-16.png    browser tab
//   public/icons/badge-96.png                      Android status-bar badge (only if the logo
//                                                  has transparency: it's the logo's silhouette)
//   src/assets/brand/logo.png                      the in-app logo (bundled, content-hashed)
//   ../desktop/src-tauri/icons/*                   Windows/macOS app icons (via `tauri icon`)
//
// Files under /icons are served with a one-year immutable cache, so every
// reference (index.html, manifest, service worker) gets `?v=<hash of the logo>`:
// a new logo means new URLs, and every browser and installed app fetches it.
// Nothing here needs Rust: the Tauri CLI is a prebuilt binary.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(WEB, "..", "desktop");
const SOURCE = join(WEB, "public", "logo.webp");
const ICONS = join(WEB, "public", "icons");

const backgroundArg = process.argv.indexOf("--background");
const background = backgroundArg > 0 ? process.argv[backgroundArg + 1] : "#FFFFFF";

if (!existsSync(SOURCE)) {
  console.error(
    `No logo at ${SOURCE}. Put the official logo there (square, ideally 1024×1024) and run again.`,
  );
  process.exit(1);
}

const logo = readFileSync(SOURCE);
const meta = await sharp(logo).metadata();
if (!meta.width || !meta.height) throw new Error("Can't read the logo's size");
if (Math.abs(meta.width - meta.height) > 2) {
  console.warn(
    `! The logo is ${meta.width}×${meta.height}, not square: it will be centered on a square.`,
  );
}
const version = createHash("sha256").update(logo).digest("hex").slice(0, 10);
mkdirSync(ICONS, { recursive: true });

const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
/** The logo fitted into `size`×`size`, scaled to `scale` of it, on `bg`. */
async function render(size, { scale = 1, bg = transparent } = {}) {
  const inner = Math.round(size * scale);
  const fitted = await sharp(logo)
    .resize(inner, inner, { fit: "contain", background: transparent })
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: bg } })
    .composite([{ input: fitted, gravity: "center" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}
const write = (path, buffer) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
  console.log(`  ${path.replace(`${WEB}/`, "")}`);
};

console.log(`Logo ${meta.width}×${meta.height} (${meta.format}), version ${version}`);
write(join(ICONS, "icon-192.png"), await render(192));
write(join(ICONS, "icon-512.png"), await render(512));
// Android masks adaptive icons to a circle or squircle: keep the logo inside the 80 % safe zone.
write(join(ICONS, "icon-maskable-512.png"), await render(512, { scale: 0.8, bg: background }));
write(join(ICONS, "apple-touch-icon.png"), await render(180, { scale: 0.9, bg: background }));
write(join(ICONS, "favicon-32.png"), await render(32));
write(join(ICONS, "favicon-16.png"), await render(16));
write(join(WEB, "src", "assets", "brand", "logo.png"), await render(256));

// The status-bar badge is drawn by Android as a white silhouette: only a logo
// with transparency has a meaningful one.
const { channels, isOpaque } = await sharp(logo).stats();
if (meta.hasAlpha && !isOpaque && channels.length === 4) {
  const alpha = await sharp(await render(96, { scale: 0.85 }))
    .extractChannel(3)
    .toBuffer();
  const white = await sharp({
    create: { width: 96, height: 96, channels: 3, background: "#FFFFFF" },
  })
    .joinChannel(alpha)
    .png()
    .toBuffer();
  write(join(ICONS, "badge-96.png"), white);
} else {
  console.log("  (badge-96.png kept: the logo has no transparency to make a silhouette from)");
}

// Every reference to /icons/*.png gets the new version.
for (const file of [
  join(WEB, "index.html"),
  join(WEB, "public", "manifest.webmanifest"),
  join(WEB, "public", "sw.js"),
]) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(/(\/icons\/[\w.-]+\.png)(\?v=[\w-]+)?/g, `$1?v=${version}`);
  if (after !== before) writeFileSync(file, after);
}

// Desktop icons: `tauri icon` wants a PNG; only the files tauri.conf.json lists are kept.
const tmp = mkdtempSync(join(tmpdir(), "brand-"));
try {
  const png = join(tmp, "logo-1024.png");
  writeFileSync(png, await render(1024));
  execFileSync(
    "pnpm",
    ["--filter", "desktop", "exec", "tauri", "icon", png, "-o", join(tmp, "out")],
    {
      stdio: "inherit",
    },
  );
  for (const name of [
    "32x32.png",
    "128x128.png",
    "128x128@2x.png",
    "icon.icns",
    "icon.ico",
    "icon.png",
  ]) {
    copyFileSync(join(tmp, "out", name), join(DESKTOP, "src-tauri", "icons", name));
    console.log(`  ../desktop/src-tauri/icons/${name}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(
  "Done. Commit the changed files; desktop users get the new icon with the next installer build.",
);
