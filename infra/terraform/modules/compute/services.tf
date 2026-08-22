/**
 * The three services (plan §14.4).
 *
 * Baselines and ceilings come from §14.4's table. The autoscaling triggers do
 * not all live here: CPU and ALB request count are ECS-native, but "queue depth
 * over 500" is a metric this platform publishes itself (`queue_depth`, see
 * docs/ops/observability.md) and scaling on it needs that metric in CloudWatch
 * first. Noted in the worker's block rather than silently substituted with a
 * CPU trigger that would not catch the condition §14.4 actually names.
 */

locals {
  # Injected into every task. Secrets are separate — see `secrets` below — and
  # never appear here, because everything in `environment` is readable in the
  # task definition by anyone with describe permission.
  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "LOG_FORMAT", value = "json" },
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.otlp_endpoint },
    { name = "OTEL_BASELINE_RATIO", value = tostring(var.trace_baseline_ratio) },
    { name = "OTEL_SLOW_REQUEST_MS", value = "600" },
  ]

  common_secrets = [
    { name = "DATABASE_URL", valueFrom = var.database_url_secret_arn },
    { name = "REDIS_URL", valueFrom = var.redis_url_secret_arn },
    { name = "JWT_PRIVATE_KEY", valueFrom = var.jwt_private_key_secret_arn },
    { name = "STRIPE_SECRET_KEY", valueFrom = var.stripe_secret_key_arn },
    { name = "STRIPE_WEBHOOK_SECRET", valueFrom = var.stripe_webhook_secret_arn },
  ]

  log_configuration = {
    logDriver = "awslogs"
    options = {
      "awslogs-region"        = var.region
      "awslogs-stream-prefix" = "ecs"
    }
  }
}

# ── api ──────────────────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "api"
    image     = "${var.api_image}:${var.image_tag}"
    essential = true

    portMappings = [
      { containerPort = var.api_port, protocol = "tcp" },
      { containerPort = 9464, protocol = "tcp" },
    ]

    environment = concat(local.common_environment, [
      { name = "PORT", value = tostring(var.api_port) },
      { name = "METRICS_PORT", value = "9464" },
    ])
    secrets = local.common_secrets

    logConfiguration = merge(local.log_configuration, {
      options = merge(local.log_configuration.options, {
        "awslogs-group" = aws_cloudwatch_log_group.services["api"].name
      })
    })

    # The container's own check, distinct from the load balancer's. It reaches
    # /health/ready, which verifies the database — deliberately not Redis:
    # NFR-AVL-04 says the platform degrades rather than fails when Redis is
    # down, so failing readiness would pull healthy tasks for a dependency they
    # can trade without.
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://localhost:${var.api_port}/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }

    # Node handles SIGTERM through Nest's shutdown hooks. 30s is enough to
    # finish in-flight requests and closes well inside the ALB's own
    # deregistration delay.
    stopTimeout = 30
  }])

  tags = var.tags
}

resource "aws_ecs_service" "api" {
  name            = "${var.name}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  # Service discovery is how the BFF finds the API: `api.<namespace>` resolves
  # to the healthy tasks. Without it the BFF would need a second load balancer
  # for traffic that never leaves the VPC.
  service_registries {
    registry_arn = aws_service_discovery_service.api.arn
  }

  # Circuit breaker with rollback: a task definition that cannot start is
  # reverted automatically instead of leaving the service stuck part-deployed
  # while the old tasks drain.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # 100/200 is a rolling deploy that never drops below full capacity —
  # §14.2's zero-downtime commitment.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  enable_execute_command = var.enable_execute_command

  tags = var.tags
}

# ── worker ───────────────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "worker"
    essential = true

    # The same image as the api, with a different command. See
    # apps/api/Dockerfile.
    image   = "${var.api_image}:${var.image_tag}"
    command = ["node", "dist/worker/main.js"]

    portMappings = [{ containerPort = 9465, protocol = "tcp" }]

    environment = concat(local.common_environment, [
      { name = "WORKER_METRICS_PORT", value = "9465" },
    ])
    secrets = local.common_secrets

    logConfiguration = merge(local.log_configuration, {
      options = merge(local.log_configuration.options, {
        "awslogs-group" = aws_cloudwatch_log_group.services["worker"].name
      })
    })

    # Longer than the API's: the worker finishes in-flight jobs on SIGTERM, and
    # a half-sent email is worse than a slow deploy.
    stopTimeout = 60
  }])

  tags = var.tags
}

resource "aws_ecs_service" "worker" {
  name            = "${var.name}-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Unlike the others, the worker may drop below full capacity during a deploy.
  # Its work is a sweep or a queue job: a missed pass costs nothing because the
  # next one recomputes the same answer, and jobs are reclaimed by lease.
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  enable_execute_command = var.enable_execute_command

  tags = var.tags
}

# ── web ──────────────────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_cpu
  memory                   = var.web_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "web"
    image     = "${var.web_image}:${var.image_tag}"
    essential = true

    portMappings = [{ containerPort = var.web_port, protocol = "tcp" }]

    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = tostring(var.web_port) },
      # Binds every interface. The standalone server defaults to loopback, so
      # without this the container answers only itself and fails every health
      # check from outside.
      { name = "HOSTNAME", value = "0.0.0.0" },
      # Private DNS, not the public hostname: the BFF calls the API inside the
      # VPC, and routing that through the internet would double the latency and
      # expose an internal call path.
      { name = "API_ORIGIN", value = "http://api.${var.service_discovery_namespace}:${var.api_port}" },
      { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.otlp_endpoint },
      { name = "OTEL_BASELINE_RATIO", value = tostring(var.trace_baseline_ratio) },
      # Without this Next suppresses fetch spans, and the BFF-to-API hop — the
      # one thing traces exist to show — silently disappears from every trace.
      { name = "NEXT_OTEL_VERBOSE", value = "1" },
    ]

    logConfiguration = merge(local.log_configuration, {
      options = merge(local.log_configuration.options, {
        "awslogs-group" = aws_cloudwatch_log_group.services["web"].name
      })
    })

    stopTimeout = 30
  }])

  tags = var.tags
}

resource "aws_ecs_service" "web" {
  name            = "${var.name}-web"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.web_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = var.web_port
  }

  # The load balancer needs a moment before a new task's health counts.
  health_check_grace_period_seconds = 45

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  enable_execute_command = var.enable_execute_command

  depends_on = [aws_lb_listener.https]

  tags = var.tags
}

# ── Service discovery ────────────────────────────────────────────────────────

resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = var.service_discovery_namespace
  description = "Internal DNS so the BFF can reach the API without a load balancer"
  vpc         = var.vpc_id
  tags        = var.tags
}

resource "aws_service_discovery_service" "api" {
  name = "api"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = var.tags
}
