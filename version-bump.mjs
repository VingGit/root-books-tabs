import { readFile, writeFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
packageJson.version = manifest.version;
await writeFile("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

const versions = JSON.parse(await readFile("versions.json", "utf8"));
versions[manifest.version] = manifest.minAppVersion;
await writeFile("versions.json", `${JSON.stringify(versions, null, 2)}\n`);
