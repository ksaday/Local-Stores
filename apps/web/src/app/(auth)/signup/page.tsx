import type { Metadata } from "next";
import { AuthCard } from "@/components/ui";
import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create an account" };

export default function SignUpPage() {
  return (
    <AuthCard title="Create an account" subtitle="Shop from local stores near you.">
      <SignUpForm />
    </AuthCard>
  );
}
