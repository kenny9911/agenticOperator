import { describe, it, expect } from "vitest";
import { pickDisplayName, pickId } from "./allmeta-client";

describe("pickDisplayName", () => {
  it("Candidate: returns name field", () => {
    expect(pickDisplayName("Candidate", { name: "张三" })).toBe("张三");
  });
  it("Candidate: returns null when name is placeholder '未命名候选人'", () => {
    expect(pickDisplayName("Candidate", { name: "未命名候选人" })).toBeNull();
  });
  it("Candidate: prefers explicit displayName when set", () => {
    expect(pickDisplayName("Candidate", { displayName: "李四", name: "张三" })).toBe("李四");
  });
  it("Resume: derives from file_path when no name field", () => {
    expect(pickDisplayName("Resume", { file_path: "/uploads/【深圳】赵杰 8年.pdf" })).toBe("【深圳】赵杰 8年");
  });
  it("Resume: takes first line of summary if available", () => {
    expect(pickDisplayName("Resume", { summary: "10年Java\n后端开发" })).toBe("10年Java");
  });
  it("Job_Requisition: prefers title", () => {
    expect(pickDisplayName("Job_Requisition", { title: "前端工程师", position_name: "Frontend Dev" })).toBe("前端工程师");
  });
  it("unknown type falls back to name then title", () => {
    expect(pickDisplayName("MysteryType", { title: "X" })).toBe("X");
  });
  it("returns null when nothing usable", () => {
    expect(pickDisplayName("Candidate", { foo: "bar" })).toBeNull();
  });
  it("Candidate: returns null when name is 'Unknown'", () => {
    expect(pickDisplayName("Candidate", { name: "Unknown" })).toBeNull();
  });
  it("Resume: truncates long summary first line to 40 chars", () => {
    const longLine = "A".repeat(45);
    const result = pickDisplayName("Resume", { summary: longLine });
    expect(result).toBe("A".repeat(40) + "…");
  });
  it("Job_Posting: prefers title field", () => {
    expect(pickDisplayName("Job_Posting", { title: "高级Java开发", posting_title: "Java Dev" })).toBe("高级Java开发");
  });
  it("Job_Requisition: falls back to position_name when title absent", () => {
    expect(pickDisplayName("Job_Requisition", { position_name: "Backend Engineer" })).toBe("Backend Engineer");
  });
  it("Resume: falls through to file_path stem when summary is placeholder", () => {
    expect(pickDisplayName("Resume", { summary: "未命名", file_path: "/uploads/resume.pdf" })).toBe("resume");
  });
});

describe("pickId", () => {
  it("Candidate: uses candidate_id field", () => {
    expect(pickId("Candidate", { candidate_id: "C-1" })).toBe("C-1");
  });
  it("falls back to id field", () => {
    expect(pickId("Candidate", { id: "C-1" })).toBe("C-1");
  });
  it("returns null when neither present", () => {
    expect(pickId("Candidate", {})).toBeNull();
  });
  it("Resume: uses resume_id field", () => {
    expect(pickId("Resume", { resume_id: "R-1" })).toBe("R-1");
  });
  it("Job_Requisition: uses job_requisition_id field", () => {
    expect(pickId("Job_Requisition", { job_requisition_id: "JR-42" })).toBe("JR-42");
  });
  it("prefers type-specific id over generic id", () => {
    expect(pickId("Candidate", { candidate_id: "C-specific", id: "generic" })).toBe("C-specific");
  });
});
