import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { afterEach, describe, test } from "node:test";
import { createStudyApiPlugin, getChatCompletionsUrl } from "../vite.config.js";

const testApiKey = "test-only-server-key";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Register the real Vite middleware handlers without starting a network server.
function makeApi(apiKey = testApiKey, endpoint = "https://llm.example.test/v1/chat/completions") {
  const handlers = new Map();
  const plugin = createStudyApiPlugin(apiKey, endpoint);
  plugin.configureServer({
    middlewares: {
      use(path, handler) {
        handlers.set(path, handler);
      },
    },
  });
  return handlers;
}

async function invoke(handler, method, body = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method = method;
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; },
  };
  await handler(request, response);
  return { ...response, json: JSON.parse(response.body || "null") };
}

function mockChatResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("LLM 서버 연결", () => {
  test("API 기본 주소를 Chat Completions 경로로 정리하고 위험한 주소는 거부한다", () => {
    assert.equal(getChatCompletionsUrl("https://llm.example.test/v1/"), "https://llm.example.test/v1/chat/completions");
    assert.equal(getChatCompletionsUrl("https://llm.example.test/v1/chat/completions"), "https://llm.example.test/v1/chat/completions");
    assert.equal(getChatCompletionsUrl("file:///tmp/llm"), null);
    assert.equal(getChatCompletionsUrl("https://user:password@llm.example.test/v1"), null);
  });

  test("상태 API는 키 설정 여부만 반환하고 키 값은 공개하지 않는다", async () => {
    const response = await invoke(makeApi().get("/api/status"), "GET");

    assert.deepEqual(response.json, { aiConfigured: true, apiKeyConfigured: true, baseUrlConfigured: true });
    assert.equal(JSON.stringify(response.json).includes(testApiKey), false);
  });

  test("질문·요약·두 종류의 문제 생성·채점을 서버 키로 각각 전송한다", async () => {
    const handlers = makeApi();
    const route = handlers.get("/api/answer");
    const cases = [
      {
        name: "질문 답변",
        body: { task: "answer", question: "반복 학습이란 무엇인가요?", sources: [{ fileName: "학습.pdf", pageNumber: 2, text: "반복 학습은 기억을 돕는다." }] },
        systemText: "친절한 한국어 튜터",
      },
      {
        name: "강의 요약",
        body: { task: "summary", sources: [{ fileName: "학습.pdf", pageNumber: 2, text: "반복 학습은 기억을 돕는다." }] },
        systemText: "핵심 개념",
      },
      {
        name: "설정한 개수의 전체 문제",
        body: { task: "quiz-course", quizSettings: { multipleChoiceCount: 2, shortAnswerCount: 1 }, sources: [{ fileName: "학습.pdf", pageNumber: 2, text: "반복 학습은 기억을 돕는다." }] },
        systemText: "객관식 2개와 주관식 1개",
      },
      {
        name: "질문 개념 문제",
        body: { task: "quiz-concept", question: "앞선 설명: 반복 학습은 기억을 돕는다.", sources: [{ fileName: "학습.pdf", pageNumber: 2, text: "반복 학습은 기억을 돕는다." }] },
        systemText: "객관식 문제를 정확히 3개",
      },
      {
        name: "주관식 답안 채점",
        body: { task: "grade-short-answer", question: "반복 학습의 효과는?", grading: { referenceAnswer: "기억을 돕는다.", userAnswer: "오래 기억하게 한다." } },
        systemText: "공정하고 친절한 한국어 채점 도우미",
      },
    ];

    // Replace only server-side fetch so tests never contact a paid external model.
    for (const scenario of cases) {
      let upstreamRequest;
      globalThis.fetch = async (url, options) => {
        upstreamRequest = { url, options, body: JSON.parse(options.body) };
        return mockChatResponse("검증된 응답");
      };

      const response = await invoke(route, "POST", scenario.body);
      assert.equal(response.statusCode, 200, scenario.name);
      assert.equal(response.json.answer, "검증된 응답", scenario.name);
      assert.equal(upstreamRequest.url, "https://llm.example.test/v1/chat/completions", scenario.name);
      assert.equal(upstreamRequest.body.model, "jitda-chat", scenario.name);
      assert.equal(upstreamRequest.body.messages[0].content.includes(scenario.systemText), true, scenario.name);
      assert.equal(upstreamRequest.options.headers.Authorization, `Bearer ${testApiKey}`, scenario.name);
      assert.equal(JSON.stringify(response.json).includes(testApiKey), false, `${scenario.name}: 키가 응답으로 노출되면 안 됩니다.`);
      if (scenario.body.task === "grade-short-answer") {
        assert.match(upstreamRequest.body.messages[1].content, /모범 답안/);
        assert.match(upstreamRequest.body.messages[1].content, /학생 답안/);
      }
    }
  });

  test("잘못된 문제 설정과 채점 입력은 LLM 호출 전에 거부한다", async () => {
    const route = makeApi().get("/api/answer");
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return mockChatResponse("사용되면 안 되는 응답");
    };

    const invalidQuiz = await invoke(route, "POST", {
      task: "quiz-course",
      quizSettings: { multipleChoiceCount: 0, shortAnswerCount: 0 },
      sources: [{ fileName: "학습.pdf", pageNumber: 1, text: "내용" }],
    });
    assert.equal(invalidQuiz.statusCode, 400);
    assert.equal(invalidQuiz.json.error, "INVALID_QUIZ_SETTINGS");

    const incompleteGrade = await invoke(route, "POST", {
      task: "grade-short-answer",
      question: "질문",
      grading: { referenceAnswer: "모범 답안", userAnswer: "" },
    });
    assert.equal(incompleteGrade.statusCode, 400);
    assert.equal(incompleteGrade.json.error, "INVALID_GRADING_REQUEST");
    assert.equal(upstreamCalls, 0);
  });

  test("키가 설정되지 않은 서버는 AI 호출을 하지 않고 설정 안내를 반환한다", async () => {
    const route = makeApi("", "https://llm.example.test/v1/chat/completions").get("/api/answer");
    let upstreamCalled = false;
    globalThis.fetch = async () => {
      upstreamCalled = true;
      return mockChatResponse("응답");
    };

    const response = await invoke(route, "POST", { task: "answer", question: "질문", sources: [{ text: "내용" }] });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json.error, "AI_NOT_CONFIGURED");
    assert.equal(upstreamCalled, false);
  });
});
