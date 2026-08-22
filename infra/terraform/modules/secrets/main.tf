/**
 * Secrets, and the ECR repositories the images live in (plan §14.1, §14.3).
 *
 * Every secret is created *empty* and populated out of band. Terraform state is
 * plaintext JSON — encrypted at rest in S3, but readable by anyone who can read
 * the bucket and by every CI run that touches state — so a secret whose value
 * passes through a variable is a secret stored in two places, one of which
 * nobody thinks of as a secret store.
 *
 * The one exception is the database URL, which is assembled from an endpoint
 * Terraform already knows and a password it deliberately never sees: RDS
 * manages the master password itself, and the task reads both.
 */

resource "aws_secretsmanager_secret" "app" {
  for_each = toset([
    "jwt-private-key",
    "stripe-secret-key",
    "stripe-webhook-secret",
    "ses-credentials",
  ])

  name        = "${var.name}/${each.key}"
  description = "Populated out of band. Terraform creates the container, never the value."

  # Long enough to undo an accidental delete, short enough that a rotated
  # secret does not linger.
  recovery_window_in_days = 7

  tags = merge(var.tags, { Name = "${var.name}/${each.key}" })

  lifecycle {
    # Rotation happens outside Terraform, so a plan must never propose
    # reverting a rotated value to whatever it last saw.
    ignore_changes = [tags_all]
  }
}

/**
 * The connection strings — created empty, like the rest.
 *
 * Terraform knows the RDS endpoint, so it is tempting to assemble the URL here
 * and be done. It is not done, because the other half is the password, and RDS
 * manages that itself precisely so it never enters Terraform state. Joining the
 * two in a `secret_version` would put a working database credential into a
 * plaintext JSON file that every CI run reads.
 *
 * Populating these is a documented deploy step — see infra/terraform/README.md
 * — and it is a one-liner against an endpoint this configuration outputs.
 */
resource "aws_secretsmanager_secret" "database_url" {
  name        = "${var.name}/database-url"
  description = "Assembled from the RDS endpoint and the AWS-managed master secret."
  recovery_window_in_days = 7
  tags        = merge(var.tags, { Name = "${var.name}/database-url" })
}

resource "aws_secretsmanager_secret" "redis_url" {
  name        = "${var.name}/redis-url"
  description = "rediss:// — transit encryption is on, so the scheme is not redis://."
  recovery_window_in_days = 7
  tags        = merge(var.tags, { Name = "${var.name}/redis-url" })
}

# ── Image repositories ───────────────────────────────────────────────────────

resource "aws_ecr_repository" "this" {
  for_each = toset(["api", "web"])

  name = "${var.name}/${each.key}"

  # A tag that can be overwritten makes a rollback ambiguous — "the SHA we
  # deployed" stops meaning one image. Immutable tags make the deployed
  # artefact a fact rather than a claim.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = merge(var.tags, { Name = "${var.name}/${each.key}" })
}

/**
 * Keep the last 30 images and expire the rest.
 *
 * Not for storage cost, which is trivial, but because an unbounded repository
 * makes "which of these is running" a slow question during an incident. Thirty
 * is comfortably more than a rollback ever needs.
 */
resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 30
      }
      action = { type = "expire" }
    }]
  })
}
