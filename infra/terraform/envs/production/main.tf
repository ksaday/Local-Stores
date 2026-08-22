/**
 * Production (plan §14.2).
 *
 * A thin root: every decision that differs between environments is an argument
 * here, and everything that must not differ lives in the modules. §14.2's
 * non-negotiable — staging runs the same images and the same migrations as
 * production — is only true if the two roots differ in *sizing and posture*
 * rather than in structure. Compare this file against ../staging/main.tf and
 * the whole difference should be visible at once.
 */

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }

    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  /**
   * State in S3 with locking (§14.6: "all resources reproducible from code").
   *
   * Values are supplied by `-backend-config` rather than hardcoded, because the
   * bucket is created outside this configuration — a Terraform state backend
   * cannot be managed by the configuration whose state it holds without a
   * chicken-and-egg problem on first apply.
   */
  backend "s3" {
    key     = "production/terraform.tfstate"
    encrypt = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

locals {
  name = "bba-production"

  tags = {
    Project     = "bba"
    Environment = "production"
    ManagedBy   = "terraform"
  }
}

module "network" {
  source = "../../modules/network"

  name     = local.name
  region   = var.region
  vpc_cidr = "10.0.0.0/16"

  # One NAT per AZ. A shared one is a single point of failure for all outbound
  # traffic — Stripe calls included — and sends half the fleet's egress across
  # an AZ boundary at a per-gigabyte charge.
  single_nat_gateway = false

  tags = local.tags
}

module "secrets" {
  source = "../../modules/secrets"

  name = local.name
  tags = local.tags
}

module "data" {
  source = "../../modules/data"

  name            = local.name
  vpc_id          = module.network.vpc_id
  data_subnet_ids = module.network.data_subnet_ids

  app_security_group_id = module.compute.tasks_security_group_id

  # §14.4's baseline.
  db_instance_class        = "db.m7g.large"
  db_allocated_storage     = 100
  db_max_allocated_storage = 1000

  # Survives an AZ loss automatically, which is the launch commitment in §14.6.
  multi_az = true

  # §14.6: 35 days, the maximum RDS allows, supporting PITR at 5-minute
  # granularity for RPO <= 15 min.
  backup_retention_days = 35

  # Neither the database nor the load balancer may be destroyed by an errant
  # apply, and a final snapshot is taken if one ever is.
  deletion_protection = true

  redis_node_type  = "cache.t4g.medium"
  redis_node_count = 2

  tags = local.tags
}

module "compute" {
  source = "../../modules/compute"

  name              = local.name
  region            = var.region
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids
  app_subnet_ids    = module.network.app_subnet_ids

  certificate_arn = module.dns.alb_certificate_arn

  api_image = module.secrets.api_repository_url
  web_image = module.secrets.web_repository_url
  image_tag = var.image_tag

  # §14.4's baselines and ceilings.
  web_desired_count = 2
  web_max_count     = 10
  api_desired_count = 2
  api_max_count     = 20
  worker_desired_count = 1
  worker_max_count     = 8

  log_retention_days = 90

  otlp_endpoint        = var.otlp_endpoint
  trace_baseline_ratio = 0.05

  database_url_secret_arn    = module.secrets.database_url_arn
  redis_url_secret_arn       = module.secrets.redis_url_arn
  jwt_private_key_secret_arn = module.secrets.jwt_private_key_arn
  stripe_secret_key_arn      = module.secrets.stripe_secret_key_arn
  stripe_webhook_secret_arn  = module.secrets.stripe_webhook_secret_arn
  secret_arns                = module.secrets.all_secret_arns

  origin_secret = random_password.origin_secret.result

  media_bucket_arn = module.storage.media_bucket_arn

  # A shell into a running production task is an audited backdoor. Staging has
  # it; production does not, and an incident that genuinely needs it should
  # require a deliberate change rather than finding the door already open.
  enable_execute_command = false

  deletion_protection = true

  tags = local.tags
}

/**
 * A second provider, pinned to us-east-1.
 *
 * CloudFront's certificate and its WAF web ACL must live there whatever region
 * the rest of this runs in. Passed explicitly to the modules that need it, so
 * the constraint is visible here rather than surfacing as an apply-time error.
 */
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}

/**
 * The secret CloudFront sends and the load balancer requires.
 *
 * Generated rather than configured, because nobody needs to know it and a
 * value a human chose is a value that ends up in a chat message. It lands in
 * Terraform state, which is why the load balancer treats it as proof of origin
 * and never as authentication — the controls that matter are the session
 * cookie and, for webhooks, Stripe's signature.
 */
resource "random_password" "origin_secret" {
  length  = 48
  special = false
}

module "storage" {
  source = "../../modules/storage"

  bucket_name = var.media_bucket_name
  domain_name = var.domain_name

  tags = local.tags
}

module "dns" {
  source = "../../modules/dns"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name             = local.name
  hosted_zone_name = var.hosted_zone_name
  domain_name      = var.domain_name
  cdn_domain_name  = var.cdn_domain_name

  tags = local.tags
}

module "edge" {
  source = "../../modules/edge"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name            = local.name
  hosted_zone_id  = module.dns.zone_id
  certificate_arn = module.dns.cloudfront_certificate_arn
  domain_name     = var.domain_name
  cdn_domain_name = var.cdn_domain_name

  media_bucket_name                 = module.storage.media_bucket_name
  media_bucket_arn                  = module.storage.media_bucket_arn
  media_bucket_regional_domain_name = module.storage.media_bucket_regional_domain_name

  alb_dns_name = module.compute.alb_dns_name

  origin_secret = random_password.origin_secret.result

  stripe_ip_ranges = var.stripe_ip_ranges

  tags = local.tags
}
