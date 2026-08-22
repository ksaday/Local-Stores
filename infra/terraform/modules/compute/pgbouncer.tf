/**
 * PgBouncer, as a service of its own (plan §14.4).
 *
 * ## Why a service and not a sidecar
 *
 * A sidecar in each task pools that task's own connections, which is not the
 * problem. §14.4's problem is the total: 20 API tasks at 10 Prisma connections
 * each is 200 connections arriving at RDS, and the worker and any migration
 * task add to it. A sidecar changes none of that — every task still opens its
 * own connections to Postgres.
 *
 * A shared service is what multiplexes. Every task connects here, and here
 * connects to RDS with `default_pool_size` server connections per database.
 * The ratio is the whole benefit, and it only exists if the pooler is shared.
 *
 * The cost is that this is now in the path of every query, so it runs more than
 * one task and is reached through the same private DNS the API uses.
 */

resource "aws_ecs_task_definition" "pgbouncer" {
  family                   = "${var.name}-pgbouncer"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.pgbouncer_cpu
  memory                   = var.pgbouncer_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "pgbouncer"
    image     = "${var.pgbouncer_image}:${var.pgbouncer_image_tag}"
    essential = true

    portMappings = [{ containerPort = 6432, protocol = "tcp" }]

    environment = [
      { name = "PGB_HOST", value = var.postgres_host },
      { name = "PGB_PORT", value = tostring(var.postgres_port) },
      { name = "PGB_DATABASE", value = "bba" },
      { name = "PGB_USER", value = var.postgres_app_user },
      # Sized against §14.4: 20 API tasks x 10, plus the worker, plus headroom
      # for a migration task, with room to spare so the pooler is never the
      # thing that refuses a connection.
      { name = "PGB_MAX_CLIENT_CONN", value = tostring(var.pgbouncer_max_client_conn) },
      # What actually reaches Postgres. Deliberately far below what RDS allows:
      # the ceiling that matters is not connection count but the memory each
      # backend holds, and a smaller pool with queueing outperforms a larger
      # one that swaps.
      { name = "PGB_DEFAULT_POOL_SIZE", value = tostring(var.pgbouncer_pool_size) },
    ]

    secrets = [
      { name = "PGB_PASSWORD", valueFrom = var.postgres_password_secret_arn },
    ]

    logConfiguration = merge(local.log_configuration, {
      options = merge(local.log_configuration.options, {
        "awslogs-group" = aws_cloudwatch_log_group.pgbouncer.name
      })
    })

    # Long enough to finish the transactions in flight. PgBouncer drains on
    # SIGTERM rather than cutting, and a transaction cut here is a payment cut.
    stopTimeout = 60
  }])

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "pgbouncer" {
  name              = "/ecs/${var.name}/pgbouncer"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_ecs_service" "pgbouncer" {
  name            = "${var.name}-pgbouncer"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.pgbouncer.arn
  desired_count   = var.pgbouncer_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [aws_security_group.pgbouncer.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.pgbouncer.arn
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Never below full capacity: this is in the path of every query, and losing
  # the last task means losing the database.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  tags = var.tags
}

/**
 * Its own security group, so the data tier can grant access to *this* and not
 * to the whole app tier.
 *
 * That narrowing is the point: with PgBouncer in front, an application task has
 * no reason to reach Postgres directly, and the only thing that should be able
 * to is the pooler. See the data module, which takes this group's id.
 */
resource "aws_security_group" "pgbouncer" {
  name        = "${var.name}-pgbouncer"
  description = "Connection pooler. The only thing that talks to Postgres."
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-pgbouncer" })
}

resource "aws_vpc_security_group_ingress_rule" "pgbouncer_from_tasks" {
  security_group_id            = aws_security_group.pgbouncer.id
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = 6432
  to_port                      = 6432
  ip_protocol                  = "tcp"
  description                  = "Application tasks"
}

resource "aws_vpc_security_group_egress_rule" "pgbouncer_out" {
  security_group_id = aws_security_group.pgbouncer.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Postgres, and Secrets Manager at start"
}

resource "aws_service_discovery_service" "pgbouncer" {
  name = "pgbouncer"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id

    dns_records {
      # Short, so a replaced task is picked up quickly. A client holding a
      # stale address here cannot reach the database at all.
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

/**
 * Who may reach the data tier.
 *
 * These rules live here rather than in the data module because granting access
 * means naming the group being granted it, and those groups belong to services
 * defined in this file. The data module exports its security groups precisely
 * so the dependency runs one way.
 *
 * Note what is *not* here: no rule lets an application task reach Postgres. The
 * pooler is the only path, which is what makes §14.4's connection accounting
 * true rather than aspirational — a task that could open its own connection
 * would eventually be given a reason to.
 */
resource "aws_vpc_security_group_ingress_rule" "postgres_from_pgbouncer" {
  security_group_id            = var.postgres_security_group_id
  referenced_security_group_id = aws_security_group.pgbouncer.id
  from_port                    = var.postgres_port
  to_port                      = var.postgres_port
  ip_protocol                  = "tcp"
  description                  = "Postgres from the connection pooler only"
}

/**
 * Redis has no pooler and needs none.
 *
 * BullMQ holds long-lived connections and uses blocking commands that sit open
 * for many seconds — precisely the pattern transaction pooling cannot handle,
 * and precisely why Redis is not behind one.
 */
resource "aws_vpc_security_group_ingress_rule" "redis_from_tasks" {
  security_group_id            = var.redis_security_group_id
  referenced_security_group_id = aws_security_group.tasks.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  description                  = "Redis from application tasks"
}
