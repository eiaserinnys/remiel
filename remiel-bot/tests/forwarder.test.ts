import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessageForwarder } from "../src/forwarder.js";
import { UserResolver } from "../src/user-resolver.js";

const SERVER_URL = "http://localhost:3120";
const API_KEY = "test-api-key";

function createMockResolver(nameMap: Record<string, { name: string; avatarUrl: string | null }> = {}): UserResolver {
  return {
    resolve: vi.fn(async (userId: string) => nameMap[userId] ?? { name: userId, avatarUrl: null }),
  } as unknown as UserResolver;
}

function createMockWebClient(channels: Record<string, string> = {}) {
  return {
    conversations: {
      info: vi.fn(async ({ channel }: { channel: string }) => ({
        channel: { name: channels[channel] ?? channel },
      })),
    },
  } as any;
}

describe("MessageForwarder", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("forwardMessage", () => {
    it("일반 사용자 메시지를 POST /api/messages 로 포워딩한다", async () => {
      const resolver = createMockResolver({
        U001: { name: "홍길동", avatarUrl: "https://img/48.png" },
      });
      const forwarder = new MessageForwarder(SERVER_URL, API_KEY);
      forwarder.setUserResolver(resolver);

      await forwarder.forwardMessage({
        channel: "C123",
        ts: "1234.5678",
        user: "U001",
        text: "안녕하세요",
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${SERVER_URL}/api/messages`);
      expect(opts.method).toBe("POST");
      expect(opts.headers["x-api-key"]).toBe(API_KEY);

      const body = JSON.parse(opts.body);
      expect(body.channel_id).toBe("C123");
      expect(body.ts).toBe("1234.5678");
      expect(body.user_id).toBe("U001");
      expect(body.user_name).toBe("홍길동");
      expect(body.avatar_url).toBe("https://img/48.png");
      expect(body.content).toBe("안녕하세요");
      expect(body.is_bot).toBe(false);
      expect(body.thread_ts).toBeNull();
    });

    it("봇 메시지를 포워딩한다 (user 없음, bot_id 있음)", async () => {
      const resolver = createMockResolver();
      const forwarder = new MessageForwarder(SERVER_URL, API_KEY);
      forwarder.setUserResolver(resolver);

      await forwarder.forwardMessage({
        channel: "C123",
        ts: "1234.5678",
        bot_id: "B001",
        text: "봇 메시지",
        bot_profile: { name: "TestBot", icons: { image_48: "https://bot/icon.png" } },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.user_id).toBe("B001");
      expect(body.user_name).toBe("TestBot");
      expect(body.avatar_url).toBe("https://bot/icon.png");
      expect(body.is_bot).toBe(true);
    });

    it("user/bot_id 둘 다 없는 이벤트는 skip하고 warn 로그를 출력한다", async () => {
      const resolver = createMockResolver();
      const forwarder = new MessageForwarder(SERVER_URL, API_KEY);
      forwarder.setUserResolver(resolver);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await forwarder.forwardMessage({
        channel: "C123",
        ts: "9999.0001",
        text: "orphan message",
      });

      // fetch가 호출되지 않아야 한다 (API 전송 없음)
      expect(fetchMock).not.toHaveBeenCalled();

      // warn 로그가 출력되어야 한다
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain("[Forwarder] Skipping event without user/bot_id");
      expect(warnSpy.mock.calls[0][0]).toContain("C123");

      warnSpy.mockRestore();
    });

    it("file_share subtype — text 없어도 user 있으면 정상 포워딩", async () => {
      const resolver = createMockResolver({
        U001: { name: "사용자", avatarUrl: null },
      });
      const forwarder = new MessageForwarder(SERVER_URL, API_KEY);
      forwarder.setUserResolver(resolver);

      await forwarder.forwardMessage({
        channel: "C123",
        ts: "1234.5678",
        user: "U001",
        files: [
          { name: "photo.jpg", filetype: "jpg", url_private: "https://files.slack.com/photo.jpg", size: 2048 },
        ],
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.user_id).toBe("U001");
      expect(body.content).toBe("");
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0].name).toBe("photo.jpg");
    });

    it("스레드 답글의 thread_ts를 포함한다", async () => {
      const resolver = createMockResolver({
        U001: { name: "사용자", avatarUrl: null },
      });
      const forwarder = new MessageForwarder(SERVER_URL, API_KEY);
      forwarder.setUserResolver(resolver);

      await forwarder.forwardMessage({
        channel: "C123",
        ts: "1234.9999",
        thread_ts: "1234.5678",
        user: "U001",
        text: "스레드 답글",
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.thread_ts).toBe("1234.5678");
    });

    it("파일 첨부를 attachments로 변환한다", async () => {
      const resolver = createMockResolver({
        U001: { name: "사용자", avatarUrl: null },
      });
      const forwarder = new MessageForwarder(SERVER_URL, API_KEY);
      forwarder.setUserResolver(resolver);

      await forwarder.forwardMessage({
        channel: "C123",
        ts: "1234.5678",
        user: "U001",
        text: "파일 첨부",
        files: [
          { name: "test.png", filetype: "png", url_private: "https://example.com/test.png", size: 1024 },
        ],
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.attachments).toEqual([
        { name: "test.png", type: "png", url: "https://example.com/test.png", size: 1024 },
      ]);
    });
  });

  describe("forwardUpdate", () => {
    it("PATCH /api/messages/:channel/:ts 로 업데이트를 전송한다", async () => {
      const forwarder = new MessageForwarder(SERVER_URL, API_KEY);

      await forwarder.forwardUpdate("C123", "1234.5678", {
        content: "수정된 메시지",
        source_edited: true,
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${SERVER_URL}/api/messages/C123/1234.5678`);
      expect(opts.method).toBe("PATCH");
      expect(opts.headers["x-api-key"]).toBe(API_KEY);

      const body = JSON.parse(opts.body);
      expect(body.content).toBe("수정된 메시지");
      expect(body.source_edited).toBe(true);
    });

    it("리액션 추가를 전송한다", async () => {
      const forwarder = new MessageForwarder(SERVER_URL, API_KEY);

      await forwarder.forwardUpdate("C123", "1234.5678", {
        reaction_add: { emoji: "thumbsup", user: "U001" },
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.reaction_add).toEqual({ emoji: "thumbsup", user: "U001" });
    });
  });

  describe("forwardDelete", () => {
    it("DELETE /api/messages/:channel/:ts 를 전송한다", async () => {
      const forwarder = new MessageForwarder(SERVER_URL, API_KEY);

      await forwarder.forwardDelete("C123", "1234.5678");

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(`${SERVER_URL}/api/messages/C123/1234.5678`);
      expect(opts.method).toBe("DELETE");
      expect(opts.headers["x-api-key"]).toBe(API_KEY);
    });
  });

  describe("registerChannels", () => {
    it("각 채널 정보를 POST /api/channels 로 등록한다", async () => {
      const forwarder = new MessageForwarder(SERVER_URL, API_KEY);
      const client = createMockWebClient({
        C001: "general",
        C002: "random",
      });

      await forwarder.registerChannels(["C001", "C002"], client);

      expect(fetchMock).toHaveBeenCalledTimes(2);

      const body1 = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body1).toEqual({ id: "C001", name: "general", source: "slack" });

      const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body2).toEqual({ id: "C002", name: "random", source: "slack" });
    });

    it("채널 등록 실패 시 나머지 채널은 계속 등록한다", async () => {
      // 첫 번째 fetch 실패, 두 번째 성공
      fetchMock
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce({ ok: true });

      const forwarder = new MessageForwarder(SERVER_URL, API_KEY);
      const client = createMockWebClient({ C001: "general", C002: "random" });

      // 에러를 던지지 않아야 함
      await forwarder.registerChannels(["C001", "C002"], client);

      // 두 번째 채널도 시도했는지 확인
      expect(client.conversations.info).toHaveBeenCalledTimes(2);
    });
  });
});
