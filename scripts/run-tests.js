import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDirectory = path.join(projectRoot, "public");
const reportPath = path.join(reportDirectory, "test-results.json");
const testFiles = ["tests/study-tools.test.js", "tests/study-api.test.js"];

// Convert Node's TAP report into a small browser-readable summary.
function parseTapReport(tap, exitCode, durationMs) {
  const tests = [];
  const suites = [];

  for (const line of tap.split(/\r?\n/)) {
    const suiteMatch = line.match(/^(\s*)# Subtest: (.+)$/);
    if (suiteMatch) {
      const indent = suiteMatch[1].length;
      while (suites.length && suites.at(-1).indent >= indent) suites.pop();
      suites.push({ indent, name: suiteMatch[2] });
      continue;
    }

    const resultMatch = line.match(/^(\s*)(not )?ok \d+(?: - (.*))?$/);
    if (!resultMatch || resultMatch[1].length === 0) continue;

    const indent = resultMatch[1].length;
    const name = resultMatch[3] || "이름 없는 테스트";
    const branch = suites.filter((suite) => suite.indent <= indent).map((suite) => suite.name);
    if (branch.at(-1) === name) branch.pop();
    tests.push({
      suite: branch.join(" · ") || "기타 테스트",
      name,
      status: resultMatch[2] ? "failed" : line.includes("# SKIP") ? "skipped" : "passed",
    });
  }

  const readCount = (label, fallback) => {
    const match = tap.match(new RegExp(`^# ${label} (\\d+)$`, "m"));
    return match ? Number(match[1]) : fallback;
  };
  const passed = readCount("pass", tests.filter((test) => test.status === "passed").length);
  const failed = readCount("fail", tests.filter((test) => test.status === "failed").length);

  return {
    generatedAt: new Date().toISOString(),
    durationMs,
    status: exitCode === 0 && failed === 0 ? "passed" : "failed",
    summary: {
      total: readCount("tests", tests.length),
      passed,
      failed,
      skipped: readCount("skipped", tests.filter((test) => test.status === "skipped").length),
    },
    tests,
    files: testFiles,
  };
}

const startedAt = Date.now();
const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], {
  cwd: projectRoot,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let processError = null;

// Keep terminal output while saving the same run for the preview page.
child.stdout.setEncoding("utf8").on("data", (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
child.stderr.setEncoding("utf8").on("data", (chunk) => {
  output += chunk;
  process.stderr.write(chunk);
});
child.on("error", (error) => { processError = error; });

const exitCode = await new Promise((resolve) => {
  child.on("close", (code) => resolve(code ?? 1));
});
if (processError) output += `\n${processError.stack || processError.message}\n`;

const report = parseTapReport(output, exitCode, Date.now() - startedAt);
if (processError) {
  report.status = "failed";
  report.error = processError.message;
}

try {
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`\n결과 페이지: /test-results.html (${report.summary.passed}/${report.summary.total} 통과)\n`);
} catch (error) {
  process.stderr.write(`테스트는 실행했지만 결과 페이지 파일을 저장하지 못했어요: ${error.message}\n`);
  process.exitCode = 1;
}

if (exitCode !== 0) process.exitCode = exitCode;
