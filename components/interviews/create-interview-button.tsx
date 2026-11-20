"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { CreateInterviewDialog } from "@/components/booking/create-interview-dialog";

export function CreateInterviewButton({
  profiles,
  isAdmin,
}: {
  profiles: { id: string; label: string }[];
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700"
      >
        <Plus className="size-4" />
        New interview
      </button>
      <CreateInterviewDialog
        open={open}
        onClose={() => setOpen(false)}
        profiles={profiles}
        isAdmin={isAdmin}
      />
    </>
  );
}
