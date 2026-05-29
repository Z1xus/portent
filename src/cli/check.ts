import { loadManifestDir } from "../config/manifest.ts";

const manifestDir = Bun.env["MANIFEST_DIR"] ?? "manifests";
const manifests = await loadManifestDir(manifestDir);
const enabled = manifests.filter((manifest) => manifest.enabled);

console.log(`Manifest check passed. manifests=${manifests.length}, enabled=${enabled.length}`);
