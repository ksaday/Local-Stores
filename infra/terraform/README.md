# Infrastructure

AWS, ECS Fargate, Terraform-managed, per [plan §14](../../docs/plan/14-deployment-architecture.md).

```
modules/
  network/   VPC, three subnet tiers across two AZs, NAT, S3 gateway endpoint
  data/      RDS Postgres 16, ElastiCache Redis, their security groups
  compute/   ECS cluster, ALB, the three services, autoscaling, IAM, logs
  secrets/   Secrets Manager entries and the ECR repositories
envs/
  staging/     smaller, single-AZ, rebuildable
  production/  §14.4 baselines, Multi-AZ, deletion protection
```

The two environment roots are deliberately the same file with different
numbers. §14.2's non-negotiable is that staging runs the same images and the
same migrations as production, and that only holds if the two differ in sizing
and posture rather than in shape — a staging environment assembled differently
stops being evidence about production. `diff envs/production/main.tf
envs/staging/main.tf` should read as a list of decisions, and does.

---

## What is not here yet

**The edge tier.** CloudFront, WAF, Route 53 and ACM (§14.1, §14.8) are not
written. They need the real domain to exist, ACM validation is interactive, and
the WAF rule for Stripe webhooks needs Stripe's published IP ranges. The ALB is
internet-facing in the meantime, which is fine for staging and is **not** the
production posture §14.1 describes — CloudFront in front, ALB reachable only
from it.

**PgBouncer.** §14.4 is explicit that connection management matters more than
task count: 20 API tasks against RDS will exhaust Postgres connections without
transaction pooling in front. Prisma's pool is sized in the app, but the pooler
itself is a service that needs adding before the API tier scales past a handful
of tasks.

**The worker's real autoscaling trigger.** §14.4 scales it on queue depth and
oldest-job age. Both are already published by the platform
(`queue_depth{queue,state}`) but are not in CloudWatch, so only a CPU policy is
wired — and CPU cannot see the case that matters, a worker blocked on a slow
external call with a deep queue and an idle core. See the note at the bottom of
`modules/compute/autoscaling.tf`.

**S3 for media, SES, and the DR region.** Referenced by variables where the
seam exists (`media_bucket_arn`), not created.

---

## First apply

State lives in S3 with locking, and the bucket cannot be managed by the
configuration whose state it holds. Create it once, by hand:

```bash
aws s3api create-bucket --bucket bba-tfstate --region us-east-2 \
  --create-bucket-configuration LocationConstraint=us-east-2
aws s3api put-bucket-versioning --bucket bba-tfstate \
  --versioning-configuration Status=Enabled
```

Then, per environment:

```bash
cd envs/staging
terraform init -backend-config=bucket=bba-tfstate -backend-config=region=us-east-2
terraform plan -var image_tag=$(git rev-parse HEAD) -var certificate_arn=...
```

## Secrets are created empty

Terraform creates every secret and populates none of them. State is plaintext
JSON — encrypted at rest, but readable by anyone who can read the bucket and by
every CI run that touches it — so a secret whose value passes through a variable
is stored in two places, one of which nobody thinks of as a secret store.

That includes the database URL, which is tempting to assemble here since
Terraform knows the endpoint. The other half is the password, and RDS manages
that itself precisely so it never enters state. After the first apply:

```bash
# the password stays in the AWS-managed secret; only the assembled URL is written
PASS=$(aws secretsmanager get-secret-value \
  --secret-id "$(terraform output -raw postgres_master_secret_arn)" \
  --query SecretString --output text | jq -r .password)

aws secretsmanager put-secret-value --secret-id bba-staging/database-url \
  --secret-string "postgresql://bba_root:${PASS}@$(terraform output -raw postgres_endpoint):5432/bba?schema=public"
```

The application connects as `bba_app`, the RLS-restricted role, which migration
`00000000000001` creates. `bba_root` is only for migrations.

## Migrations

Run as a one-off ECS task using **the same image** as the service, before the
service updates. §14 uses expand-then-contract, so the schema change and the
code that depends on it deploy separately — and a migration task built from a
different image is how those two end up out of step.

```bash
aws ecs run-task --cluster bba-staging --task-definition bba-staging-api \
  --overrides '{"containerOverrides":[{"name":"api","command":["npx","prisma","migrate","deploy"]}]}'
```

---

## Verification status

**None of this has been applied.** There is no Terraform binary, no AWS
credentials and no account on the machine it was written on, so it has never
been planned against a real provider.

What was checked:

- every `.tf` file parses as HCL — this caught `{ type = number, default = 1024 }`,
  which is not valid HCL, in 22 variable blocks
- module wiring: every module call passes only declared variables, supplies
  every required one, and every `module.x.output` reference resolves to a
  declared output

What that leaves unproven is everything requiring the AWS provider's schema:
whether each resource argument exists and is spelled correctly, whether
attribute references like `master_user_secret[0].secret_arn` are right, and
whether instance classes and engine versions are valid in the chosen region.
The `terraform` job added to CI runs `fmt -check` and `validate`, which closes
exactly that gap on the next push — expect it to find things.
