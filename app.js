import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  buildQuizSettings,
  chunkSources,
  collectCoursePages,
  findRelevantPages,
  getShortAnswerSources,
  getSourcePages,
  groupSourcePages,
  parseQuiz,
  parseShortAnswerGrade,
  uniqueSourceRefs,
} from "./study-tools.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const DB_NAME = "moa-study-space";
const DB_VERSION = 1;
const STORE_NAME = "workspace";
const STORE_KEY = "current";
const FALLBACK_KEY = "moa-study-space-fallback";
const MAX_PDF_BYTES = 40 * 1024 * 1024;

const state = {
  courses: [],
  activeCourseId: null,
  aiConfigured: false,
  apiKeyConfigured: false,
  baseUrlConfigured: false,
  aiKeyInvalid: false,
  chatExpanded: false,
  sidebarCollapsed: false,
};
const uploadStates = new Map();
const busyCourses = new Set();
const studyProgress = new Map();
const expandedDocumentLists = new Set();
const courseQuizPreferences = new Map();
const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
let databasePromise;
let saveQueue = Promise.resolve();
let toastTimer;
let storageWarningShown = false;
let sidebarOpen = false;

const iconPaths = {
  book: '<path d="M5 4.5h10.2A2.8 2.8 0 0 1 18 7.3V20H7.5A2.5 2.5 0 0 1 5 17.5v-13Z"/><path d="M5 16.5A2.5 2.5 0 0 1 7.5 14H18M9 8h5M9 11h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"/>',
  file: '<path d="M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9l-6-6Z"/><path d="M13 3v6h6M8 14h8M8 17h6"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  arrow: '<path d="m9 18 6-6-6-6"/>',
  send: '<path d="m4 5 16 7-16 7 3-7-3-7Z"/><path d="M7 12h13"/>',
  sparkle: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L7 10l3.2-1.8L12 3Z"/><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h5l2 2h7a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z"/><path d="M3.5 10h17"/>',
  expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/>',
  collapse: '<path d="M8 3v5H3M21 8h-5V3M16 21v-5h5M3 16h5v5"/>',
  settings: '<path d="M9.2 3.4 10 2.5h4l.8.9.3 2a7 7 0 0 1 1.6.9l1.9-.7 1.2.5 2 3.5-.3 1.3-1.6 1.3v1.8l1.6 1.3.3 1.3-2 3.5-1.2.5-1.9-.7a7 7 0 0 1-1.6.9l-.3 2-.8.9h-4l-.8-.9-.3-2a7 7 0 0 1-1.6-.9l-1.9.7-1.2-.5-2-3.5.3-1.3 1.6-1.3v-1.8L2.5 11.5l-.3-1.3 2-3.5 1.2-.5 1.9.7a7 7 0 0 1 1.6-.9l.3-2Z"/><circle cx="12" cy="12" r="3"/>',
  trash: '<path d="M4 7h16M10 11v6m4-6v6M5.5 7l1 13h11l1-13M9 7V4h6v3"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m6 15 6-6 6 6"/>',
  summary: '<path d="M5 4.5h9l5 5v10A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-15Z"/><path d="M14 4.5V10h5M8 13h8M8 16h8"/>',
  quiz: '<path d="M8 5h11M8 12h11M8 19h11"/><path d="m3.5 5 1 1 2-2M3.5 12l1 1 2-2m-3 8 1 1 2-2"/>',
};

function icon(name, className = "") {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || ""}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function timeLabel(timestamp) {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(timestamp || Date.now());
}

function getCourse(courseId = state.activeCourseId) {
  return state.courses.find((course) => course.id === courseId) || null;
}

function getDocument(course, documentId) {
  return course?.documents.find((document) => document.id === documentId) || null;
}

function openDatabase() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB is not available"));
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onblocked = () => reject(new Error("IndexedDB open is blocked"));
      request.onerror = () => reject(request.error || new Error("Database unavailable"));
    });
  }
  return databasePromise;
}

async function readStoredState() {
  try {
    const database = await openDatabase();
    const stored = await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(STORE_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (stored) return stored;
  } catch {
    // Use the small local-storage fallback when IndexedDB is unavailable.
  }
  try {
    return JSON.parse(localStorage.getItem(FALLBACK_KEY) || "null");
  } catch {
    return null;
  }
}

function saveState() {
  const snapshot = { courses: state.courses, activeCourseId: state.activeCourseId };
  saveQueue = saveQueue.then(async () => {
    try {
      const database = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(snapshot, STORE_KEY);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error("Save aborted"));
      });
      try { localStorage.removeItem(FALLBACK_KEY); } catch { /* Storage may be restricted. */ }
    } catch {
      try {
        localStorage.setItem(FALLBACK_KEY, JSON.stringify(snapshot));
      } catch {
        if (!storageWarningShown) {
          storageWarningShown = true;
          showToast("브라우저 저장 공간이 부족해요. PDF 자료 수를 줄여 주세요.", true);
        }
      }
    }
  });
  return saveQueue;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

function renderRecoveryScreen(error) {
  console.error("Study space initialization failed", error);
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}`.slice(0, 240)
    : String(error || "알 수 없는 오류").slice(0, 240);
  app.innerHTML = `<main class="recovery-screen" role="alert"><span class="recovery-mark" aria-hidden="true">!</span><p class="eyebrow">STUDY SPACE</p><h1>화면을 불러오지 못했어요</h1><p>저장된 강의 자료는 지워지지 않았어요. 아래 오류 정보를 확인한 뒤 다시 시도해 주세요.</p><code class="recovery-detail">${escapeHtml(detail)}</code><button class="button button-primary" type="button" data-action="reload-app">새로고침</button></main>`;
}

function normalizeStoredCourse(course) {
  if (!course || typeof course !== "object" || Array.isArray(course)) return null;
  if (typeof course.id !== "string" || typeof course.name !== "string") return null;

  const documents = (Array.isArray(course.documents) ? course.documents : [])
    .filter((document) => document && typeof document === "object" && !Array.isArray(document))
    .map((document) => {
      const pages = (Array.isArray(document.pages) ? document.pages : [])
        .filter((page) => page && typeof page === "object" && Number.isInteger(Number(page.pageNumber)))
        .map((page) => ({
          pageNumber: Number(page.pageNumber),
          text: typeof page.text === "string" ? page.text : "",
        }));
      return {
        ...document,
        id: typeof document.id === "string" ? document.id : makeId(),
        fileName: typeof document.fileName === "string" ? document.fileName : "강의 자료.pdf",
        size: Number.isFinite(Number(document.size)) ? Number(document.size) : 0,
        pageCount: Number.isFinite(Number(document.pageCount)) ? Number(document.pageCount) : pages.length,
        pages,
      };
    });
  const documentIds = new Set(documents.map((document) => document.id));
  const messages = (Array.isArray(course.messages) ? course.messages : [])
    .filter((message) => message && typeof message === "object" && !Array.isArray(message))
    .map((message) => {
      const quiz = message.quiz && typeof message.quiz === "object" && !Array.isArray(message.quiz)
        ? message.quiz
        : null;
      return {
        ...message,
        id: typeof message.id === "string" ? message.id : makeId(),
        role: message.role === "user" ? "user" : "assistant",
        text: typeof message.text === "string" ? message.text : "",
        sources: (Array.isArray(message.sources) ? message.sources : [])
          .filter((source) => source && typeof source === "object" && documentIds.has(source.documentId) && Number.isInteger(Number(source.pageNumber)))
          .map((source) => ({ documentId: source.documentId, pageNumber: Number(source.pageNumber) })),
        quiz: quiz ? {
          ...quiz,
          questions: (Array.isArray(quiz.questions) ? quiz.questions : []).filter((item) => item && typeof item === "object").map((item) => {
            const choices = (Array.isArray(item.choices) ? item.choices : []).slice(0, 4).map(String);
            const answerIndex = Number(item.answerIndex);
            return {
              question: typeof item.question === "string" ? item.question : "연습 문제",
              choices,
              answerIndex: Number.isInteger(answerIndex) && answerIndex >= 0 && answerIndex < choices.length ? answerIndex : 0,
              explanation: typeof item.explanation === "string" ? item.explanation : "",
            };
          }),
          shortAnswers: (Array.isArray(quiz.shortAnswers) ? quiz.shortAnswers : []).filter((item) => item && typeof item === "object").map((item) => ({
            question: typeof item.question === "string" ? item.question : "주관식 연습 문제",
            answer: typeof item.answer === "string" ? item.answer : "",
          })),
          userAnswers: quiz.userAnswers && typeof quiz.userAnswers === "object" ? quiz.userAnswers : {},
          userResponses: quiz.userResponses && typeof quiz.userResponses === "object" ? quiz.userResponses : {},
          grades: quiz.grades && typeof quiz.grades === "object" ? quiz.grades : {},
        } : null,
      };
    });

  return {
    ...course,
    documents,
    messages,
  };
}

function renderSidebar() {
  const courseItems = state.courses.map((course) => `
    <div class="course-row">
      <button class="course-item" type="button" data-action="select-course" data-course-id="${escapeHtml(course.id)}" aria-current="${course.id === state.activeCourseId ? "page" : "false"}">
        <span class="course-item-icon">${icon("book")}</span>
        <span class="course-item-copy"><span class="course-item-name">${escapeHtml(course.name)}</span><span class="course-item-meta">${course.documents.length ? `${course.documents.length}개 PDF 자료` : "자료를 추가해 보세요"}</span></span>
        ${icon("arrow", "course-item-arrow")}
      </button>
      <button class="course-delete" type="button" data-action="delete-course" data-course-id="${escapeHtml(course.id)}" aria-label="${escapeHtml(course.name)} 강의 삭제" title="강의 삭제">${icon("trash")}</button>
    </div>`).join("");

  return `
    <aside class="sidebar ${sidebarOpen ? "is-open" : ""}" id="sidebar" aria-label="강의 목록">
      <div class="brand-row">
        <div class="brand-mark">${icon("book")}</div>
        <div class="brand-copy"><span class="brand-name">모아</span><span class="brand-caption">강의 공부 도우미</span></div>
        <button class="icon-button sidebar-close" type="button" data-action="close-sidebar" aria-label="사이드바 닫기" title="사이드바 닫기">${icon("close")}</button>
      </div>
      <div class="sidebar-content">
        <button class="new-course-button" type="button" data-action="new-course">
          <span class="new-course-icon">${icon("plus")}</span><span>새 강의 등록</span><span class="shortcut-hint">+</span>
        </button>
        <div class="section-label-row"><span class="section-label">내 강의</span><span class="course-count">${state.courses.length}</span></div>
        <nav class="course-list" aria-label="등록한 강의">${courseItems}</nav>
        ${state.courses.length ? "" : '<p class="sidebar-empty">아직 등록한 강의가 없어요.<br>새 강의를 만들어 시작해 보세요.</p>'}
      </div>
      <div class="sidebar-footer">
        <div class="privacy-note"><span class="privacy-icon">${icon("lock")}</span><span><strong>강의와 대화는 내 기기에</strong><small>질문 관련 PDF 페이지만 AI가 읽어요</small></span></div>
        <div class="sidebar-footnote">PDF 파일 전체는 AI로 보내지 않아요</div>
        <a class="test-results-link" href="/test-results.html"><span class="test-results-link-icon">${icon("check")}</span><span>테스트 결과 보기</span>${icon("arrow", "test-results-link-arrow")}</a>
      </div>
    </aside>`;
}

function renderLanding() {
  return `
    <section class="launch-state">
      <div class="launch-copy">
        <p class="eyebrow">YOUR STUDY SPACE</p>
        <h1>긴 강의자료,<br>이제 <em>함께 읽어요.</em></h1>
        <p>강의 PDF를 올리고 궁금한 내용을 물어보세요. 이해하기 쉬운 설명과 자료의 페이지까지 함께 확인할 수 있어요.</p>
        <button class="upload-button" type="button" data-action="new-course">${icon("plus")}첫 강의 등록하기</button>
      </div>
      <div class="launch-aside">
        <p class="launch-aside-kicker">HOW IT WORKS</p>
        <div class="launch-step"><span class="launch-step-number">01</span><span><strong>과목명을 적어요</strong><span>과목마다 공부 공간을 따로 만들어요.</span></span></div>
        <div class="launch-step"><span class="launch-step-number">02</span><span><strong>강의 PDF를 올려요</strong><span>페이지별로 글자를 읽어 자료를 찾아요.</span></span></div>
        <div class="launch-step"><span class="launch-step-number">03</span><span><strong>궁금한 걸 물어봐요</strong><span>쉬운 설명과 출처 페이지를 확인해요.</span></span></div>
        <p class="launch-aside-note">${icon("lock")}PDF 파일 전체는 AI로 보내지 않아요</p>
      </div>
    </section>`;
}

function renderDocumentPill(document, courseId) {
  return `<div class="document-pill">
    <span class="pdf-mark">PDF</span>
    <span class="document-pill-copy"><span class="document-pill-name" title="${escapeHtml(document.fileName)}">${escapeHtml(document.fileName)}</span><span class="document-pill-meta">${document.pageCount}쪽 · ${formatBytes(document.size)}</span></span>
    <button class="remove-document" type="button" data-action="remove-document" data-course-id="${escapeHtml(courseId)}" data-doc-id="${escapeHtml(document.id)}" aria-label="${escapeHtml(document.fileName)} 삭제">${icon("close")}</button>
  </div>`;
}

function renderWelcome(course) {
  return `<div class="welcome-state">
    <div class="welcome-symbol">${icon("sparkle")}</div>
    <p class="eyebrow">READY WHEN YOU ARE</p>
    <h2>어디부터 같이 볼까요?</h2>
    <p>${escapeHtml(course.name)} 자료를 읽었어요. 궁금한 개념을 질문하면 쉬운 설명과 근거가 된 페이지를 함께 찾아드릴게요.</p>
    <div class="prompt-area"><p class="prompt-caption">이렇게 질문해 볼 수 있어요</p>
      <div class="prompt-chips">
        <button class="prompt-chip" type="button" data-action="prompt" data-question="이 자료의 핵심 개념을 알려줘">이 자료의 핵심 개념을 알려줘</button>
        <button class="prompt-chip" type="button" data-action="prompt" data-question="어려운 내용을 쉬운 예시로 설명해줘">어려운 내용을 쉬운 예시로 설명해줘</button>
        <button class="prompt-chip" type="button" data-action="prompt" data-question="이 자료에서 중요한 용어는 뭐야?">중요한 용어가 궁금해</button>
      </div>
    </div>
    <div class="welcome-footnote">${icon("lock")}질문과 관련된 PDF 페이지 내용만 AI에 전달돼요</div>
  </div>`;
}

function renderEmptyMaterials() {
  return `<div class="empty-material-state">
    <div class="empty-stack"><span class="empty-sheet back"></span><span class="empty-sheet front">PDF</span></div>
    <h2>먼저 강의 자료를 올려주세요</h2>
    <p>자료를 올리면 PDF의 페이지별 글자를 읽어 질문에 답하고, 참고한 파일과 페이지를 표시해 드려요.</p>
    <p class="empty-upload-hint">위 자료 영역의 PDF 추가 버튼으로 파일을 선택할 수 있어요.</p>
    <div class="privacy-callout">${icon("lock")}PDF 파일 전체는 AI로 보내지 않아요</div>
  </div>`;
}

function renderSources(sources, course) {
  return groupSourcePages(sources, course).map(({ document, pages: orderedPages }) => {
    const pageList = orderedPages.map((page) => `${page}쪽`).join(", ");
    const label = `${document.fileName} · ${pageList}`;
    return `<button class="source-chip" type="button" data-action="show-source" data-doc-id="${escapeHtml(document.id)}" data-pages="${orderedPages.join(",")}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon("file")}<span>${escapeHtml(label)}</span></button>`;
  }).join("");
}

function renderSummaryText(text) {
  let inList = false;
  const blocks = [];
  const closeList = () => {
    if (inList) blocks.push("</ul>");
    inList = false;
  };

  for (const line of String(text || "").split(/\r?\n/)) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const content = (value) => escapeHtml(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    if (heading) {
      closeList();
      blocks.push(`<h3 class="summary-heading">${content(heading[1])}</h3>`);
    } else if (bullet) {
      if (!inList) blocks.push("<ul>");
      inList = true;
      blocks.push(`<li>${content(bullet[1])}</li>`);
    } else if (line.trim()) {
      closeList();
      blocks.push(`<p>${content(line)}</p>`);
    } else {
      closeList();
    }
  }
  closeList();
  return blocks.join("");
}

function renderQuizMessage(message) {
  const quiz = message.quiz;
  const multipleChoice = (quiz.questions || []).map((item, questionIndex) => {
    const selected = quiz.userAnswers?.[questionIndex];
    const hasAnswer = Number.isInteger(selected);
    const options = (item.choices || []).map((choice, choiceIndex) => {
      const isSelected = selected === choiceIndex;
      const isCorrect = hasAnswer && choiceIndex === item.answerIndex;
      const className = `quiz-option${isSelected ? " is-selected" : ""}${isCorrect ? " is-correct" : hasAnswer && isSelected ? " is-incorrect" : ""}`;
      return `<button class="${className}" type="button" data-action="select-quiz-option" data-message-id="${escapeHtml(message.id)}" data-question-index="${questionIndex}" data-option-index="${choiceIndex}" aria-pressed="${isSelected}"><span class="quiz-option-letter">${String.fromCharCode(65 + choiceIndex)}</span><span>${escapeHtml(choice)}</span></button>`;
    }).join("");
    const feedback = hasAnswer
      ? `<div class="quiz-feedback ${selected === item.answerIndex ? "is-correct" : "is-incorrect"}"><strong>${selected === item.answerIndex ? "정답이에요" : `정답은 ${String.fromCharCode(65 + item.answerIndex)}예요`}</strong><span>${escapeHtml(item.explanation || "")}</span></div>`
      : "";
    return `<section class="quiz-question"><h4><span>${String(questionIndex + 1).padStart(2, "0")}</span>${escapeHtml(item.question)}</h4><div class="quiz-options">${options}</div>${feedback}</section>`;
  }).join("");
  const shortAnswers = (quiz.shortAnswers || []).map((item, questionIndex) => {
    const response = quiz.userResponses?.[questionIndex] || "";
    const grade = quiz.grades?.[questionIndex];
    const busy = busyCourses.has(message.courseRef?.id);
    const gradeLabel = grade?.result === "correct" ? "정답" : grade?.result === "partial" ? "부분 정답" : "오답";
    const gradeFeedback = grade
      ? `<div class="quiz-feedback quiz-grade-feedback is-${escapeHtml(grade.result)}"><strong>${gradeLabel} · ${Number(grade.score)}/2점</strong><span>${escapeHtml(grade.feedback || "")}</span></div>`
      : "";
    return `<section class="quiz-question quiz-short-question"><h4><span>${String(questionIndex + 1).padStart(2, "0")}</span>${escapeHtml(item.question)}</h4><label class="visually-hidden" for="quiz-response-${escapeHtml(message.id)}-${questionIndex}">내 주관식 답안</label><textarea id="quiz-response-${escapeHtml(message.id)}-${questionIndex}" class="quiz-response" rows="2" placeholder="짧은 답을 적고 채점해 보세요" data-message-id="${escapeHtml(message.id)}" data-question-index="${questionIndex}" ${busy ? "disabled" : ""}>${escapeHtml(response)}</textarea><div class="quiz-answer-actions"><button class="quiz-grade-button" type="button" data-action="grade-short-answer" data-message-id="${escapeHtml(message.id)}" data-question-index="${questionIndex}" ${!response.trim() || busy ? "disabled" : ""}>${busy ? "채점 중..." : "채점하기"}</button></div>${gradeFeedback}</section>`;
  }).join("");
  const hasShortAnswers = Boolean(shortAnswers);

  return `<article class="message message--assistant quiz-message">
    <div class="message-avatar">모</div>
    <div class="message-content">
      <div class="message-byline"><span class="message-author">모아</span><span class="answer-kind is-quiz">${quiz.scope === "concept" ? "질문 개념 연습" : "강의 전체 예상문제"}</span><time>${escapeHtml(timeLabel(message.createdAt))}</time></div>
      <div class="quiz-card"><div class="quiz-intro"><strong>${escapeHtml(quiz.title || "예상문제")}</strong><span>객관식은 정답을 고르고, 주관식은 짧게 답한 뒤 채점해 보세요.</span></div>${multipleChoice ? `<div class="quiz-section-title">객관식 <span>${(quiz.questions || []).length}문제</span></div>${multipleChoice}` : ""}${hasShortAnswers ? `<div class="quiz-section-title">주관식 <span>${quiz.shortAnswers.length}문제</span></div>${shortAnswers}` : ""}</div>
      ${renderSources(message.sources, message.courseRef || null)}
    </div>
  </article>`;
}

function renderMessage(message, course) {
  if (message.quiz) return renderQuizMessage({ ...message, courseRef: course });
  const isUser = message.role === "user";
  const kind = message.kind === "ai" ? '<span class="answer-kind">강의 자료 기반</span>' : message.kind === "search" ? '<span class="answer-kind is-search">자료 확인</span>' : message.kind === "summary" ? '<span class="answer-kind is-summary">강의 전체 요약</span>' : "";
  const sources = renderSources(message.sources, course);
  const conceptQuizButton = !isUser && message.kind === "ai"
    ? `<div class="message-tools"><button class="concept-quiz-button" type="button" data-action="generate-concept-quiz" data-message-id="${escapeHtml(message.id)}" aria-label="이 답변으로 예상문제 만들기" title="클릭하거나 우클릭해 객관식 3문제 만들기" ${busyCourses.has(course.id) ? "disabled" : ""}>${icon("quiz")}<span>이 답변으로 예상문제 만들기</span></button></div>`
    : "";
  return `<article class="message ${isUser ? "message--user" : "message--assistant"}" data-message-id="${escapeHtml(message.id)}" ${!isUser && message.kind === "ai" ? 'data-context-quiz="true"' : ""}>
    <div class="message-avatar">${isUser ? "나" : "모"}</div>
    <div class="message-content">
      <div class="message-byline"><span class="message-author">${isUser ? "나" : "모아"}</span>${kind}<time>${escapeHtml(timeLabel(message.createdAt))}</time></div>
      <div class="message-bubble">${message.kind === "summary" ? renderSummaryText(message.text) : escapeHtml(message.text).replace(/\n/g, "<br>")}</div>
      ${conceptQuizButton}
      ${sources ? `<div class="message-sources" aria-label="답변 출처">${sources}</div>` : ""}
    </div>
  </article>`;
}

function renderCourse(course) {
  const documents = course.documents || [];
  const isDocumentListExpanded = documents.length >= 3 && expandedDocumentLists.has(course.id);
  const pageCount = documents.reduce((total, document) => total + document.pageCount, 0);
  const activeUpload = uploadStates.get(course.id);
  const isBusy = busyCourses.has(course.id);
  const messages = course.messages || [];
  const currentMessages = !documents.length
    ? renderEmptyMaterials()
    : messages.length
      ? messages.map((message) => renderMessage(message, course)).join("")
      : renderWelcome(course);

  return `
    <div class="course-heading">
      <div><p class="eyebrow">COURSE SPACE</p><h1 title="${escapeHtml(course.name)}">${escapeHtml(course.name)}</h1><p class="course-subtitle">${documents.length ? `${documents.length}개 PDF · ${pageCount}쪽의 텍스트를 읽었어요` : "자료를 올리고 궁금한 내용을 질문해 보세요"}</p></div>
      <div class="heading-actions"><span class="local-storage-label">${icon("lock")}이 기기에 저장</span></div>
    </div>
    <section class="materials-panel ${isDocumentListExpanded ? "is-expanded" : ""}" aria-label="강의 PDF 자료">
      <div class="materials-label">${icon("folder")}<span>자료</span>${documents.length < 3 ? `<span class="materials-count">${documents.length}</span>` : ""}</div>
      <div class="document-list">${documents.length >= 3 ? `<button class="document-count-toggle" type="button" data-action="toggle-documents" data-course-id="${escapeHtml(course.id)}" aria-controls="document-files-${escapeHtml(course.id)}" aria-expanded="${isDocumentListExpanded}">${icon(isDocumentListExpanded ? "chevronUp" : "chevronDown")}<span>PDF 자료 ${documents.length}개${isDocumentListExpanded ? " · 목록 접기" : " · 목록 보기"}</span></button><div class="document-files" id="document-files-${escapeHtml(course.id)}" ${isDocumentListExpanded ? "" : "hidden"}>${isDocumentListExpanded ? documents.map((document) => renderDocumentPill(document, course.id)).join("") : ""}</div>` : documents.length ? documents.map((document) => renderDocumentPill(document, course.id)).join("") : '<span class="no-document-label">아직 PDF 자료가 없어요</span>'}</div>
      <button class="add-document-compact" type="button" data-action="upload-pdf" aria-label="PDF 자료 추가">${icon("plus")}<span>PDF 추가</span></button>
    </section>
    ${activeUpload ? `<div class="uploading-note"><span class="spinner"></span><span id="upload-progress-text">${escapeHtml(activeUpload.fileName)} 읽는 중 ${activeUpload.page ? `· ${activeUpload.page}/${activeUpload.total}쪽` : ""}</span></div>` : ""}
    <div class="chat-expand-backdrop" ${state.chatExpanded ? "" : "hidden"} data-action="toggle-chat-expand" aria-hidden="true"></div>
    <section class="chat-card ${state.chatExpanded ? "is-expanded" : ""}" aria-label="강의 질문 채팅">
      <div class="chat-toolbar"><div class="conversation-title"><span class="conversation-led ${documents.length ? "is-ready" : ""}"></span><span class="conversation-title-text">강의 질문</span><span class="conversation-description">${documents.length ? "PDF 페이지를 근거로 답변해요" : "자료를 올리면 질문할 수 있어요"}</span></div><div class="chat-toolbar-actions"><span class="conversation-status">${messages.length ? `${String(messages.length).padStart(2, "0")} MESSAGES` : "NEW SESSION"}</span>${documents.length ? `<div class="chat-study-actions"><button class="chat-study-button" type="button" data-action="generate-summary" aria-label="강의 PDF 전체 요약하기" ${isBusy ? "disabled" : ""} title="강의 PDF 전체를 요약해요">${icon("summary")}<span>요약하기</span></button><span class="course-quiz-controls"><button class="chat-study-button" type="button" data-action="generate-course-quiz" aria-label="기본 설정으로 강의 전체 예상문제 만들기" ${isBusy ? "disabled" : ""} title="객관식 5개와 주관식 5개를 전체 자료에서 만들어요">${icon("quiz")}<span>예상문제 만들기</span></button><button class="icon-button quiz-settings-button" type="button" data-action="open-quiz-settings" aria-label="예상문제 개수와 범위 설정" title="예상문제 설정" ${isBusy ? "disabled" : ""}>${icon("settings")}</button></span></div>` : ""}<button class="icon-button chat-expand-button" type="button" data-action="toggle-chat-expand" aria-label="${state.chatExpanded ? "채팅 화면 축소" : "채팅 화면 확대"}" aria-pressed="${state.chatExpanded}" title="${state.chatExpanded ? "원래 크기로" : "채팅 크게 보기"}">${icon(state.chatExpanded ? "collapse" : "expand")}</button></div></div>
      <div class="chat-messages" id="chat-messages" aria-live="polite" aria-relevant="additions text">${currentMessages}${isBusy ? `<div class="typing-indicator"><span class="typing-dots"><span></span><span></span><span></span></span><span>${escapeHtml(studyProgress.get(course.id) || "자료에서 근거를 찾고 있어요")}</span></div>` : ""}</div>
      <form class="chat-composer" id="chat-form" data-course-id="${escapeHtml(course.id)}">
        <textarea class="composer-input" id="question-input" name="question" rows="1" maxlength="1200" placeholder="${documents.length ? "강의 자료에 대해 궁금한 점을 물어보세요" : "먼저 강의 PDF를 올려주세요"}" ${documents.length && !isBusy ? "" : "disabled"} aria-label="강의에 질문하기"></textarea>
        <div class="composer-footer"><span class="composer-hint">${documents.length ? "답변은 강의 자료 범위에서 찾아요" : "PDF 자료를 올리면 질문할 수 있어요"}</span><span class="composer-actions"><button class="send-button" type="submit" ${documents.length && !isBusy ? "" : "disabled"}>보내기${icon("send")}</button></span></div>
      </form>
    </section>`;
}

function renderQuizSettingsDialog(course) {
  if (!course?.documents.length) return "";
  const preferences = courseQuizPreferences.get(course.id);
  const documentOptions = course.documents.map((document) => {
    const pageCount = Math.max(1, Number(document.pageCount) || document.pages.length || 1);
    const isReadable = document.pages.some((page) => page.text);
    const savedRange = preferences?.ranges?.[document.id];
    const isSelected = preferences?.selectedIds ? preferences.selectedIds.includes(document.id) : isReadable;
    return `<div class="quiz-scope-document" data-quiz-scope-document data-doc-id="${escapeHtml(document.id)}">
      <label class="quiz-scope-select"><input class="quiz-scope-enabled" type="checkbox" ${isSelected ? "checked" : ""} ${isReadable ? "" : "disabled"} aria-label="${escapeHtml(document.fileName)} 출제 범위에 포함"><span class="quiz-scope-file"><strong title="${escapeHtml(document.fileName)}">${escapeHtml(document.fileName)}</strong><small>${pageCount}쪽${isReadable ? "" : " · 읽을 수 있는 글자 없음"}</small></span></label>
      <div class="quiz-page-range"><span>페이지</span><label><span class="visually-hidden">${escapeHtml(document.fileName)} 시작 페이지</span><input class="quiz-page-start" type="number" min="1" max="${pageCount}" value="${savedRange?.start || 1}" ${isReadable ? "" : "disabled"}></label><span aria-hidden="true">~</span><label><span class="visually-hidden">${escapeHtml(document.fileName)} 끝 페이지</span><input class="quiz-page-end" type="number" min="1" max="${pageCount}" value="${savedRange?.end || pageCount}" ${isReadable ? "" : "disabled"}></label><span>쪽</span></div>
    </div>`;
  }).join("");
  const multipleChoiceCount = preferences?.multipleChoiceCount ?? 5;
  const shortAnswerCount = preferences?.shortAnswerCount ?? 5;

  return `<dialog class="app-dialog quiz-settings-dialog" id="quiz-settings-dialog" aria-labelledby="quiz-settings-title">
    <form id="quiz-settings-form" data-course-id="${escapeHtml(course.id)}">
      <div class="dialog-heading"><div><p class="eyebrow">PRACTICE SETTINGS</p><h2 id="quiz-settings-title">예상문제 설정</h2><p class="quiz-settings-course">${escapeHtml(course.name)} 자료에서 출제할 범위를 골라요.</p></div><button class="icon-button dialog-close" type="button" data-action="close-quiz-settings" aria-label="닫기">${icon("close")}</button></div>
      <div class="quiz-count-grid">
        <label class="quiz-count-field"><span>객관식</span><span class="quiz-count-control"><input name="multipleChoiceCount" type="number" min="0" max="20" value="${multipleChoiceCount}" required><small>문제</small></span></label>
        <label class="quiz-count-field"><span>주관식</span><span class="quiz-count-control"><input name="shortAnswerCount" type="number" min="0" max="20" value="${shortAnswerCount}" required><small>문제</small></span></label>
      </div>
      <p class="quiz-settings-hint">각 유형은 0~20개로 설정할 수 있어요. 한 유형은 1개 이상 만들어 주세요.</p>
      <section class="quiz-scope-section" aria-labelledby="quiz-scope-title">
        <div class="quiz-scope-heading"><div><h3 id="quiz-scope-title">출제 범위</h3><p>PDF를 선택하고 페이지 구간을 정해 주세요.</p></div><div class="quiz-scope-actions"><button class="quiz-scope-action" type="button" data-action="set-all-quiz-scope" data-selected="true">전체 선택</button><button class="quiz-scope-action" type="button" data-action="set-all-quiz-scope" data-selected="false">해제</button></div></div>
        <div class="quiz-scope-list">${documentOptions}</div>
      </section>
      <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-quiz-settings">취소</button><button class="button button-primary" type="submit">이 설정으로 만들기</button></div>
    </form>
  </dialog>`;
}

function renderDialogs(course) {
  return `
    <dialog class="app-dialog course-dialog" id="course-dialog" aria-labelledby="course-dialog-title">
      <form id="course-form">
        <div class="dialog-heading"><div><p class="eyebrow">NEW COURSE SPACE</p><h2 id="course-dialog-title">어떤 강의인가요?</h2></div><button class="icon-button dialog-close" type="button" data-action="close-course-dialog" aria-label="닫기">${icon("close")}</button></div>
        <label class="field-label" for="course-name">과목명</label>
        <input class="text-field" id="course-name" name="courseName" type="text" maxlength="60" placeholder="예: 인지심리학" required autocomplete="off">
        <p class="field-hint">같은 이름의 강의가 있으면 번호를 붙여 구분해요.</p>
        <label class="field-label optional-label" for="course-file">PDF 자료 <span>선택 사항</span></label>
        <label class="file-picker" for="course-file"><span class="file-picker-icon">${icon("upload")}</span><span class="file-picker-copy"><strong id="course-file-name">PDF를 함께 올릴 수 있어요</strong><small>글자를 선택할 수 있는 PDF · 최대 40MB</small></span><span class="file-picker-action">찾아보기</span></label>
        <input class="visually-hidden" id="course-file" type="file" accept="application/pdf,.pdf">
        <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-course-dialog">취소</button><button class="button button-primary" type="submit">강의 만들기</button></div>
      </form>
    </dialog>
    <dialog class="app-dialog source-dialog" id="source-dialog" aria-labelledby="source-dialog-title">
      <div class="dialog-heading"><div><p class="eyebrow">PDF SOURCE</p><h2 id="source-dialog-title">자료 페이지</h2><p class="source-dialog-meta" id="source-dialog-meta"></p></div><button class="icon-button dialog-close" type="button" data-action="close-source-dialog" aria-label="닫기">${icon("close")}</button></div>
      <div class="source-page-text" id="source-page-text"></div>
      <div class="dialog-actions source-dialog-actions"><button class="button button-primary" type="button" data-action="close-source-dialog">확인</button></div>
    </dialog>
    ${renderQuizSettingsDialog(course)}
    <input class="visually-hidden" id="workspace-file-input" type="file" accept="application/pdf,.pdf" multiple>
  `;
}

function render() {
  const activeCourse = getCourse();
  const wasAtBottom = (() => {
    const oldMessages = document.querySelector("#chat-messages");
    return oldMessages && oldMessages.scrollHeight - oldMessages.scrollTop - oldMessages.clientHeight < 70;
  })();
  const previousScroll = document.querySelector("#chat-messages")?.scrollTop || 0;

  app.innerHTML = `
    <div class="app-shell ${state.sidebarCollapsed ? "is-sidebar-collapsed" : ""}">
      ${renderSidebar()}
      <div class="sidebar-backdrop" id="sidebar-backdrop" ${sidebarOpen ? "" : "hidden"} data-action="close-sidebar"></div>
      <main class="main-shell">
        <header class="topbar">
          <button class="icon-button mobile-menu" type="button" data-action="open-sidebar" aria-label="강의 목록 열기">${icon("menu")}</button>
          <div class="breadcrumb"><span class="breadcrumb-root">학습 공간</span><span class="breadcrumb-separator">/</span><span class="breadcrumb-current">${escapeHtml(activeCourse?.name || "강의 선택")}</span></div>
          <div class="topbar-status ${state.aiKeyInvalid ? "is-error" : state.aiConfigured ? "is-ai" : ""}" title="${state.aiKeyInvalid ? "LLM 서비스가 현재 API 키를 유효하지 않다고 거절했어요." : state.aiConfigured ? "LLM_API_KEY와 LLM_BASE_URL이 서버에 설정되어 있어요." : !state.apiKeyConfigured ? "LLM_API_KEY 환경변수가 필요해요." : "LLM_BASE_URL 환경변수가 필요하거나 주소 형식을 확인해야 해요."}"><span class="status-dot"></span><span>${state.aiKeyInvalid ? "AI 키 확인 필요" : state.aiConfigured ? "LLM 설정됨" : !state.apiKeyConfigured ? "AI 키 설정 필요" : "API 주소 확인 필요"}</span></div>
        </header>
        <section class="workspace" id="workspace">${activeCourse ? renderCourse(activeCourse) : renderLanding()}</section>
      </main>
    </div>
    ${renderDialogs(activeCourse)}`;
  document.body.classList.toggle("chat-is-expanded", state.chatExpanded);

  const newMessages = document.querySelector("#chat-messages");
  if (newMessages && wasAtBottom) newMessages.scrollTop = newMessages.scrollHeight;
  else if (newMessages) newMessages.scrollTop = Math.min(previousScroll, newMessages.scrollHeight);
}

function validatePdf(file) {
  if (!file) return "PDF 파일을 선택해 주세요.";
  if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") return "PDF 파일만 올릴 수 있어요.";
  if (file.size > MAX_PDF_BYTES) return "PDF는 40MB 이하 파일만 올릴 수 있어요.";
  return "";
}

async function readPdfPages(file, onProgress) {
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];
  let textCharacters = 0;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const parts = [];
    for (const item of content.items) {
      if (typeof item.str !== "string" || !item.str) continue;
      parts.push(item.str);
      if (item.hasEOL) parts.push("\n");
    }
    const text = parts.join(" ").replace(/[ \t]+\n/g, "\n").replace(/\s{2,}/g, " ").trim();
    pages.push({ pageNumber, text });
    textCharacters += text.length;
    onProgress(pageNumber, pdf.numPages);
    page.cleanup();
  }

  return { pages, pageCount: pdf.numPages, textCharacters };
}

async function addFiles(fileList, courseId) {
  const course = getCourse(courseId);
  if (!course) {
    showToast("먼저 강의를 선택해 주세요.", true);
    return;
  }

  const files = Array.from(fileList || []);
  if (!files.length) return;
  for (const file of files) {
    const validationError = validatePdf(file);
    if (validationError) {
      showToast(`${file.name}: ${validationError}`, true);
      continue;
    }

    uploadStates.set(courseId, { fileName: file.name, page: 0, total: 0 });
    render();
    try {
      const result = await readPdfPages(file, (page, total) => {
        uploadStates.set(courseId, { fileName: file.name, page, total });
        const progress = document.querySelector("#upload-progress-text");
        if (progress && getCourse()?.id === courseId) progress.textContent = `${file.name} 읽는 중 · ${page}/${total}쪽`;
      });
      const currentCourse = getCourse(courseId);
      if (!currentCourse) continue;

      currentCourse.documents.push({
        id: makeId(),
        fileName: file.name,
        size: file.size,
        pageCount: result.pageCount,
        pages: result.pages,
      });
      currentCourse.updatedAt = Date.now();
      await saveState();
      if (result.textCharacters) {
        showToast(`${file.name} · ${result.pageCount}쪽을 읽었어요.`);
      } else {
        showToast(`${file.name}을 올렸지만 선택 가능한 글자가 없어요. 스캔형 PDF는 읽을 수 없을 수 있어요.`, true);
      }
    } catch (error) {
      const detail = error?.name === "PasswordException"
        ? "암호가 걸린 PDF는 읽을 수 없어요."
        : "PDF를 읽지 못했어요. 파일이 손상되지 않았는지 확인해 주세요.";
      showToast(`${file.name}: ${detail}`, true);
    } finally {
      uploadStates.delete(courseId);
      render();
    }
  }
}

async function callAiTask(task, question, sources, quizSettings = null, grading = null) {
  const requestQuizSettings = quizSettings ? {
    multipleChoiceCount: quizSettings.multipleChoiceCount,
    shortAnswerCount: quizSettings.shortAnswerCount,
  } : null;
  const response = await fetch("/api/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task, question, sources, quizSettings: requestQuizSettings, grading }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (result.diagnostic === "invalid_api_key" || response.status === 401) state.aiKeyInvalid = true;
    throw new Error(result.message || "AI 답변을 만들지 못했어요. 잠시 뒤 다시 시도해 주세요.");
  }
  state.aiKeyInvalid = false;
  return result.answer;
}

async function createAnswer(question, course) {
  const pages = findRelevantPages(question, course);
  if (!pages.length) {
    const hasReadableText = course.documents.some((document) => document.pages.some((page) => page.text));
    return {
      kind: "search",
      sources: [],
      text: hasReadableText
        ? "강의 자료에서 질문과 관련된 근거를 찾지 못했어요. 자료에 쓰인 용어나 개념을 포함해 다시 질문해 주세요."
        : "PDF에서 선택할 수 있는 글자를 찾지 못했어요. 스캔한 이미지 PDF라면 자료 내용을 검색할 수 없어요.",
    };
  }

  const sources = uniqueSourceRefs(pages);
  if (!state.aiConfigured) {
    const missingConfig = !state.apiKeyConfigured
      ? "서버에 LLM_API_KEY가 설정되지 않았어요."
      : "서버에 LLM_BASE_URL이 설정되지 않았거나 주소 형식이 맞지 않아요.";
    return {
      kind: "search",
      sources,
      text: `질문과 관련된 페이지를 찾았어요. ${missingConfig} 자동 설명은 아직 만들지 못했어요. 아래 출처를 눌러 강의 자료 내용을 확인해 주세요.`,
    };
  }

  const answer = await callAiTask("answer", question, pages.map(({ fileName, pageNumber, text }) => ({ fileName, pageNumber, text: text.slice(0, 3600) })));
  return { kind: "ai", sources, question, text: answer };
}

function updateStudyProgress(courseId, label) {
  studyProgress.set(courseId, label);
  if (getCourse()?.id === courseId) render();
}

async function prepareCourseContext(course, courseId, pageSelection = null) {
  const originalPages = collectCoursePages(course, pageSelection);
  if (!originalPages.length) throw new Error("PDF에서 선택할 수 있는 글자를 찾지 못했어요. 스캔된 이미지 PDF는 요약하거나 문제를 만들 수 없어요.");

  let context = originalPages;
  let level = 0;
  while (context.length > 16 || context.reduce((total, source) => total + source.text.length, 0) > 12_000) {
    level += 1;
    if (level > 6) throw new Error("자료가 너무 커서 한 번에 처리할 수 없어요. PDF를 몇 개로 나누어 등록해 주세요.");
    const chunks = chunkSources(context);
    const digests = [];
    for (let offset = 0; offset < chunks.length; offset += 2) {
      const currentChunks = chunks.slice(offset, offset + 2);
      updateStudyProgress(courseId, `강의 자료를 구간별로 정리하고 있어요 · ${Math.min(offset + currentChunks.length, chunks.length)}/${chunks.length}`);
      const results = await Promise.all(currentChunks.map(async (chunk, index) => {
        const range = chunk.map((source) => `${source.fileName} ${source.pageNumber}쪽`).join(", ");
        const answer = await callAiTask("digest", "", chunk.map(({ fileName, pageNumber, text }) => ({ fileName, pageNumber, text })));
        return {
          fileName: `강의 자료 정리 ${offset + index + 1}`,
          pageNumber: 1,
          text: `원본 출처: ${range}\n${answer}`,
        };
      }));
      digests.push(...results);
    }
    context = digests;
  }

  return { sources: context, references: uniqueSourceRefs(originalPages) };
}

function appendStudyMessage(course, message) {
  course.messages.push({ id: makeId(), role: "assistant", createdAt: Date.now(), ...message });
  course.updatedAt = Date.now();
}

async function runStudyAction(action, courseId, messageId = "", quizSettings = null) {
  const course = getCourse(courseId);
  if (!course || busyCourses.has(courseId)) return;
  if (!state.aiConfigured) {
    showToast("AI 연결 설정을 확인해 주세요. PDF 출처는 계속 확인할 수 있어요.", true);
    return;
  }

  const isConceptQuiz = action === "quiz-concept";
  const answerMessage = isConceptQuiz ? course.messages.find((message) => message.id === messageId && message.kind === "ai") : null;
  if (isConceptQuiz && !answerMessage) return;
  const answerIndex = isConceptQuiz ? course.messages.indexOf(answerMessage) : -1;
  const originalQuestion = isConceptQuiz
    ? answerMessage.question || course.messages.slice(0, answerIndex).reverse().find((message) => message.role === "user")?.text || "강의 개념에 대한 질문"
    : "";
  const originalPages = isConceptQuiz
    ? (answerMessage.sources || []).map((source) => {
      const document = getDocument(course, source.documentId);
      const page = document?.pages.find((item) => item.pageNumber === source.pageNumber);
      return document && page ? { documentId: document.id, fileName: document.fileName, pageNumber: page.pageNumber, text: page.text } : null;
    }).filter(Boolean)
    : [];
  if (isConceptQuiz && !originalPages.length) {
    showToast("답변의 PDF 출처를 찾지 못했어요. 원래 질문을 다시 해 주세요.", true);
    return;
  }

  busyCourses.add(courseId);
  const firstLabel = action === "summary" ? "강의 전체를 요약하고 있어요" : "예상문제를 만들고 있어요";
  studyProgress.set(courseId, firstLabel);
  if (getCourse()?.id === courseId) render();
  let wasAdded = false;

  try {
    if (isConceptQuiz) {
      const context = `학생의 질문: ${originalQuestion}\n\n앞선 쉬운 설명:\n${answerMessage.text}`;
      const conceptCounts = { multipleChoiceCount: 3, shortAnswerCount: 0 };
      const answer = await callAiTask("quiz-concept", context, originalPages.map(({ fileName, pageNumber, text }) => ({ fileName, pageNumber, text })), conceptCounts);
      const quiz = parseQuiz(answer, "concept", conceptCounts);
      appendStudyMessage(course, { kind: "quiz", quiz, sources: uniqueSourceRefs(originalPages) });
    } else {
      const pages = action === "quiz-course" ? quizSettings?.pages || null : null;
      const prepared = await prepareCourseContext(course, courseId, pages);
      updateStudyProgress(courseId, action === "summary" ? "핵심 개념과 출처를 정리하고 있어요" : "강의 전체 범위에서 문제를 만들고 있어요");
      const task = action === "summary" ? "summary" : "quiz-course";
      const answer = await callAiTask(task, "", prepared.sources, action === "quiz-course" ? quizSettings : null);
      if (action === "summary") {
        appendStudyMessage(course, { kind: "summary", text: answer, sources: prepared.references });
      } else {
        const counts = {
          multipleChoiceCount: quizSettings?.multipleChoiceCount ?? 5,
          shortAnswerCount: quizSettings?.shortAnswerCount ?? 5,
        };
        appendStudyMessage(course, { kind: "quiz", quiz: parseQuiz(answer, "course", counts), sources: prepared.references });
      }
    }
    wasAdded = true;
  } catch (error) {
    showToast(error.message || "요청을 마치지 못했어요. 잠시 뒤 다시 시도해 주세요.", true);
  } finally {
    busyCourses.delete(courseId);
    studyProgress.delete(courseId);
    if (wasAdded) await saveState();
    if (getCourse()?.id === courseId) render();
  }
}

async function gradeShortAnswer(messageId, questionIndex, response) {
  const course = getCourse();
  const message = course?.messages.find((item) => item.id === messageId && item.quiz);
  const item = message?.quiz.shortAnswers?.[questionIndex];
  const answer = String(response || "").trim();
  if (!course || !message || !item || !answer || busyCourses.has(course.id)) {
    if (!answer) showToast("먼저 주관식 답안을 적어 주세요.", true);
    return;
  }
  if (!state.aiConfigured) {
    showToast("AI 연결을 확인한 뒤 다시 채점해 주세요.", true);
    return;
  }

  message.quiz.userResponses[questionIndex] = answer;
  message.quiz.grades ||= {};
  delete message.quiz.grades[questionIndex];
  const sources = getShortAnswerSources(course, message, item, answer);
  busyCourses.add(course.id);
  studyProgress.set(course.id, "주관식 답안을 채점하고 있어요");
  await saveState();
  if (getCourse()?.id === course.id) render();

  try {
    const responseText = await callAiTask(
      "grade-short-answer",
      item.question,
      sources,
      null,
      { referenceAnswer: item.answer, userAnswer: answer },
    );
    message.quiz.grades[questionIndex] = { ...parseShortAnswerGrade(responseText), submittedAnswer: answer, gradedAt: Date.now() };
    course.updatedAt = Date.now();
  } catch (error) {
    showToast(error.message || "채점하지 못했어요. 잠시 뒤 다시 시도해 주세요.", true);
  } finally {
    busyCourses.delete(course.id);
    studyProgress.delete(course.id);
    await saveState();
    if (getCourse()?.id === course.id) render();
  }
}

function readQuizSettings(form) {
  const multipleChoiceCount = Number(form.elements.multipleChoiceCount.value);
  const shortAnswerCount = Number(form.elements.shortAnswerCount.value);

  const courseId = form.dataset.courseId;
  const course = getCourse(courseId);
  if (!course) throw new Error("강의를 찾을 수 없어요. 다시 선택해 주세요.");

  const scopes = [...form.querySelectorAll("[data-quiz-scope-document]")].map((row) => ({
    documentId: row.dataset.docId,
    enabled: Boolean(row.querySelector(".quiz-scope-enabled")?.checked),
    start: Number(row.querySelector(".quiz-page-start")?.value),
    end: Number(row.querySelector(".quiz-page-end")?.value),
  }));

  return buildQuizSettings(course, {
    multipleChoiceCount,
    shortAnswerCount,
    scopes,
  });
}

async function askQuestion(question, courseId) {
  const text = question.trim();
  const course = getCourse(courseId);
  if (!text || !course || busyCourses.has(courseId)) return;
  if (!course.documents.length) {
    showToast("먼저 이 강의에 PDF 자료를 올려 주세요.", true);
    return;
  }

  course.messages.push({ id: makeId(), role: "user", text, createdAt: Date.now() });
  course.updatedAt = Date.now();
  busyCourses.add(courseId);
  studyProgress.set(courseId, "자료에서 근거를 찾고 있어요");
  await saveState();
  if (getCourse()?.id === courseId) render();

  try {
    const answer = await createAnswer(text, course);
    course.messages.push({ id: makeId(), role: "assistant", ...answer, createdAt: Date.now() });
  } catch (error) {
    course.messages.push({ id: makeId(), role: "assistant", kind: "search", sources: [], text: error.message || "답변을 불러오지 못했어요. 잠시 뒤 다시 질문해 주세요.", createdAt: Date.now() });
  } finally {
    busyCourses.delete(courseId);
    studyProgress.delete(courseId);
    course.updatedAt = Date.now();
    await saveState();
    if (getCourse()?.id === courseId) render();
  }
}

function openCourseDialog() {
  const dialog = document.querySelector("#course-dialog");
  const form = document.querySelector("#course-form");
  form.reset();
  document.querySelector("#course-file-name").textContent = "PDF를 함께 올릴 수 있어요";
  dialog.showModal();
  window.setTimeout(() => document.querySelector("#course-name")?.focus(), 30);
}

function closeDialog(selector) {
  const dialog = document.querySelector(selector);
  if (dialog?.open) dialog.close();
}

async function createCourse(form) {
  const nameInput = form.elements.courseName;
  const baseName = nameInput.value.trim();
  const selectedFile = document.querySelector("#course-file").files[0];
  if (!baseName) {
    nameInput.focus();
    return;
  }
  if (selectedFile) {
    const validationError = validatePdf(selectedFile);
    if (validationError) {
      showToast(validationError, true);
      return;
    }
  }

  let name = baseName;
  let suffix = 1;
  while (state.courses.some((course) => course.name === name)) {
    name = `${baseName} (${suffix})`;
    suffix += 1;
  }
  const course = { id: makeId(), name, createdAt: Date.now(), updatedAt: Date.now(), documents: [], messages: [] };
  state.courses.unshift(course);
  state.activeCourseId = course.id;
  sidebarOpen = false;
  closeDialog("#course-dialog");
  await saveState();
  render();
  if (selectedFile) await addFiles([selectedFile], course.id);
}

async function deleteCourse(courseId) {
  const course = getCourse(courseId);
  if (!course) return;
  const detail = course.documents.length
    ? `PDF ${course.documents.length}개와 대화 기록도 함께 삭제돼요.`
    : "이 강의의 대화 기록도 함께 삭제돼요.";
  if (!window.confirm(`“${course.name}” 강의를 삭제할까요?\n${detail}`)) return;

  state.courses = state.courses.filter((item) => item.id !== courseId);
  if (state.activeCourseId === courseId) {
    state.activeCourseId = state.courses[0]?.id || null;
    state.chatExpanded = false;
  }
  expandedDocumentLists.delete(courseId);
  courseQuizPreferences.delete(courseId);
  busyCourses.delete(courseId);
  studyProgress.delete(courseId);
  uploadStates.delete(courseId);
  await saveState();
  render();
  showToast(`“${course.name}” 강의를 삭제했어요.`);
}

async function removeDocument(courseId, documentId) {
  const course = getCourse(courseId);
  const target = getDocument(course, documentId);
  if (!course || !target) return;
  if (!window.confirm(`"${target.fileName}" 자료를 삭제할까요?`)) return;
  course.documents = course.documents.filter((document) => document.id !== documentId);
  if (course.documents.length < 3) expandedDocumentLists.delete(courseId);
  course.messages = course.messages.map((message) => ({
    ...message,
    sources: (message.sources || []).filter((source) => source.documentId !== documentId),
  }));
  course.updatedAt = Date.now();
  await saveState();
  render();
  showToast("강의 자료를 삭제했어요.");
}

function showSource(documentId, pageNumbers) {
  const course = getCourse();
  const { document, pages } = getSourcePages(course, documentId, pageNumbers);
  if (!document || !pages.length) return;
  const dialog = window.document.querySelector("#source-dialog");
  dialog.querySelector("#source-dialog-title").textContent = document.fileName;
  dialog.querySelector("#source-dialog-meta").textContent = `PDF 자료 · ${pages.map((page) => `${page.pageNumber}쪽`).join(", ")}`;
  dialog.querySelector("#source-page-text").textContent = pages.map((page) => `──── ${page.pageNumber}쪽 ────\n${page.text || "이 페이지에서 선택할 수 있는 글자를 찾지 못했어요."}`).join("\n\n");
  dialog.showModal();
}

function onClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    if (event.target.tagName === "DIALOG" && event.target.open) event.target.close();
    return;
  }

  const action = target.dataset.action;
  if (action === "new-course") openCourseDialog();
  if (action === "reload-app") window.location.reload();
  if (action === "close-course-dialog") closeDialog("#course-dialog");
  if (action === "close-source-dialog") closeDialog("#source-dialog");
  if (action === "close-quiz-settings") closeDialog("#quiz-settings-dialog");
  if (action === "open-sidebar") {
    state.sidebarCollapsed = false;
    sidebarOpen = window.matchMedia("(max-width: 760px)").matches;
    render();
  }
  if (action === "close-sidebar") {
    sidebarOpen = false;
    if (!window.matchMedia("(max-width: 760px)").matches) state.sidebarCollapsed = true;
    render();
  }
  if (action === "select-course") {
    state.activeCourseId = target.dataset.courseId;
    state.chatExpanded = false;
    state.sidebarCollapsed = false;
    sidebarOpen = false;
    void saveState();
    render();
  }
  if (action === "delete-course") void deleteCourse(target.dataset.courseId);
  if (action === "generate-summary") void runStudyAction("summary", state.activeCourseId);
  if (action === "generate-course-quiz") {
    void runStudyAction("quiz-course", state.activeCourseId, "", {
      multipleChoiceCount: 5,
      shortAnswerCount: 5,
    });
  }
  if (action === "open-quiz-settings") {
    const dialog = document.querySelector("#quiz-settings-dialog");
    if (dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector('[name="multipleChoiceCount"]')?.focus();
    }
  }
  if (action === "set-all-quiz-scope") {
    const form = target.closest("form");
    const selected = target.dataset.selected === "true";
    for (const checkbox of form?.querySelectorAll(".quiz-scope-enabled:not(:disabled)") || []) checkbox.checked = selected;
  }
  if (action === "generate-concept-quiz") void runStudyAction("quiz-concept", state.activeCourseId, target.dataset.messageId);
  if (action === "grade-short-answer") {
    const questionIndex = Number(target.dataset.questionIndex);
    const response = target.closest(".quiz-short-question")?.querySelector(".quiz-response")?.value || "";
    void gradeShortAnswer(target.dataset.messageId, questionIndex, response);
  }
  if (action === "select-quiz-option") {
    const message = getCourse()?.messages.find((item) => item.id === target.dataset.messageId && item.quiz);
    const questionIndex = Number(target.dataset.questionIndex);
    const optionIndex = Number(target.dataset.optionIndex);
    if (message && Number.isInteger(questionIndex) && Number.isInteger(optionIndex)) {
      message.quiz.userAnswers[questionIndex] = optionIndex;
      void saveState();
      render();
    }
  }
  if (action === "toggle-chat-expand") {
    state.chatExpanded = !state.chatExpanded;
    render();
    document.querySelector(".chat-expand-button")?.focus({ preventScroll: true });
  }
  if (action === "upload-pdf") document.querySelector("#workspace-file-input")?.click();
  if (action === "remove-document") void removeDocument(target.dataset.courseId, target.dataset.docId);
  if (action === "toggle-documents") {
    const courseId = target.dataset.courseId;
    if (expandedDocumentLists.has(courseId)) expandedDocumentLists.delete(courseId);
    else expandedDocumentLists.add(courseId);
    render();
    document.querySelector(".document-count-toggle")?.focus({ preventScroll: true });
  }
  if (action === "show-source") showSource(target.dataset.docId, target.dataset.pages);
  if (action === "prompt") {
    const input = document.querySelector("#question-input");
    if (input) {
      input.value = target.dataset.question || "";
      input.closest("form")?.requestSubmit();
    }
  }
}

document.addEventListener("click", onClick);

app.addEventListener("contextmenu", (event) => {
  const bubble = event.target.closest('.message--assistant[data-context-quiz="true"] .message-bubble');
  if (!bubble) return;
  event.preventDefault();
  const answer = bubble.closest(".message--assistant[data-message-id]");
  if (answer) void runStudyAction("quiz-concept", state.activeCourseId, answer.dataset.messageId);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !state.chatExpanded || document.querySelector("dialog[open]")) return;
  state.chatExpanded = false;
  render();
  document.querySelector(".chat-expand-button")?.focus({ preventScroll: true });
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "course-form") {
    event.preventDefault();
    void createCourse(event.target);
    return;
  }
  if (event.target.id === "quiz-settings-form") {
    event.preventDefault();
    const form = event.target;
    const courseId = form.dataset.courseId;
    try {
      const settings = readQuizSettings(form);
      courseQuizPreferences.set(courseId, {
        multipleChoiceCount: settings.multipleChoiceCount,
        shortAnswerCount: settings.shortAnswerCount,
        selectedIds: settings.selectedIds,
        ranges: settings.ranges,
      });
      closeDialog("#quiz-settings-dialog");
      void runStudyAction("quiz-course", courseId, "", settings);
    } catch (error) {
      showToast(error.message || "문제 설정을 확인해 주세요.", true);
    }
    return;
  }
  if (event.target.id === "chat-form") {
    event.preventDefault();
    const form = event.target;
    const input = form.elements.question;
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    input.style.height = "";
    void askQuestion(question, form.dataset.courseId);
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "course-file") {
    const file = event.target.files[0];
    document.querySelector("#course-file-name").textContent = file?.name || "PDF를 함께 올릴 수 있어요";
  }
  if (event.target.id === "workspace-file-input") {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length) void addFiles(files, state.activeCourseId);
  }
  if (event.target.matches(".quiz-response")) {
    const message = getCourse()?.messages.find((item) => item.id === event.target.dataset.messageId && item.quiz);
    const questionIndex = Number(event.target.dataset.questionIndex);
    if (message && Number.isInteger(questionIndex)) {
      message.quiz.userResponses[questionIndex] = event.target.value;
      if (message.quiz.grades) delete message.quiz.grades[questionIndex];
      void saveState();
    }
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "question-input") {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`;
    return;
  }
  if (!event.target.matches(".quiz-response")) return;
  const message = getCourse()?.messages.find((item) => item.id === event.target.dataset.messageId && item.quiz);
  const questionIndex = Number(event.target.dataset.questionIndex);
  const answer = event.target.value;
  const gradeButton = event.target.closest(".quiz-short-question")?.querySelector(".quiz-grade-button");
  if (gradeButton) gradeButton.disabled = !answer.trim() || busyCourses.has(getCourse()?.id);
  if (message && Number.isInteger(questionIndex)) {
    message.quiz.userResponses[questionIndex] = answer;
    if (message.quiz.grades?.[questionIndex]) {
      delete message.quiz.grades[questionIndex];
      event.target.closest(".quiz-short-question")?.querySelector(".quiz-grade-feedback")?.remove();
    }
  }
});

app.addEventListener("dragover", (event) => {
  if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
  event.preventDefault();
  document.querySelector("#workspace")?.classList.add("is-dragging");
});

app.addEventListener("dragleave", (event) => {
  if (!app.contains(event.relatedTarget)) document.querySelector("#workspace")?.classList.remove("is-dragging");
});

app.addEventListener("drop", (event) => {
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  event.preventDefault();
  document.querySelector("#workspace")?.classList.remove("is-dragging");
  if (!state.activeCourseId) {
    showToast("먼저 강의를 등록한 뒤 PDF를 올려 주세요.", true);
    return;
  }
  void addFiles(files, state.activeCourseId);
});

async function checkAiStatus() {
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    state.aiConfigured = Boolean(status.aiConfigured);
    state.apiKeyConfigured = Boolean(status.apiKeyConfigured);
    state.baseUrlConfigured = Boolean(status.baseUrlConfigured);
    render();
  } catch {
    state.aiConfigured = false;
    state.apiKeyConfigured = false;
    state.baseUrlConfigured = false;
    render();
  }
}

async function initialize() {
  try {
    render();
  } catch (error) {
    renderRecoveryScreen(error);
    return;
  }
  try {
    const stored = await readStoredState();
    if (stored && Array.isArray(stored.courses)) {
      state.courses = stored.courses.map(normalizeStoredCourse).filter(Boolean);
      state.activeCourseId = state.courses.some((course) => course.id === stored.activeCourseId)
        ? stored.activeCourseId
        : state.courses[0]?.id || null;
    }
    render();
  } catch (error) {
    renderRecoveryScreen(error);
  }
  void checkAiStatus();
}

window.addEventListener("error", (event) => {
  if (!document.querySelector(".app-shell, .recovery-screen")) renderRecoveryScreen(event.error || new Error(event.message || "화면 초기화 오류"));
});

window.addEventListener("unhandledrejection", (event) => {
  if (!document.querySelector(".app-shell, .recovery-screen")) {
    event.preventDefault();
    renderRecoveryScreen(event.reason);
  }
});

void initialize();
