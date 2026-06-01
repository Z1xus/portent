import { loadManifestDir } from "../config/manifest.ts";
import { item, pass } from "./format.ts";

const manifestDir = Bun.env["MANIFEST_DIR"] ?? "manifests";
const manifests = await loadManifestDir(manifestDir);
const enabled = manifests.filter((manifest) => manifest.enabled);

pass(`Manifest check passed. ${item("dir", manifestDir)} ${item("manifests", String(manifests.length))} ${item("enabled", String(enabled.length))}`);
