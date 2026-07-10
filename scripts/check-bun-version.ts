import packageJson from "../package.json" with { type: "json" };

const parseVersion = (value: string): readonly [number, number, number] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
};

const minimum = /^>=(\d+\.\d+\.\d+)$/.exec(packageJson.engines.bun)?.[1];
const pinned = /^bun@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager)?.[1];
const current = parseVersion(Bun.version);
const floor = minimum === undefined ? undefined : parseVersion(minimum);

if (current === undefined || floor === undefined || pinned === undefined) {
  throw new Error("Bun version metadata must use exact major.minor.patch versions.");
}
if (
  current[0] < floor[0] ||
  (current[0] === floor[0] && current[1] < floor[1]) ||
  (current[0] === floor[0] && current[1] === floor[1] && current[2] < floor[2])
) {
  throw new Error(`Bun ${minimum} or newer is required; found ${Bun.version}.`);
}
if (process.argv.includes("--release") && Bun.version !== pinned) {
  throw new Error(`Release builds require Bun ${pinned}; found ${Bun.version}.`);
}

console.log(`Bun ${Bun.version}; minimum ${minimum}; release pin ${pinned}.`);
