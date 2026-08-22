/**
 * ECS Fargate, the load balancer, and the three services (plan §14.1, §14.4).
 *
 * `api` and `worker` share one image and differ only in their command — see
 * apps/api/Dockerfile for why building them separately is a way to deploy a
 * worker whose code disagrees with the API enqueuing its work.
 *
 * The load balancer routes only to `web`. Nothing outside the VPC can reach
 * the API directly: the browser talks to the Next.js BFF, which calls the API
 * over the private network with the session cookie attached. That is the whole
 * point of the BFF pattern, and putting the API behind its own public listener
 * would quietly undo it.
 */

locals {
  # One place to change the log retention. §14.5 wants 90 days hot; archival to
  # S3 for the remaining year is a lifecycle policy on the log group's export,
  # not something this module owns.
  log_retention_days = var.log_retention_days
}

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = var.tags
}

# ── Security groups ──────────────────────────────────────────────────────────

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Public load balancer"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-alb" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS from the internet"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "-1"
  description                  = "To the app tier only"
}

resource "aws_security_group" "tasks" {
  name        = "${var.name}-tasks"
  description = "ECS tasks. Reachable from the load balancer and from each other."
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-tasks" })
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.web_port
  to_port                      = var.web_port
  ip_protocol                  = "tcp"
  description                  = "Web from the load balancer"
}

/**
 * The BFF reaching the API is task-to-task inside one security group.
 *
 * Scoped to the API's port rather than opened wholesale: the metrics listeners
 * on 9464 and 9465 describe the inside of the system — every route name, its
 * latency distribution, the event loop's health — and a scraper is the only
 * thing that should reach them. The rule below deliberately does not include
 * them; the separate rule for the scraper does.
 */
resource "aws_vpc_security_group_ingress_rule" "tasks_internal_api" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = var.api_port
  to_port                      = var.api_port
  ip_protocol                  = "tcp"
  description                  = "BFF to API, task to task"
}

resource "aws_vpc_security_group_ingress_rule" "tasks_metrics" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = 9464
  to_port                      = 9465
  ip_protocol                  = "tcp"
  description                  = "Metrics scraping, inside the VPC only"
}

resource "aws_vpc_security_group_egress_rule" "tasks_out" {
  security_group_id = aws_security_group.tasks.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Stripe, SES, and image pulls, via NAT"
}

# ── Load balancer ────────────────────────────────────────────────────────────

resource "aws_lb" "this" {
  name               = var.name
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]

  # Long enough to outlive a slow report export, which §14 keeps synchronous.
  idle_timeout = 120

  enable_deletion_protection = var.deletion_protection
  drop_invalid_header_fields = true

  tags = var.tags
}

resource "aws_lb_target_group" "web" {
  name        = "${var.name}-web"
  port        = var.web_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/"
    matcher             = "200-399"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # Long enough for an in-flight render to finish, short enough that a deploy
  # does not crawl. Node receives SIGTERM at the start of this window.
  deregistration_delay = 30

  tags = var.tags
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  # TLS terminates here as well as at CloudFront, so traffic is encrypted
  # inside the VPC too (§14.8).
  ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# ── Logs ─────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "services" {
  for_each = toset(["web", "api", "worker"])

  name              = "/ecs/${var.name}/${each.key}"
  retention_in_days = local.log_retention_days
  tags              = var.tags
}

# ── IAM ──────────────────────────────────────────────────────────────────────

/**
 * Two roles per task, and the split is the point.
 *
 * The *execution* role belongs to the ECS agent: it pulls the image and reads
 * the secrets needed to start the container. The *task* role belongs to the
 * application: it is what the running code can do. Collapsing them into one
 * would give application code permission to read every secret in the account,
 * including ones for services it has no business touching.
 */
resource "aws_iam_role" "execution" {
  name = "${var.name}-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Scoped to the secrets these services actually inject, not to secretsmanager:*.
resource "aws_iam_role_policy" "execution_secrets" {
  name = "${var.name}-execution-secrets"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = var.secret_arns
    }]
  })
}

resource "aws_iam_role" "task" {
  name = "${var.name}-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

/**
 * Media lives under one prefix and the task role can reach only that prefix.
 *
 * Uploads are presigned by the API (§14.1), so the credential a browser gets is
 * derived from this role. A wildcard here would mean a presigned URL could be
 * minted for any object in the bucket.
 */
resource "aws_iam_role_policy" "task_media" {
  count = var.media_bucket_arn == null ? 0 : 1

  name = "${var.name}-task-media"
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      Resource = "${var.media_bucket_arn}/media/*"
    }]
  })
}
