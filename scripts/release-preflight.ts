import { checkLockstep, manifestFor, packageVersion, publicPackages } from "./check-lockstep.ts";

const registry = process.env.MITOME_REGISTRY_URL ?? "https://registry.npmjs.org";

await checkLockstep();
for (const name of publicPackages) {
  const manifest = await manifestFor(name);
  const response = await fetch(
    `${registry.replace(/\/$/, "")}/${encodeURIComponent(manifest.name)}`,
  );
  if (response.status === 404) {
    console.log(
      `${manifest.name}: unpublished; maintainer must verify @mitome ownership before release.`,
    );
    continue;
  }
  if (!response.ok)
    throw new Error(`${manifest.name}: registry preflight returned ${response.status}.`);
  const metadata = (await response.json()) as { versions?: Record<string, unknown> };
  if (metadata.versions?.[packageVersion] !== undefined) {
    throw new Error(`${manifest.name}@${packageVersion} already exists and cannot be republished.`);
  }
  console.log(
    `${manifest.name}: published at another version; ${packageVersion} remains unclaimed.`,
  );
}
console.log("Read-only registry preflight passed; this does not prove npm scope ownership.");
