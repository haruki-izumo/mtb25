import { AppShell } from "@/components/layout/app-shell";
import { SettingsForm } from "@/components/settings/settings-form";
import { requireSession } from "@/lib/auth-helpers";
import { getPreferredTimezone } from "@/app/actions/settings";

export default async function SettingsPage() {
  const session = await requireSession();
  const timezone = await getPreferredTimezone();

  return (
    <AppShell>
      <SettingsForm
        email={session.user.email ?? ""}
        name={session.user.name ?? ""}
        timezone={timezone}
      />
    </AppShell>
  );
}
