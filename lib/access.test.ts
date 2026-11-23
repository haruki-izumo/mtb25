import { describe, expect, it } from "vitest";
import {
  memberDirectoryWhere,
  processAccessWhere,
  profileAccessWhere,
} from "./access";

describe("profileAccessWhere", () => {
  it("lets admins see every profile", () => {
    expect(profileAccessWhere("admin", "ADMIN")).toBeUndefined();
  });

  it("limits members to assigned profiles", () => {
    expect(profileAccessWhere("member-1", "MEMBER")).toEqual({
      assignedMembers: { some: { id: "member-1" } },
    });
  });

  it("limits interviewers to profiles they handle", () => {
    expect(profileAccessWhere("iv-1", "INTERVIEWER")).toEqual({
      interviewerId: "iv-1",
    });
  });
});

describe("processAccessWhere", () => {
  it("scopes interview processes through the same profile filter", () => {
    expect(processAccessWhere("iv-1", "INTERVIEWER")).toEqual({
      profile: { interviewerId: "iv-1" },
    });
    expect(processAccessWhere("admin", "ADMIN")).toEqual({});
  });
});

describe("memberDirectoryWhere", () => {
  it("leaves admins and members unscoped", () => {
    expect(memberDirectoryWhere("admin", "ADMIN")).toBeUndefined();
    expect(memberDirectoryWhere("member-1", "MEMBER")).toBeUndefined();
  });

  it("limits interviewers to people on their profiles", () => {
    expect(memberDirectoryWhere("iv-1", "INTERVIEWER")).toEqual({
      OR: [
        { assignedProfiles: { some: { interviewerId: "iv-1" } } },
        {
          ownedProcesses: {
            some: { profile: { interviewerId: "iv-1" } },
          },
        },
      ],
    });
  });
});
