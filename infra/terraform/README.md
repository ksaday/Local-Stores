# Infrastructure

AWS, ECS Fargate, Terraform-managed, per [plan §14](../../docs/plan/14-deployment-architecture.md).

```
modules/
  network/   VPC, three subnet tiers across two AZs, NAT, S3 gateway endpoint
  data/      RDS Postgres 16, ElastiCache Redis, their security groups
  compute/   ECS cluster, ALB, the three services, autoscaling, IAM, logs
  secrets/   Secrets Manager entries and the ECR repositories
  storage/   The media bucket
  dns/       The hosted zone and both certificates
  edge/      CloudFront, WAF, the media CDN, Route 53 records
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

## The module graph, and why it has the shape it has

```
network   secrets   storage   dns        (depend on nothing)
   ↓         ↓         ↓        ↓
        compute  ←──────────────┘
        ↓     ↓
      data   edge
```

Two of those edges exist to avoid a cycle rather than because the decomposition
is obvious:

**`storage` is separate** because the task role needs the media bucket's ARN
while the CDN needs its domain name. With the bucket beside the distribution,
`compute` would depend on `edge` for the ARN and `edge` on `compute` for the
load balancer's DNS name. Terraform refuses that graph.

**`dns` owns both certificates** for the same reason. The ALB's listener needs
one in the deployment region and CloudFront needs one in us-east-1; putting
them beside CloudFront would mean the load balancer could not exist until the
thing that points at it did.

Both cycles were introduced while writing this and caught by the wiring check
described below, not by reasoning about the graph in advance.

## The connection pooler

§14.4: 20 API tasks at 10 Prisma connections each is 200 connections arriving at
RDS, before the worker or a migration task. PgBouncer in transaction mode
multiplexes them onto `pgbouncer_pool_size` server connections — 25 in
production.

It runs as a **shared service**, not a sidecar. A sidecar pools one task's own
connections, which is not the problem: every task would still open its own
connections to Postgres. Only a shared pooler changes the total.

**Application tasks cannot reach Postgres at all.** The only ingress rule on the
database's security group names the pooler. That is what makes the connection
accounting true rather than intended — a task that *could* open its own
connection would eventually be given a reason to.

### Why transaction pooling is safe here, and what would break it

Transaction pooling returns a connection to the pool at every COMMIT and gives
it to whoever asks next — a different shop, a different customer. That is only
safe because every RLS setting this codebase writes is transaction-local:
`set_config(..., true)`. At COMMIT the context is gone.

Change that `true` to `false` and the connection carries one tenant's
`app.store_id` into the next tenant's queries. RLS then enforces the wrong
tenant's identity, correctly and invisibly — nothing errors, no policy is
violated, and the wrong rows come back looking exactly like the right ones.

`tenant-isolation.test.ts` now fails if that changes. It was verified by making
the change: the test reports store A's id still set on the connection after the
transaction ended.

### Two connection strings

Services get the pooled URL, which must carry `?pgbouncer=true` — that is how
Prisma is told not to use prepared statements, which transaction pooling cannot
carry across connections.

Migrations get `database-url-direct`, straight to RDS. `prisma migrate deploy`
takes an advisory lock to serialise concurrent deploys and issues DDL assuming a
stable session; both are session-scoped, so through a pooler the lock would be
taken and lost on a different connection than the one still migrating.

```
bba-production/database-url         →  pgbouncer.bba.internal:6432/bba?pgbouncer=true
bba-production/database-url-direct  →  <rds endpoint>:5432/bba
```

## What is not here yet

**The worker's real autoscaling trigger.** §14.4 scales it on queue depth and
oldest-job age. Both are already published by the platform
(`queue_depth{queue,state}`) but are not in CloudWatch, so only a CPU policy is
wired — and CPU cannot see the case that matters, a worker blocked on a slow
external call with a deep queue and an idle core. See the note at the bottom of
`modules/compute/autoscaling.tf`.

**SES and the DR region.** SES identities, the cross-region snapshot copy and
the DR-region stack (§14.6) are not written. The media bucket now exists —
`modules/storage` — with versioning, a Glacier lifecycle on noncurrent versions,
and no public access at all: CloudFront reaches it through an origin access
control, so the CDN's headers and WAF are not optional for anyone who learns the
bucket name.

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
terraform plan \
  -var image_tag=$(git rev-parse HEAD) \
  -var hosted_zone_name=bba.app \
  -var domain_name=staging.bba.app \
  -var cdn_domain_name=cdn-staging.bba.app \
  -var media_bucket_name=bba-staging-media
```

## The load balancer refuses direct traffic

CloudFront is the only way in. The ALB's security group is narrowed to
CloudFront's origin-facing prefix list, and its listener defaults to a flat
**403** — every rule that forwards requires a shared secret header the
distribution sends.

Both halves are needed. The prefix list alone is not enough, because anybody
can point *their* distribution at this ALB's hostname and arrive from the same
addresses. The header alone is not enough either, since it travels in cleartext
to the origin. Together they mean a request has to come from CloudFront *and*
from ours.

The secret is generated by Terraform and lands in state, which is why the ALB
treats it as proof of origin and never as authentication. What actually
authenticates is the session cookie, and for webhooks, Stripe's signature.

## Nothing HTML is cached

Every CloudFront behaviour except `/_next/static/*` uses `CachingDisabled`.
That is deliberate: this platform serves signed-in staff, signed-in customers
and guests carrying a cart cookie from the same paths, and a cache key that
misses one cookie serves one person's account page to another. That failure is
silent, it is a breach rather than a bug, and a customer finds it first.

Storefront pages are cacheable in principle. Doing it means a cache policy keyed
on the exact cookie set, applied only to paths proven anonymous, with a test
behind it — deliberate work, not a default to leave on.

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
- module wiring: every call passes only declared variables, supplies every
  required one, every `module.x.output` reference resolves, and the graph is
  acyclic. This caught a real `compute → edge → compute` cycle that Terraform
  would have rejected at plan time

What that leaves unproven is everything requiring the AWS provider's schema:
whether each resource argument exists and is spelled correctly, whether
attribute references like `master_user_secret[0].secret_arn` are right, and
whether instance classes and engine versions are valid in the chosen region.
The `terraform` job added to CI runs `fmt -check` and `validate`, which closes
exactly that gap on the next push — expect it to find things.
