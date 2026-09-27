import { describe, expect, it } from "vitest";
import { requirementCardSchema } from "../src/cards.js";

const valid = {
  title: "登录",
  goal: "单用户能登录",
  context: "只有管理员一个人使用",
  acceptanceCriteria: ["错误密码返回 401"],
};

describe("requirementCardSchema", () => {
  it("接受完整的需求卡", () => {
    expect(requirementCardSchema.parse(valid)).toMatchObject(valid);
  });

  it("拒绝缺少必填字段的输入", () => {
    const result = requirementCardSchema.safeParse({ title: "只有标题" });
    expect(result.success).toBe(false);
  });
});
