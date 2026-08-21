"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import {
  changeStaffRole,
  changeStaffStatus,
  inviteStaff,
  type ActionResult,
} from "../actions";
import { Button, Field, FormError } from "@/components/ui";
import { StatusBadge } from "@/components/shell";
import { ROLE_LABELS, type StaffMember, type StoreRole } from "@/lib/types";

// Labels come from the shared map so this screen and the account page cannot
// drift into calling the same role two different things. Only the hints, which
// are particular to choosing a role here, live locally.
const ROLES = [
  { value: "STORE_ADMIN", hint: "Full access, including team and payments" },
  { value: "INVENTORY_MANAGER", hint: "Products and stock" },
  { value: "CLERK", hint: "Orders, the register, and customers" },
  { value: "DELIVERY", hint: "Their own deliveries only" },
].map((r) => ({ ...r, label: ROLE_LABELS[r.value as StoreRole] })) as readonly {
  value: StoreRole;
  hint: string;
  label: string;
}[];

export function StaffRow({
  storeId,
  member,
  isLastOwner,
}: {
  storeId: string;
  member: StaffMember;
  isLastOwner: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  function run(fn: () => Promise<ActionResult>) {
    setError(undefined);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{member.name}</p>
          <p className="text-sm text-ink-muted">{member.email}</p>
          {member.grants.length > 0 && (
            <p className="mt-1 text-xs text-ink-muted">
              Also allowed: {member.grants.join(", ")}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={member.status} />

          <label className="sr-only" htmlFor={`role-${member.membershipId}`}>
            Role for {member.name}
          </label>
          <select
            id={`role-${member.membershipId}`}
            value={member.role}
            disabled={pending || isLastOwner}
            onChange={(e) => run(() => changeStaffRole(storeId, member.membershipId, e.target.value))}
            className="rounded-card border border-line bg-surface px-2.5 py-1.5 text-sm disabled:opacity-60"
          >
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>

          {member.status === "SUSPENDED" ? (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => changeStaffStatus(storeId, member.membershipId, "ACTIVE"))}
            >
              Restore
            </Button>
          ) : (
            <Button
              variant="ghost"
              disabled={pending || isLastOwner}
              onClick={() => run(() => changeStaffStatus(storeId, member.membershipId, "SUSPENDED"))}
            >
              Suspend
            </Button>
          )}
        </div>
      </div>

      {isLastOwner && (
        <p className="mt-2 text-xs text-ink-muted">
          This is your only owner. Make someone else an owner before changing this one — otherwise
          nobody could manage the store.
        </p>
      )}

      {/* Suspending signs the person out everywhere, so the outcome is stated
          rather than left as a surprise. */}
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

export function InviteForm({ storeId }: { storeId: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    inviteStaff.bind(null, storeId),
    null,
  );

  return (
    <form action={action} className="space-y-4">
      {state && !state.ok && <FormError>{state.message}</FormError>}
      {state?.ok && (
        <p role="status" className="text-sm text-success">
          Invitation sent. It expires in 7 days.
        </p>
      )}

      <Field
        label="Email"
        name="email"
        type="email"
        required
        error={state && !state.ok ? state.fieldErrors?.email : undefined}
      />

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">What can they do?</legend>
        {ROLES.map((role, i) => (
          <label key={role.value} className="flex items-start gap-2.5 text-sm">
            <input
              type="radio"
              name="role"
              value={role.value}
              defaultChecked={i === 2}
              className="mt-1"
            />
            <span>
              <span className="font-medium text-ink">{role.label}</span>
              <span className="block text-xs text-ink-muted">{role.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <Button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send invitation"}
      </Button>
    </form>
  );
}
