const stamp = document.querySelector("#report-stamp");
const statusLabel = document.querySelector("#report-status");
const testList = document.querySelector("#test-list");
const runMeta = document.querySelector("#run-meta");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatRunTime(value) {
  if (!value) return "아직 실행 기록이 없습니다";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "실행 시간을 확인할 수 없습니다";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(date);
}

function renderTests(tests) {
  if (!tests.length) {
    testList.innerHTML = '<div class="empty-result">아직 저장된 테스트 결과가 없어요. 프로젝트에서 테스트를 실행하면 이곳에 항목별 결과가 표시됩니다.</div>';
    return;
  }

  const groups = new Map();
  for (const test of tests) {
    if (!groups.has(test.suite)) groups.set(test.suite, []);
    groups.get(test.suite).push(test);
  }

  testList.innerHTML = [...groups].map(([suite, items]) => `
    <section class="test-group">
      <div class="test-group-heading"><h3>${escapeHtml(suite)}</h3><span>${items.filter((item) => item.status === "passed").length}/${items.length} 통과</span></div>
      <ul>${items.map((item) => {
        const statusText = item.status === "passed" ? "통과" : item.status === "skipped" ? "건너뜀" : "실패";
        return `<li class="test-item is-${escapeHtml(item.status)}"><span class="test-status-icon" aria-hidden="true">${item.status === "passed" ? "✓" : item.status === "skipped" ? "–" : "!"}</span><span class="test-name">${escapeHtml(item.name)}</span><span class="test-status-label">${statusText}</span></li>`;
      }).join("")}</ul>
    </section>`).join("");
}

async function loadResults() {
  testList.innerHTML = '<div class="empty-result">최근 테스트 결과를 불러오는 중입니다.</div>';
  try {
    const response = await fetch(`/test-results.json?updated=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const report = await response.json();
    const summary = report.summary || {};
    const status = report.status || "not-run";
    stamp.dataset.status = status;
    statusLabel.textContent = status === "passed" ? "모든 테스트 통과" : status === "failed" ? "실패 항목 확인 필요" : "아직 실행 전";
    document.querySelector("#summary-total").textContent = Number(summary.total) || 0;
    document.querySelector("#summary-passed").textContent = Number(summary.passed) || 0;
    document.querySelector("#summary-failed").textContent = Number(summary.failed) || 0;
    document.querySelector("#summary-duration").textContent = report.durationMs ? `${(report.durationMs / 1000).toFixed(2)}초` : "--";
    runMeta.textContent = `${formatRunTime(report.generatedAt)} · 건너뜀 ${Number(summary.skipped) || 0}개`;
    renderTests(Array.isArray(report.tests) ? report.tests : []);
  } catch (error) {
    stamp.dataset.status = "failed";
    statusLabel.textContent = "결과를 불러오지 못했어요";
    runMeta.textContent = error.message;
    testList.innerHTML = '<div class="empty-result">테스트 결과 파일을 읽지 못했습니다. 잠시 뒤 새로고침해 주세요.</div>';
  }
}

document.querySelector("#refresh-results").addEventListener("click", loadResults);
void loadResults();
