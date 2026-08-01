import type { Metadata } from "next";
import { api } from "@/lib/api";
import { Card } from "@/components/shell";
import type { StaffMember } from "@/lib/types";
import { InviteForm, StaffRow } from "./staff-client";

export const metadata: Metadata = { title: "Team" };

export default async function StaffPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const members = await api<StaffMember[]>(`/stores/${storeId}/members`);

  const owners = members.filter((m) => m.role === "STORE_ADMIN" && m.status === "ACTIVE");

  return (
    <>
      <Card title="Your team" description="Everyone who can sign in to this store.">
        <ul className="divide-y divide-line">
          {members.map((member) => (
            <StaffRow
              key={member.membershipId}
              storeId={storeId}
              member={member}
              isLastOwner={member.role === "STORE_ADMIN" && owners.length <= 1}
            />
          ))}
        </ul>
      </Card>

      <Card
        title="Invite someone"
        description="They'll get an email and choose their own password — you never set it for them."
      >
        <InviteForm storeId={storeId} />
      </Card>
    </>
  );
}
