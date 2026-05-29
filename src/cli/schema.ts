import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeManifestJsonSchema } from "../config/manifest.ts";

const schemaPath = Bun.argv[2] ?? "schemas/manifest.schema.json";
await mkdir(dirname(schemaPath), { recursive: true });
await writeManifestJsonSchema(schemaPath);
console.log(`Wrote ${schemaPath}`);
