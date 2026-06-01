import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeManifestJsonSchema } from "../config/manifest.ts";
import { item, pass } from "./format.ts";

const schemaPath = Bun.argv[2] ?? "schemas/manifest.schema.json";
await mkdir(dirname(schemaPath), { recursive: true });
await writeManifestJsonSchema(schemaPath);
pass(`Wrote manifest schema. ${item("path", schemaPath)}`);
