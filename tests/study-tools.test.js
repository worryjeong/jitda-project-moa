import assert from "node:assert/strict";
import { describe, test } from "node:test";
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
} from "../study-tools.js";

function makeCourse() {
  return {
    id: "course-1",
    name: "학습심리학",
    documents: [
      {
        id: "doc-a",
        fileName: "학습자료.pdf",
        pageCount: 4,
        pages: [
          { pageNumber: 1, text: "고전적 조건형성은 자극 사이의 연합을 통해 학습하는 과정이다." },
          { pageNumber: 2, text: "반복 연습은 새로 학습한 정보를 장기 기억으로 옮기는 데 도움을 준다." },
          { pageNumber: 3, text: "간격을 둔 반복 연습은 장기 기억을 더 오래 유지하게 한다." },
          { pageNumber: 4, text: "" },
        ],
      },
      {
        id: "doc-b",
        fileName: "기억과 학습.pdf",
        pageCount: 2,
        pages: [
          { pageNumber: 1, text: "인출 연습은 기억을 강화하는 효과적인 학습 전략이다." },
          { pageNumber: 2, text: "잠은 기억을 정리하고 학습한 내용을 안정화하는 데 기여한다." },
        ],
      },
    ],
  };
}

describe("PDF 검색과 출처 도구", () => {
  test("질문과 관련된 페이지를 점수순으로 최대 세 개 찾는다", () => {
    const course = makeCourse();
    const pages = findRelevantPages("반복 연습은 기억에 어떤 효과가 있나요?", course);

    assert.ok(pages.length > 0 && pages.length <= 3);
    assert.equal(pages[0].documentId, "doc-a");
    assert.ok(pages[0].text.includes("반복 연습"));
  });

  test("관련 용어가 없으면 출처를 추측하지 않고 빈 결과를 반환한다", () => {
    assert.deepEqual(findRelevantPages("천문학의 외계 행성", makeCourse()), []);
  });

  test("같은 PDF 출처와 중복 페이지를 한 묶음으로 만든다", () => {
    const course = makeCourse();
    const sources = [
      { documentId: "doc-a", pageNumber: 3 },
      { documentId: "doc-a", pageNumber: 2 },
      { documentId: "doc-a", pageNumber: 3 },
      { documentId: "missing", pageNumber: 1 },
    ];

    assert.deepEqual(uniqueSourceRefs(sources), [
      { documentId: "doc-a", pageNumber: 3 },
      { documentId: "doc-a", pageNumber: 2 },
      { documentId: "missing", pageNumber: 1 },
    ]);
    assert.deepEqual(groupSourcePages(sources, course).map(({ document, pages }) => ({ fileName: document.fileName, pages })), [
      { fileName: "학습자료.pdf", pages: [2, 3] },
    ]);
  });

  test("출처를 누르면 요청한 페이지의 본문을 페이지 순서로 가져온다", () => {
    const result = getSourcePages(makeCourse(), "doc-a", "3,2,3,99,잘못된 값");

    assert.equal(result.document.fileName, "학습자료.pdf");
    assert.deepEqual(result.pages.map((page) => page.pageNumber), [2, 3]);
    assert.ok(result.pages[0].text.includes("반복 연습"));
    assert.deepEqual(getSourcePages(makeCourse(), "missing", "1").pages, []);
  });
});

describe("요약과 예상문제 도구", () => {
  test("강의 전체 대신 선택한 문서 페이지만 요약 입력으로 모은다", () => {
    const course = makeCourse();
    const selected = [{ documentId: "doc-a", pageNumber: 2 }];

    assert.deepEqual(collectCoursePages(course, selected).map((page) => [page.documentId, page.pageNumber]), [["doc-a", 2]]);
    assert.equal(collectCoursePages(course).length, 5);
  });

  test("긴 PDF 텍스트를 작은 요청 묶음으로 나누면서 내용을 보존한다", () => {
    const source = { documentId: "doc-a", fileName: "학습자료.pdf", pageNumber: 1, text: "가".repeat(7600) };
    const chunks = chunkSources([source], 9000, 1);

    assert.ok(chunks.length >= 3);
    assert.ok(chunks.every((chunk) => chunk.length <= 1));
    assert.equal(chunks.flat().map((page) => page.text).join(""), source.text);
  });

  test("객관식·주관식 개수와 PDF 페이지 범위를 함께 검증한다", () => {
    const settings = buildQuizSettings(makeCourse(), {
      multipleChoiceCount: 2,
      shortAnswerCount: 1,
      scopes: [
        { documentId: "doc-a", enabled: true, start: 2, end: 3 },
        { documentId: "doc-b", enabled: false, start: 1, end: 2 },
      ],
    });

    assert.deepEqual(settings.pages.map((page) => page.pageNumber), [2, 3]);
    assert.deepEqual(settings.selectedIds, ["doc-a"]);
    assert.deepEqual(settings.ranges["doc-a"], { start: 2, end: 3 });
    assert.equal(settings.multipleChoiceCount, 2);
    assert.equal(settings.shortAnswerCount, 1);
  });

  test("잘못된 개수, 페이지 범위, 비어 있는 출제 범위를 거부한다", () => {
    const course = makeCourse();
    const base = { multipleChoiceCount: 2, shortAnswerCount: 1, scopes: [] };

    assert.throws(() => buildQuizSettings(course, { ...base, multipleChoiceCount: 21 }), /0개에서 20개/);
    assert.throws(() => buildQuizSettings(course, { ...base, multipleChoiceCount: 0, shortAnswerCount: 0 }), /한 가지는 1개 이상/);
    assert.throws(() => buildQuizSettings(course, { ...base, scopes: [{ documentId: "doc-a", enabled: true, start: 4, end: 2 }] }), /페이지 범위/);
    assert.throws(() => buildQuizSettings(course, { ...base, scopes: [{ documentId: "doc-a", enabled: true, start: 4, end: 4 }] }), /읽을 수 있는 글자/);
    assert.throws(() => buildQuizSettings(course, { ...base, scopes: [{ documentId: "missing", enabled: true, start: 1, end: 1 }] }), /PDF를 찾을 수/);
  });

  test("AI가 만든 문제를 파싱하고 설정한 개수와 다른 결과는 거부한다", () => {
    const answer = JSON.stringify({
      questions: [{ question: "반복 연습의 효과는?", choices: ["장기 기억", "망각", "피로", "없음"], answerIndex: 0, explanation: "기억 유지에 도움을 줍니다." }],
      shortAnswers: [{ question: "반복 연습은 무엇을 돕나요?", answer: "장기 기억 형성" }],
    });
    const quiz = parseQuiz(answer, "course", { multipleChoiceCount: 1, shortAnswerCount: 1 });

    assert.equal(quiz.questions.length, 1);
    assert.equal(quiz.shortAnswers[0].answer, "장기 기억 형성");
    assert.throws(() => parseQuiz(answer, "course", { multipleChoiceCount: 2, shortAnswerCount: 1 }), /설정한 개수/);
    assert.throws(() => parseQuiz("not json", "course"), /형식/);
  });
});

describe("주관식 채점 도구", () => {
  test("JSON 채점 결과를 점수에 따라 정답·부분 정답·오답으로 변환한다", () => {
    assert.deepEqual(parseShortAnswerGrade('{"score":2,"feedback":"핵심을 설명했어요."}'), {
      score: 2,
      result: "correct",
      feedback: "핵심을 설명했어요.",
    });
    assert.equal(parseShortAnswerGrade('{"score":1,"feedback":"조금 더 설명해 주세요."}').result, "partial");
    assert.equal(parseShortAnswerGrade('{"score":0,"feedback":"문제와 다른 내용이에요."}').result, "incorrect");
    assert.throws(() => parseShortAnswerGrade('{"score":3,"feedback":"잘못된 점수"}'), /점수나 피드백/);
    assert.throws(() => parseShortAnswerGrade("not json"), /채점 결과/);
  });

  test("채점에 보낼 페이지를 문제 출처 안으로 제한한다", () => {
    const course = makeCourse();
    const quizMessage = { sources: [{ documentId: "doc-a", pageNumber: 3 }] };
    const item = { question: "반복 연습은 어떤 기억을 돕나요?", answer: "장기 기억" };
    const sources = getShortAnswerSources(course, quizMessage, item, "장기 기억 형성");

    assert.ok(sources.length > 0);
    assert.ok(sources.every((source) => source.fileName === "학습자료.pdf" && source.pageNumber === 3));
    assert.ok(sources[0].text.includes("반복 연습"));
  });
});
