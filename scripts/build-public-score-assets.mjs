import { readFile, writeFile } from "node:fs/promises";
import { URL } from "node:url";

// Keep the published page self-contained, including when previewed offline.
const sources = {
  bank: ["Bank Gothic Medium BT.ttf", "font/ttf"],
  sky: ["Sky_D_Front.webp", "image/webp"],
  metal: ["Metal_stained.webp", "image/webp"],
  icon: ["Player.png", "image/png"]
};
const assets = {};
assets.titleLicense = await readFile(new URL("../assets/public-scoreboard/SmileySans-LICENSE.txt", import.meta.url), "utf8");
for (const [name, [file, mime]] of Object.entries(sources)) {
  const bytes = await readFile(new URL(`../assets/public-scoreboard/${file}`, import.meta.url));
  assets[name] = `data:${mime};base64,${bytes.toString("base64")}`;
}
await writeFile(new URL("../apps/server/src/public-score-assets.json", import.meta.url), JSON.stringify(assets) + "\n");
