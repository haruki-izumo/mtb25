import { Suspense } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { ProfilesSidebar } from "@/components/profiles/profiles-sidebar";
import { ProfilesView } from "@/components/profiles/profiles-view";
import { requireSession } from "@/lib/auth-helpers";
import { normalizeProfileCertifications } from "@/app/actions/profiles";
import {
  getProfileDetail,
  getProfilesList,
  listAssignableMembers,
  listInterviewers,
} from "@/lib/profiles-data";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function ProfilesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const filter = first(sp.filter) || "all";
  const q = first(sp.q);
  const selectedId = first(sp.id);

  const [{ profiles, counts }, interviewers, assignableMembers] =
    await Promise.all([
      getProfilesList(session.user.id, session.user.role, { filter, q }),
      listInterviewers(),
      session.user.role === "ADMIN" ? listAssignableMembers() : Promise.resolve([]),
    ]);

  const detailId = selectedId || profiles[0]?.id || null;
  const rawDetail = detailId
    ? await getProfileDetail(session.user.id, session.user.role, detailId)
    : null;

  const detail = rawDetail
    ? {
        id: rawDetail.id,
        code: rawDetail.code,
        displayName: rawDetail.displayName,
        fullName: rawDetail.fullName,
        email: rawDetail.email,
        phone: rawDetail.phone,
        location: rawDetail.location,
        zipCode: rawDetail.zipCode,
        country: rawDetail.country,
        timezone: rawDetail.timezone,
        linkedinUrl: rawDetail.linkedinUrl,
        githubUrl: rawDetail.githubUrl,
        resumeFileUrl: rawDetail.resumeFileUrl,
        starred: rawDetail.starred,
        experiences: rawDetail.experiences.map((e) => ({
          id: e.id,
          company: e.company,
          location: e.location,
          startDate: e.startDate.toISOString(),
          endDate: e.endDate?.toISOString() ?? null,
        })),
        certifications: normalizeProfileCertifications(
          rawDetail.certifications,
        ),
        assignedMembers: rawDetail.assignedMembers,
        interviewer: rawDetail.interviewer,
        apiKeys: rawDetail.apiKeys,
        processes: rawDetail.processes.map((p) => ({
          id: p.id,
          companyName: p.companyName,
          jobTitle: p.jobTitle,
          status: p.status,
          updatedAt: p.updatedAt.toISOString(),
          roundCount: p._count.rounds,
        })),
      }
    : null;

  return (
    <AppShell
      sidebar={
        <Suspense fallback={null}>
          <ProfilesSidebar counts={counts} />
        </Suspense>
      }
    >
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Profiles</h1>
          <p className="text-sm text-slate-500">
            {profiles.length} profile{profiles.length === 1 ? "" : "s"}
          </p>
        </div>
        <Suspense fallback={null}>
          <ProfilesView
            profiles={profiles}
            counts={counts}
            selected={detailId}
            detail={detail}
            interviewers={interviewers}
            assignableMembers={assignableMembers}
            isAdmin={session.user.role === "ADMIN"}
          />
        </Suspense>
      </div>
    </AppShell>
  );
}
