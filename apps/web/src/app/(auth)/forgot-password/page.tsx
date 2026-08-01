import type { Metadata } from "next";
import { AuthCard } from "@/components/ui";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Reset your password" subtitle="We'll email you a link.">
      <ForgotPasswordForm />
    </AuthCard>
  );
}
