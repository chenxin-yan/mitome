import { checkLockstep, packageVersion, publicPackages } from "./check-lockstep.ts";

const run = async (command: ReadonlyArray<string>): Promise<{ readonly stdout: string }> => {
  const child = Bun.spawn(command, {
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || `Command failed: ${command.join(" ")}`);
  return { stdout };
};

if (process.argv.includes("--test-failure")) {
  const child = Bun.spawn([process.execPath, import.meta.path], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, MITOME_RELEASE_DRY_RUN_FAIL: "fixture" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (
    exitCode === 0 ||
    stdout.includes("Would publish") ||
    !stderr.includes("Injected release gate failed: fixture.")
  ) {
    throw new Error("Injected release gate reached the publish plan.");
  }
  console.log("Injected release gate aborted before the publish plan.");
} else {
  await checkLockstep();
  if (process.env.MITOME_RELEASE_DRY_RUN_FAIL !== undefined) {
    throw new Error(`Injected release gate failed: ${process.env.MITOME_RELEASE_DRY_RUN_FAIL}.`);
  }
  await run([process.execPath, "scripts/release-fixtures.ts"]);
  console.log(
    `Would publish ${publicPackages.map((name) => `@mitome/${name}@${packageVersion}`).join(", ")}.`,
  );
  console.log("Stopped before every remote action.");
}
