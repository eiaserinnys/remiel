import { describe, it, expect, vi, beforeEach } from "vitest";
import { UserResolver } from "../src/user-resolver.js";

function createMockClient(responses: Record<string, any> = {}) {
  return {
    users: {
      info: vi.fn(async ({ user }: { user: string }) => {
        if (responses[user]) return responses[user];
        throw new Error("user_not_found");
      }),
    },
  } as any;
}

describe("UserResolver", () => {
  it("display_name을 우선 반환한다", async () => {
    const client = createMockClient({
      U001: {
        user: {
          profile: { display_name: "홍길동" },
          real_name: "Gil-dong Hong",
          name: "hong",
        },
      },
    });
    const resolver = new UserResolver(client);
    expect(await resolver.resolve("U001")).toBe("홍길동");
  });

  it("display_name이 없으면 real_name을 반환한다", async () => {
    const client = createMockClient({
      U002: {
        user: {
          profile: { display_name: "" },
          real_name: "Jane Doe",
          name: "jane",
        },
      },
    });
    const resolver = new UserResolver(client);
    expect(await resolver.resolve("U002")).toBe("Jane Doe");
  });

  it("display_name, real_name 모두 없으면 name을 반환한다", async () => {
    const client = createMockClient({
      U003: {
        user: {
          profile: { display_name: "" },
          real_name: "",
          name: "fallback_name",
        },
      },
    });
    const resolver = new UserResolver(client);
    expect(await resolver.resolve("U003")).toBe("fallback_name");
  });

  it("API 호출 실패 시 userId를 그대로 반환한다", async () => {
    const client = createMockClient({}); // no responses → throws
    const resolver = new UserResolver(client);
    expect(await resolver.resolve("U999")).toBe("U999");
  });

  it("캐시가 동작한다 — 같은 userId로 두 번 호출하면 API는 한 번만 호출된다", async () => {
    const client = createMockClient({
      U001: {
        user: {
          profile: { display_name: "캐시맨" },
          real_name: "Cache Man",
        },
      },
    });
    const resolver = new UserResolver(client);

    await resolver.resolve("U001");
    await resolver.resolve("U001");

    expect(client.users.info).toHaveBeenCalledTimes(1);
  });
});
