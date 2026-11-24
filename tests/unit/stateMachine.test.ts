import { describe, expect, it } from "vitest";
import { TRANSITIONS, planTransition, type Transition, type TransitionActor, type TransitionInput, type TransitionTask } from "@carerelay/domain";

function satisfy(t: Transition): { task: TransitionTask; actor: TransitionActor; input: TransitionInput } {
  const selfLike = t.actor.kind === "self";
  const assignee = selfLike || t.guards.includes("noCurrentAssignee") ? null : "m1";
  const task: TransitionTask = { state: t.from, category: "MEDICATION", assigneeMemberId: assignee, requiredQualification: null };
  let actor: TransitionActor;
  switch (t.actor.kind) {
    case "system":
      actor = { type: "SYSTEM", permissions: [] };
      break;
    case "permission":
      actor = { type: "USER", memberId: "m9", permissions: [t.actor.permission] };
      break;
    case "verifyByCategory":
      actor = { type: "USER", memberId: "m9", permissions: ["verify_medical"] };
      break;
    case "assigneeOnly":
    case "assigneeOrDeclaration":
      actor = { type: "USER", memberId: "m1", permissions: [] };
      break;
    case "declarationRequired":
      actor = { type: "USER", memberId: "m9", permissions: ["record_care"] };
      break;
    case "self":
      actor = { type: "USER", memberId: "m2", permissions: ["record_care"] };
      break;
  }
  const input: TransitionInput = {
    reason: "because",
    declaration: "I did it at 08:05",
    targetMember: selfLike ? { id: "m2", qualifications: [] } : { id: "m3", qualifications: [] },
    resolveTo: t.event === "RESOLVE_CONFLICT" ? t.to : undefined,
  };
  return { task, actor, input };
}

describe("task state machine — every allowed transition", () => {
  it.each(TRANSITIONS.map((t) => [`${t.from} --${t.event}--> ${t.to}`, t] as const))("%s", (_name, t) => {
    const { task, actor, input } = satisfy(t);
    const r = planTransition(task, t.event, actor, input);
    expect(r.ok, r.ok ? "" : r.message).toBe(true);
    if (r.ok) expect(r.transition.to).toBe(t.to);
  });
});

describe("task state machine — forbidden transitions", () => {
  const user = (memberId: string, permissions: TransitionActor["permissions"]): TransitionActor => ({ type: "USER", memberId, permissions });
  const base = (state: TransitionTask["state"], over: Partial<TransitionTask> = {}): TransitionTask => ({ state, category: "MEDICATION", assigneeMemberId: "m1", requiredQualification: null, ...over });

  it("assigning is not acceptance: only the assignee can acknowledge", () => {
    const r = planTransition(base("AWAITING_ACKNOWLEDGEMENT"), "ACKNOWLEDGE", user("m2", ["manage_tasks", "record_care"]));
    expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
  it("cannot assign a completed task", () => {
    expect(planTransition(base("COMPLETED"), "ASSIGN", user("m2", ["manage_tasks"]), { targetMember: { id: "m3", qualifications: [] } })).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
  });
  it("users cannot mark tasks overdue", () => {
    expect(planTransition(base("ACKNOWLEDGED"), "MARK_OVERDUE", user("m2", ["manage_tasks"]))).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
  it("non-assignee completion needs a declaration", () => {
    expect(planTransition(base("ACKNOWLEDGED"), "COMPLETE", user("m2", ["record_care"]))).toMatchObject({ ok: false, code: "GUARD_FAILED" });
  });
  it("completing an unaccepted task always needs a declaration", () => {
    expect(planTransition(base("UNASSIGNED", { assigneeMemberId: null }), "COMPLETE", user("m2", ["record_care"]))).toMatchObject({ ok: false, code: "GUARD_FAILED" });
  });
  it("leaving CONFLICTING requires resolve_conflicts", () => {
    expect(planTransition(base("CONFLICTING"), "RESOLVE_CONFLICT", user("m1", ["record_care"]), { reason: "x", resolveTo: "COMPLETED" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
  it("cancel requires a reason", () => {
    expect(planTransition(base("UNASSIGNED"), "CANCEL", user("m2", ["manage_tasks"]))).toMatchObject({ ok: false, code: "GUARD_FAILED" });
  });
  it("medical verification requires verify_medical (manage_tasks is not enough)", () => {
    expect(planTransition(base("AWAITING_VERIFICATION"), "VERIFY", user("m2", ["manage_tasks"]))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(planTransition(base("AWAITING_VERIFICATION", { category: "ERRAND" }), "VERIFY", user("m2", ["manage_tasks"]))).toMatchObject({ ok: true });
  });
  it("cannot claim a task someone else owns", () => {
    expect(planTransition(base("OVERDUE"), "CLAIM", user("m2", ["record_care"]), { targetMember: { id: "m2", qualifications: [] } })).toMatchObject({ ok: false, code: "GUARD_FAILED" });
  });
  it("cannot claim on behalf of someone else", () => {
    expect(planTransition(base("UNASSIGNED", { assigneeMemberId: null }), "CLAIM", user("m2", ["record_care"]), { targetMember: { id: "m3", qualifications: [] } })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  describe("qualification guard", () => {
    const wound = base("UNASSIGNED", { assigneeMemberId: null, category: "WOUND_CARE", requiredQualification: "WOUND_CARE_TRAINED" });
    it("refuses an unqualified assignee", () => {
      const r = planTransition(wound, "ASSIGN", user("p", ["manage_tasks"]), { targetMember: { id: "ravi", qualifications: [] } });
      expect(r).toMatchObject({ ok: false, code: "GUARD_FAILED" });
      if (!r.ok) expect(r.message).toContain("WOUND_CARE_TRAINED");
    });
    it("allows a qualified assignee", () => {
      expect(planTransition(wound, "ASSIGN", user("p", ["manage_tasks"]), { targetMember: { id: "meena", qualifications: ["WOUND_CARE_TRAINED"] } })).toMatchObject({ ok: true });
    });
    it("refuses an unqualified self-claim and unqualified reassignment", () => {
      expect(planTransition(wound, "CLAIM", user("ravi", ["record_care"]), { targetMember: { id: "ravi", qualifications: [] } })).toMatchObject({ ok: false, code: "GUARD_FAILED" });
      expect(planTransition({ ...wound, state: "ACKNOWLEDGED", assigneeMemberId: "meena" }, "REASSIGN", user("p", ["manage_tasks"]), { targetMember: { id: "ravi", qualifications: [] } })).toMatchObject({ ok: false, code: "GUARD_FAILED" });
    });
  });
});
