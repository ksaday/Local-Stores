import type { Metadata } from "next";
import { SignInForm } from "./sign-in-form";
import { AuthCard } from "@/components/ui";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <AuthCard title="Sign in" subtitle="Welcome back.">
      <SignInForm />
    </AuthCard>
  );
}
