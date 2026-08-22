/**
 * Postgres and Redis (plan §14.1, §14.4, §14.6).
 *
 * Both live in the data subnets, which have no route to the internet, and both
 * accept traffic only from a named security group — never from a CIDR. The
 * distinction matters: a CIDR rule keeps working when something unexpected is
 * placed in that range, whereas a security-group rule grants access to a
 * specific set of tasks and nothing else.
 *
 * Postgres is reached only by the connection pooler, not by application tasks
 * at all. See modules/compute/pgbouncer.tf for why that indirection exists and
 * for the rules that grant it.
 */

# ── Security groups ──────────────────────────────────────────────────────────

resource "aws_security_group" "postgres" {
  name        = "${var.name}-postgres"
  description = "Postgres. Reachable only from the app tier."
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "${var.name}-postgres" })
}

# Deliberately no egress rule. Postgres has no reason to originate a
# connection, and the absence is the control.
#
# The *ingress* rules are not here either, and that is structural. Granting
# access means naming the security group being granted it, which belongs to the
# compute module — and a module that depends on compute while compute depends on
# it for the database endpoint is a cycle Terraform refuses. Standalone rule
# resources exist for exactly this: compute creates them against the groups this
# module exports.

resource "aws_security_group" "redis" {
  name        = "${var.name}-redis"
  description = "Redis. Reachable only from the app tier."
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "${var.name}-redis" })
}

# ── Postgres ─────────────────────────────────────────────────────────────────

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-postgres"
  subnet_ids = var.data_subnet_ids
  tags       = merge(var.tags, { Name = "${var.name}-postgres" })
}

/**
 * Parameter group, and the settings here are not defaults worth accepting.
 *
 * `log_min_duration_statement` at 300ms matches NFR-PRF-03's read target, so
 * anything Postgres logs is by definition something that missed the SLO.
 * `pg_stat_statements` is what makes "which query got slower" answerable after
 * the fact rather than only while it is happening.
 */
resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-postgres16"
  family = "postgres16"

  parameter {
    name  = "log_min_duration_statement"
    value = "300"
  }

  parameter {
    name  = "shared_preload_libraries"
    value = "pg_stat_statements"
    # Loaded at startup, so changing it needs a reboot rather than a reload.
    apply_method = "pending-reboot"
  }

  # Every connection logged with its user and database. Cheap, and the only way
  # to answer "what was connected when the pool exhausted".
  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  tags = merge(var.tags, { Name = "${var.name}-postgres16" })
}

resource "aws_db_instance" "this" {
  identifier     = "${var.name}-postgres"
  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.db_instance_class

  # gp3 rather than gp2: baseline IOPS are independent of volume size, so
  # storage can grow without buying throughput nobody asked for. §14.7 names
  # RDS storage IOPS as a cost driver.
  storage_type          = "gp3"
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_encrypted     = true

  db_name  = "bba"
  username = var.master_username
  # Managed by AWS and rotated there, so the password never passes through
  # Terraform state — which is a plaintext JSON file however carefully the
  # bucket is locked down.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.postgres.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false

  multi_az = var.multi_az

  # §14.6: PITR at 5-minute granularity, 35-day retention. 35 is the maximum
  # RDS allows and costs only storage.
  backup_retention_period = var.backup_retention_days
  backup_window           = "07:00-08:00"
  maintenance_window      = "Sun:08:30-Sun:09:30"
  copy_tags_to_snapshot   = true

  performance_insights_enabled = true
  monitoring_interval          = 60
  monitoring_role_arn          = aws_iam_role.rds_monitoring.arn
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  auto_minor_version_upgrade = true

  # A production database must not be destroyable by an errant `terraform
  # destroy`, and must leave a snapshot behind if it ever is.
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = !var.deletion_protection
  final_snapshot_identifier = var.deletion_protection ? "${var.name}-postgres-final" : null

  tags = merge(var.tags, { Name = "${var.name}-postgres" })
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${var.name}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# ── Redis ────────────────────────────────────────────────────────────────────

resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name}-redis"
  subnet_ids = var.data_subnet_ids
  tags       = merge(var.tags, { Name = "${var.name}-redis" })
}

/**
 * `maxmemory-policy` is `noeviction`, and that is deliberate.
 *
 * This Redis is a queue as well as a cache. The default `volatile-lru` would
 * silently discard BullMQ job data under memory pressure — losing a password
 * reset or an image to process, with nothing to say it happened. Refusing
 * writes is far better: the failure is loud, the enqueue errors, and NFR-AVL-04
 * already says the platform degrades rather than fails when Redis is
 * unavailable.
 */
resource "aws_elasticache_parameter_group" "this" {
  name   = "${var.name}-redis7"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }

  tags = merge(var.tags, { Name = "${var.name}-redis7" })
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "${var.name}-redis"
  description          = "BBA cache and job queues"

  engine         = "redis"
  engine_version = var.redis_version
  node_type      = var.redis_node_type
  port           = 6379

  num_cache_clusters         = var.redis_node_count
  automatic_failover_enabled = var.redis_node_count > 1
  multi_az_enabled           = var.redis_node_count > 1

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.redis.id]
  parameter_group_name = aws_elasticache_parameter_group.this.name

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  # §14.6 treats Redis as disposable — queues are reconstructible from the
  # outbox table — so there is no snapshot retention to pay for.
  snapshot_retention_limit = 0

  maintenance_window       = "sun:09:30-sun:10:30"
  auto_minor_version_upgrade = true

  tags = merge(var.tags, { Name = "${var.name}-redis" })
}
