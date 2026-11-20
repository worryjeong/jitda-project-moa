const stopWords = new Set([
  "이것", "저것", "그것", "여기", "저기", "거기", "자료", "강의", "내용", "부분", "대해", "관련", "개념", "핵심", "중요",
  "설명", "예시", "쉽게", "알려", "알려줘", "말해", "말해줘", "해줘", "주세요", "무엇", "뭐야", "어떻게", "왜", "그리고",
  "에서", "으로", "에게", "한테", "부터", "까지", "은", "는", "이", "가", "을", "를", "의", "와", "과", "에", "도", "만",
]);

function queryTerms(question) {
  const endings = /(에게|한테|으로|에서|까지|부터|은|는|이|가|을|를|의|와|과|에|도|만|로)$/;
  return [...new Set((String(question || "").toLocaleLowerCase().match(/[가-힣]{2,}|[a-z0-9][a-z0-9._-]*/g) || [])
    .map((term) => term.replace(endings, ""))
    .filter((term) => term.length >= 2 && !stopWords.has(term)))];
}

// Finds the most relevant readable PDF pages without asking the AI to guess the source.
export function findRelevantPages(question, course) {
  const terms = queryTerms(question);
  if (!terms.length || !Array.isArray(course?.documents)) return [];
  const matches = [];

  for (const document of course.documents) {
    for (const page of document.pages || []) {
      if (!page.text) continue;
      const text = page.text.toLocaleLowerCase();
      let score = 0;
      for (const term of terms) {
        let offset = 0;
        let count = 0;
        while ((offset = text.indexOf(term, offset)) !== -1 && count < 4) {
          count += 1;
          offset += term.length;
        }
        score += count * Math.min(term.length, 5);
      }
      if (score > 0) matches.push({ documentId: document.id, fileName: document.fileName, pageNumber: page.pageNumber, text: page.text, score });
    }
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, 3);
}

// Removes duplicate file/page citations while preserving their original order.
export function uniqueSourceRefs(sources = []) {
  const seen = new Set();
  return sources.filter((source) => {
    const key = `${source.documentId}:${source.pageNumber}`;
    if (!source.documentId || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ documentId, pageNumber }) => ({ documentId, pageNumber }));
}

// Groups citations by PDF so one source chip can list several page numbers.
export function groupSourcePages(sources, course) {
  const grouped = new Map();
  for (const source of sources || []) {
    const document = course?.documents?.find((item) => item.id === source.documentId);
    const pageNumber = Number(source.pageNumber);
    if (!document || !Number.isInteger(pageNumber)) continue;
    if (!grouped.has(document.id)) grouped.set(document.id, { document, pages: new Set() });
    grouped.get(document.id).pages.add(pageNumber);
  }

  return [...grouped.values()].map(({ document, pages }) => ({
    document,
    pages: [...pages].sort((a, b) => a - b),
  }));
}

// Returns only requested pages from the cited PDF, ordered for the source dialog.
export function getSourcePages(course, documentId, pageNumbers) {
  const document = course?.documents?.find((item) => item.id === documentId) || null;
  const requestedPages = Array.isArray(pageNumbers)
    ? pageNumbers.map(Number)
    : String(pageNumbers || "").split(",").map(Number);
  const wanted = new Set(requestedPages.filter(Number.isInteger));
  const pages = (document?.pages || [])
    .filter((page) => wanted.has(Number(page.pageNumber)))
    .sort((a, b) => a.pageNumber - b.pageNumber);
  return { document, pages };
}

// Collects readable pages and optionally applies an explicit page selection.
export function collectCoursePages(course, pageSelection = null) {
  const selectedPages = pageSelection ? new Set(pageSelection.map((page) => `${page.documentId}:${page.pageNumber}`)) : null;
  return (course?.documents || []).flatMap((document) => (document.pages || [])
    .filter((page) => page.text && (!selectedPages || selectedPages.has(`${document.id}:${page.pageNumber}`)))
    .map((page) => ({
      documentId: document.id,
      fileName: document.fileName,
      pageNumber: page.pageNumber,
      text: page.text,
    })));
}

// Splits large PDF text into bounded groups before summary or quiz requests.
export function chunkSources(sources, maxCharacters = 9000, maxItems = 10) {
  const chunks = [];
  let current = [];
  let currentCharacters = 0;

  for (const source of sources) {
    const originalText = String(source.text || "");
    const parts = [];
    for (let offset = 0; offset < originalText.length; offset += 3600) {
      parts.push(originalText.slice(offset, offset + 3600));
    }
    for (const text of parts) {
      if (current.length && (currentCharacters + text.length > maxCharacters || current.length >= maxItems)) {
        chunks.push(current);
        current = [];
        currentCharacters = 0;
      }
      current.push({ ...source, text });
      currentCharacters += text.length;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// Validates quiz counts and returns only readable pages in each selected range.
export function buildQuizSettings(course, { multipleChoiceCount, shortAnswerCount, scopes }) {
  const validCount = (count) => Number.isInteger(count) && count >= 0 && count <= 20;
  if (!validCount(multipleChoiceCount) || !validCount(shortAnswerCount)) {
    throw new Error("문제 수는 각각 0개에서 20개 사이로 입력해 주세요.");
  }
  if (multipleChoiceCount + shortAnswerCount === 0) {
    throw new Error("객관식이나 주관식 중 한 가지는 1개 이상 선택해 주세요.");
  }

  const pages = [];
  const selectedIds = [];
  const ranges = {};
  for (const scope of scopes || []) {
    if (!scope.enabled) continue;
    const document = course?.documents?.find((item) => item.id === scope.documentId);
    if (!document) throw new Error("출제 범위의 PDF를 찾을 수 없어요. 다시 열어 주세요.");
    const start = Number(scope.start);
    const end = Number(scope.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > document.pageCount) {
      throw new Error(`${document.fileName}의 페이지 범위를 확인해 주세요.`);
    }

    selectedIds.push(document.id);
    ranges[document.id] = { start, end };
    pages.push(...(document.pages || [])
      .filter((page) => page.text && page.pageNumber >= start && page.pageNumber <= end)
      .map((page) => ({ documentId: document.id, fileName: document.fileName, pageNumber: page.pageNumber, text: page.text })));
  }

  if (!selectedIds.length) throw new Error("출제할 PDF를 하나 이상 선택해 주세요.");
  if (!pages.length) throw new Error("선택한 페이지 범위에서 읽을 수 있는 글자를 찾지 못했어요.");

  return { multipleChoiceCount, shortAnswerCount, pages, selectedIds, ranges };
}

// Parses generated questions and rejects malformed or incorrectly sized quizzes.
export function parseQuiz(answer, scope, expectedCounts = null) {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("예상문제 형식으로 답변을 받지 못했어요. 다시 눌러 생성해 주세요.");

  let result;
  try {
    result = JSON.parse(answer.slice(start, end + 1));
  } catch {
    throw new Error("예상문제를 읽을 수 없어요. 한 번 더 생성해 주세요.");
  }

  const questions = (result.questions || result.multipleChoice || []).map((item) => {
    const choices = (item.choices || item.options || []).slice(0, 4);
    const rawIndex = item.answerIndex ?? item.correctIndex ?? item.answer;
    const answerIndex = typeof rawIndex === "string" && /^[A-D]$/i.test(rawIndex.trim())
      ? rawIndex.trim().toUpperCase().charCodeAt(0) - 65
      : Number(rawIndex);
    if (!item.question || choices.length < 2 || !Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= choices.length) return null;
    return {
      question: String(item.question),
      choices: choices.map(String).slice(0, 4),
      answerIndex,
      explanation: String(item.explanation || ""),
    };
  }).filter(Boolean);
  const shortAnswers = (result.shortAnswers || result.subjective || []).map((item) => ({
    question: String(item.question || ""),
    answer: String(item.answer || item.sampleAnswer || ""),
  })).filter((item) => item.question && item.answer);
  if (!questions.length && !shortAnswers.length) throw new Error("만들어진 예상문제가 비어 있어요. 다시 눌러 생성해 주세요.");
  if (expectedCounts && (questions.length !== expectedCounts.multipleChoiceCount || shortAnswers.length !== expectedCounts.shortAnswerCount)) {
    throw new Error(`설정한 개수와 맞지 않게 문제가 생성됐어요. 다시 시도해 주세요. (객관식 ${questions.length}개, 주관식 ${shortAnswers.length}개)`);
  }

  return {
    scope,
    title: scope === "concept" ? "질문한 개념 연습" : "강의 전체 예상문제",
    questions,
    shortAnswers,
    userAnswers: {},
    userResponses: {},
    grades: {},
  };
}

// Converts the model's JSON grading response into a validated UI result.
export function parseShortAnswerGrade(answer) {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("채점 결과를 읽지 못했어요. 다시 채점해 주세요.");

  let result;
  try {
    result = JSON.parse(answer.slice(start, end + 1));
  } catch {
    throw new Error("채점 결과 형식이 올바르지 않아요. 다시 채점해 주세요.");
  }

  const score = Number(result.score);
  if (!Number.isInteger(score) || score < 0 || score > 2 || typeof result.feedback !== "string") {
    throw new Error("채점 결과에 점수나 피드백이 없어요. 다시 채점해 주세요.");
  }

  return {
    score,
    result: score === 2 ? "correct" : score === 1 ? "partial" : "incorrect",
    feedback: result.feedback.slice(0, 600),
  };
}

// Restricts grading references to pages already attached to the generated quiz.
export function getShortAnswerSources(course, quizMessage, item, response) {
  const allowed = new Set((quizMessage.sources || []).map((source) => `${source.documentId}:${source.pageNumber}`));
  const matches = findRelevantPages(`${item.question} ${response}`, course)
    .filter((page) => allowed.has(`${page.documentId}:${page.pageNumber}`));
  const pages = matches.length
    ? matches.slice(0, 4)
    : (quizMessage.sources || []).slice(0, 4).map((source) => {
      const document = course?.documents?.find((candidate) => candidate.id === source.documentId);
      const page = document?.pages.find((candidate) => candidate.pageNumber === source.pageNumber);
      return document && page ? { fileName: document.fileName, pageNumber: page.pageNumber, text: page.text } : null;
    }).filter(Boolean);
  return pages.map(({ fileName, pageNumber, text }) => ({ fileName, pageNumber, text: text.slice(0, 3000) }));
}
